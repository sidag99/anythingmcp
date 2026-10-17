import { Injectable, Logger } from '@nestjs/common';
import ivm from 'isolated-vm';
import { SANDBOX_LIMITS, type SandboxLimits } from './limits';
import { countLines, HINTS, parseSyntaxError, toSandboxError } from './sandbox-errors';
import {
  RUNTIME_FILE,
  RUNTIME_SOURCE,
  SCRIPT_FILE,
  wrapUserCode,
} from './sandbox-runtime';
import type {
  SandboxError,
  SandboxRunMeta,
  SandboxRunRequest,
  SandboxRunResult,
  SandboxSyntaxCheck,
  SandboxTool,
  SandboxToolResult,
} from './types';

const MAX_AVAILABLE_NAMES = 20;
const MAX_TOOL_ERROR_CHARS = 2_000;

/**
 * Runs agent-written JavaScript in an isolated V8 isolate next to the connectors.
 *
 * The isolate has no filesystem, network, process, timers or credentials: those
 * APIs do not exist in it, so there is nothing to bypass. The only way out is the
 * `tools.<name>(args)` bridge, which resolves names against `allowedTools` (already
 * role-filtered) and calls `executeTool` with the caller's own invocation context.
 * The script can never choose or change the tenant.
 *
 * Resource caps: V8 heap (`memoryMb`), wall clock for the whole run (`timeoutMs`),
 * connector call count and bytes, result size. The wall clock is enforced by the
 * host disposing the isolate: isolated-vm's own `timeout` only covers synchronous
 * execution and would not stop a loop that starts after an `await`.
 */
