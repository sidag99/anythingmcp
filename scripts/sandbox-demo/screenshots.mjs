#!/usr/bin/env node
/**
 * Drives the real dashboard with a browser and saves screenshots of code mode,
 * against a running backend and frontend that have the demo seeded.
 *
 *   AMCP_EMAIL=admin@example.com AMCP_PASSWORD=... node scripts/sandbox-demo/screenshots.mjs
 *
 * Needs the backend (AMCP_API, default http://localhost:4000), the frontend, and Playwright's
 * Chromium (`npx playwright install chromium`), or CHROMIUM_PATH pointing at an installed one.
 * The pictures go to docs/sandbox/screenshots. Any browser console error or uncaught exception
 * is printed and makes the exit code non-zero, so this doubles as a smoke test of the page.
 *
 * Environment: AMCP_UI (default http://localhost:3000), AMCP_EMAIL, AMCP_PASSWORD;
 * optional AMCP_VIEWER_TOKEN for the read-only screenshot, and DEMO_SERVER / BIG_SERVER
 * (the names of the two servers to show; defaults "koch-demo" and "Shop A").
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'docs/sandbox/screenshots');
const BASE = (process.env.AMCP_UI ?? 'http://localhost:3000').replace(/\/$/, '');
const DEMO_SERVER = process.env.DEMO_SERVER ?? 'koch-demo';
const BIG_SERVER = process.env.BIG_SERVER ?? 'Shop A';

if (!process.env.AMCP_EMAIL || !process.env.AMCP_PASSWORD) {
  console.error('Set AMCP_EMAIL and AMCP_PASSWORD.');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const problems = [];
const watch = (page, label) => {
  page.on('pageerror', (e) => problems.push(`[${label}] uncaught: ${e.message}`));
  page.on('console', (m) => {
    // A 4xx from a request the page makes on purpose is not a defect of the page.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[${label}] console: ${m.text()}`);
  });
};
const shot = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`saved ${name}.png`);
};
async function chooseServer(page, name) {
  await page.getByRole('combobox', { name: 'MCP server' }).click();
  await page.getByRole('option', { name }).click();
  await page.waitForTimeout(300);
}
const tab = (page, name) => page.getByRole('tab', { name }).click();

// CHROMIUM_PATH: use a Chromium that is already installed instead of Playwright's own build.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  // ---- sign in ---------------------------------------------------------------
  // Sign in through the API and hand the session to the page the way the login form does
  // (cookie + localStorage), as the Playwright tests do. The form itself detours through
  // email verification and a first-run questionnaire that a demo account has not done.
  const API = (process.env.AMCP_API ?? 'http://localhost:4000').replace(/\/$/, '');
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.AMCP_EMAIL, password: process.env.AMCP_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`login failed: HTTP ${loginRes.status} ${await loginRes.text()}`);
  const session = await loginRes.json();
  // Tall enough that the result panels are not cut off by the dashboard's own scroll area.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1300 } });
  await ctx.addCookies([{ name: 'amcp_token', value: session.accessToken, url: BASE }]);
  await ctx.addInitScript(([token, user]) => {
    localStorage.setItem('amcp_token', token);
    localStorage.setItem('amcp_user', user);
  }, [session.accessToken, JSON.stringify({ ...session.user, emailVerified: true })]);
  const page = await ctx.newPage();
  watch(page, 'admin');

  await page.goto(`${BASE}/sandbox`);
  await expect(page.getByRole('tablist', { name: 'Code mode' })).toBeVisible();
  await chooseServer(page, DEMO_SERVER);

  // ---- 1. a saved script, read ------------------------------------------------
  await page.getByTestId('script-row').filter({ hasText: 'delayed_orders_last_month' }).click();
  await expect(page.locator('pre').first()).toContainText('erp_orders_export');
  await shot(page, '01-scripts');

  // ---- 2. ...and run: the data-flow line is the point of code mode -------------
  await page.locator('#script-args').fill('{"asOf": "2026-10-15"}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-result')).toContainText('Succeeded', { timeout: 30_000 });
  await expect(page.getByTestId('run-result')).toContainText('"delayedOrders": 922');
  await shot(page, '02-script-run');

  // ---- 3. write a script, save it, run it, delete it ---------------------------
  await page.getByRole('button', { name: 'New script' }).click();
  await page.locator('#script-name').fill('top_categories_this_year');
  await page.locator('#script-desc').fill('Revenue of the three biggest categories this year');
  await page.getByLabel('Script code').fill(`const items = await tools.erp_order_items_list({ from: '2026-01-01', to: '2027-01-01', limit: 200000 });
const products = await tools.erp_products_list({});
const category = Object.fromEntries(products.rows.map((p) => [p.id, p.category]));
const totals = {};
for (const i of items.rows) totals[category[i.product_id]] = (totals[category[i.product_id]] ?? 0) + i.qty * i.price;
const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 3);
return Object.fromEntries(top.map(([c, v]) => [c, Math.round(v * 100) / 100]));
`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved top_categories_this_year', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-result')).toContainText('Succeeded', { timeout: 30_000 });
  await shot(page, '03-new-script');
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page.getByTestId('script-row').filter({ hasText: 'top_categories_this_year' })).toHaveCount(0);

  // ---- 4. run history ----------------------------------------------------------
  await tab(page, 'Runs');
  await expect(page.getByTestId('run-row').first()).toBeVisible();
  await page.getByTestId('run-row').first().click();
  await shot(page, '04-runs');

  // ---- 5. the isolation suite: the judges' screen ------------------------------
  await tab(page, 'Isolation tests');
  await page.getByRole('button', { name: 'Run isolation suite' }).click();
  await expect(page.getByTestId('isolation-results')).toContainText('passed', { timeout: 60_000 });
  await expect(page.getByTestId('isolation-row').first()).toBeVisible();
  const rows = await page.getByTestId('isolation-row').count();
  const passed = await page.locator('[data-testid="isolation-row"][data-passed="true"]').count();
  console.log(`isolation suite on screen: ${passed} of ${rows} passed`);
  if (passed !== rows) problems.push(`isolation suite shows ${rows - passed} failing row(s)`);
  await shot(page, '05-isolation');

  // ---- 6. benchmark: the demo question -----------------------------------------
  await tab(page, 'Benchmark');
  await page.getByRole('button', { name: /Use the demo question/ }).click();
  await page.getByRole('button', { name: 'Run both' }).click();
  await expect(page.getByTestId('benchmark-result')).toContainText('Sandbox script', { timeout: 60_000 });
  await shot(page, '06-benchmark');

  // ---- 7. benchmark: the 44 MB response of the brief ---------------------------
  await chooseServer(page, BIG_SERVER);
  await tab(page, 'Benchmark');
  await page.getByRole('combobox', { name: 'Tool to call directly' }).click();
  await page.getByRole('option', { name: 'shop_export_big' }).click();
  await page.locator('#bench-tool-args').fill('{"mb": 44}');
  await page.locator('#bench-code').fill(`// About 44 MB of orders: count the delivered ones inside the gateway.
const rows = await tools.shop_export_big({ mb: 44 });
let delivered = 0;
for (const o of rows) if (o.status === 'delivered') delivered++;
return { rows: rows.length, delivered };
`);
  await page.getByRole('button', { name: 'Run both' }).click();
  await expect(page.getByTestId('reduction-bytes')).toBeVisible({ timeout: 90_000 });
  await shot(page, '07-benchmark-44mb');

  // ---- 8. a viewer: read-only ---------------------------------------------------
  if (process.env.AMCP_VIEWER_TOKEN) {
    const viewerCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await viewerCtx.addCookies([{ name: 'amcp_token', value: process.env.AMCP_VIEWER_TOKEN, url: BASE }]);
    await viewerCtx.addInitScript((token) => {
      localStorage.setItem('amcp_token', token);
      localStorage.setItem('amcp_user', JSON.stringify({ id: 'viewer', email: 'viewer@a.test', name: 'Vera Viewer', role: 'VIEWER', organizationId: 'x', emailVerified: true }));
    }, process.env.AMCP_VIEWER_TOKEN);
    const vp = await viewerCtx.newPage();
    watch(vp, 'viewer');
    await vp.goto(`${BASE}/sandbox`);
    await expect(vp.getByRole('tablist', { name: 'Code mode' })).toBeVisible();
    await chooseServer(vp, DEMO_SERVER);
    await vp.getByTestId('script-row').first().click();
    await expect(vp.getByText('Viewers can read scripts but not run them.')).toBeVisible();
    await expect(vp.getByRole('button', { name: 'New script' })).toHaveCount(0);
    await shot(vp, '08-viewer-read-only');
    await viewerCtx.close();
  }

  // ---- 9. a phone ---------------------------------------------------------------
  const phoneCtx = await browser.newContext({ ...(await ctx.storageState().then((s) => ({ storageState: s }))), viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();
  watch(phone, 'phone');
  await phone.goto(`${BASE}/sandbox`);
  await expect(phone.getByRole('tablist', { name: 'Code mode' })).toBeVisible();
  await chooseServer(phone, DEMO_SERVER);
  await tab(phone, 'Isolation tests');
  await phone.getByRole('button', { name: 'Run isolation suite' }).click();
  await expect(phone.getByTestId('isolation-results')).toContainText('passed', { timeout: 60_000 });
  await shot(phone, '09-phone-isolation');
  await phoneCtx.close();
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('\nNo console errors or uncaught exceptions.');
