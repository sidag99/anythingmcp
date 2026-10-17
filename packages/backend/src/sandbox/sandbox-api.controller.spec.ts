import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { RegisteredTool } from '../mcp-server/tool-registry';
import { ISOLATION_CASES } from './isolation-suite';
import { SandboxApiController } from './sandbox-api.controller';
import type { SandboxRunResult } from './types';

const ORG = 'org-a';
const SERVER = 'srv-1';

const ADMIN = { sub: 'u-admin', email: 'admin@a.test', role: 'ADMIN', organizationId: ORG };
const EDITOR = { sub: 'u-editor', email: 'editor@a.test', role: 'EDITOR', organizationId: ORG };
const VIEWER = { sub: 'u-viewer', email: 'viewer@a.test', role: 'VIEWER', organizationId: ORG };
const asReq = (user: typeof ADMIN) => ({ user }) as any;

function tool(id: string, name: string, method = 'GET', connectorId = 'conn-1'): RegisteredTool {
  return {
    id,
    connectorId,
    organizationId: ORG,
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    connectorType: 'REST',
    connectorConfig: { baseUrl: 'https://api.example.com', authType: 'NONE' },
    endpointMapping: { method, path: '/x' },
  };
}

const LIST_ORDERS = tool('t-orders', 'shop_list_orders');
const LIST_CUSTOMERS = tool('t-customers', 'shop_list_customers');
const CREATE_REFUND = tool('t-refund', 'shop_create_refund', 'POST');
const OTHER_CONNECTOR = tool('t-other', 'crm_list_leads', 'GET', 'conn-other');

const okResult = (result: unknown, bytesReturned = 20): SandboxRunResult => ({
  ok: true,
  result,
  meta: {
    ms: 12,
    connectorCalls: 1,
    bytesFromConnectors: 5000,
    bytesReturned,
    logs: [],
    toolsCalled: ['shop_list_orders'],
  },
});

const failResult = (code: string): SandboxRunResult =>
  ({
    ok: false,
    error: { code, message: `${code} happened` },
    meta: { ms: 3, connectorCalls: 0, bytesFromConnectors: 0, bytesReturned: 0, logs: [], toolsCalled: [] },
  }) as SandboxRunResult;

function setup(opts: { allowedToolIds?: string[] | null; server?: any } = {}) {
  const server =
    opts.server === undefined
      ? { id: SERVER, name: 'Shop', organizationId: ORG, isActive: true }
      : opts.server;
  const sandbox = {
    run: jest.fn().mockResolvedValue(okResult({ total: 3 })),
    checkSyntax: jest.fn().mockResolvedValue({ ok: true }),
  };
  const scripts = {
    getForServer: jest.fn(),
    get: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    updateByIdAsAuthor: jest.fn(),
    removeAsUser: jest.fn().mockResolvedValue(undefined),
    listRuns: jest.fn().mockResolvedValue([]),
    recordRun: jest.fn().mockResolvedValue('run-1'),
  };
  const servers = {
    findById: jest.fn().mockResolvedValue(server),
    getConnectorIds: jest.fn().mockResolvedValue(['conn-1']),
  };
  const roles = {
    getAllowedToolIds: jest
      .fn()
      .mockResolvedValue(opts.allowedToolIds === undefined ? null : opts.allowedToolIds),
  };
  const registry = {
    getAllTools: jest.fn().mockReturnValue([LIST_ORDERS, LIST_CUSTOMERS, CREATE_REFUND, OTHER_CONNECTOR]),
  };
  const executor = {
    executeTool: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(new Array(200).fill({ id: 1 })) }],
    }),
  };
  const controller = new SandboxApiController(
    sandbox as any,
    scripts as any,
    servers as any,
    roles as any,
    registry as any,
    executor as any,
  );
  return { controller, sandbox, scripts, servers, roles, registry, executor };
}

