import { getEventListeners } from 'node:events';
import { Logger } from '@nestjs/common';
import { SandboxService } from './sandbox.service';
import type {
  SandboxExecuteTool,
  SandboxInvocationContext,
  SandboxRunRequest,
  SandboxTool,
  SandboxToolResult,
} from './types';

/**
 * The security properties of the bridge between a script and the connectors,
 * stated one at a time: read-only by default, arguments checked on the host,
 * deadlines that a slow connector cannot get around, cancellation, cleanup, and
 * byte-exact limits. Unit tests of the real SandboxService with a fake executor.
 */

jest.setTimeout(30_000);

const session: SandboxInvocationContext = {
  sandboxRunId: 'run-under-test',
  userId: 'user-1',
  userEmail: 'user@a.test',
  organizationId: 'org-a',
  authMethod: 'jwt',
  mcpServerId: 'srv-1',
  mcpServerName: 'koch-demo',
  connectorIds: ['conn-1', 'conn-2'],
};

const readTool = (name: string, over: Partial<SandboxTool> = {}): SandboxTool => ({
  name,
  connectorId: 'conn-1',
  description: `${name} description`,
  parameters: { type: 'object', properties: { limit: { type: 'number' } } },
  readOnly: true,
  ...over,
});

const ORDERS = readTool('erp_orders_list');
const REFUND = readTool('erp_refund_create', { readOnly: false });

const ok = (value: unknown): SandboxToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structured: value,
});

type Calls = Array<{ name: string; args: Record<string, unknown>; ctx: SandboxInvocationContext }>;

function executor(impl: (name: string, args: Record<string, unknown>) => Promise<SandboxToolResult> | SandboxToolResult) {
  const calls: Calls = [];
  const fn: SandboxExecuteTool = async (name, args, ctx) => {
    calls.push({ name, args, ctx });
    return impl(name, args);
  };
  return { fn, calls };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, status: i % 7 === 0 ? 'delayed' : 'ok' }));

