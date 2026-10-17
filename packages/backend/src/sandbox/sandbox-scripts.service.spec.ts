import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { SandboxScriptsService } from './sandbox-scripts.service';
import type { SandboxRunResult } from './types';

const ORG = 'org-a';
const SERVER = 'srv-1';

function makePrisma() {
  return {
    sandboxScript: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'sc-1', version: 1, ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 'sc-1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    sandboxRun: {
      create: jest.fn().mockResolvedValue({ id: 'run-1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    mcpServerConfig: {
      findFirst: jest.fn().mockResolvedValue({ id: SERVER }),
    },
  };
}

const okResult = (result: unknown): SandboxRunResult => ({
  ok: true,
  result,
  meta: {
    ms: 12,
    connectorCalls: 2,
    bytesFromConnectors: 5000,
    bytesReturned: 20,
    logs: [],
    toolsCalled: ['erp_orders_list'],
  },
});

describe('SandboxScriptsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: SandboxScriptsService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new SandboxScriptsService(prisma as any);
  });

  describe('tenant scoping', () => {
    it('filters every read by organization', async () => {
      await service.list(ORG, SERVER);
      await service.get(ORG, 'sc-1').catch(() => undefined);
      await service.getByName(ORG, SERVER, 'x');
      await service.listRuns(ORG, SERVER);
      expect(prisma.sandboxScript.findMany.mock.calls[0][0].where).toEqual({
        organizationId: ORG,
        mcpServerId: SERVER,
      });
      expect(prisma.sandboxScript.findFirst.mock.calls[0][0].where).toEqual({
        id: 'sc-1',
        organizationId: ORG,
      });
      expect(prisma.sandboxScript.findFirst.mock.calls[1][0].where).toEqual({
        organizationId: ORG,
        mcpServerId: SERVER,
        name: 'x',
      });
      expect(prisma.sandboxRun.findMany.mock.calls[0][0].where).toEqual({
        organizationId: ORG,
        mcpServerId: SERVER,
      });
    });

    it('scopes update and delete by organization, so another org\'s id is not found', async () => {
      await service.update(ORG, 'sc-1', { code: 'return 1' });
      expect(prisma.sandboxScript.update.mock.calls[0][0].where).toEqual({
        id: 'sc-1',
        organizationId: ORG,
      });
      prisma.sandboxScript.deleteMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.remove('org-b', 'sc-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.sandboxScript.deleteMany).toHaveBeenCalledWith({
        where: { id: 'sc-1', organizationId: 'org-b' },
      });
    });

    it('maps a missing record on update to NotFound', async () => {
      prisma.sandboxScript.update.mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'P2025' }),
      );
      await expect(service.update('org-b', 'sc-1', { code: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses to create a script on a server outside the organization', async () => {
      prisma.mcpServerConfig.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create(ORG, 'srv-of-other-org', 'u1', { name: 'abc', code: 'return 1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.mcpServerConfig.findFirst.mock.calls[0][0].where).toEqual({
        id: 'srv-of-other-org',
        organizationId: ORG,
      });
      expect(prisma.sandboxScript.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('leaves the code out unless asked', async () => {
      await service.list(ORG, SERVER);
      await service.list(ORG, SERVER, { includeCode: true });
      expect(prisma.sandboxScript.findMany.mock.calls[0][0].select.code).toBe(false);
      expect(prisma.sandboxScript.findMany.mock.calls[1][0].select.code).toBe(true);
    });
  });

  describe('create', () => {
    it.each(['A', 'a', '1abc', 'has space', 'UPPER', 'a'.repeat(65), '../x', ''])(
      'rejects the name %j',
      async (name) => {
        await expect(
          service.create(ORG, SERVER, 'u1', { name, code: 'return 1' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.sandboxScript.create).not.toHaveBeenCalled();
      },
    );

    it('stores the script for the caller\'s organization and server', async () => {
      await service.create(ORG, SERVER, 'u1', {
        name: 'delayed_orders-1',
        code: 'return 1',
        description: 'd',
      });
      expect(prisma.sandboxScript.create.mock.calls[0][0].data).toMatchObject({
        organizationId: ORG,
        mcpServerId: SERVER,
        createdById: 'u1',
        name: 'delayed_orders-1',
      });
    });

    it('reports a duplicate name as a conflict', async () => {
      prisma.sandboxScript.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      );
      await expect(
        service.create(ORG, SERVER, undefined, { name: 'abc', code: 'return 1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('bumps the version only when the code changes', async () => {
      await service.update(ORG, 'sc-1', { code: 'return 2' });
      await service.update(ORG, 'sc-1', { description: 'only text' });
      expect(prisma.sandboxScript.update.mock.calls[0][0].data).toEqual({
        code: 'return 2',
        version: { increment: 1 },
      });
      expect(prisma.sandboxScript.update.mock.calls[1][0].data).toEqual({
        description: 'only text',
      });
    });

    it('requires something to change', async () => {
      await expect(service.update(ORG, 'sc-1', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets the author edit by name within the caller\'s server', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce({ id: 'sc-9', createdById: 'u1' });
      await service.updateByName(ORG, SERVER, 'abc', { code: 'return 3' }, 'u1');
      expect(prisma.sandboxScript.findFirst.mock.calls[0][0].where).toEqual({
        organizationId: ORG,
        mcpServerId: SERVER,
        name: 'abc',
      });
      expect(prisma.sandboxScript.update.mock.calls[0][0].where.id).toBe('sc-9');
    });

    it('refuses an edit by anyone but the author, so planted code cannot run with someone else\'s authority', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce({ id: 'sc-9', createdById: 'u-admin' });
      await expect(
        service.updateByName(ORG, SERVER, 'monthly_report', { code: 'await tools.delete_all({})' }, 'u-low'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.sandboxScript.update).not.toHaveBeenCalled();
    });

    it('treats an unidentified editor as a different person from an identified author', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce({ id: 'sc-9', createdById: 'u1' });
      await expect(
        service.updateByName(ORG, SERVER, 'abc', { code: 'x' }, undefined),
      ).rejects.toBeInstanceOf(ForbiddenException);
      prisma.sandboxScript.findFirst.mockResolvedValueOnce({ id: 'sc-9', createdById: null });
      await expect(
        service.updateByName(ORG, SERVER, 'abc', { code: 'x' }, 'u1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.sandboxScript.update).not.toHaveBeenCalled();
    });

    it('lets scripts made without a user (auth disabled) be edited without one', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce({ id: 'sc-9', createdById: null });
      await service.updateByName(ORG, SERVER, 'abc', { code: 'return 3' }, undefined);
      expect(prisma.sandboxScript.update).toHaveBeenCalledTimes(1);
    });

    it('reports an unknown name as not found', async () => {
      await expect(
        service.updateByName(ORG, SERVER, 'nope', { code: 'x' }, 'u1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('recordRun', () => {
    it('stores the run and refreshes the saved script\'s last-run summary', async () => {
      const id = await service.recordRun({
        organizationId: ORG,
        mcpServerId: SERVER,
        scriptId: 'sc-1',
        userId: 'u1',
        code: 'return 1',
        args: { month: 'previous' },
        result: okResult({ delayed: 3 }),
      });
      expect(id).toBe('run-1');
      const data = prisma.sandboxRun.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        organizationId: ORG,
        mcpServerId: SERVER,
        scriptId: 'sc-1',
        ok: true,
        errorCode: null,
        resultPreview: { delayed: 3 },
        args: { month: 'previous' },
      });
      expect(prisma.sandboxScript.updateMany).toHaveBeenCalledWith({
        where: { id: 'sc-1', organizationId: ORG },
        data: expect.objectContaining({
          lastRunOk: true,
          lastRunMeta: { ms: 12, connectorCalls: 2, bytesFromConnectors: 5000, bytesReturned: 20 },
        }),
      });
    });

    it('stores inline runs without touching any script', async () => {
      await service.recordRun({
        organizationId: ORG,
        mcpServerId: SERVER,
        code: 'return 1',
        result: okResult(1),
      });
      expect(prisma.sandboxScript.updateMany).not.toHaveBeenCalled();
    });

    it('keeps a failed run\'s error code and no result preview', async () => {
      await service.recordRun({
        organizationId: ORG,
        mcpServerId: SERVER,
        code: 'while(true){}',
        result: {
          ok: false,
          error: { code: 'TIMEOUT', message: 'Script did not finish within 10000 ms.' },
          meta: okResult(null).meta,
        },
      });
      const data = prisma.sandboxRun.create.mock.calls[0][0].data;
      expect(data.ok).toBe(false);
      expect(data.errorCode).toBe('TIMEOUT');
      expect(data.resultPreview).toBe(Prisma.JsonNull);
    });

    it('stores a null result as JSON null, not a missing value', async () => {
      await service.recordRun({
        organizationId: ORG,
        mcpServerId: SERVER,
        code: 'return null',
        result: okResult(null),
      });
      expect(prisma.sandboxRun.create.mock.calls[0][0].data.resultPreview).toBe(Prisma.JsonNull);
    });

    it('bounds a large result preview', async () => {
      const big = Array.from({ length: 5000 }, (_, i) => ({ id: i, text: 'x'.repeat(100) }));
      await service.recordRun({
        organizationId: ORG,
        mcpServerId: SERVER,
        code: 'return big',
        result: okResult(big),
      });
      const preview = prisma.sandboxRun.create.mock.calls[0][0].data.resultPreview;
      expect(JSON.stringify(preview).length).toBeLessThan(20 * 1024);
    });

    it('never throws when storage fails', async () => {
      prisma.sandboxRun.create.mockRejectedValueOnce(new Error('db down'));
      await expect(
        service.recordRun({
          organizationId: ORG,
          mcpServerId: SERVER,
          code: 'return 1',
          result: okResult(1),
        }),
      ).resolves.toBeNull();
    });
  });

  describe('listRuns', () => {
    it('clamps the page size', async () => {
      await service.listRuns(ORG, SERVER, 100000);
      await service.listRuns(ORG, SERVER, -5);
      await service.listRuns(ORG, SERVER, Number.NaN);
      expect(prisma.sandboxRun.findMany.mock.calls.map((c) => c[0].take)).toEqual([200, 1, 50]);
    });

    it('lists every run of the server unless narrowed to one user', async () => {
      await service.listRuns(ORG, SERVER);
      await service.listRuns(ORG, SERVER, 10, 'u1');
      expect(prisma.sandboxRun.findMany.mock.calls[0][0].where).toEqual({
        organizationId: ORG,
        mcpServerId: SERVER,
      });
      expect(prisma.sandboxRun.findMany.mock.calls[1][0].where).toEqual({
        organizationId: ORG,
        mcpServerId: SERVER,
        userId: 'u1',
      });
    });
  });

  describe('dashboard access (by id)', () => {
    it('finds a script only on the server it belongs to', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce({ id: 'sc-1', mcpServerId: SERVER });
      await service.getForServer(ORG, SERVER, 'sc-1');
      expect(prisma.sandboxScript.findFirst.mock.calls[0][0].where).toEqual({
        id: 'sc-1',
        organizationId: ORG,
        mcpServerId: SERVER,
      });
      await expect(service.getForServer(ORG, 'srv-2', 'sc-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('lets the author edit by id', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce({ id: 'sc-1', name: 'abc', createdById: 'u1' });
      await service.updateByIdAsAuthor(ORG, 'sc-1', { code: 'return 2' }, 'u1');
      expect(prisma.sandboxScript.findFirst.mock.calls[0][0].where).toEqual({
        id: 'sc-1',
        organizationId: ORG,
      });
      expect(prisma.sandboxScript.update.mock.calls[0][0]).toMatchObject({
        where: { id: 'sc-1', organizationId: ORG },
        data: { code: 'return 2', version: { increment: 1 } },
      });
    });

    it('refuses an edit by anyone but the author, administrators included', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce({ id: 'sc-1', name: 'abc', createdById: 'u-low' });
      await expect(
        service.updateByIdAsAuthor(ORG, 'sc-1', { code: 'await tools.x({})' }, 'u-admin'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.sandboxScript.update).not.toHaveBeenCalled();
    });

    it('does not edit a script of another organization', async () => {
      await expect(
        service.updateByIdAsAuthor('org-b', 'sc-1', { code: 'x' }, 'u1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.sandboxScript.update).not.toHaveBeenCalled();
    });

    it('lets the author delete their script', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce({ id: 'sc-1', createdById: 'u1' });
      await service.removeAsUser(ORG, 'sc-1', { userId: 'u1', isAdmin: false });
      expect(prisma.sandboxScript.deleteMany).toHaveBeenCalledWith({
        where: { id: 'sc-1', organizationId: ORG },
      });
    });

    it('lets an administrator delete anyone\'s script', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce({ id: 'sc-1', createdById: 'u-low' });
      await service.removeAsUser(ORG, 'sc-1', { userId: 'u-admin', isAdmin: true });
      expect(prisma.sandboxScript.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('refuses a delete by someone who is neither the author nor an administrator', async () => {
      prisma.sandboxScript.findFirst.mockResolvedValueOnce({ id: 'sc-1', createdById: 'u1' });
      await expect(
        service.removeAsUser(ORG, 'sc-1', { userId: 'u2', isAdmin: false }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.sandboxScript.deleteMany).not.toHaveBeenCalled();
    });

    it('does not delete a script of another organization, even for an administrator', async () => {
      await expect(
        service.removeAsUser('org-b', 'sc-1', { userId: 'u-admin', isAdmin: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.sandboxScript.deleteMany).not.toHaveBeenCalled();
    });
  });
});
