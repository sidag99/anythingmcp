import { z } from 'zod';
import type { SandboxLimits } from './limits';
import type { SandboxService } from './sandbox.service';
import type {
  SandboxErrorCode,
  SandboxExecuteTool,
  SandboxInvocationContext,
  SandboxRunResult,
  SandboxTool,
} from './types';

/**
 * The fixed isolation and limits suite (spec §9). One list of cases serves two
 * callers: the Jest spec, and the dashboard's "Run isolation suite" button, which
 * runs the same cases against the live service.
 *
 * The suite never touches a connector, a database or a customer's data. It runs
 * the real SandboxService against synthetic tools whose results are generated
 * here, so it is safe to run on any server and shows what the production
 * isolate does, not what a mock does.
 */

export type ExpectedOutcome = 'OK' | SandboxErrorCode;

export interface IsolationCase {
  id: string;
  name: string;
  /** What passing proves, in one sentence (shown on the dashboard). */
  claim: string;
  /** Where the case comes from: a row of spec §9, or an extra attempt added here. */
  specRef: string;
  code: string;
  expected: ExpectedOutcome;
  limits?: Partial<SandboxLimits>;
  /** Extra check on the outcome; returns why it failed, or null. */
  verify?: (result: SandboxRunResult) => string | null;
}

export interface IsolationCaseResult {
  id: string;
  name: string;
  claim: string;
  specRef: string;
  expectedCode: ExpectedOutcome;
  actualCode: ExpectedOutcome;
  passed: boolean;
  ms: number;
  /** Why a case failed, or what a passing one observed. */
  detail?: string;
}

const SUITE_CONNECTOR = 'conn-suite';

const tool = (name: string, description: string, readOnly = true): SandboxTool => ({
  name,
  connectorId: SUITE_CONNECTOR,
  description,
  parameters: { type: 'object', properties: {} },
  readOnly,
});

// Checked the way the MCP endpoint checks a direct call: the tool's own schema.
const ordersListArgs = z.object({ limit: z.number().optional() });

/** The only tools the suite's scripts may see. `other_org_customers_list` is deliberately absent. */
const SUITE_TOOLS: SandboxTool[] = [
  {
    ...tool('erp_orders_list', 'Up to 1000 synthetic orders.'),
    validateArgs: (args) => {
      const parsed = ordersListArgs.safeParse(args);
      return parsed.success
        ? { ok: true, args: parsed.data }
        : { ok: false, message: `Invalid arguments: limit: ${parsed.error.issues[0]?.message}` };
    },
  },
  tool('erp_orders_export', 'About 7 MB of synthetic orders: the "large call" of the brief.'),
  tool('erp_products_list', 'A handful of synthetic products.'),
  tool('erp_whoami', 'Echoes the identity the bridge handed to the executor.'),
  tool('erp_slow', 'Answers after three seconds.'),
  tool('erp_hangs', 'Never answers.'),
  // A tool that changes data. Present on purpose: scripts must be refused it.
  tool('erp_refund_create', 'Refunds an order.', false),
];

const orderRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i,
    status: i % 7 === 0 ? 'delayed' : 'ok',
    amount: (i * 37) % 1000,
    note: 'synthetic order for the isolation suite',
  }));

let exportRows: ReturnType<typeof orderRows> | undefined;

/** A fake connector executor: deterministic data, and it reports the identity it was given. */
const executeTool: SandboxExecuteTool = async (name, args, context) => {
  const ok = (structured: unknown) => ({ content: [{ type: 'text', text: '' }], structured });
  switch (name) {
    case 'erp_orders_list':
      return ok(orderRows(Math.min(Number(args.limit) || 1000, 1000)));
    case 'erp_orders_export':
      return ok((exportRows ??= orderRows(60_000)));
    case 'erp_products_list':
      return ok([{ id: 1, sku: 'P-1' }]);
    case 'erp_slow':
      // unref: an abandoned call must not keep the process alive.
      return new Promise((resolve) => setTimeout(() => resolve(ok([])), 3_000).unref());
    case 'erp_hangs':
      return new Promise(() => undefined);
    case 'erp_refund_create':
      // Reaching this would be a failure of the read-only policy.
      return ok({ refunded: true });
    case 'erp_whoami':
      return ok({
        organizationId: context.organizationId,
        connectorIds: context.connectorIds,
        argsSeen: args,
      });
    default:
      return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  }
};

