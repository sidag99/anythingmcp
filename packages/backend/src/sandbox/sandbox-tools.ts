import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { SANDBOX_LIMITS, SANDBOX_TIMEOUT_RANGE_MS, areSandboxWritesAllowed } from './limits';
import { SandboxScriptsService } from './sandbox-scripts.service';
import {
  SCRIPT_CODE_MAX_CHARS,
  SCRIPT_DESCRIPTION_MAX_CHARS,
  SCRIPT_NAME_MESSAGE,
  SCRIPT_NAME_PATTERN,
} from './sandbox-scripts.dto';
import { SandboxService } from './sandbox.service';
import { buildToolsSignature } from './tool-signature.util';
import type {
  SandboxExecuteTool,
  SandboxInvocationContext,
  SandboxMcpToolEntry,
  SandboxSyntaxCheck,
  SandboxTool,
} from './types';

const logger = new Logger('SandboxTools');

export const SANDBOX_RUN_TOOL = 'sandbox_run_script';
export const SANDBOX_TOOL_NAMES = [
  SANDBOX_RUN_TOOL,
  'sandbox_create_script',
  'sandbox_edit_script',
  'sandbox_list_scripts',
] as const;

export interface SandboxToolDeps {
  sandbox: SandboxService;
  scripts: SandboxScriptsService;
  /** DynamicMcpTools.executeTool, bound by the caller. */
  executeTool: SandboxExecuteTool;
}

/** The part of the SDK's handler context the run tool uses: the request's abort signal. */
interface HandlerContext {
  mcpReq?: { signal?: AbortSignal };
}

export interface SandboxToolScope {
  /**
   * Looks the caller's visible tools up again. Called at the start of every run,
   * so a role changed since the session was planned (a stateful session keeps its
   * plan) takes effect on the next run. Failing closed: if it throws, nothing runs.
   */
  reauthorize?: () => Promise<SandboxTool[]>;
  /**
   * Organization that owns the MCP server. Scripts and runs are stored under
   * it; it can differ from invocationContext.organizationId (the caller's
   * active org) when a multi-org member uses another workspace's server.
   */
  storageOrganizationId: string;
  invocationContext: SandboxInvocationContext;
}

function runDescription(signature: string): string {
  const outKb = Math.round(SANDBOX_LIMITS.maxOutputBytes / 1024);
  return (
    'Run a short JavaScript snippet inside AnythingMCP, next to the data. Use this instead of calling ' +
    'data tools directly whenever a tool would return a large list and you only need a count, a sum, ' +
    'a filtered subset, a join or a summary. Your code runs in an isolated sandbox with no network, ' +
    'filesystem or secrets; it can only call the tools listed below via `await tools.<name>(args)`. ' +
    `Top-level \`await\` and \`return\` are allowed; \`return\` a small JSON value (under ${outKb} KB). ` +
    'Fetch, filter and aggregate in the script; never `return` raw rows unless the user asked for them ' +
    '(then `rows.slice(0, 20)`). If a field name is unknown, first run a script that returns ' +
    "`(await tools.x({})).slice(0, 3)` or call `await tools.describe('x')`. Errors come back with a " +
    '`code` and a `hint`; fix and rerun. Pass `scriptName` to run a saved script instead of `code`.\n\n' +
    signature
  );
}

const textResult = (text: string, isError = false) => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
});

const jsonResult = (payload: Record<string, unknown>, opts: { isError?: boolean; structured?: boolean } = {}) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  ...(opts.structured ? { structuredContent: payload } : {}),
  ...(opts.isError ? { isError: true } : {}),
});

const formatSyntax = (check: SandboxSyntaxCheck) =>
  check.ok ? 'ok' : { line: check.line, column: check.column, message: check.message };

/** Message for a failed script write; never leaks internals for unexpected errors. */
function writeFailure(err: unknown, scriptName: string) {
  if (err instanceof ConflictException) {
    return textResult(`Script '${scriptName}' exists; use sandbox_edit_script`, true);
  }
  if (
    err instanceof NotFoundException ||
    err instanceof BadRequestException ||
    err instanceof ForbiddenException
  ) {
    return textResult(err.message, true);
  }
  logger.warn(`Sandbox script write failed: ${(err as Error)?.message ?? err}`);
  return textResult('Could not save the script. Try again.', true);
}

/**
 * The four MCP tools of code mode, scoped to one authenticated MCP session:
 * the tools a script may call are exactly `allowedTools` (already filtered by
 * role), and every call carries the session's own invocation context.
 */
