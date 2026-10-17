import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Logger } from '@nestjs/common';
import { McpEndpointController } from '../mcp-server/mcp-endpoint.controller';
import { SandboxService } from './sandbox.service';
import { SANDBOX_TOOL_NAMES } from './sandbox-tools';

/**
 * Code mode through the real MCP stack: planToolSet registers the tools on a
 * real McpServer and a real MCP Client calls them, so the SDK's own input
 * validation and outputSchema handling are exercised, not mocked.
 */

const SERVER_ORG = 'org-A';

const orderRows = Array.from({ length: 3000 }, (_, i) => ({
  id: i,
  status: i % 4 === 0 ? 'delayed' : 'ok',
  amount: i % 100,
}));

const tool = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  connectorId: `conn-${id}`,
  organizationId: SERVER_ORG,
  name,
  description: `${name}. Longer text that must not appear in the signature comment.`,
  parameters: { type: 'object', properties: { limit: { type: 'number' } } },
  connectorType: 'DATABASE',
  connectorConfig: { envVars: {} },
  endpointMapping: { method: 'query', path: 'SELECT 1' },
  outputSchema: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' } } } },
  ...extra,
});

const ORDERS = tool('t1', 'erp_orders_list');
const CUSTOMERS = tool('t2', 'erp_customers_list');
// A tool that changes data: a statement that is not a read.
const PURGE = tool('t3', 'erp_orders_purge', {
  endpointMapping: { method: 'query', path: 'DELETE FROM orders' },
});

function makeController(
  opts: { withSandbox?: boolean; roleAllows?: string[] | null; registryTools?: unknown[] } = {},
) {
  const withSandbox = opts.withSandbox ?? true;
  const roles = { getAllowedToolIds: jest.fn(async () => opts.roleAllows ?? null) };
  const executeTool = jest.fn(async (name: string) => ({
    content: [{ type: 'text' as const, text: 'ignored' }],
    structured: name === 'erp_orders_list' ? orderRows : [{ id: 'c1' }],
  }));
  const scripts = {
    getByName: jest.fn(async (): Promise<any> => null),
    create: jest.fn(async (_o: string, _s: string, _u: any, input: any) => ({ id: 'sc-1', version: 1, ...input })),
    updateByName: jest.fn(),
    list: jest.fn(async () => []),
    recordRun: jest.fn(async () => 'run-1'),
  };
  const controller = new McpEndpointController(
    {
      findById: jest.fn(),
      getConnectorIds: jest.fn(async () => ['conn-t1', 'conn-t2', 'conn-t3']),
    } as any,
    { getAllTools: jest.fn().mockReturnValue(opts.registryTools ?? [ORDERS, CUSTOMERS]) } as any,
    { executeTool } as any,
    roles as any,
    { lookup: jest.fn(), isEnabled: jest.fn(), captureIntentEnabled: jest.fn() } as any,
    { get: jest.fn(), add: jest.fn(), remove: jest.fn() } as any,
    { resolve: jest.fn().mockResolvedValue(null) } as any,
    { create: jest.fn() } as any,
    undefined,
    undefined,
    withSandbox ? new SandboxService() : undefined,
    withSandbox ? (scripts as any) : undefined,
  );
  return { controller, executeTool, scripts, roles };
}

const baseParams = (over: Record<string, unknown> = {}) => ({
  serverTools: [ORDERS, CUSTOMERS],
  allowedToolIds: null,
  captureIntent: false,
  kgEnabled: false,
  invocationContext: {
    userId: 'u1',
    organizationId: SERVER_ORG,
    authMethod: 'api-key',
    mcpServerId: 'srv-A',
    mcpServerName: 'koch-demo',
    connectorIds: ['conn-t1', 'conn-t2'],
  },
  sandboxOrganizationId: SERVER_ORG,
  ...over,
});

const names = (entries: Array<{ name: string }>) => entries.map((e) => e.name);

