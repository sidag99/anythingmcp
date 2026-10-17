import { SCRIPT_FILE, WRAPPER_LINE_OFFSET } from './sandbox-runtime';
import type { SandboxError, SandboxErrorCode } from './types';

/** What the agent should try next, by error code. Returned in `error.hint`. */
export const HINTS: Partial<Record<SandboxErrorCode, string>> = {
  TIMEOUT: 'Reduce data fetched or use util.groupBy instead of nested loops.',
  MEMORY_LIMIT: "Filter rows as you fetch; don't hold the whole dataset.",
  OUTPUT_TOO_LARGE:
    'Return aggregates, counts, or the first 20 rows (e.g. rows.slice(0, 20)).',
  TOOL_NOT_ALLOWED: 'Call tools.list() to see which tools this sandbox can use.',
  TOOL_ERROR:
    "Check the arguments with await tools.describe('<tool name>') and retry.",
  CONNECTOR_CALL_LIMIT:
    'Fetch once with a larger limit or a filter and aggregate in the script instead of one call per row.',
  CONNECTOR_BYTES_LIMIT:
    'Narrow the query (date range, status, limit) so less data is pulled in.',
  SYNTAX_ERROR:
    'Fix the syntax and rerun. Top-level await and return are allowed.',
  RUNTIME_ERROR:
    'Check field names with tools.describe(...) or log a sample first: console.log(rows.slice(0, 2)).',
  CODE_TOO_LARGE: 'Shorten the script or split it into saved scripts.',
  WRITE_NOT_ALLOWED:
    'Sandbox scripts are read-only. Use the data tool directly if the user asked for a change.',
  CONNECTOR_TIMEOUT:
    'The connector was too slow. Narrow the query (date range, status, limit) or fetch less per call.',
  CANCELLED: 'The request was cancelled before the script finished.',
  BUSY: 'Too many scripts are running for this organization. Retry in a moment.',
};

/** Codes the bridge raises inside the isolate as `CODE: message`. */
const BRIDGE_ERROR =
  /^(TOOL_NOT_ALLOWED|TOOL_ERROR|CONNECTOR_CALL_LIMIT|CONNECTOR_BYTES_LIMIT|WRITE_NOT_ALLOWED|CONNECTOR_TIMEOUT): ([\s\S]*)$/;

const FRAME = new RegExp(`${SCRIPT_FILE.replace('.', '\\.')}:(\\d+):(\\d+)`);

export function countLines(code: string): number {
  return code.split('\n').length;
}

/** Map a wrapped-script position back to the user's own line/column. */
function toUserPosition(
  line: number,
  column: number,
  lineCount: number,
): { line: number; column: number } | null {
  const userLine = line - WRAPPER_LINE_OFFSET;
  if (userLine < 1 || userLine > lineCount) return null;
  return { line: userLine, column };
}

/**
 * Keep only frames that point into the user's script, rewritten to the user's
 * line numbers. Everything else (host paths, the isolate boundary, the runtime
 * bootstrap) is dropped: none of it is the agent's business.
 */
function userFrames(stack: unknown, lineCount: number): Array<{ line: number; column: number }> {
  if (typeof stack !== 'string') return [];
  const frames: Array<{ line: number; column: number }> = [];
  for (const raw of stack.split('\n')) {
    const m = FRAME.exec(raw);
    if (!m) continue;
    const pos = toUserPosition(Number(m[1]), Number(m[2]), lineCount);
    if (pos) frames.push(pos);
    if (frames.length >= 5) break;
  }
  return frames;
}

/** V8 syntax errors end in `[sandbox.js:LINE:COL]`; strip it and map the position. */
export function parseSyntaxError(
  err: unknown,
  lineCount: number,
): { line: number; column: number; message: string } {
  const text = errorText(err);
  const m = /\s*\[sandbox\.js:(\d+):(\d+)\]\s*$/.exec(text);
  const message = (m ? text.slice(0, m.index) : text).trim() || 'Invalid syntax';
  if (!m) return { line: 1, column: 1, message };
  // An unclosed block/bracket is reported on the wrapper's closing lines: clamp
  // to the last line of the user's code.
  const line = Math.min(Math.max(Number(m[1]) - WRAPPER_LINE_OFFSET, 1), lineCount);
  return { line, column: Number(m[2]), message };
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

interface ClassifyContext {
  timedOut: boolean;
  cancelled?: boolean;
  lineCount: number;
  timeoutMs: number;
  memoryMb: number;
}

/** Turn whatever the isolate (or its kill switch) rejected with into a SandboxError. */
export function toSandboxError(err: unknown, ctx: ClassifyContext): SandboxError {
  const raw = errorText(err);
  const withHint = (code: SandboxErrorCode, message: string, extra: Partial<SandboxError> = {}): SandboxError => ({
    code,
    message,
    hint: HINTS[code],
    ...extra,
  });

  // The heap kill, and the allocation failures V8 reports when a script asks
  // for more buffer or string memory than the isolate may hold.
  if (/due to memory limit|Array buffer allocation failed|Invalid string length/.test(raw)) {
    return withHint('MEMORY_LIMIT', `Script exceeded the ${ctx.memoryMb} MB memory limit.`);
  }
  if (ctx.cancelled) {
    return withHint('CANCELLED', 'The run was cancelled.');
  }
  if (ctx.timedOut || /Script execution timed out/.test(raw)) {
    return withHint('TIMEOUT', `Script did not finish within ${ctx.timeoutMs} ms.`);
  }

  const frames = userFrames((err as { stack?: unknown } | null)?.stack, ctx.lineCount);
  const at = frames[0] ? ` (line ${frames[0].line})` : '';
  const stack = frames.length
    ? frames.map((f) => `at line ${f.line}, column ${f.column}`).join('\n')
    : undefined;

  const bridge = BRIDGE_ERROR.exec(raw);
  if (bridge) {
    return withHint(bridge[1] as SandboxErrorCode, `${bridge[2]}${at}`, { stack });
  }

  const message = /not an instance of `Error`/.test(raw)
    ? 'Script threw a value that is not an Error. Use throw new Error("message").'
    : raw;
  return withHint('RUNTIME_ERROR', `${message}${at}`, { stack });
}