describe('SandboxApiController', () => {
  afterEach(() => {
    delete process.env.SANDBOX_ENABLED;
  });

  describe('access to the server', () => {
    it('answers 404 for a server of another organization, without saying it exists', async () => {
      const { controller } = setup({
        server: { id: SERVER, name: 'Shop', organizationId: 'org-b', isActive: true },
      });
      await expect(controller.listScripts(asReq(EDITOR), SERVER, {})).rejects.toThrow(NotFoundException);
      await expect(controller.runs(asReq(EDITOR), SERVER, {})).rejects.toThrow(NotFoundException);
    });

    it('answers 404 for a server that does not exist', async () => {
      const { controller } = setup({ server: null });
      await expect(controller.listScripts(asReq(EDITOR), 'nope', {})).rejects.toThrow(NotFoundException);
    });

    it('turns every route into a 404 when SANDBOX_ENABLED=false', async () => {
      process.env.SANDBOX_ENABLED = 'false';
      const { controller, servers } = setup();
      await expect(controller.listScripts(asReq(ADMIN), SERVER, {})).rejects.toThrow(/turned off/);
      await expect(controller.run(asReq(ADMIN), SERVER, { code: 'return 1' })).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        controller.createScript(asReq(ADMIN), SERVER, { name: 'abc', code: 'return 1' }),
      ).rejects.toThrow(NotFoundException);
      // It does not even look the server up.
      expect(servers.findById).not.toHaveBeenCalled();
    });
  });

  describe('viewers', () => {
    it('can read scripts and runs', async () => {
      const { controller, scripts } = setup();
      scripts.list.mockResolvedValue([{ id: 's1', createdById: 'u-editor' }]);
      await expect(controller.listScripts(asReq(VIEWER), SERVER, {})).resolves.toEqual([
        { id: 's1', createdById: 'u-editor', ownedByYou: false },
      ]);
      await expect(controller.runs(asReq(VIEWER), SERVER, {})).resolves.toEqual([]);
    });

    it('cannot run, benchmark, create, edit or delete', async () => {
      const { controller, sandbox } = setup();
      const req = asReq(VIEWER);
      await expect(controller.run(req, SERVER, { code: 'return 1' })).rejects.toThrow(ForbiddenException);
      await expect(
        controller.benchmark(req, SERVER, { toolName: 'shop_list_orders', code: 'return 1' }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.createScript(req, SERVER, { name: 'abc', code: 'return 1' }),
      ).rejects.toThrow(ForbiddenException);
      await expect(controller.updateScript(req, 's1', { code: 'x' })).rejects.toThrow(
        ForbiddenException,
      );
      await expect(controller.deleteScript(req, 's1')).rejects.toThrow(ForbiddenException);
      expect(sandbox.run).not.toHaveBeenCalled();
    });
  });

  describe('run', () => {
    it('needs exactly one of code and scriptId', async () => {
      const { controller, sandbox } = setup();
      await expect(controller.run(asReq(EDITOR), SERVER, {})).rejects.toThrow(BadRequestException);
      await expect(
        controller.run(asReq(EDITOR), SERVER, { code: 'return 1', scriptId: 's1' }),
      ).rejects.toThrow(BadRequestException);
      await expect(controller.run(asReq(EDITOR), SERVER, { code: '' })).rejects.toThrow(
        BadRequestException,
      );
      expect(sandbox.run).not.toHaveBeenCalled();
    });

    it('refuses an inactive server like the MCP endpoint does', async () => {
      const { controller } = setup({
        server: { id: SERVER, name: 'Shop', organizationId: ORG, isActive: false },
      });
      await expect(controller.run(asReq(EDITOR), SERVER, { code: 'return 1' })).rejects.toThrow(
        /inactive/,
      );
    });

    it('runs the code as the caller, in the server\'s organization', async () => {
      const { controller, sandbox, scripts } = setup();
      const body = await controller.run(asReq(EDITOR), SERVER, {
        code: 'return await tools.shop_list_orders({})',
        args: { month: '2026-09' },
        timeoutMs: 5000,
      });

      const call = sandbox.run.mock.calls[0][0];
      expect(call.code).toBe('return await tools.shop_list_orders({})');
      expect(call.args).toEqual({ month: '2026-09' });
      expect(call.limits).toEqual({ timeoutMs: 5000 });
      expect(call.allowWrites).toBe(false);
      expect(call.invocationContext).toEqual({
        sandboxRunId: expect.any(String),
        userId: 'u-editor',
        userEmail: 'editor@a.test',
        organizationId: ORG,
        authMethod: 'jwt',
        mcpServerId: SERVER,
        mcpServerName: 'Shop',
        connectorIds: ['conn-1'],
      });
      expect(scripts.recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          mcpServerId: SERVER,
          userId: 'u-editor',
          scriptId: undefined,
          code: 'return await tools.shop_list_orders({})',
          // The id of the stored run is the one the connectors' audit rows carry.
          id: (body as any).runId,
        }),
      );
      expect(call.invocationContext.sandboxRunId).toBe((body as any).runId);
      expect(body).toMatchObject({ runId: expect.any(String), ok: true, result: { total: 3 } });
      expect(body).not.toHaveProperty('script');
    });

    it('lets a script call only the tools the caller\'s role allows', async () => {
      // Only the orders tool is granted; customers and refund are hidden from this caller.
      const { controller, sandbox, roles } = setup({ allowedToolIds: ['t-orders'] });
      await controller.run(asReq(EDITOR), SERVER, { code: 'return 1' });
      const names = sandbox.run.mock.calls[0][0].allowedTools.map((t: any) => t.name);
      expect(names).toEqual(['shop_list_orders']);
      // The allow-list is read for the server's organization, for this very user.
      expect(roles.getAllowedToolIds).toHaveBeenCalledWith('u-editor', ORG);
    });

    it('offers nothing to a caller whose role grants nothing', async () => {
      const { controller, sandbox } = setup({ allowedToolIds: [] });
      await controller.run(asReq(EDITOR), SERVER, { code: 'return 1' });
      expect(sandbox.run.mock.calls[0][0].allowedTools).toEqual([]);
    });

    it('offers only tools of the server\'s own connectors', async () => {
      const { controller, sandbox } = setup({ allowedToolIds: null });
      await controller.run(asReq(ADMIN), SERVER, { code: 'return 1' });
      const names = sandbox.run.mock.calls[0][0].allowedTools.map((t: any) => t.name);
      expect(names).toEqual(['shop_list_orders', 'shop_list_customers', 'shop_create_refund']);
      expect(names).not.toContain('crm_list_leads');
    });

    it('runs a saved script by id, shows whose code it was, and records the run against it', async () => {
      const { controller, sandbox, scripts } = setup();
      scripts.getForServer.mockResolvedValue({
        id: 's1',
        name: 'monthly',
        version: 3,
        code: 'return 42',
        createdById: 'u-admin',
      });
      const body: any = await controller.run(asReq(EDITOR), SERVER, { scriptId: 's1' });

      expect(scripts.getForServer).toHaveBeenCalledWith(ORG, SERVER, 's1');
      expect(sandbox.run.mock.calls[0][0].code).toBe('return 42');
      expect(scripts.recordRun).toHaveBeenCalledWith(
        expect.objectContaining({ scriptId: 's1', userId: 'u-editor', code: 'return 42' }),
      );
      expect(body.script).toEqual({ id: 's1', name: 'monthly', version: 3, ownedByYou: false });
    });

    it('does not find a script that belongs to another server', async () => {
      const { controller, scripts } = setup();
      scripts.getForServer.mockRejectedValue(new NotFoundException('Script not found'));
      await expect(
        controller.run(asReq(EDITOR), SERVER, { scriptId: 'other-servers-script' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns a failed script as a 200 body with the error', async () => {
      const { controller, sandbox } = setup();
      sandbox.run.mockResolvedValue(failResult('TIMEOUT'));
      const body: any = await controller.run(asReq(EDITOR), SERVER, { code: 'while(true){}' });
      expect(body).toMatchObject({ runId: expect.any(String), ok: false, error: { code: 'TIMEOUT' } });
    });

    it('answers 429 with the body when the organization has no free slot', async () => {
      const { controller, sandbox, scripts } = setup();
      sandbox.run.mockResolvedValue(failResult('BUSY'));
      const err = await controller.run(asReq(EDITOR), SERVER, { code: 'return 1' }).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(429);
      expect(err.getResponse()).toMatchObject({ ok: false, error: { code: 'BUSY' } });
      expect(scripts.recordRun).toHaveBeenCalled();
    });
  });

  describe('benchmark', () => {
    const dto = { toolName: 'shop_list_orders', code: 'return (await tools.shop_list_orders({})).length' };

    it('compares the raw payload with what the script returned', async () => {
      const { controller, sandbox, executor } = setup();
      const rawText = JSON.stringify(new Array(200).fill({ id: 1 }));
      executor.executeTool.mockResolvedValue({ content: [{ type: 'text', text: rawText }] });
      sandbox.run.mockResolvedValue(okResult(200, 3));

      const body: any = await controller.benchmark(asReq(EDITOR), SERVER, dto);

      const rawBytes = Buffer.byteLength(rawText);
      expect(body.raw).toEqual({
        ok: true,
        ms: expect.any(Number),
        bytes: rawBytes,
        estTokens: Math.ceil(rawBytes / 4),
      });
      expect(body.script).toMatchObject({
        ok: true,
        bytes: 3,
        estTokens: 1,
        bytesFromConnectors: 5000,
        connectorCalls: 1,
        result: 200,
      });
      expect(body.reduction.bytesPct).toBeCloseTo((1 - 3 / rawBytes) * 100, 1);
      expect(body.reduction.tokensPct).toBeGreaterThan(99);
      expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
      // Both halves of the comparison carry the run's id.
      expect(executor.executeTool.mock.calls[0][2].sandboxRunId).toBe(body.runId);
      expect(sandbox.run.mock.calls[0][0].invocationContext.sandboxRunId).toBe(body.runId);
      // The raw call is made as the caller, scoped to the tool's own connector.
      expect(executor.executeTool).toHaveBeenCalledWith(
        'shop_list_orders',
        {},
        expect.objectContaining({ userId: 'u-editor', organizationId: ORG, connectorIds: ['conn-1'] }),
      );
    });

    it('refuses a tool the caller cannot see', async () => {
      const { controller, executor } = setup({ allowedToolIds: ['t-customers'] });
      await expect(controller.benchmark(asReq(EDITOR), SERVER, dto)).rejects.toThrow(NotFoundException);
      expect(executor.executeTool).not.toHaveBeenCalled();
    });

    it('refuses to call a write tool for real', async () => {
      const { controller, executor, sandbox } = setup();
      await expect(
        controller.benchmark(asReq(ADMIN), SERVER, { ...dto, toolName: 'shop_create_refund' }),
      ).rejects.toThrow(/not a read-only tool/);
      expect(executor.executeTool).not.toHaveBeenCalled();
      expect(sandbox.run).not.toHaveBeenCalled();
    });

    it('reports a failing raw call and does not run the script', async () => {
      const { controller, sandbox, executor } = setup();
      executor.executeTool.mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: '{"error":"upstream 500"}' }],
      });
      const body: any = await controller.benchmark(asReq(EDITOR), SERVER, dto);
      expect(body.raw).toMatchObject({ ok: false, error: expect.stringContaining('upstream 500') });
      expect(body.script).toBeNull();
      expect(body.reduction).toBeNull();
      expect(sandbox.run).not.toHaveBeenCalled();
    });

    it('survives a tool that throws, without leaking the message', async () => {
      const { controller, executor } = setup();
      executor.executeTool.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
      const body: any = await controller.benchmark(asReq(EDITOR), SERVER, dto);
      expect(body.raw.ok).toBe(false);
      expect(JSON.stringify(body)).not.toContain('10.0.0.5');
    });

    it('has no reduction when the script failed', async () => {
      const { controller, sandbox } = setup();
      sandbox.run.mockResolvedValue(failResult('RUNTIME_ERROR'));
      const body: any = await controller.benchmark(asReq(EDITOR), SERVER, dto);
      expect(body.script).toMatchObject({ ok: false, error: { code: 'RUNTIME_ERROR' } });
      expect(body.reduction).toBeNull();
    });

    it('answers 429 when the organization is at its concurrency limit', async () => {
      const { controller, sandbox } = setup();
      sandbox.run.mockResolvedValue(failResult('BUSY'));
      const err = await controller.benchmark(asReq(EDITOR), SERVER, dto).catch((e) => e);
      expect(err.getStatus()).toBe(429);
    });
  });

  describe('run history', () => {
    it('shows an administrator every run', async () => {
      const { controller, scripts } = setup();
      await controller.runs(asReq(ADMIN), SERVER, { limit: 25 });
      expect(scripts.listRuns).toHaveBeenCalledWith(ORG, SERVER, 25, undefined);
    });

    it('shows anyone else only their own runs: results may hold data they cannot reach', async () => {
      const { controller, scripts } = setup();
      await controller.runs(asReq(EDITOR), SERVER, {});
      expect(scripts.listRuns).toHaveBeenCalledWith(ORG, SERVER, undefined, 'u-editor');
      await controller.runs(asReq(VIEWER), SERVER, {});
      expect(scripts.listRuns).toHaveBeenLastCalledWith(ORG, SERVER, undefined, 'u-viewer');
    });
  });

  describe('saved scripts', () => {
    it('marks which scripts the caller wrote', async () => {
      const { controller, scripts } = setup();
      scripts.list.mockResolvedValue([
        { id: 'a', createdById: 'u-editor' },
        { id: 'b', createdById: 'u-admin' },
      ]);
      const rows: any[] = await controller.listScripts(asReq(EDITOR), SERVER, {});
      expect(rows.map((r) => r.ownedByYou)).toEqual([true, false]);
    });

    it('returns a script with its code from the right server only', async () => {
      const { controller, scripts } = setup();
      scripts.get.mockResolvedValue({ id: 's1', code: 'return 1', createdById: 'u-editor' });
      await expect(controller.getScript(asReq(EDITOR), 's1')).resolves.toMatchObject({
        code: 'return 1',
        ownedByYou: true,
      });
      // Looked up in the caller's own organization only.
      expect(scripts.get).toHaveBeenCalledWith(ORG, 's1');
    });

    it('creates a script under the caller and reports whether it parses', async () => {
      const { controller, scripts, sandbox } = setup();
      scripts.create.mockResolvedValue({ id: 's1', name: 'monthly', code: 'return (', version: 1 });
      sandbox.checkSyntax.mockResolvedValue({ ok: false, line: 1, column: 9, message: 'Unexpected end' });

      const body: any = await controller.createScript(asReq(EDITOR), SERVER, {
        name: 'monthly',
        code: 'return (',
      });

      expect(scripts.create).toHaveBeenCalledWith(ORG, SERVER, 'u-editor', {
        name: 'monthly',
        code: 'return (',
      });
      expect(body.syntax).toEqual({ ok: false, line: 1, column: 9, message: 'Unexpected end' });
      expect(body.ownedByYou).toBe(true);
    });

    it('edits through the author-only rule', async () => {
      const { controller, scripts } = setup();
      scripts.updateByIdAsAuthor.mockResolvedValue({ id: 's1', code: 'return 2', version: 2 });
      const body: any = await controller.updateScript(asReq(EDITOR), 's1', { code: 'return 2' });
      expect(scripts.updateByIdAsAuthor).toHaveBeenCalledWith(
        ORG,
        's1',
        { code: 'return 2' },
        'u-editor',
      );
      expect(body.syntax).toEqual({ ok: true });
    });

    it('passes the refusal for someone else\'s script through, even to an administrator', async () => {
      const { controller, scripts } = setup();
      scripts.updateByIdAsAuthor.mockRejectedValue(new ForbiddenException('only they can edit it'));
      await expect(
        controller.updateScript(asReq(ADMIN), 's1', { code: 'return 2' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets the service decide who may delete, telling it whether the caller is an administrator', async () => {
      const { controller, scripts } = setup();
      await controller.deleteScript(asReq(EDITOR), 's1');
      expect(scripts.removeAsUser).toHaveBeenLastCalledWith(ORG, 's1', {
        userId: 'u-editor',
        isAdmin: false,
      });
      await controller.deleteScript(asReq(ADMIN), 's1');
      expect(scripts.removeAsUser).toHaveBeenLastCalledWith(ORG, 's1', {
        userId: 'u-admin',
        isAdmin: true,
      });
    });
  });

  describe('isolation tests', () => {
    it('runs every case of the fixed suite against the live sandbox, as the server\'s organization', async () => {
      const { controller, sandbox } = setup();
      const results: any[] = await controller.isolationTests(asReq(EDITOR), SERVER);
      expect(results).toHaveLength(ISOLATION_CASES.length);
      expect(sandbox.run).toHaveBeenCalledTimes(ISOLATION_CASES.length);
      for (const call of sandbox.run.mock.calls) {
        expect(call[0].invocationContext.organizationId).toBe(ORG);
      }
      expect(results[0]).toMatchObject({
        id: 'control',
        expectedCode: 'OK',
        passed: expect.any(Boolean),
        ms: expect.any(Number),
      });
    });

    it('touches no connector and loads no tools of the server', async () => {
      const { controller, registry, roles, executor } = setup();
      await controller.isolationTests(asReq(EDITOR), SERVER);
      expect(registry.getAllTools).not.toHaveBeenCalled();
      expect(roles.getAllowedToolIds).not.toHaveBeenCalled();
      expect(executor.executeTool).not.toHaveBeenCalled();
    });

    it('is closed to viewers and to servers of other organizations', async () => {
      const { controller } = setup();
      await expect(controller.isolationTests(asReq(VIEWER), SERVER)).rejects.toThrow(ForbiddenException);
      const other = setup({ server: { id: SERVER, name: 'Shop', organizationId: 'org-b', isActive: true } });
      await expect(other.controller.isolationTests(asReq(EDITOR), SERVER)).rejects.toThrow(NotFoundException);
    });

    it('answers 429 rather than a wall of false failures when the organization is at its limit', async () => {
      const { controller, sandbox } = setup();
      sandbox.run.mockResolvedValue(failResult('BUSY'));
      const err = await controller.isolationTests(asReq(EDITOR), SERVER).catch((e) => e);
      expect(err.getStatus()).toBe(429);
    });
  });

  describe('script list', () => {
    it('leaves the code out unless asked for it', async () => {
      const { controller, scripts } = setup();
      await controller.listScripts(asReq(EDITOR), SERVER, {});
      expect(scripts.list).toHaveBeenLastCalledWith(ORG, SERVER, { includeCode: false });
      await controller.listScripts(asReq(EDITOR), SERVER, { includeCode: '1' });
      expect(scripts.list).toHaveBeenLastCalledWith(ORG, SERVER, { includeCode: true });
      await controller.listScripts(asReq(EDITOR), SERVER, { includeCode: '0' });
      expect(scripts.list).toHaveBeenLastCalledWith(ORG, SERVER, { includeCode: false });
    });
  });

  describe('scripts addressed by id', () => {
    it('is switched off together with the rest when SANDBOX_ENABLED=false', async () => {
      process.env.SANDBOX_ENABLED = 'false';
      const { controller, scripts } = setup();
      await expect(controller.getScript(asReq(ADMIN), 's1')).rejects.toThrow(NotFoundException);
      await expect(controller.updateScript(asReq(ADMIN), 's1', { code: 'x' })).rejects.toThrow(
        NotFoundException,
      );
      await expect(controller.deleteScript(asReq(ADMIN), 's1')).rejects.toThrow(NotFoundException);
      expect(scripts.get).not.toHaveBeenCalled();
    });

    it('cannot reach a script of another organization', async () => {
      const { controller, scripts } = setup();
      scripts.get.mockRejectedValue(new NotFoundException('Script not found'));
      await expect(
        controller.getScript(asReq({ ...EDITOR, organizationId: 'org-b' }), 'script-of-org-a'),
      ).rejects.toThrow(NotFoundException);
      expect(scripts.get).toHaveBeenCalledWith('org-b', 'script-of-org-a');
    });
  });
});