@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);
  /** Runs in flight per organization (the BUSY guard). */
  private readonly active = new Map<string, number>();

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    const started = Date.now();
    const limits = mergeLimits(req.limits);
    const meta: SandboxRunMeta = {
      ms: 0,
      connectorCalls: 0,
      bytesFromConnectors: 0,
      bytesReturned: 0,
      logs: [],
      toolsCalled: [],
    };
    const failWith = (error: SandboxError): SandboxRunResult => {
      meta.ms = Date.now() - started;
      return {
        ok: false,
        error: { ...error, hint: error.hint ?? HINTS[error.code] },
        meta: snapshot(meta),
      };
    };

    const codeBytes = Buffer.byteLength(req.code);
    if (codeBytes > limits.maxCodeBytes) {
      return failWith({
        code: 'CODE_TOO_LARGE',
        message: `Code is ${codeBytes} bytes; limit is ${limits.maxCodeBytes}.`,
      });
    }

    // Claim a slot before the first await so concurrent callers see it.
    const orgKey = req.invocationContext.organizationId ?? '__anonymous__';
    const running = this.active.get(orgKey) ?? 0;
    if (running >= limits.maxConcurrent) {
      return failWith({
        code: 'BUSY',
        message: `${running} scripts are already running for this organization (limit ${limits.maxConcurrent}).`,
      });
    }
    this.active.set(orgKey, running + 1);
    try {
      const result = await this.execute(req, limits, meta, started, failWith);
      this.logger.debug(
        `sandbox run ok=${result.ok} code=${result.error?.code ?? '-'} ms=${result.meta.ms} ` +
          `calls=${result.meta.connectorCalls} in=${result.meta.bytesFromConnectors}B out=${result.meta.bytesReturned}B`,
      );
      return result;
    } finally {
      const left = (this.active.get(orgKey) ?? 1) - 1;
      if (left <= 0) this.active.delete(orgKey);
      else this.active.set(orgKey, left);
    }
  }

  /** Compile (never run) a script to report syntax errors with line and column. */
  async checkSyntax(code: string): Promise<SandboxSyntaxCheck> {
    if (Buffer.byteLength(code) > SANDBOX_LIMITS.maxCodeBytes) {
      return {
        ok: false,
        line: 1,
        column: 1,
        message: `Code exceeds ${SANDBOX_LIMITS.maxCodeBytes} bytes`,
      };
    }
    const isolate = new ivm.Isolate({ memoryLimit: 16 });
    try {
      await isolate.compileScript(wrapUserCode(code), { filename: SCRIPT_FILE });
      return { ok: true };
    } catch (err) {
      return { ok: false, ...parseSyntaxError(err, countLines(code)) };
    } finally {
      disposeQuietly(isolate);
    }
  }

  private async execute(
    req: SandboxRunRequest,
    limits: SandboxLimits,
    meta: SandboxRunMeta,
    started: number,
    failWith: (error: SandboxError) => SandboxRunResult,
  ): Promise<SandboxRunResult> {
    const lineCount = countLines(req.code);
    const allowWrites = req.allowWrites === true;
    // Fixed for the whole run: the script cannot add a tool, and a change to the
    // caller's role while it runs does not reach it.
    const allowed = new Map<string, SandboxTool>(req.allowedTools.map((t) => [t.name, t]));
    // What the script is told it can call. A write tool stays known, so that a
    // call to it is refused with a reason, but it is not listed unless writes
    // are allowed.
    const names = req.allowedTools.filter((t) => t.readOnly || allowWrites).map((t) => t.name);

    let argsJson: string;
    try {
      argsJson = JSON.stringify(req.args ?? {});
    } catch {
      return failWith({ code: 'RUNTIME_ERROR', message: 'args must be JSON-serialisable.' });
    }

    const isolate = new ivm.Isolate({ memoryLimit: limits.memoryMb });
    let timedOut = false;
    let cancelled = false;
    let done = false;
    // Deadlines of connector calls still being waited on: settled when the run ends.
    const liveCalls = new Set<() => void>();
    // Host-side wall clock for the whole run: the script, the time it spends
    // waiting on connectors, and the handling of its result. Disposing a busy
    // isolate stops it (about 200 ms).
    const timer = setTimeout(() => {
      timedOut = true;
      disposeQuietly(isolate);
    }, limits.timeoutMs);
    // The caller went away: stop the isolate now instead of finishing for nobody.
    const onAbort = () => {
      cancelled = true;
      disposeQuietly(isolate);
    };
    if (req.signal?.aborted) onAbort();
    else req.signal?.addEventListener('abort', onAbort, { once: true });

    const classify = (err: unknown): SandboxRunResult =>
      failWith(
        toSandboxError(err, {
          timedOut,
          cancelled,
          lineCount,
          timeoutMs: limits.timeoutMs,
          memoryMb: limits.memoryMb,
        }),
      );

    // ---- host side of the bridge -------------------------------------------
    // These never reject: they resolve a JSON envelope the in-isolate wrapper
    // turns into a throw. A rejecting callback whose isolate is already gone
    // would surface as an unhandled rejection on the host.
    const refuse = (code: SandboxError['code'], message: string): string =>
      JSON.stringify({ ok: false, code, message });

    const callTool = async (nameArg: unknown, argsArg: unknown): Promise<string> => {
      try {
        if (done) return refuse('TOOL_ERROR', 'The sandbox run has already finished.');
        const name = String(nameArg);
        const tool = allowed.get(name);
        if (!tool) return refuse('TOOL_NOT_ALLOWED', notAvailable(name, names));
        // Checked on every call, before anything runs: a tool that may change
        // data is refused unless the trusted policy allows writes.
        if (!tool.readOnly && !allowWrites) {
          return refuse(
            'WRITE_NOT_ALLOWED',
            `Tool '${name}' can change data, and sandbox scripts are read-only.`,
          );
        }
        if (meta.connectorCalls >= limits.maxConnectorCalls) {
          return refuse(
            'CONNECTOR_CALL_LIMIT',
            `Connector call limit (${limits.maxConnectorCalls}) reached.`,
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(argsArg));
        } catch {
          return refuse('TOOL_ERROR', 'Tool arguments must be valid JSON.');
        }
        if (!isPlainObject(parsed)) {
          return refuse(
            'TOOL_ERROR',
            `Tool arguments must be an object, e.g. tools.${name}({ limit: 10 }).`,
          );
        }

        // The same check the MCP endpoint applies to a direct call, here on the
        // host: the script's arguments are data, never trusted as they come.
        let callArgs: Record<string, unknown> = parsed;
        if (tool.validateArgs) {
          let checked;
          try {
            checked = tool.validateArgs(parsed);
          } catch {
            return refuse('TOOL_ERROR', `Arguments for '${name}' could not be checked.`);
          }
          if (!checked.ok) return refuse('TOOL_ERROR', checked.message);
          callArgs = checked.args;
        }

        meta.connectorCalls++;
        if (!meta.toolsCalled.includes(name)) meta.toolsCalled.push(name);

        // A call gets its own deadline only when that is shorter than what is
        // left of the run. Otherwise the whole-run deadline is the one that
        // applies, so the two never race for the same instant.
        const left = limits.timeoutMs - (Date.now() - started);
        const callMs = limits.connectorTimeoutMs < left ? limits.connectorTimeoutMs : undefined;
        let result: SandboxToolResult;
        try {
          // Scope to the owning connector (avoids cross-connector name clashes)
          // and keep everything else from the authenticated session.
          result = await withDeadline(
            Promise.resolve().then(() =>
              req.executeTool(name, callArgs, {
                ...req.invocationContext,
                connectorIds: [tool.connectorId],
              }),
            ),
            callMs,
            liveCalls,
          );
        } catch (err) {
          if (err === RUN_ENDED) {
            return refuse('TOOL_ERROR', 'The sandbox run has already finished.');
          }
          if (err === DEADLINE) {
            return refuse(
              'CONNECTOR_TIMEOUT',
              `Tool '${name}' did not answer within ${limits.connectorTimeoutMs} ms.`,
            );
          }
          this.logger.warn(
            `Tool "${name}" threw inside a sandbox run: ${(err as Error)?.constructor?.name ?? 'error'}`,
          );
          return refuse('TOOL_ERROR', `Tool '${name}' failed unexpectedly.`);
        }
        if (done) return refuse('TOOL_ERROR', 'The sandbox run has already finished.');
        if (result.isError) return refuse('TOOL_ERROR', toolErrorText(result));

        // A cheap bound before the payload is serialised again and copied into
        // the isolate. The text form is pretty-printed, so it is never smaller
        // than the compact JSON; the exact check follows.
        const textBytes = Buffer.byteLength(result.content?.[0]?.text ?? '', 'utf8');
        if (textBytes > limits.maxConnectorResponseBytes * 4) {
          return refuse(
            'CONNECTOR_BYTES_LIMIT',
            `Connector response is larger than the per-response limit (${limits.maxConnectorResponseBytes} bytes).`,
          );
        }
        const out = JSON.stringify(toolValue(result)) ?? 'null';
        const outBytes = Buffer.byteLength(out, 'utf8');
        if (outBytes > limits.maxConnectorResponseBytes) {
          return refuse(
            'CONNECTOR_BYTES_LIMIT',
            `Connector response of ${outBytes} bytes is larger than the per-response limit (${limits.maxConnectorResponseBytes} bytes).`,
          );
        }
        meta.bytesFromConnectors += outBytes;
        if (meta.bytesFromConnectors > limits.maxConnectorBytes) {
          return refuse(
            'CONNECTOR_BYTES_LIMIT',
            `Connector data limit (${limits.maxConnectorBytes} bytes) reached.`,
          );
        }
        return `{"ok":true,"v":${out}}`;
      } catch {
        return refuse('TOOL_ERROR', 'Sandbox bridge error.');
      }
    };

    const describeTool = async (nameArg: unknown): Promise<string> => {
      try {
        const name = String(nameArg);
        const tool = allowed.get(name);
        if (!tool) return refuse('TOOL_NOT_ALLOWED', notAvailable(name, names));
        if (!tool.readOnly && !allowWrites) {
          return refuse(
            'WRITE_NOT_ALLOWED',
            `Tool '${name}' can change data, and sandbox scripts are read-only.`,
          );
        }
        return `{"ok":true,"v":${JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          outputSchema: tool.outputSchema ?? null,
        })}}`;
      } catch {
        return refuse('TOOL_ERROR', 'Sandbox bridge error.');
      }
    };

    const logLine = (line: unknown): void => {
      if (done || meta.logs.length >= limits.maxLogLines) return;
      meta.logs.push(String(line).slice(0, 500));
    };

    // ---- run ----------------------------------------------------------------
    try {
      const context = await isolate.createContext();
      const jail = context.global;
      await jail.set('__call', new ivm.Reference(callTool));
      await jail.set('__describe', new ivm.Reference(describeTool));
      await jail.set('__log', new ivm.Reference(logLine));
      await jail.set('__toolNamesJson', JSON.stringify(names));
      await jail.set('__argsJson', argsJson);
      await jail.set('__maxOut', limits.maxOutputBytes);
      await jail.set('__maxLog', limits.maxLogLines);
      const runtime = await isolate.compileScript(RUNTIME_SOURCE, { filename: RUNTIME_FILE });
      await runtime.run(context);

      let script: ivm.Script;
      try {
        script = await isolate.compileScript(wrapUserCode(req.code), { filename: SCRIPT_FILE });
      } catch (err) {
        if (timedOut || isolate.isDisposed || (err as Error)?.name !== 'SyntaxError') {
          return classify(err);
        }
        const syntax = parseSyntaxError(err, lineCount);
        return failWith({
          code: 'SYNTAX_ERROR',
          message: `Syntax error at line ${syntax.line}, column ${syntax.column}: ${syntax.message}`,
          line: syntax.line,
          column: syntax.column,
        });
      }

      const raw: unknown = await script.run(context, {
        timeout: limits.timeoutMs,
        promise: true,
        copy: true,
      });
      return this.finish(raw, limits, meta, started, failWith);
    } catch (err) {
      return classify(err);
    } finally {
      done = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      // No call outlives the run: its timer is cleared and its waiter released.
      for (const settle of [...liveCalls]) settle();
      disposeQuietly(isolate);
    }
  }

  /** Validate what the isolate handed back; never trust its shape. */
  private finish(
    raw: unknown,
    limits: SandboxLimits,
    meta: SandboxRunMeta,
    started: number,
    failWith: (error: SandboxError) => SandboxRunResult,
  ): SandboxRunResult {
    const out = (raw && typeof raw === 'object' ? raw : {}) as {
      k?: unknown;
      j?: unknown;
      n?: unknown;
      m?: unknown;
    };
    const tooLarge = (bytes: number) =>
      failWith({
        code: 'OUTPUT_TOO_LARGE',
        message:
          `Result is ${bytes} bytes; limit is ${limits.maxOutputBytes}. ` +
          'Return aggregates, counts, or the first 20 rows (e.g. rows.slice(0, 20)).',
      });

    if (out.k === 'ok' && typeof out.j === 'string') {
      const bytes = Buffer.byteLength(out.j);
      if (bytes > limits.maxOutputBytes) return tooLarge(bytes);
      meta.bytesReturned = bytes;
      meta.ms = Date.now() - started;
      return { ok: true, result: JSON.parse(out.j), meta: snapshot(meta) };
    }
    if (out.k === 'toolarge' && typeof out.n === 'number') return tooLarge(out.n);
    if (out.k === 'unserializable') {
      return failWith({
        code: 'RUNTIME_ERROR',
        message: `Result is not JSON-serialisable: ${String(out.m).slice(0, 200)}`,
      });
    }
    return failWith({
      code: 'RUNTIME_ERROR',
      message: 'Script ended without producing a result.',
    });
  }
}

