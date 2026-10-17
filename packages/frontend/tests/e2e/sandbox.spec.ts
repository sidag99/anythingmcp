import { expect, test, type Page, type Route } from '@playwright/test';

// Code mode (/sandbox): scripts an agent runs next to the data. The API is mocked, as in the
// other smoke tests; the real thing is exercised by scripts/sandbox-e2e and sandbox-demo.

const SERVER = { id: 'srv-1', name: 'Demo ERP', slug: 'demo-erp' };

const SCRIPT = {
  id: 'scr-1',
  name: 'delayed_orders',
  description: 'Orders delivered after the promised date.',
  version: 1,
  createdById: 'u1',
  ownedByYou: true,
  lastRunAt: null,
  lastRunOk: null,
  lastRunMeta: null,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  code: "const res = await tools.erp_orders_export({ from: '2026-09-01', to: '2026-10-01' });\nreturn { delayed: res.rows.length };",
};

const RUN_OK = {
  runId: 'run-1',
  ok: true,
  result: { delayed: 922 },
  meta: { ms: 78, connectorCalls: 1, bytesFromConnectors: 1_220_000, bytesReturned: 17, logs: [], toolsCalled: ['erp_orders_export'] },
  script: { id: 'scr-1', name: 'delayed_orders', version: 1, ownedByYou: true },
};

const ISOLATION = [
  { id: 'a', name: 'No network', claim: '`fetch` does not exist.', specRef: '§9 #2', expectedCode: 'OK', actualCode: 'OK', passed: true, ms: 4 },
  { id: 'b', name: 'Infinite loop is killed', claim: 'Stopped at the wall-clock limit.', specRef: '§9 #4', expectedCode: 'TIMEOUT', actualCode: 'TIMEOUT', passed: true, ms: 1000 },
];

async function session(page: Page, role: 'ADMIN' | 'VIEWER', options: { off?: boolean } = {}) {
  const user = { id: 'u1', email: 'test@example.com', name: 'Test User', role, organizationId: 'o1', emailVerified: true };
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' }]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, user);

  await page.route(/\/(api|health)\//, async (route: Route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/health/server-info')) {
      return json({ deploymentMode: 'self-hosted', mcpAuthMode: 'both', serverUrl: 'http://localhost:4000', mcpEndpoint: 'http://localhost:4000/mcp', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(user);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role, joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/mcp-servers')) return json([SERVER]);

    if (url.includes('/api/sandbox/')) {
      if (options.off) return json({ statusCode: 404, message: 'Code mode is turned off on this instance.' }, 404);
      if (url.endsWith('/isolation-tests')) return json(ISOLATION);
      if (url.endsWith('/run')) return json(RUN_OK);
      if (url.includes('/runs')) return json([]);
      if (url.endsWith('/scripts') && method === 'GET') return json([SCRIPT]);
      if (url.endsWith('/scripts/scr-1') && method === 'GET') return json(SCRIPT);
    }
    return json([]);
  });
}

test.describe('code mode', () => {
  test('an administrator reads a saved script and runs it', async ({ page }) => {
    await session(page, 'ADMIN');
    await page.goto('/sandbox');

    await expect(page.getByRole('tablist', { name: 'Code mode' })).toBeVisible();
    await page.getByTestId('script-row').filter({ hasText: 'delayed_orders' }).click();
    await expect(page.locator('pre').first()).toContainText('erp_orders_export');

    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const result = page.getByTestId('run-result');
    await expect(result).toContainText('Succeeded');
    await expect(result).toContainText('"delayed": 922');
    // The point of code mode: much was pulled in next to the data, little went back.
    await expect(result).toContainText('1.16 MB');
    await expect(result).toContainText('17 B');
  });

  test('the isolation tab runs the suite and shows each attempt', async ({ page }) => {
    await session(page, 'ADMIN');
    await page.goto('/sandbox');

    await page.getByRole('tab', { name: 'Isolation tests' }).click();
    await page.getByRole('button', { name: 'Run isolation suite' }).click();
    await expect(page.getByTestId('isolation-results')).toContainText('2 of 2 passed');
    await expect(page.getByTestId('isolation-row')).toHaveCount(2);
    await expect(page.locator('[data-testid="isolation-row"][data-passed="true"]')).toHaveCount(2);
  });

  test('a viewer can read scripts but not write or run them', async ({ page }) => {
    await session(page, 'VIEWER');
    await page.goto('/sandbox');

    await page.getByTestId('script-row').first().click();
    await expect(page.getByText('Viewers can read scripts but not run them.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New script' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  });

  test('says so when code mode is turned off on the instance', async ({ page }) => {
    await session(page, 'ADMIN', { off: true });
    await page.goto('/sandbox');

    await expect(page.getByText('SANDBOX_ENABLED=false')).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Code mode' })).toHaveCount(0);
  });
});