async function connect(entries: Array<{ register: (s: McpServer) => unknown }>) {
  const server = new McpServer({ name: 'spec', version: '1.0.0' });
  for (const e of entries) e.register(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'spec', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('code mode through planToolSet', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug']));

  const originalEnv = process.env.SANDBOX_ENABLED;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SANDBOX_ENABLED;
    else process.env.SANDBOX_ENABLED = originalEnv;
  });

  describe('when the sandbox tools are offered', () => {
    it('appends the four sandbox tools after the connector tools', () => {
      const { controller } = makeController();
      const entries = (controller as any).planToolSet(baseParams());
      expect(names(entries)).toEqual(['erp_orders_list', 'erp_customers_list', ...SANDBOX_TOOL_NAMES]);
    });

    it('does not offer them on a surface that did not supply the owning organization (the public demo)', () => {
      const { controller } = makeController();
      const entries = (controller as any).planToolSet(
        baseParams({
          sandboxOrganizationId: undefined,
          invocationContext: {
            organizationId: SERVER_ORG,
            authMethod: 'demo',
            mcpServerId: 'srv-demo',
            mcpServerName: 'demo',
            connectorIds: [],
          },
          resultFooter: 'served by the demo',
        }),
      );
      expect(names(entries).filter((n) => n.startsWith('sandbox_'))).toEqual([]);
    });

    it('honours the SANDBOX_ENABLED=false kill switch', () => {
      process.env.SANDBOX_ENABLED = 'false';
      const { controller } = makeController();
      const entries = (controller as any).planToolSet(baseParams());
      expect(names(entries)).toEqual(['erp_orders_list', 'erp_customers_list']);
    });

    it('is off, not broken, when the sandbox module is not wired', () => {
      const { controller } = makeController({ withSandbox: false });
      const entries = (controller as any).planToolSet(baseParams());
      expect(names(entries)).toEqual(['erp_orders_list', 'erp_customers_list']);
    });

    it('does not register a sandbox tool whose name a connector already uses', async () => {
      const { controller } = makeController();
      const clash = tool('t9', 'sandbox_list_scripts');
      const entries = (controller as any).planToolSet(baseParams({ serverTools: [ORDERS, clash] }));
      const count = names(entries).filter((n) => n === 'sandbox_list_scripts').length;
      expect(count).toBe(1);
      // Registering every entry on a real server must not throw on a duplicate.
      const client = await connect(entries);
      const listed = (await client.listTools()).tools.map((t) => t.name);
      expect(listed.filter((n) => n === 'sandbox_list_scripts')).toHaveLength(1);
    });

    it('leaves the whole feature off when a connector owns the run tool\'s name', () => {
      const { controller } = makeController();
      const clash = tool('t9', 'sandbox_run_script');
      const entries = (controller as any).planToolSet(baseParams({ serverTools: [clash] }));
      expect(names(entries)).toEqual(['sandbox_run_script']);
    });

    it('changes the signature of the run tool when the visible tool set changes', () => {
      const { controller } = makeController();
      const sigOf = (serverTools: unknown[]) =>
        (controller as any)
          .planToolSet(baseParams({ serverTools }))
          .find((e: any) => e.name === 'sandbox_run_script').sig;
      expect(sigOf([ORDERS, CUSTOMERS])).toBe(sigOf([ORDERS, CUSTOMERS]));
      expect(sigOf([ORDERS, CUSTOMERS])).not.toBe(sigOf([ORDERS]));
    });
  });

  describe('as an MCP client sees them', () => {
    it('lists the tools with the callable API in the run tool\'s description', async () => {
      const { controller } = makeController();
      const client = await connect((controller as any).planToolSet(baseParams()));
      const listed = (await client.listTools()).tools;

      const run = listed.find((t) => t.name === 'sandbox_run_script')!;
      expect(run.description).toContain('tools.erp_orders_list({ limit?: number })');
      expect(run.description).toContain('tools.erp_customers_list(');
      expect(run.description).not.toContain('Longer text that must not appear');
      // Read-only while writes are off, which is the default.
      expect(run.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      expect(Object.keys(run.inputSchema.properties ?? {}).sort()).toEqual(['args', 'code', 'scriptName', 'timeoutMs']);
      expect(listed.find((t) => t.name === 'sandbox_list_scripts')!.annotations?.readOnlyHint).toBe(true);
    });

    it('answers a question from 3000 rows with a tiny result and reports what stayed server-side', async () => {
      const { controller, executeTool, scripts } = makeController();
      const client = await connect((controller as any).planToolSet(baseParams()));

      const res: any = await client.callTool({
        name: 'sandbox_run_script',
        arguments: {
          code: `const r = await tools.erp_orders_list({ limit: 5000 });
                 return { delayed: r.filter(o => o.status === 'delayed').length, total: r.length };`,
        },
      });

      expect(res.isError).toBeFalsy();
      expect(res.structuredContent.result).toEqual({
        delayed: orderRows.filter((o) => o.status === 'delayed').length,
        total: 3000,
      });
      expect(res.structuredContent.meta).toMatchObject({ connectorCalls: 1, toolsCalled: ['erp_orders_list'] });
      expect(res.structuredContent.meta.bytesFromConnectors).toBeGreaterThan(100_000);
      expect(res.content[0].text.length).toBeLessThan(600);
      // The connector call carries the session's own scope, set by the server.
      expect(executeTool).toHaveBeenCalledWith(
        'erp_orders_list',
        { limit: 5000 },
        expect.objectContaining({ organizationId: SERVER_ORG, userId: 'u1', connectorIds: ['conn-t1'] }),
      );
      expect(scripts.recordRun).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: SERVER_ORG, mcpServerId: 'srv-A', userId: 'u1' }),
      );
    });

    it('returns a failure with a code and a hint, flagged as an error', async () => {
      const { controller } = makeController();
      const client = await connect((controller as any).planToolSet(baseParams()));
      const res: any = await client.callTool({
        name: 'sandbox_run_script',
        arguments: { code: 'return await tools.erp_orders_list({})' },
      });
      expect(res.isError).toBe(true);
      expect(res.structuredContent.ok).toBe(false);
      expect(res.structuredContent.error.code).toBe('OUTPUT_TOO_LARGE');
      expect(res.structuredContent.error.hint).toMatch(/rows\.slice/);
      expect(res.structuredContent.meta.bytesReturned).toBe(0);
      expect(res.content[0].text.length).toBeLessThan(1500);
    });

    it('shows the isolation to an agent that tries to leave it', async () => {
      const { controller, executeTool } = makeController();
      const client = await connect((controller as any).planToolSet(baseParams()));
      const probe = async (code: string): Promise<any> =>
        client.callTool({ name: 'sandbox_run_script', arguments: { code } });

      const host: any = await probe(`return [typeof require, typeof process, typeof fetch, typeof WebSocket].join()`);
      expect(host.structuredContent.result).toBe('undefined,undefined,undefined,undefined');

      const unknown: any = await probe(`return await tools.other_org_customers_list({})`);
      expect(unknown.structuredContent.error.code).toBe('TOOL_NOT_ALLOWED');

      const spin: any = await client.callTool({
        name: 'sandbox_run_script',
        arguments: { code: 'while(true){}', timeoutMs: 1000 },
      });
      expect(spin.structuredContent.error.code).toBe('TIMEOUT');
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('lets a script call only the tools the role allows', async () => {
      const { controller, executeTool } = makeController({ roleAllows: [ORDERS.id] });
      const entries = (controller as any).planToolSet(
        baseParams({ allowedToolIds: [ORDERS.id] }), // CUSTOMERS filtered out by role
      );
      expect(names(entries)).not.toContain('erp_customers_list');
      const client = await connect(entries);

      const listed = (await client.listTools()).tools.find((t) => t.name === 'sandbox_run_script')!;
      expect(listed.description).not.toContain('erp_customers_list');

      const res: any = await client.callTool({
        name: 'sandbox_run_script',
        arguments: { code: 'return await tools.erp_customers_list({})' },
      });
      expect(res.structuredContent.error.code).toBe('TOOL_NOT_ALLOWED');
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('rejects out-of-range input before any handler runs', async () => {
      const { controller, scripts } = makeController();
      const client = await connect((controller as any).planToolSet(baseParams()));
      const tooShort: any = await client
        .callTool({ name: 'sandbox_run_script', arguments: { code: 'return 1', timeoutMs: 5 } })
        .catch((e) => ({ isError: true, thrown: String(e) }));
      expect(tooShort.isError).toBe(true);
      const badName: any = await client
        .callTool({ name: 'sandbox_create_script', arguments: { name: 'Bad Name', code: 'return 1' } })
        .catch((e) => ({ isError: true, thrown: String(e) }));
      expect(badName.isError).toBe(true);
      expect(scripts.create).not.toHaveBeenCalled();
    });

    it('creates a script, syntax-checks it, and reruns it by name', async () => {
      const { controller, scripts } = makeController();
      const client = await connect((controller as any).planToolSet(baseParams()));

      const created: any = await client.callTool({
        name: 'sandbox_create_script',
        arguments: { name: 'delayed_orders', code: 'return { n: 1 }', description: 'Delayed orders' },
      });
      expect(JSON.parse(created.content[0].text)).toMatchObject({ ok: true, name: 'delayed_orders', syntax: 'ok' });
      expect(scripts.create).toHaveBeenCalledWith(SERVER_ORG, 'srv-A', 'u1', expect.objectContaining({ name: 'delayed_orders' }));

      const broken: any = await client.callTool({
        name: 'sandbox_create_script',
        arguments: { name: 'broken', code: 'return {' },
      });
      expect(JSON.parse(broken.content[0].text).syntax).toMatchObject({ line: expect.any(Number) });

      scripts.getByName.mockResolvedValueOnce({ id: 'sc-1', code: 'return { rerun: args.month }' });
      const rerun: any = await client.callTool({
        name: 'sandbox_run_script',
        arguments: { scriptName: 'delayed_orders', args: { month: 'previous' } },
      });
      expect(rerun.structuredContent.result).toEqual({ rerun: 'previous' });
    });

    describe('authorization at run time', () => {
      it('honours a role that changed after the session was planned', async () => {
        const { controller, executeTool, roles } = makeController();
        // Planned while the caller may use every tool, as a stateful session would be.
        const client = await connect((controller as any).planToolSet(baseParams()));
        const first: any = await client.callTool({
          name: 'sandbox_run_script',
          arguments: { code: 'return (await tools.erp_customers_list({})).length' },
        });
        expect(first.structuredContent.result).toBe(1);

        roles.getAllowedToolIds.mockResolvedValue([ORDERS.id]); // customers revoked
        const second: any = await client.callTool({
          name: 'sandbox_run_script',
          arguments: { code: 'return await tools.erp_customers_list({})' },
        });
        expect(second.structuredContent.error.code).toBe('TOOL_NOT_ALLOWED');
        expect(executeTool).toHaveBeenCalledTimes(1);
      });

      it('runs nothing when access cannot be re-checked', async () => {
        const { controller, executeTool, roles, scripts } = makeController();
        const client = await connect((controller as any).planToolSet(baseParams()));
        roles.getAllowedToolIds.mockRejectedValue(new Error('db down'));
        const res: any = await client.callTool({
          name: 'sandbox_run_script',
          arguments: { code: 'return 1' },
        });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toMatch(/could not verify your access/i);
        expect(res.content[0].text).not.toMatch(/db down/);
        expect(executeTool).not.toHaveBeenCalled();
        expect(scripts.recordRun).not.toHaveBeenCalled();
      });
    });

    describe('read-only by default', () => {
      const withWriteTool = () =>
        makeController({ registryTools: [ORDERS, CUSTOMERS, PURGE] });
      const planWithWriteTool = (controller: any) =>
        controller.planToolSet(baseParams({ serverTools: [ORDERS, CUSTOMERS, PURGE] }));

      afterEach(() => {
        delete process.env.SANDBOX_ALLOW_WRITES;
      });

      it('refuses a write tool before it runs, and does not offer it', async () => {
        const { controller, executeTool } = withWriteTool();
        const client = await connect(planWithWriteTool(controller));
        const listed = (await client.listTools()).tools.find((t) => t.name === 'sandbox_run_script')!;
        expect(listed.description).toContain('erp_orders_list');
        expect(listed.description).not.toContain('erp_orders_purge');

        const res: any = await client.callTool({
          name: 'sandbox_run_script',
          arguments: { code: 'return await tools.erp_orders_purge({})' },
        });
        expect(res.structuredContent.error.code).toBe('WRITE_NOT_ALLOWED');
        expect(res.structuredContent.error.hint).toMatch(/read-only/i);
        expect(executeTool).not.toHaveBeenCalled();
      });

      it('has no way for the agent to ask for writes', async () => {
        const { controller, executeTool } = withWriteTool();
        const client = await connect(planWithWriteTool(controller));
        const listed = (await client.listTools()).tools.find((t) => t.name === 'sandbox_run_script')!;
        expect(Object.keys(listed.inputSchema.properties ?? {})).not.toContain('allowWrite');
        // An extra argument is not a grant either: the call is refused or the key is ignored.
        const res: any = await client
          .callTool({
            name: 'sandbox_run_script',
            arguments: { code: 'return await tools.erp_orders_purge({})', allowWrite: true, allowWrites: true },
          })
          .catch((e) => ({ thrown: String(e) }));
        expect(executeTool).not.toHaveBeenCalled();
        if (!res.thrown) expect(res.structuredContent.error.code).toBe('WRITE_NOT_ALLOWED');
      });

      it('allows the write only when the operator\'s policy says so', async () => {
        process.env.SANDBOX_ALLOW_WRITES = 'true';
        const { controller, executeTool } = withWriteTool();
        const client = await connect(planWithWriteTool(controller));
        const listed = (await client.listTools()).tools.find((t) => t.name === 'sandbox_run_script')!;
        expect(listed.description).toContain('erp_orders_purge');
        expect(listed.annotations).toMatchObject({ readOnlyHint: false });

        const res: any = await client.callTool({
          name: 'sandbox_run_script',
          arguments: { code: 'return await tools.erp_orders_purge({})' },
        });
        expect(res.isError).toBeFalsy();
        expect(executeTool).toHaveBeenCalledWith('erp_orders_purge', {}, expect.any(Object));
      });
    });

    describe('audit and cancellation', () => {
      it('puts the run id on every connector call and on the stored run', async () => {
        const { controller, executeTool, scripts } = makeController();
        const client = await connect((controller as any).planToolSet(baseParams()));
        const res: any = await client.callTool({
          name: 'sandbox_run_script',
          arguments: {
            code: 'await tools.erp_orders_list({}); await tools.erp_customers_list({}); return 1',
          },
        });
        const runId = res.structuredContent.runId;
        expect(runId).toMatch(/^[0-9a-f-]{36}$/);
        const contexts = executeTool.mock.calls.map((c: any[]) => c[2]);
        expect(contexts).toHaveLength(2);
        for (const ctx of contexts) {
          expect(ctx.sandboxRunId).toBe(runId);
          // ...next to the caller's own identity, which the script cannot touch.
          expect(ctx).toMatchObject({ userId: 'u1', organizationId: SERVER_ORG, mcpServerId: 'srv-A' });
        }
        expect(scripts.recordRun).toHaveBeenCalledWith(expect.objectContaining({ id: runId }));
      });

      it('gives two runs two different ids', async () => {
        const { controller } = makeController();
        const client = await connect((controller as any).planToolSet(baseParams()));
        const a: any = await client.callTool({ name: 'sandbox_run_script', arguments: { code: 'return 1' } });
        const b: any = await client.callTool({ name: 'sandbox_run_script', arguments: { code: 'return 1' } });
        expect(a.structuredContent.runId).not.toBe(b.structuredContent.runId);
      });

      it('stops the run when the client cancels the request', async () => {
        const { controller, executeTool, scripts } = makeController();
        // A connector that never answers: the script is parked on an await.
        executeTool.mockImplementation(() => new Promise(() => undefined));
        const client = await connect((controller as any).planToolSet(baseParams()));

        const abort = new AbortController();
        const pending = client
          .callTool(
            { name: 'sandbox_run_script', arguments: { code: 'return await tools.erp_orders_list({})' } },
            { signal: abort.signal } as any,
          )
          .catch((e) => ({ aborted: true, e }));
        await new Promise((r) => setTimeout(r, 200));
        abort.abort();
        await pending;

        // The run is not left waiting out its 10 s deadline: it ends as CANCELLED.
        const deadline = Date.now() + 3_000;
        while (!scripts.recordRun.mock.calls.length && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(scripts.recordRun).toHaveBeenCalledTimes(1);
        const stored: any = (scripts.recordRun.mock.calls[0] as any[])[0];
        expect(stored.result.ok).toBe(false);
        expect(stored.result.error.code).toBe('CANCELLED');
        expect(stored.result.meta.ms).toBeLessThan(3_000);
      });
    });
  });
});