/** Marks a connector call that the run stopped waiting for. */
const DEADLINE = Symbol('deadline');
/** Marks a connector call still pending when its run ended. */
const RUN_ENDED = Symbol('run-ended');

/**
 * Stops waiting for a call after `ms`. The call itself is not cancelled: the
 * executor takes no signal, and the connector engines carry their own timeouts.
 * What this guarantees is that the run moves on, and that the call's eventual
 * outcome, a result or a rejection, is absorbed here and reaches nothing.
 *
 * `live` holds a settle function for each call still being waited on; the run
 * calls them all when it ends, so no timer outlives it.
 */
function withDeadline<T>(
  pending: Promise<T>,
  ms: number | undefined,
  live: Set<() => void>,
): Promise<T> {
  pending.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const finish = () => {
      if (timer) clearTimeout(timer);
      live.delete(end);
    };
    const end = () => {
      finish();
      reject(RUN_ENDED);
    };
    // No timer when the run's own deadline is the only one that applies.
    const timer =
      ms === undefined
        ? undefined
        : setTimeout(() => {
            finish();
            reject(DEADLINE);
          }, ms);
    timer?.unref?.();
    live.add(end);
    pending.then(
      (value) => {
        finish();
        resolve(value);
      },
      (err) => {
        finish();
        reject(err);
      },
    );
  });
}

