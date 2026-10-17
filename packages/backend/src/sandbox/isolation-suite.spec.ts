import { ISOLATION_CASES, runIsolationSuite } from './isolation-suite';
import { SandboxService } from './sandbox.service';
import type { SandboxRunResult } from './types';

jest.setTimeout(60_000);

describe('isolation suite (spec §9)', () => {
  let service: SandboxService;

  beforeEach(() => {
    service = new SandboxService();
  });

  it('passes every case against the real sandbox', async () => {
    const results = await runIsolationSuite(service, { organizationId: 'org-suite' });
    const failures = results.filter((r) => !r.passed).map((r) => `${r.id}: ${r.detail}`);
    expect(failures).toEqual([]);
    expect(results.map((r) => r.id)).toEqual(ISOLATION_CASES.map((c) => c.id));
  });

  it('covers every row of the spec table, numbered 0 to 10', () => {
    const refs = new Set(ISOLATION_CASES.map((c) => c.specRef));
    for (let i = 0; i <= 10; i++) expect(refs).toContain(`§9 #${i}`);
  });

  it('reports the expected and the actual outcome of each case', async () => {
    const results = await runIsolationSuite(service, { organizationId: 'org-suite' });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId['control']).toMatchObject({ expectedCode: 'OK', actualCode: 'OK' });
    expect(byId['infinite-loop']).toMatchObject({ expectedCode: 'TIMEOUT', actualCode: 'TIMEOUT' });
    expect(byId['cross-tenant-tool']).toMatchObject({
      expectedCode: 'TOOL_NOT_ALLOWED',
      actualCode: 'TOOL_NOT_ALLOWED',
    });
    for (const r of results) expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('runs as the given organization, so it counts against that organization only', async () => {
    const seen = new Set<string | undefined>();
    const spy = {
      run: jest.fn(async (req: Parameters<SandboxService['run']>[0]) => {
        seen.add(req.invocationContext.organizationId);
        return service.run(req);
      }),
    };
    await runIsolationSuite(spy, { organizationId: 'org-x' });
    expect([...seen]).toEqual(['org-x']);
  });

  // A suite that cannot fail proves nothing: feed it a sandbox that lets everything through.
  describe('a broken sandbox fails the suite', () => {
    const permissive: Pick<SandboxService, 'run'> = {
      run: async (): Promise<SandboxRunResult> => ({
        ok: true,
        result: 'object/object/object',
        meta: { ms: 1, connectorCalls: 0, bytesFromConnectors: 0, bytesReturned: 5, logs: [], toolsCalled: [] },
      }),
    };

    it('flags the isolation cases when the script is allowed to succeed', async () => {
      const results = await runIsolationSuite(permissive, { organizationId: 'org-suite' });
      const failed = new Set(results.filter((r) => !r.passed).map((r) => r.id));
      for (const id of [
        'host-modules',
        'network',
        'infinite-loop',
        'memory-bomb',
        'oversize-return',
        'cross-tenant-tool',
        'call-limit',
        'syntax-error',
      ]) {
        expect(failed).toContain(id);
      }
    });

    it('says what went wrong', async () => {
      const results = await runIsolationSuite(permissive, { organizationId: 'org-suite' });
      const loop = results.find((r) => r.id === 'infinite-loop')!;
      expect(loop.passed).toBe(false);
      expect(loop.actualCode).toBe('OK');
      expect(loop.detail).toMatch(/expected TIMEOUT/);
    });
  });
});
