import { Logger } from '@nestjs/common';
import { SandboxService } from './sandbox.service';
import { SANDBOX_LIMITS } from './limits';
import type {
  SandboxExecuteTool,
  SandboxInvocationContext,
  SandboxRunRequest,
  SandboxTool,
} from './types';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

const baseContext: SandboxInvocationContext = {
  userId: 'user-1',
  organizationId: ORG_A,
  authMethod: 'api-key',
  mcpServerId: 'server-1',
  mcpServerName: 'koch-demo',
  connectorIds: ['conn-1', 'conn-2'],
};

function tool(name: string, connectorId = 'conn-1', readOnly = true): SandboxTool {
  return {
    name,
    connectorId,
    description: `${name} description`,
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    outputSchema: { type: 'array' },
    readOnly,
  };
}

const TOOLS = [
  tool('erp_orders_list'),
  tool('erp_orders_export'),
  tool('erp_products_list'),
  tool('erp_customers_list'),
  tool('erp_broken'),
];

const orders = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i,
    status: i % 7 === 0 ? 'delayed' : 'ok',
    amount: (i * 37) % 1000,
  }));

const CUSTOMERS_BY_ORG: Record<string, unknown[]> = {
  [ORG_A]: [{ id: 'a1', name: 'Alpha GmbH' }],
  [ORG_B]: [{ id: 'b1', name: 'Bravo AG' }],
};

/** Fake of DynamicMcpTools.executeTool: tenant data is chosen by context, not args. */
function makeExecuteTool(delayMs = 0) {
  const calls: Array<{
    name: string;
    args: Record<string, unknown>;
    ctx: SandboxInvocationContext;
  }> = [];
  const fn: SandboxExecuteTool = async (name, args, ctx) => {
    calls.push({ name, args, ctx });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const ok = (value: unknown) => ({
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structured: value,
    });
    switch (name) {
      case 'erp_orders_list':
        return ok(orders(1000));
      case 'erp_orders_export':
        return ok(orders(60_000));
      case 'erp_products_list':
        return ok([{ sku: 'p1' }, { sku: 'p2' }]);
      case 'erp_customers_list':
        return ok(CUSTOMERS_BY_ORG[ctx.organizationId ?? ''] ?? []);
      case 'erp_broken':
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'upstream 503' }) }],
          isError: true,
        };
      default:
        throw new Error(`unexpected tool ${name}`);
    }
  };
  return { fn, calls };
}