describe('sandbox bridge hardening', () => {
  let service: SandboxService;

  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug']));
  beforeEach(() => {
    service = new SandboxService();
  });

  const run = (
    code: string,
    over: Partial<SandboxRunRequest> = {},
    exec = executor(() => ok(rows(10))),
  ) =>
    service.run({
      code,
      allowedTools: [ORDERS, REFUND],
      invocationContext: session,
      executeTool: exec.fn,
      ...over,
    });

  describe('read-only by default', () => {
    it('refuses a tool that can change data before it executes', async () => {
      const exec = executor(() => ok({ refunded: true }));
      const res = await run('return await tools.erp_refund_create({ orderId: 1 })', {}, exec);
      expect(res.error?.code).toBe('WRITE_NOT_ALLOWED');
      expect(res.error?.hint).toMatch(/read-only/i);
      expect(exec.calls).toHaveLength(0);
      expect(res.meta.connectorCalls).toBe(0);
      expect(res.meta.toolsCalled).toEqual([]);
    });

    it('treats a tool of unknown kind as a write: readOnly is a positive claim', async () => {
      const unknown = readTool('erp_mystery', { readOnly: false });
      const exec = executor(() => ok(1));
      const res = await run('return await tools.erp_mystery({})', { allowedTools: [unknown] }, exec);
      expect(res.error?.code).toBe('WRITE_NOT_ALLOWED');
      expect(exec.calls).toHaveLength(0);
    });

    it('does not offer a write tool to the script, nor describe it', async () => {
      const res = await run(
        `const listed = tools.list();
         let described; try { await tools.describe('erp_refund_create'); described = 'described'; } catch (e) { described = e.code; }
         return { listed, described, has: 'erp_refund_create' in tools };`,
      );
      expect(res.result).toEqual({ listed: ['erp_orders_list'], described: 'WRITE_NOT_ALLOWED', has: false });
    });

    it('lets the script catch the refusal and carry on reading', async () => {
      const res = await run(
        `let refused; try { await tools.erp_refund_create({}); } catch (e) { refused = e.code; }
         const r = await tools.erp_orders_list({});
         return { refused, n: r.length };`,
      );
      expect(res.ok).toBe(true);
      expect(res.result).toEqual({ refused: 'WRITE_NOT_ALLOWED', n: 10 });
    });

    it('allows the write only when the host sets the policy on the request', async () => {
      const exec = executor(() => ok({ refunded: true }));
      const res = await run(
        'return [tools.list().includes("erp_refund_create"), await tools.erp_refund_create({ orderId: 1 })]',
        { allowWrites: true },
        exec,
      );
      expect(res.ok).toBe(true);
      expect(res.result).toEqual([true, { refunded: true }]);
      expect(exec.calls.map((c) => c.name)).toEqual(['erp_refund_create']);
    });

    it('cannot be switched on by the script: not by arguments, not by globals', async () => {
      const exec = executor(() => ok(1));
      const res = await run(
        `globalThis.allowWrites = true; tools.allowWrites = true;
         try { return await tools.erp_refund_create({ allowWrites: true, allowWrite: true }); }
         catch (e) { return e.code; }`,
        { args: { allowWrites: true } },
        exec,
      );
      expect(res.result).toBe('WRITE_NOT_ALLOWED');
      expect(exec.calls).toHaveLength(0);
    });
  });

  describe('arguments are validated on the host', () => {
    const strict = readTool('erp_orders_list', {
      validateArgs: (args) =>
        typeof args.limit === 'number' || args.limit === undefined
          ? { ok: true, args: { limit: args.limit as number | undefined } }
          : { ok: false, message: 'Invalid arguments: limit: expected number' },
    });

    it('rejects arguments the tool’s schema does not allow, before the tool runs', async () => {
      const exec = executor(() => ok(rows(1)));
      const res = await run(
        'return await tools.erp_orders_list({ limit: { $gt: 0 } })',
        { allowedTools: [strict] },
        exec,
      );
      expect(res.error?.code).toBe('TOOL_ERROR');
      expect(res.error?.message).toContain('limit');
      expect(exec.calls).toHaveLength(0);
      expect(res.meta.connectorCalls).toBe(0);
    });

    it('hands the tool the validated arguments, not the raw ones', async () => {
      const exec = executor(() => ok(rows(1)));
      await run(
        "await tools.erp_orders_list({ limit: 5, organizationId: 'org-b', connectorIds: ['conn-9'] }); return 1",
        { allowedTools: [strict] },
        exec,
      );
      expect(exec.calls[0].args).toEqual({ limit: 5 });
    });

    it('turns a validator that throws into a plain error', async () => {
      const broken = readTool('erp_orders_list', {
        validateArgs: () => {
          throw new Error('schema compile failed at /srv/app/secret/path.js');
        },
      });
      const exec = executor(() => ok(1));
      const res = await run('return await tools.erp_orders_list({})', { allowedTools: [broken] }, exec);
      expect(res.error?.code).toBe('TOOL_ERROR');
      expect(res.error?.message).not.toMatch(/secret|\/srv/);
      expect(exec.calls).toHaveLength(0);
    });

    it('does not let arguments change who the call runs as', async () => {
      const exec = executor(() => ok(1));
      await run(
        `await tools.erp_orders_list({ userId: 'admin', organizationId: 'org-b', sandboxRunId: 'forged', connectorIds: ['conn-9'], authMethod: 'static_api_key' }); return 1`,
        {},
        exec,
      );
      expect(exec.calls[0].ctx).toEqual({ ...session, connectorIds: ['conn-1'] });
      expect(exec.calls[0].ctx.sandboxRunId).toBe('run-under-test');
    });
  });

  describe('connector deadlines', () => {
    it('gives up on one slow connector call at its own deadline', async () => {
      const exec = executor(() => new Promise((r) => setTimeout(() => r(ok(1)), 1_500)));
      const started = Date.now();
      const res = await run('return await tools.erp_orders_list({})', {
        limits: { connectorTimeoutMs: 150, timeoutMs: 10_000 },
      }, exec);
      expect(res.error?.code).toBe('CONNECTOR_TIMEOUT');
      expect(res.error?.message).toContain('erp_orders_list');
      expect(res.error?.message).toContain('150 ms');
      expect(Date.now() - started).toBeLessThan(1_200);
    });

    it('lets the script catch the timeout and finish', async () => {
      const exec = executor(() => new Promise((r) => setTimeout(() => r(ok(1)), 1_500)));
      const res = await run(
        `try { await tools.erp_orders_list({}); return 'late'; } catch (e) { return 'recovered:' + e.code; }`,
        { limits: { connectorTimeoutMs: 100, timeoutMs: 10_000 } },
        exec,
      );
      expect(res.result).toBe('recovered:CONNECTOR_TIMEOUT');
    });

    it('ends a run whose connector never answers at the whole-run deadline', async () => {
      const exec = executor(() => new Promise(() => undefined));
      const started = Date.now();
      const res = await run('return await tools.erp_orders_list({})', {
        limits: { timeoutMs: 400, connectorTimeoutMs: 60_000 },
      }, exec);
      expect(res.error?.code).toBe('TIMEOUT');
      expect(Date.now() - started).toBeLessThan(1_500);
    });

    it('reports a timed-out run as a timeout, not as a connector failure, when both deadlines coincide', async () => {
      const exec = executor(() => new Promise(() => undefined));
      const res = await run('return await tools.erp_orders_list({})', {
        limits: { timeoutMs: 300, connectorTimeoutMs: 300 },
      }, exec);
      expect(res.error?.code).toBe('TIMEOUT');
    });

    describe('a connector that answers after its call was abandoned', () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      beforeEach(() => {
        rejections.length = 0;
        process.on('unhandledRejection', onRejection);
      });
      afterEach(() => process.off('unhandledRejection', onRejection));

      it('cannot change the finished result with a late success', async () => {
        const exec = executor(() => new Promise((r) => setTimeout(() => r(ok({ late: true })), 250)));
        const res = await run('return await tools.erp_orders_list({})', {
          limits: { connectorTimeoutMs: 50 },
        }, exec);
        const snapshot = JSON.stringify(res);
        await new Promise((r) => setTimeout(r, 500));
        expect(JSON.stringify(res)).toBe(snapshot);
        expect(res.error?.code).toBe('CONNECTOR_TIMEOUT');
        expect(res.meta.bytesFromConnectors).toBe(0);
        expect(rejections).toEqual([]);
      });

      it('leaves no unhandled rejection behind with a late failure', async () => {
        const exec = executor(
          () => new Promise((_, reject) => setTimeout(() => reject(new Error('boom: password=hunter2')), 250)),
        );
        const res = await run('return await tools.erp_orders_list({})', {
          limits: { connectorTimeoutMs: 50 },
        }, exec);
        await new Promise((r) => setTimeout(r, 500));
        expect(res.error?.code).toBe('CONNECTOR_TIMEOUT');
        expect(JSON.stringify(res)).not.toContain('hunter2');
        expect(rejections).toEqual([]);
      });

      it('cannot reach a run that already ended, nor count against its limits', async () => {
        const exec = executor(() => new Promise((r) => setTimeout(() => r(ok(rows(5))), 300)));
        const res = await run(
          `tools.erp_orders_list({}); return 'did not wait';`, // a call nobody awaits
          {},
          exec,
        );
        expect(res.result).toBe('did not wait');
        await new Promise((r) => setTimeout(r, 500));
        expect(res.meta.bytesFromConnectors).toBe(0);
        expect(rejections).toEqual([]);
      });
    });
  });

  describe('cancellation and cleanup', () => {
    it('stops a run parked on a connector when the caller cancels', async () => {
      const exec = executor(() => new Promise(() => undefined));
      const abort = new AbortController();
      const started = Date.now();
      const pending = run('return await tools.erp_orders_list({})', { signal: abort.signal }, exec);
      await new Promise((r) => setTimeout(r, 150));
      abort.abort();
      const res = await pending;
      expect(res.error?.code).toBe('CANCELLED');
      expect(res.error?.message).not.toMatch(/dispos|isolate/i);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(exec.calls).toHaveLength(1);
    });

    it('stops a busy loop when the caller cancels', async () => {
      const abort = new AbortController();
      const pending = run('while (true) {}', { signal: abort.signal });
      await new Promise((r) => setTimeout(r, 150));
      abort.abort();
      expect((await pending).error?.code).toBe('CANCELLED');
    });

    it('does not even start a run whose caller is already gone', async () => {
      const exec = executor(() => ok(1));
      const res = await run('return await tools.erp_orders_list({})', { signal: AbortSignal.abort() }, exec);
      expect(res.error?.code).toBe('CANCELLED');
      expect(exec.calls).toHaveLength(0);
    });

    it('removes its listener from the signal after success, failure and cancellation', async () => {
      const outcomes: Array<[string, (c: AbortController) => void]> = [
        ['return 1', () => undefined],
        ['throw new Error("x")', () => undefined],
        ['while (true) {}', (c) => setTimeout(() => c.abort(), 100)],
      ];
      for (const [code, after] of outcomes) {
        const abort = new AbortController();
        after(abort);
        await run(code, { signal: abort.signal });
        expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
      }
    });

    it('ignores a cancellation that arrives after the run finished', async () => {
      const abort = new AbortController();
      const res = await run('return 7', { signal: abort.signal });
      expect(res.result).toBe(7);
      expect(() => abort.abort()).not.toThrow();
    });

    it('frees the concurrency slot after every kind of ending', async () => {
      const limits = { maxConcurrent: 1, timeoutMs: 400 };
      const endings: Array<[string, Partial<SandboxRunRequest>]> = [
        ['return 1', {}],
        ['return {', {}], // syntax error
        ['throw new Error("x")', {}], // runtime error
        ['while (true) {}', {}], // timeout
        ['return await tools.erp_refund_create({})', {}], // refused write
        ['return await tools.erp_orders_list({})', { signal: AbortSignal.abort() }], // cancelled
      ];
      for (const [code, over] of endings) {
        await run(code, { limits, ...over });
        const next = await run('return "next"', { limits });
        expect(next.result).toBe('next');
      }
    });

    it('stops many cancelled runs without a leak: each one ends and the next one starts', async () => {
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 40; i++) {
        const abort = new AbortController();
        const exec = executor(() => new Promise(() => undefined));
        const pending = run('return await tools.erp_orders_list({})', { signal: abort.signal }, exec);
        setTimeout(() => abort.abort(), 5);
        expect((await pending).error?.code).toBe('CANCELLED');
      }
      expect(process.memoryUsage().heapUsed - before).toBeLessThan(150 * 1024 * 1024);
    });
  });

  describe('connector response limits', () => {
    it('rejects one response over the per-response limit, and counts nothing for it', async () => {
      const exec = executor(() => ok(rows(60_000)));
      const res = await run('return await tools.erp_orders_list({})', {
        limits: { maxConnectorResponseBytes: 1_000_000 },
      }, exec);
      expect(res.error?.code).toBe('CONNECTOR_BYTES_LIMIT');
      expect(res.error?.message).toMatch(/per-response/);
      expect(res.meta.bytesFromConnectors).toBe(0);
    });

    it('turns away a very large response before serialising it again', async () => {
      let touched = false;
      const huge: SandboxToolResult = {
        content: [{ type: 'text', text: 'x'.repeat(6_000_000) }],
        get structured() {
          touched = true;
          return rows(3);
        },
      };
      const res = await run('return await tools.erp_orders_list({})', {
        limits: { maxConnectorResponseBytes: 1_000_000 },
      }, executor(() => huge));
      expect(res.error?.code).toBe('CONNECTOR_BYTES_LIMIT');
      expect(touched).toBe(false);
    });

    it('lets a script carry on after a response was refused', async () => {
      let n = 0;
      const exec = executor(() => ok(n++ === 0 ? rows(60_000) : rows(3)));
      const res = await run(
        `let first; try { await tools.erp_orders_list({}); } catch (e) { first = e.code; }
         const second = await tools.erp_orders_list({});
         return { first, second: second.length };`,
        { limits: { maxConnectorResponseBytes: 1_000_000 } },
        exec,
      );
      expect(res.result).toEqual({ first: 'CONNECTOR_BYTES_LIMIT', second: 3 });
    });

    it('counts connector bytes as UTF-8 bytes, not characters', async () => {
      const value = { text: '€'.repeat(1000) }; // 1000 characters, 3000 bytes
      const res = await run('return (await tools.erp_orders_list({})).text.length', {}, executor(() => ok(value)));
      expect(res.result).toBe(1000);
      expect(res.meta.bytesFromConnectors).toBe(Buffer.byteLength(JSON.stringify(value), 'utf8'));
      expect(res.meta.bytesFromConnectors).toBeGreaterThan(3000);
    });

    it('rejects a response that is under the limit in characters but over it in bytes', async () => {
      const exec = executor(() => ok({ text: '€'.repeat(400_000) })); // 400k characters, 1.2 MB
      const res = await run('return await tools.erp_orders_list({})', {
        limits: { maxConnectorResponseBytes: 1_000_000 },
      }, exec);
      expect(res.error?.code).toBe('CONNECTOR_BYTES_LIMIT');
    });

    it('applies the total connector limit in bytes across calls', async () => {
      const exec = executor(() => ok({ text: '€'.repeat(200_000) })); // 600 KB each, 400k characters in all
      const res = await run(
        'await tools.erp_orders_list({}); return await tools.erp_orders_list({})',
        { limits: { maxConnectorBytes: 1_000_000 } },
        exec,
      );
      expect(res.error?.code).toBe('CONNECTOR_BYTES_LIMIT');
      expect(res.meta.connectorCalls).toBe(2);
    });

    it('measures the script source in bytes', async () => {
      const code = `return 1; //${'€'.repeat(30_000)}`; // 30k characters, 90 KB
      expect(code.length).toBeLessThan(64 * 1024);
      const res = await run(code);
      expect(res.error?.code).toBe('CODE_TOO_LARGE');
    });

    it('measures the result in bytes', async () => {
      const res = await run(`return '€'.repeat(15000)`, { limits: { maxOutputBytes: 32 * 1024 } }); // 45 KB
      expect(res.error?.code).toBe('OUTPUT_TOO_LARGE');
      expect(res.meta.bytesReturned).toBe(0);
    });
  });

  describe('nothing sensitive reaches the script or the caller', () => {
    it('describes a tool with its public fields only', async () => {
      const leaky = {
        ...ORDERS,
        authConfig: '{"apiKey":"sk-live-123"}',
        connectorConfig: { baseUrl: 'https://secret.internal' },
      } as SandboxTool;
      const res = await run(`return await tools.describe('erp_orders_list')`, { allowedTools: [leaky] });
      expect(Object.keys(res.result as object).sort()).toEqual(['description', 'name', 'outputSchema', 'parameters']);
      expect(JSON.stringify(res)).not.toMatch(/sk-live-123|secret\.internal|conn-1/);
    });

    it('does not pass an executor exception on, only that the tool failed', async () => {
      const exec = executor(() => {
        throw new Error('connect ECONNREFUSED postgres://admin:hunter2@10.0.0.5:5432/prod');
      });
      const res = await run('return await tools.erp_orders_list({})', {}, exec);
      expect(res.error?.code).toBe('TOOL_ERROR');
      expect(JSON.stringify(res)).not.toMatch(/hunter2|10\.0\.0\.5|ECONNREFUSED/);
    });

    it('gives the script no way to read the session identity or the run id', async () => {
      const res = await run(
        `return JSON.stringify({ g: Object.getOwnPropertyNames(globalThis), a: args })`,
        { args: { month: '2026-09' } },
      );
      const seen = String(res.result);
      expect(seen).not.toMatch(/org-a|user-1|user@a\.test|run-under-test|conn-1|jwt|koch-demo/);
    });
  });
});