const TIMEOUT_MS = 1_000;

export const ISOLATION_CASES: IsolationCase[] = [
  {
    id: 'control',
    name: 'Control: aggregate next to the data',
    claim: 'A script can pull 1,000 rows and return only the answer; the rows never leave the service.',
    specRef: '§9 #0',
    code: 'const r = await tools.erp_orders_list({ limit: 1000 }); return { n: r.length };',
    expected: 'OK',
    verify: (r) =>
      (r.result as { n?: number })?.n === 1000 &&
      r.meta.bytesReturned < 100 &&
      r.meta.bytesFromConnectors > 10_000
        ? null
        : `unexpected result ${JSON.stringify(r.result)} / ${r.meta.bytesReturned} B returned`,
  },
  {
    id: 'host-modules',
    name: 'No host modules',
    claim: '`require` and `process` do not exist in the isolate, so there is no way to reach the host.',
    specRef: '§9 #1',
    code: "return typeof require + '/' + typeof process + '/' + typeof globalThis.process;",
    expected: 'OK',
    verify: (r) => (r.result === 'undefined/undefined/undefined' ? null : `got ${JSON.stringify(r.result)}`),
  },
  {
    id: 'network',
    name: 'No network',
    claim: '`fetch`, `XMLHttpRequest` and `WebSocket` do not exist, so a script cannot reach the internet.',
    specRef: '§9 #2',
    code: "return typeof fetch + '/' + typeof XMLHttpRequest + '/' + typeof WebSocket;",
    expected: 'OK',
    verify: (r) => (r.result === 'undefined/undefined/undefined' ? null : `got ${JSON.stringify(r.result)}`),
  },
  {
    id: 'secrets',
    name: 'No secrets on the global object',
    claim: 'The global object holds only the script API: no environment, credentials or bridge handles.',
    specRef: '§9 #3',
    code: 'return Object.getOwnPropertyNames(globalThis);',
    expected: 'OK',
    verify: (r) => {
      if (!Array.isArray(r.result)) return `got ${JSON.stringify(r.result)}`;
      // `__finish` is the runtime's own result serializer: it lives inside the
      // isolate, is not writable or configurable, and holds no host reference.
      const bad = (r.result as string[]).filter((n) => n !== '__finish').filter((n) =>
        /^(__|process|env|require|module|fetch|XML|WebSocket|Buffer|DATABASE|ivm|isolated)/i.test(n),
      );
      return bad.length === 0 ? null : `unexpected globals: ${bad.join(', ')}`;
    },
  },
  {
    id: 'constructor-chain',
    name: 'Constructor-chain escape finds nothing',
    claim: '`eval` and `Function` give access to the same empty world: `process` and `require` are not there either.',
    specRef: 'extra',
    code:
      "const g = (0, eval)('this');\n" +
      "const viaFunction = (() => {}).constructor('return typeof process + \",\" + typeof require')();\n" +
      "return [typeof g.process, typeof g.require, viaFunction].join('/');",
    expected: 'OK',
    verify: (r) =>
      r.result === 'undefined/undefined/undefined,undefined' ? null : `got ${JSON.stringify(r.result)}`,
  },
  {
    id: 'no-imports-or-timers',
    name: 'No module loader, Buffer or timers',
    claim: 'There is no `import`, `Buffer`, timer or microtask API to build a side channel from.',
    specRef: 'extra',
    code:
      "let dyn;\ntry { await import('fs'); dyn = 'imported'; } catch (e) { dyn = 'blocked'; }\n" +
      'return [dyn, typeof Buffer, typeof setTimeout, typeof setInterval, typeof queueMicrotask].join("/");',
    expected: 'OK',
    verify: (r) =>
      r.result === 'blocked/undefined/undefined/undefined/undefined' ? null : `got ${JSON.stringify(r.result)}`,
  },
  {
    id: 'infinite-loop',
    name: 'Infinite loop is killed',
    claim: 'A script that never ends is stopped at the wall-clock limit.',
    specRef: '§9 #4',
    code: 'while (true) {}',
    expected: 'TIMEOUT',
    limits: { timeoutMs: TIMEOUT_MS },
    verify: (r) => (r.meta.ms <= TIMEOUT_MS + 500 ? null : `took ${r.meta.ms} ms for a ${TIMEOUT_MS} ms limit`),
  },
  {
    id: 'loop-after-await',
    name: 'Loop after a connector call is killed',
    claim: 'The wall clock also covers code that runs after an await, where V8’s own timeout does not.',
    specRef: 'extra',
    code: 'await tools.erp_products_list({}); while (true) {}',
    expected: 'TIMEOUT',
    limits: { timeoutMs: TIMEOUT_MS },
    verify: (r) => (r.meta.ms <= TIMEOUT_MS + 500 ? null : `took ${r.meta.ms} ms for a ${TIMEOUT_MS} ms limit`),
  },
  {
    id: 'memory-bomb',
    name: 'Memory bomb is killed',
    claim: 'A script that allocates without end is stopped at the heap limit.',
    specRef: '§9 #5',
    code: 'const a = []; while (true) a.push(new Array(1e6).fill(1));',
    expected: 'MEMORY_LIMIT',
    limits: { memoryMb: 32, timeoutMs: 5_000 },
  },
  {
    id: 'buffer-bomb',
    name: 'Typed-array bomb is refused',
    claim: 'Buffers and typed arrays count against the same limit, so they cannot be used to exhaust the host.',
    specRef: 'extra',
    code: 'const a = new Uint8Array(1 << 30); a.fill(1); return a.length;',
    expected: 'MEMORY_LIMIT',
    limits: { memoryMb: 32, timeoutMs: 5_000 },
  },
  {
    id: 'oversize-return',
    name: 'Oversize result never leaves the service',
    claim: 'A script that tries to return ~7 MB gets an error instead; none of the payload reaches the caller.',
    specRef: '§9 #6',
    code: 'return await tools.erp_orders_export({});',
    expected: 'OUTPUT_TOO_LARGE',
    verify: (r) =>
      r.meta.bytesReturned === 0 && r.meta.bytesFromConnectors > 5_000_000
        ? null
        : `bytesReturned=${r.meta.bytesReturned}, bytesFromConnectors=${r.meta.bytesFromConnectors}`,
  },
  {
    id: 'cross-tenant-tool',
    name: 'Another tenant’s tool is not callable',
    claim: 'A tool outside the caller’s visible set is refused, however the script names it.',
    specRef: '§9 #7',
    code: 'return await tools.other_org_customers_list({});',
    expected: 'TOOL_NOT_ALLOWED',
    verify: (r) =>
      /not available in this sandbox/.test(r.error?.message ?? '') ? null : `message: ${r.error?.message}`,
  },
  {
    id: 'cross-tenant-args',
    name: 'Tenant comes from the session, not from arguments',
    claim: 'Passing another organization’s id (or connector ids) as arguments changes nothing: the bridge uses the session’s identity.',
    specRef: '§9 #8',
    code: "return await tools.erp_whoami({ organizationId: 'org-someone-else', connectorIds: ['conn-someone-else'] });",
    expected: 'OK',
    verify: (r) => {
      const seen = r.result as { organizationId?: string; connectorIds?: string[] };
      return seen?.organizationId !== 'org-someone-else' &&
        JSON.stringify(seen?.connectorIds) === JSON.stringify([SUITE_CONNECTOR])
        ? null
        : `executor saw ${JSON.stringify(seen)}`;
    },
  },
  {
    id: 'write-refused',
    name: 'Write tools are refused by default',
    claim: 'A tool that changes data is refused before it runs; sandbox scripts are read-only unless the operator allows writes.',
    specRef: 'extra',
    code: 'return await tools.erp_refund_create({ orderId: 1 });',
    expected: 'WRITE_NOT_ALLOWED',
    verify: (r) =>
      r.meta.connectorCalls === 0 && r.meta.toolsCalled.length === 0
        ? null
        : `the write tool was reached: ${JSON.stringify(r.meta.toolsCalled)}`,
  },
  {
    id: 'writes-not-listed',
    name: 'Write tools are not offered',
    claim: 'The tool list a script sees leaves out everything that could change data.',
    specRef: 'extra',
    code: 'return tools.list();',
    expected: 'OK',
    verify: (r) => {
      const list = r.result as string[];
      return Array.isArray(list) && !list.includes('erp_refund_create') && list.includes('erp_orders_list')
        ? null
        : `listed: ${JSON.stringify(list)}`;
    },
  },
  {
    id: 'argument-validation',
    name: 'Arguments are validated on the host',
    claim: 'A script’s arguments are checked against the tool’s schema before the tool runs, like a direct call.',
    specRef: 'extra',
    code: 'return await tools.erp_orders_list({ limit: { $gt: 0 } });',
    expected: 'TOOL_ERROR',
    verify: (r) =>
      r.meta.connectorCalls === 0 && /limit/.test(r.error?.message ?? '')
        ? null
        : `calls=${r.meta.connectorCalls}, message: ${r.error?.message}`,
  },
  {
    id: 'slow-connector-times-out',
    name: 'A slow connector call times out',
    claim: 'One slow connector call is abandoned at its own deadline; the script can carry on or fail cleanly.',
    specRef: 'extra',
    code: 'return await tools.erp_slow({});',
    expected: 'CONNECTOR_TIMEOUT',
    limits: { connectorTimeoutMs: 300, timeoutMs: 5_000 },
    verify: (r) => (r.meta.ms < 1_500 ? null : `took ${r.meta.ms} ms for a 300 ms call deadline`),
  },
  {
    id: 'waiting-on-connector',
    name: 'A connector that never answers cannot keep the run alive',
    claim: 'The whole-run deadline covers time spent waiting on a connector.',
    specRef: 'extra',
    code: 'return await tools.erp_hangs({});',
    expected: 'TIMEOUT',
    limits: { connectorTimeoutMs: 60_000, timeoutMs: TIMEOUT_MS },
    verify: (r) => (r.meta.ms <= TIMEOUT_MS + 500 ? null : `took ${r.meta.ms} ms for a ${TIMEOUT_MS} ms limit`),
  },
  {
    id: 'call-limit',
    name: 'Connector call limit',
    claim: 'A script cannot hammer a connector: calls per run are capped.',
    specRef: '§9 #9',
    code: 'for (let i = 0; i < 60; i++) await tools.erp_products_list({}); return "done";',
    expected: 'CONNECTOR_CALL_LIMIT',
    limits: { maxConnectorCalls: 50 },
  },
  {
    id: 'syntax-error',
    name: 'Syntax error reports a line',
    claim: 'Bad code is rejected before it runs, with a line number the agent can fix.',
    specRef: '§9 #10',
    code: 'return {',
    expected: 'SYNTAX_ERROR',
    verify: (r) => (r.error?.line === 1 ? null : `line was ${r.error?.line}`),
  },
];