function mergeLimits(over?: Partial<SandboxLimits>): SandboxLimits {
  const merged = { ...SANDBOX_LIMITS };
  for (const [key, value] of Object.entries(over ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      (merged as Record<string, number>)[key] = value;
    }
  }
  return merged;
}

/** Copy of the meta so a late callback cannot mutate a result already returned. */
function snapshot(meta: SandboxRunMeta): SandboxRunMeta {
  return { ...meta, logs: [...meta.logs], toolsCalled: [...meta.toolsCalled] };
}

function disposeQuietly(isolate: ivm.Isolate): void {
  try {
    if (!isolate.isDisposed) isolate.dispose();
  } catch {
    /* already gone (memory-limit kill disposes on its own) */
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notAvailable(name: string, names: string[]): string {
  const shown = names.slice(0, MAX_AVAILABLE_NAMES).join(', ');
  const more = names.length > MAX_AVAILABLE_NAMES ? '…' : '';
  return `Tool '${name}' is not available in this sandbox. Available: ${shown}${more}`;
}

/** Pre-serialised object when the executor gave one, else the first text block. */
function toolValue(result: SandboxToolResult): unknown {
  if (result.structured !== undefined) return result.structured;
  const text = result.content?.[0]?.text;
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toolErrorText(result: SandboxToolResult): string {
  const text = result.content?.[0]?.text ?? 'Tool failed.';
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === 'string') message = parsed.error;
  } catch {
    /* plain text error */
  }
  return message.slice(0, MAX_TOOL_ERROR_CHARS);
}