export function buildSandboxToolEntries(
  deps: SandboxToolDeps,
  scope: SandboxToolScope,
  allowedTools: SandboxTool[],
): SandboxMcpToolEntry[] {
  const { sandbox, scripts, executeTool } = deps;
  const { storageOrganizationId: orgId, invocationContext } = scope;
  const serverId = invocationContext.mcpServerId;
  const userId = invocationContext.userId;

  // Write tools are not offered unless the trusted policy allows them, so the
  // model is not shown a tool that every call would be refused.
  const signature = buildToolsSignature(
    allowedTools.filter((t) => t.readOnly || areSandboxWritesAllowed()),
  );
  const description = runDescription(signature);
  const sig = `sandbox:v1:${createHash('sha1').update(description).digest('hex').slice(0, 16)}`;

  const run = async (
    input: {
      code?: string;
      scriptName?: string;
      args?: Record<string, unknown>;
      timeoutMs?: number;
    },
    handlerContext?: HandlerContext,
  ) => {
    const hasCode = typeof input.code === 'string' && input.code.length > 0;
    const hasName = typeof input.scriptName === 'string' && input.scriptName.length > 0;
    if (hasCode === hasName) {
      return textResult('Provide exactly one of "code" or "scriptName".', true);
    }

    let code = input.code as string;
    let scriptId: string | undefined;
    // Which saved script ran, shown to the caller: it runs with THEIR authority
    // but may have been written by someone else.
    let scriptInfo: { name: string; version: number; ownedByYou: boolean } | undefined;
    if (hasName) {
      const saved = await scripts.getByName(orgId, serverId, input.scriptName as string);
      if (!saved) {
        return textResult(
          `Script '${input.scriptName}' not found. Call sandbox_list_scripts to see the saved scripts.`,
          true,
        );
      }
      code = saved.code;
      scriptId = saved.id;
      scriptInfo = {
        name: saved.name,
        version: saved.version,
        ownedByYou: (saved.createdById ?? null) === (userId ?? null),
      };
    }

    // Authorization is decided now, not when the session was planned.
    let tools = allowedTools;
    if (scope.reauthorize) {
      try {
        tools = await scope.reauthorize();
      } catch (err) {
        logger.warn(`Could not re-check access for a sandbox run: ${(err as Error)?.message ?? err}`);
        return textResult('Could not verify your access to the tools. Try again.', true);
      }
    }

    // One id for the run: its row in sandbox_runs, and the mark on the audit row
    // of every connector call it makes.
    const runId = randomUUID();
    const result = await sandbox.run({
      code,
      args: input.args,
      allowedTools: tools,
      allowWrites: areSandboxWritesAllowed(),
      signal: handlerContext?.mcpReq?.signal,
      invocationContext: { ...invocationContext, sandboxRunId: runId },
      executeTool,
      limits: input.timeoutMs ? { timeoutMs: input.timeoutMs } : undefined,
    });
    await scripts.recordRun({
      id: runId,
      organizationId: orgId,
      mcpServerId: serverId,
      scriptId,
      userId,
      code,
      args: input.args,
      result,
    });

    if (result.ok) {
      return jsonResult(
        { ok: true, runId, result: result.result, meta: result.meta, ...(scriptInfo && { script: scriptInfo }) },
        { structured: true },
      );
    }
    const { code: errorCode, message, hint, line, column } = result.error!;
    return jsonResult(
      {
        ok: false,
        runId,
        error: { code: errorCode, message, hint, line, column },
        meta: result.meta,
        ...(scriptInfo && { script: scriptInfo }),
      },
      { structured: true, isError: true },
    );
  };

  const create = async (input: { name: string; code: string; description?: string }) => {
    try {
      const script = await scripts.create(orgId, serverId, userId, input);
      const syntax = await sandbox.checkSyntax(input.code);
      return jsonResult({
        ok: true,
        scriptId: script.id,
        name: script.name,
        version: script.version,
        syntax: formatSyntax(syntax),
      });
    } catch (err) {
      return writeFailure(err, input.name);
    }
  };

  const edit = async (input: { name: string; code?: string; description?: string }) => {
    if (input.code === undefined && input.description === undefined) {
      return textResult('Provide "code" and/or "description" to change.', true);
    }
    try {
      const script = await scripts.updateByName(
        orgId,
        serverId,
        input.name,
        { code: input.code, description: input.description },
        userId,
      );
      const syntax = await sandbox.checkSyntax(script.code);
      return jsonResult({
        ok: true,
        name: script.name,
        version: script.version,
        syntax: formatSyntax(syntax),
      });
    } catch (err) {
      return writeFailure(err, input.name);
    }
  };

  const list = async () => {
    const rows = await scripts.list(orgId, serverId);
    return jsonResult({
      scripts: rows.map((s) => {
        const meta = (s.lastRunMeta ?? {}) as { ms?: number; bytesReturned?: number };
        return {
          name: s.name,
          description: s.description,
          version: s.version,
          ownedByYou: (s.createdById ?? null) === (userId ?? null),
          lastRunAt: s.lastRunAt,
          lastRunOk: s.lastRunOk,
          lastRunMeta: s.lastRunMeta ? { ms: meta.ms, bytesReturned: meta.bytesReturned } : null,
        };
      }),
    });
  };

  const codeField = z
    .string()
    .min(1)
    .max(SCRIPT_CODE_MAX_CHARS)
    .describe('JavaScript body. Top-level await and return are allowed.');
  const descriptionField = z.string().max(SCRIPT_DESCRIPTION_MAX_CHARS);

  const entry = (
    name: string,
    build: (mcpServer: Parameters<SandboxMcpToolEntry['register']>[0]) => unknown,
  ): SandboxMcpToolEntry => ({
    name,
    sig,
    register: (mcpServer) => build(mcpServer) as { remove: () => void },
  });

  return [
    entry(SANDBOX_RUN_TOOL, (mcpServer) =>
      mcpServer.registerTool(
        SANDBOX_RUN_TOOL,
        {
          description,
          inputSchema: {
            code: z
              .string()
              .max(SCRIPT_CODE_MAX_CHARS)
              .optional()
              .describe('JavaScript to run. Provide this or scriptName.'),
            scriptName: z.string().optional().describe('Name of a saved script to run instead of code.'),
            args: z
              .record(z.string(), z.unknown())
              .optional()
              .describe('Available inside the script as `args`.'),
            timeoutMs: z
              .number()
              .int()
              .min(SANDBOX_TIMEOUT_RANGE_MS.min)
              .max(SANDBOX_TIMEOUT_RANGE_MS.max)
              .optional()
              .describe(`Wall-clock limit in milliseconds (default ${SANDBOX_LIMITS.timeoutMs}).`),
          },
          // Loose, like the connector tools: a raw shape would reject extra keys.
          outputSchema: z.looseObject({
            ok: z.boolean(),
            result: z.any().optional(),
            error: z.any().optional(),
            meta: z.any(),
          }),
          // Read-only while writes are off (the default): a script can then only
          // read through the connectors. It reaches their external systems.
          annotations: {
            title: 'Run script in sandbox',
            readOnlyHint: !areSandboxWritesAllowed(),
            destructiveHint: false,
            openWorldHint: true,
          },
        },
        run,
      ),
    ),
    entry('sandbox_create_script', (mcpServer) =>
      mcpServer.registerTool(
        'sandbox_create_script',
        {
          description:
            'Save a reusable script for this MCP server so it can be rerun by name with ' +
            'sandbox_run_script { scriptName }. The code is syntax-checked but not executed.',
          inputSchema: {
            name: z.string().regex(SCRIPT_NAME_PATTERN, SCRIPT_NAME_MESSAGE),
            code: codeField,
            description: descriptionField.optional(),
          },
          annotations: {
            title: 'Save sandbox script',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        create,
      ),
    ),
    entry('sandbox_edit_script', (mcpServer) =>
      mcpServer.registerTool(
        'sandbox_edit_script',
        {
          description:
            "Change a saved script's code and/or description. Only the script's author can edit it " +
            '(`ownedByYou` in sandbox_list_scripts); to change someone else\'s script, save your own ' +
            'copy under a new name. The version increases when the code changes. The code is ' +
            'syntax-checked but not executed.',
          inputSchema: {
            name: z.string(),
            code: codeField.optional(),
            description: descriptionField.optional(),
          },
          annotations: {
            title: 'Edit sandbox script',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        edit,
      ),
    ),
    entry('sandbox_list_scripts', (mcpServer) =>
      mcpServer.registerTool(
        'sandbox_list_scripts',
        {
          description:
            'List the saved scripts of this MCP server with their version and last run (duration, bytes returned).',
          inputSchema: {},
          annotations: { title: 'List sandbox scripts', readOnlyHint: true, openWorldHint: false },
        },
        list,
      ),
    ),
  ];
}