/**
 * Runs every case, one after another, and reports each outcome. The cases run as
 * the given organization so they count against its concurrency limit like any run.
 */
export async function runIsolationSuite(
  sandbox: Pick<SandboxService, 'run'>,
  opts: { organizationId: string },
): Promise<IsolationCaseResult[]> {
  const invocationContext: SandboxInvocationContext = {
    organizationId: opts.organizationId,
    authMethod: 'isolation-suite',
    mcpServerId: 'isolation-suite',
    mcpServerName: 'Isolation suite',
    connectorIds: [SUITE_CONNECTOR],
  };

  const results: IsolationCaseResult[] = [];
  for (const c of ISOLATION_CASES) {
    const started = Date.now();
    const result = await sandbox.run({
      code: c.code,
      allowedTools: SUITE_TOOLS,
      invocationContext,
      executeTool,
      // The default policy, stated outright: the suite shows what a normal run gets.
      allowWrites: false,
      limits: c.limits,
    });
    const ms = Date.now() - started;
    const actualCode: ExpectedOutcome = result.ok ? 'OK' : (result.error?.code ?? 'RUNTIME_ERROR');

    let passed = actualCode === c.expected;
    let detail: string | undefined;
    if (!passed) {
      detail = result.ok
        ? `expected ${c.expected} but the script succeeded with ${JSON.stringify(result.result)?.slice(0, 120)}`
        : `expected ${c.expected} but got ${actualCode}: ${result.error?.message.slice(0, 120)}`;
    } else if (c.verify) {
      // A sandbox that misbehaves can hand back anything; a check that throws
      // must read as a failed case, not take the whole run down.
      let why: string | null;
      try {
        why = c.verify(result);
      } catch (err) {
        why = `could not check the outcome: ${(err as Error).message}`;
      }
      if (why) {
        passed = false;
        detail = why;
      }
    }
    results.push({
      id: c.id,
      name: c.name,
      claim: c.claim,
      specRef: c.specRef,
      expectedCode: c.expected,
      actualCode,
      passed,
      ms,
      ...(detail && { detail }),
    });
  }
  return results;
}