describe('SandboxService', () => {
  let service: SandboxService;

  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug']));

  beforeEach(() => {
    service = new SandboxService();
  });

  function run(code: string, over: Partial<SandboxRunRequest> = {}, exec = makeExecuteTool()) {
    return service.run({
      code,
      allowedTools: TOOLS,
      invocationContext: baseContext,
      executeTool: exec.fn,
      ...over,
    });
  }

  describe('control', () => {
    it('aggregates connector data in the sandbox and returns only the small answer', async () => {
      const res = await run(
        `const r = await tools.erp_orders_list({ limit: 1000 });
         return { n: r.length, delayed: r.filter(o => o.status === 'delayed').length };`,
      );
      expect(res.ok).toBe(true);
      expect(res.result).toEqual({ n: 1000, delayed: 143 });
      expect(res.meta.bytesReturned).toBeLessThan(100);
      expect(res.meta.bytesFromConnectors).toBeGreaterThan(20_000);
      expect(res.meta.connectorCalls).toBe(1);
      expect(res.meta.toolsCalled).toEqual(['erp_orders_list']);
    });

    it('passes args into the script', async () => {
      const res = await run(`return args.month * 2`, { args: { month: 4 } });
      expect(res).toMatchObject({ ok: true, result: 8 });
    });

    it('returns null for a script that returns nothing', async () => {
      const res = await run(`const x = 1;`);
      expect(res).toMatchObject({ ok: true, result: null });
    });
  });

  describe('isolation: absent, not blocked', () => {
    it('has no host modules', async () => {
      const res = await run(
        `return typeof require + '/' + typeof process + '/' + typeof globalThis.process`,
      );
      expect(res).toMatchObject({ ok: true, result: 'undefined/undefined/undefined' });
    });

    it('has no network', async () => {
      const res = await run(
        `return typeof fetch + '/' + typeof XMLHttpRequest + '/' + typeof WebSocket`,
      );
      expect(res).toMatchObject({ ok: true, result: 'undefined/undefined/undefined' });
    });

    it('has no timers, WebAssembly or module loader', async () => {
      const res = await run(
        `return [typeof setTimeout, typeof setInterval, typeof WebAssembly, typeof importScripts, typeof Buffer].join('/')`,
      );
      expect(res).toMatchObject({
        ok: true,
        result: 'undefined/undefined/undefined/undefined/undefined',
      });
    });

    it('exposes no secrets or bridge internals on the global object', async () => {
      const res = await run(
        `return { keys: Object.keys(globalThis), all: Object.getOwnPropertyNames(globalThis) }`,
      );
      expect(res.ok).toBe(true);
      const { keys, all } = res.result as { keys: string[]; all: string[] };
      expect(keys.sort()).toEqual(['args', 'tools', 'util']);
      for (const forbidden of ['env', 'DATABASE_URL', 'process', 'require', '__call', '__describe', '__log']) {
        expect(all).not.toContain(forbidden);
      }
    });

    it('cannot reach bridge references by name', async () => {
      const res = await run(
        `return typeof __call + '/' + typeof __describe + '/' + typeof __log`,
      );
      expect(res).toMatchObject({ ok: true, result: 'undefined/undefined/undefined' });
    });
  });

  describe('limits', () => {
    it('kills an infinite loop within the timeout', async () => {
      const t0 = Date.now();
      const res = await run(`while (true) {}`, { limits: { timeoutMs: 500 } });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('TIMEOUT');
      expect(res.error?.hint).toBeTruthy();
      expect(Date.now() - t0).toBeLessThan(700);
    });

    it('also kills a busy loop that starts after awaiting a connector (wall clock)', async () => {
      const t0 = Date.now();
      const res = await run(
        `await tools.erp_products_list({}); while (true) {}`,
        { limits: { timeoutMs: 600 } },
      );
      expect(res.error?.code).toBe('TIMEOUT');
      expect(Date.now() - t0).toBeLessThan(1_200);
    });

    it('times out a script that waits on a connector longer than the limit', async () => {
      const res = await run(
        `return await tools.erp_products_list({})`,
        { limits: { timeoutMs: 300 } },
        makeExecuteTool(2_000),
      );
      expect(res.error?.code).toBe('TIMEOUT');
    });

    it('stops a memory bomb', async () => {
      const res = await run(
        `const a = []; while (true) a.push(new Array(1e6).fill(1))`,
        { limits: { memoryMb: 32, timeoutMs: 5_000 } },
      );
      expect(res.error?.code).toBe('MEMORY_LIMIT');
      expect(res.error?.hint).toBeTruthy();
    });

    it('refuses an oversize result and never returns the payload', async () => {
      const res = await run(`return await tools.erp_orders_export({})`);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('OUTPUT_TOO_LARGE');
      expect(res.error?.message).toMatch(/limit is 32768/);
      expect(res.meta.bytesReturned).toBe(0);
      expect(res.meta.bytesFromConnectors).toBeGreaterThan(1_000_000);
      expect(res.result).toBeUndefined();
      expect(JSON.stringify(res).length).toBeLessThan(5_000);
    });

    it('counts output in bytes, not characters', async () => {
      const res = await run(`return '€'.repeat(5000)`, { limits: { maxOutputBytes: 12_000 } });
      expect(res.error?.code).toBe('OUTPUT_TOO_LARGE');
    });

    it('enforces the connector call limit', async () => {
      const exec = makeExecuteTool();
      const res = await run(
        `for (let i = 0; i < 60; i++) await tools.erp_products_list({});`,
        {},
        exec,
      );
      expect(res.error?.code).toBe('CONNECTOR_CALL_LIMIT');
      expect(res.meta.connectorCalls).toBe(SANDBOX_LIMITS.maxConnectorCalls);
      expect(exec.calls).toHaveLength(SANDBOX_LIMITS.maxConnectorCalls);
    });

    it('enforces the connector call limit across parallel calls', async () => {
      const exec = makeExecuteTool();
      const res = await run(
        `await Promise.all(Array.from({ length: 10 }, () => tools.erp_products_list({})))`,
        { limits: { maxConnectorCalls: 3 } },
        exec,
      );
      expect(res.error?.code).toBe('CONNECTOR_CALL_LIMIT');
      expect(exec.calls).toHaveLength(3);
    });

    it('enforces the connector byte limit', async () => {
      const res = await run(`return (await tools.erp_orders_list({})).length`, {
        limits: { maxConnectorBytes: 1_000 },
      });
      expect(res.error?.code).toBe('CONNECTOR_BYTES_LIMIT');
    });

    it('rejects oversize code before running it', async () => {
      const exec = makeExecuteTool();
      const res = await run(`return 1; //${'x'.repeat(SANDBOX_LIMITS.maxCodeBytes)}`, {}, exec);
      expect(res.error?.code).toBe('CODE_TOO_LARGE');
      expect(exec.calls).toHaveLength(0);
    });

    it('fails fast with BUSY beyond the per-organization concurrency', async () => {
      const slow = makeExecuteTool(300);
      const first = run(`return await tools.erp_products_list({})`, { limits: { maxConcurrent: 1 } }, slow);
      const second = await run(`return 1`, { limits: { maxConcurrent: 1 } }, slow);
      expect(second.error?.code).toBe('BUSY');
      expect((await first).ok).toBe(true);
      // slot is released afterwards
      expect((await run(`return 1`, { limits: { maxConcurrent: 1 } })).ok).toBe(true);
    });

    it('does not let one organization starve another', async () => {
      const slow = makeExecuteTool(300);
      const first = run(`return await tools.erp_products_list({})`, { limits: { maxConcurrent: 1 } }, slow);
      const other = await run(`return 1`, {
        limits: { maxConcurrent: 1 },
        invocationContext: { ...baseContext, organizationId: ORG_B },
      });
      expect(other.ok).toBe(true);
      await first;
    });
  });

  describe('tenant scoping', () => {
    it('refuses a tool that is not in the allowed set', async () => {
      const exec = makeExecuteTool();
      const res = await run(`return await tools.other_org_customers_list({})`, {}, exec);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('TOOL_NOT_ALLOWED');
      expect(res.error?.message).toContain('other_org_customers_list');
      expect(res.error?.message).toContain('erp_orders_list');
      expect(exec.calls).toHaveLength(0);
    });

    it('takes the tenant from the session context, never from script arguments', async () => {
      const exec = makeExecuteTool();
      const plain = await run(`return await tools.erp_customers_list({})`, {}, exec);
      const spoofed = await run(
        `return await tools.erp_customers_list({ organizationId: '${ORG_B}', connectorIds: ['conn-x'] })`,
        {},
        exec,
      );
      expect(plain.result).toEqual([{ id: 'a1', name: 'Alpha GmbH' }]);
      expect(spoofed.result).toEqual(plain.result);
      for (const c of exec.calls) {
        expect(c.ctx.organizationId).toBe(ORG_A);
        expect(c.ctx.userId).toBe('user-1');
        expect(c.ctx.connectorIds).toEqual(['conn-1']);
      }
    });

    it('scopes each call to the connector that owns the tool', async () => {
      const exec = makeExecuteTool();
      await run(
        `await tools.erp_customers_list({}); return 1`,
        { allowedTools: [tool('erp_customers_list', 'conn-2')] },
        exec,
      );
      expect(exec.calls[0].ctx.connectorIds).toEqual(['conn-2']);
    });

    it('does not mutate the caller\'s invocation context', async () => {
      const ctx = { ...baseContext, connectorIds: ['conn-1', 'conn-2'] };
      await run(`await tools.erp_products_list({}); return 1`, { invocationContext: ctx });
      expect(ctx.connectorIds).toEqual(['conn-1', 'conn-2']);
    });
  });

  describe('errors', () => {
    it('reports a syntax error with a line number and does not execute', async () => {
      const exec = makeExecuteTool();
      const res = await run(`const a = 1;\nreturn {`, {}, exec);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('SYNTAX_ERROR');
      expect(res.error?.line).toBeGreaterThanOrEqual(1);
      expect(res.error?.message).toMatch(/line \d+/);
      expect(exec.calls).toHaveLength(0);
    });

    it('reports a runtime error with the line in the user script', async () => {
      const res = await run(`const a = 1;\nconst b = a + nope;\nreturn b;`);
      expect(res.error?.code).toBe('RUNTIME_ERROR');
      expect(res.error?.message).toContain('nope is not defined');
      expect(res.error?.message).toMatch(/line 2/);
    });

    it('never leaks host paths or internal frames in error output', async () => {
      const res = await run(`null.x`);
      const dump = JSON.stringify(res);
      expect(dump).not.toMatch(/node_modules|isolated-vm|\.ts\b|[A-Za-z]:\\\\|\/Users\/|\/home\//);
    });

    it('survives a script that throws a non-Error value', async () => {
      const a = await run(`throw 'boom'`);
      expect(a.error?.code).toBe('RUNTIME_ERROR');
      const b = await run(`throw { secret: 1 }`);
      expect(b.error?.code).toBe('RUNTIME_ERROR');
    });

    it('surfaces the connector error text as TOOL_ERROR', async () => {
      const res = await run(`return await tools.erp_broken({})`);
      expect(res.error?.code).toBe('TOOL_ERROR');
      expect(res.error?.message).toContain('upstream 503');
    });

    it('lets a script catch a tool error and carry on', async () => {
      const res = await run(
        `try { await tools.erp_broken({}); } catch (e) { return { caught: e.code } }`,
      );
      expect(res).toMatchObject({ ok: true, result: { caught: 'TOOL_ERROR' } });
    });

    it('turns a non-serialisable result into a clear error', async () => {
      const res = await run(`const a = {}; a.self = a; return a;`);
      expect(res.error?.code).toBe('RUNTIME_ERROR');
      expect(res.error?.message).toMatch(/serial/i);
    });

    it('does not crash on a hostile tool argument payload', async () => {
      const res = await run(`return await tools.erp_products_list(1n)`);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('RUNTIME_ERROR');
    });
  });

  describe('bridge and helpers', () => {
    it('lists and describes the visible tools', async () => {
      const res = await run(
        `return { names: tools.list(), d: await tools.describe('erp_orders_list'), keys: Object.keys(tools).length }`,
      );
      expect(res.ok).toBe(true);
      const r = res.result as any;
      expect(r.names).toEqual(TOOLS.map((t) => t.name));
      expect(r.keys).toBe(TOOLS.length);
      expect(r.d).toMatchObject({
        name: 'erp_orders_list',
        description: 'erp_orders_list description',
        outputSchema: { type: 'array' },
      });
      expect(r.d.parameters).toBeDefined();
    });

    it('refuses to describe a tool outside the allowed set', async () => {
      const res = await run(`return await tools.describe('nope')`);
      expect(res.error?.code).toBe('TOOL_NOT_ALLOWED');
    });

    it('does not treat the tools object as a thenable', async () => {
      const res = await run(`const t = await tools; return typeof t.list`);
      expect(res).toMatchObject({ ok: true, result: 'function' });
    });

    it('provides date and aggregation helpers', async () => {
      const res = await run(
        `const g = util.groupBy([{k:'a',v:1},{k:'b',v:2},{k:'a',v:3},{k:'__proto__',v:4}], r => r.k);
         return {
           a: util.sum(g.a, r => r.v),
           keys: Object.keys(g).sort(),
           start: util.startOfMonth(new Date('2026-09-15T12:00:00Z')),
           end: util.endOfMonth(new Date('2026-09-15T12:00:00Z')),
           ago: /^\\d{4}-\\d{2}-\\d{2}$/.test(util.daysAgo(3)),
         }`,
      );
      expect(res.result).toEqual({
        a: 4,
        keys: ['__proto__', 'a', 'b'],
        start: '2026-09-01',
        end: '2026-09-30',
        ago: true,
      });
    });

    it('captures console output and caps it', async () => {
      const res = await run(
        `console.log('hello', { a: 1 });
         for (let i = 0; i < 500; i++) console.log('x'.repeat(2000));
         return 1`,
      );
      expect(res.ok).toBe(true);
      expect(res.meta.logs[0]).toBe('hello {"a":1}');
      expect(res.meta.logs.length).toBe(SANDBOX_LIMITS.maxLogLines);
      expect(res.meta.logs[1].length).toBeLessThanOrEqual(500);
    });

    it('keeps console output from a run that later fails', async () => {
      const res = await run(`console.log('before'); throw new Error('after')`);
      expect(res.error?.code).toBe('RUNTIME_ERROR');
      expect(res.meta.logs).toEqual(['before']);
    });

    it('runs parallel connector calls', async () => {
      const exec = makeExecuteTool();
      const res = await run(
        `const [a, b] = await Promise.all([tools.erp_products_list({}), tools.erp_customers_list({})]);
         return a.length + b.length`,
        {},
        exec,
      );
      expect(res).toMatchObject({ ok: true, result: 3 });
      expect(res.meta.connectorCalls).toBe(2);
    });

    it('leaves no unhandled rejection when the isolate dies with a call in flight', async () => {
      // The connector call (500 ms) outlives the isolate (killed at 200 ms) and
      // resolves into a disposed isolate. Jest fails the running test on any
      // unhandled rejection, so waiting past the call is the assertion.
      const res = await run(
        `return await tools.erp_products_list({})`,
        { limits: { timeoutMs: 200 } },
        makeExecuteTool(500),
      );
      expect(res.error?.code).toBe('TIMEOUT');
      await new Promise((r) => setTimeout(r, 700));
    });

    it('does not let a late connector callback change a result already returned', async () => {
      const res = await run(
        `return await tools.erp_products_list({})`,
        { limits: { timeoutMs: 200 } },
        makeExecuteTool(500),
      );
      const before = JSON.stringify(res.meta);
      await new Promise((r) => setTimeout(r, 700));
      expect(JSON.stringify(res.meta)).toBe(before);
    });

    it('survives many sequential runs without ballooning memory', async () => {
      const before = process.memoryUsage().rss;
      for (let i = 0; i < 30; i++) await run(`return ${i}`);
      expect(process.memoryUsage().rss - before).toBeLessThan(400 * 1024 * 1024);
    });
  });

  describe('checkSyntax', () => {
    it('accepts valid code, including top-level await and return', async () => {
      expect(await service.checkSyntax(`const r = await tools.x({}); return r;`)).toEqual({ ok: true });
    });

    it('reports line and column for invalid code without running it', async () => {
      const res = await service.checkSyntax(`const a = 1;\nreturn {`);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.line).toBeGreaterThanOrEqual(1);
        expect(res.column).toBeGreaterThanOrEqual(1);
        expect(res.message).toBeTruthy();
      }
    });
  });
});
