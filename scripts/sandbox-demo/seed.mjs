#!/usr/bin/env node
/**
 * Seeds the Codebound demo into a running AnythingMCP through its own REST API
 * (so the tool registry is updated live, exactly as when a user does it in the
 * dashboard): a read-only DATABASE connector on the generated SQLite file, five
 * tools with output schemas, an MCP server `koch-demo`, an API key for the demo
 * client, and the three saved scripts.
 *
 *   AMCP_EMAIL=admin@example.com AMCP_PASSWORD=... node scripts/sandbox-demo/seed.mjs
 *
 * Run `node scripts/sandbox-demo/generate-db.mjs` first. Safe to run again: it
 * replaces what it created before.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const API = (process.env.AMCP_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const DB_FILE = resolve(process.env.DEMO_DB ?? `${ROOT}/packages/backend/demo/koch-demo.sqlite`);
const STATE_FILE = resolve(ROOT, 'packages/backend/demo/demo-state.json');
const CONNECTOR_NAME = 'KOCH Demo ERP';
const SERVER_NAME = 'koch-demo';

if (!existsSync(DB_FILE)) {
  console.error(`No demo database at ${DB_FILE}. Run: node scripts/sandbox-demo/generate-db.mjs`);
  process.exit(1);
}
if (!process.env.AMCP_EMAIL || !process.env.AMCP_PASSWORD) {
  console.error('Set AMCP_EMAIL and AMCP_PASSWORD to an administrator of the instance.');
  process.exit(1);
}

async function api(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

// ---- tools ------------------------------------------------------------------
// Optional filters carry a default that matches everything: the SQL is a template
// and an omitted parameter would otherwise stay in it as text.
const DATE_FROM = { type: 'string', default: '0000-01-01', description: 'First day to include, YYYY-MM-DD (inclusive)' };
const DATE_TO = { type: 'string', default: '9999-12-31', description: 'Day to stop before, YYYY-MM-DD (exclusive)' };
const LIMIT = { type: 'integer', default: 1000, description: 'Maximum rows to return' };
const OFFSET = { type: 'integer', default: 0, description: 'Rows to skip, for paging' };

const resultOf = (columns) => ({
  type: 'object',
  properties: {
    rows: { type: 'array', items: { type: 'object', properties: columns } },
    totalRows: { type: 'number', description: 'Rows the query matched' },
    truncated: { type: 'boolean', description: 'True when more rows matched than were returned' },
  },
});
const ORDER_COLUMNS = {
  id: { type: 'integer' },
  customer_id: { type: 'integer' },
  ordered_at: { type: 'string', description: 'YYYY-MM-DD' },
  promised_at: { type: 'string', description: 'YYYY-MM-DD' },
  delivered_at: { type: 'string', description: 'YYYY-MM-DD, null while undelivered' },
  status: { type: 'string', description: 'delivered, delayed (delivered after promised_at) or open' },
  total: { type: 'number' },
};
const ORDER_SELECT = 'SELECT id, customer_id, ordered_at, promised_at, delivered_at, status, total FROM orders';

const TOOLS = [
  {
    name: 'erp_orders_list',
    description:
      'Orders, one page at a time (default 1000 rows). Filter by order date and by status ' +
      '(delivered, delayed, open). A delayed order was delivered after its promised date.',
    parameters: {
      type: 'object',
      properties: {
        from: DATE_FROM,
        to: DATE_TO,
        status: { type: 'string', default: '%', description: 'delivered, delayed or open; % for all' },
        limit: LIMIT,
        offset: OFFSET,
      },
    },
    outputSchema: resultOf(ORDER_COLUMNS),
    endpointMapping: {
      method: 'query',
      path: `${ORDER_SELECT} WHERE ordered_at >= \${from} AND ordered_at < \${to} AND status LIKE \${status} ORDER BY id LIMIT \${limit} OFFSET \${offset}`,
    },
  },
  {
    name: 'erp_orders_export',
    description:
      'Every order in a date range in one response, without paging (up to the connector limit of ' +
      '200,000 rows). Large: prefer a script for anything that only needs a count, a sum or a ranking.',
    parameters: { type: 'object', properties: { from: DATE_FROM, to: DATE_TO } },
    outputSchema: resultOf(ORDER_COLUMNS),
    endpointMapping: {
      method: 'query',
      path: `${ORDER_SELECT} WHERE ordered_at >= \${from} AND ordered_at < \${to} ORDER BY id`,
    },
  },
  {
    name: 'erp_order_items_list',
    description:
      'Order lines (order_id, product_id, qty, price) of the orders placed in a date range, or of one order. ' +
      'Paged: default 1000 rows; pass a larger limit to read more in one call.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'integer', default: 0, description: 'One order; 0 for all' },
        from: DATE_FROM,
        to: DATE_TO,
        limit: LIMIT,
        offset: OFFSET,
      },
    },
    outputSchema: resultOf({
      order_id: { type: 'integer' },
      product_id: { type: 'integer' },
      qty: { type: 'integer' },
      price: { type: 'number' },
    }),
    endpointMapping: {
      method: 'query',
      path:
        'SELECT i.order_id, i.product_id, i.qty, i.price FROM order_items i JOIN orders o ON o.id = i.order_id ' +
        'WHERE o.ordered_at >= ${from} AND o.ordered_at < ${to} AND (${order_id} = 0 OR i.order_id = ${order_id}) ' +
        'ORDER BY i.order_id LIMIT ${limit} OFFSET ${offset}',
    },
  },
  {
    name: 'erp_customers_list',
    description: 'Customers, optionally of one country (DE, AT, CH, FR, IT, ES, NL, PL, SE, DK).',
    parameters: { type: 'object', properties: { country: { type: 'string', default: '%', description: 'Country code; % for all' } } },
    outputSchema: resultOf({
      id: { type: 'integer' },
      name: { type: 'string' },
      city: { type: 'string' },
      country: { type: 'string' },
      segment: { type: 'string' },
    }),
    endpointMapping: { method: 'query', path: 'SELECT id, name, city, country, segment FROM customers WHERE country LIKE ${country} ORDER BY id' },
  },
  {
    name: 'erp_products_list',
    description: 'Products with their category and unit price, optionally of one category.',
    parameters: { type: 'object', properties: { category: { type: 'string', default: '%', description: 'Category name; % for all' } } },
    outputSchema: resultOf({
      id: { type: 'integer' },
      sku: { type: 'string' },
      name: { type: 'string' },
      category: { type: 'string' },
      unit_price: { type: 'number' },
    }),
    endpointMapping: { method: 'query', path: 'SELECT id, sku, name, category, unit_price FROM products WHERE category LIKE ${category} ORDER BY id' },
  },
];

// ---- the three saved scripts --------------------------------------------------
// They read `args.asOf` (YYYY-MM-DD, default today) so that the demo answers are
// the ones in ground-truth.json, whatever day it is run.
const PRELUDE = `const asOf = args.asOf ? new Date(args.asOf + 'T00:00:00Z') : new Date();
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const y = asOf.getUTCFullYear(), m = asOf.getUTCMonth();
const cents = (x) => Math.round(x * 100) / 100;`;

const SCRIPTS = [
  {
    name: 'delayed_orders_last_month',
    description: 'Orders of last month that were delivered after the promised date, and the revenue they carried.',
    code: `${PRELUDE}
const from = iso(Date.UTC(y, m - 1, 1)), to = iso(Date.UTC(y, m, 1));
const res = await tools.erp_orders_export({ from, to });
if (res.truncated) throw new Error('The order list was cut at ' + res.rows.length + ' rows; narrow the range.');
const late = res.rows.filter((o) => o.delivered_at && o.delivered_at > o.promised_at);
return { from, to, delayedOrders: late.length, revenue: cents(util.sum(late, (o) => o.total)) };`,
  },
  {
    name: 'revenue_by_category_q3',
    description: 'Revenue by product category for the last full quarter (Q3 when run in Q4).',
    code: `${PRELUDE}
const q = Math.floor(m / 3);
const from = iso(Date.UTC(y, (q - 1) * 3, 1)), to = iso(Date.UTC(y, q * 3, 1));
const products = await tools.erp_products_list({});
const category = Object.fromEntries(products.rows.map((p) => [p.id, p.category]));
const items = await tools.erp_order_items_list({ from, to, limit: 200000 });
if (items.truncated) throw new Error('The order lines were cut at ' + items.rows.length + ' rows; narrow the range.');
const totals = {};
for (const i of items.rows) totals[category[i.product_id]] = (totals[category[i.product_id]] ?? 0) + i.qty * i.price;
const revenueByCategory = Object.fromEntries(Object.entries(totals).map(([c, v]) => [c, cents(v)]).sort((a, b) => b[1] - a[1]));
return { from, to, revenueByCategory };`,
  },
  {
    name: 'top10_customers_by_delay_days',
    description: 'The ten customers whose late orders add up to the most delay days this year.',
    code: `${PRELUDE}
const from = y + '-01-01', to = (y + 1) + '-01-01';
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const res = await tools.erp_orders_export({ from, to });
if (res.truncated) throw new Error('The order list was cut at ' + res.rows.length + ' rows; narrow the range.');
const per = {};
for (const o of res.rows) {
  if (!o.delivered_at || o.delivered_at <= o.promised_at) continue;
  const c = (per[o.customer_id] ??= { customerId: o.customer_id, delayDays: 0, delayedOrders: 0 });
  c.delayDays += days(o.promised_at, o.delivered_at);
  c.delayedOrders++;
}
const top = Object.values(per).sort((a, b) => b.delayDays - a.delayDays || a.customerId - b.customerId).slice(0, 10);
const customers = await tools.erp_customers_list({});
const name = Object.fromEntries(customers.rows.map((c) => [c.id, c.name]));
return { year: y, top10: top.map((t) => ({ ...t, name: name[t.customerId] })) };`,
  },
];

// ---- go ---------------------------------------------------------------------
const login = await api('POST', '/api/auth/login', null, { email: process.env.AMCP_EMAIL, password: process.env.AMCP_PASSWORD });
const token = login.accessToken;

// Replace what an earlier run created.
for (const c of await api('GET', '/api/connectors', token)) {
  if (c.name === CONNECTOR_NAME) await api('DELETE', `/api/connectors/${c.id}`, token);
}
for (const s of await api('GET', '/api/mcp-servers', token)) {
  if (s.name === SERVER_NAME) await api('DELETE', `/api/mcp-servers/${s.id}`, token);
}

const connector = await api('POST', '/api/connectors', token, {
  name: CONNECTOR_NAME,
  type: 'DATABASE',
  baseUrl: `sqlite://${DB_FILE}`,
  authType: 'CONNECTION_STRING',
  // readOnly: the engine refuses anything but a read, and scripts may use the
  // tools. maxRows: lets one call return a whole date range (default is 1000).
  config: { readOnly: true, maxRows: 200000 },
});
await api('POST', `/api/connectors/${connector.id}/import`, token, { source: 'json', content: JSON.stringify(TOOLS) });

const server = await api('POST', '/api/mcp-servers', token, {
  name: SERVER_NAME,
  description: 'Codebound demo: an ERP with 150,000 orders',
  instructions: 'Use sandbox_run_script for anything that needs a count, a sum or a ranking over many rows.',
});
await api('PUT', `/api/mcp-servers/${server.id}/connectors`, token, { connectorIds: [connector.id] });
const key = await api('POST', '/api/mcp-keys', token, { name: 'koch-demo client', mcpServerId: server.id });

const scripts = {};
for (const s of SCRIPTS) {
  const created = await api('POST', `/api/sandbox/servers/${server.id}/scripts`, token, s);
  if (!created.syntax.ok) throw new Error(`Script ${s.name} does not parse: ${JSON.stringify(created.syntax)}`);
  scripts[s.name] = created.id;
}

writeFileSync(
  STATE_FILE,
  JSON.stringify({ api: API, serverId: server.id, connectorId: connector.id, apiKey: key.key, scripts }, null, 2) + '\n',
);
console.log(`Seeded "${SERVER_NAME}" (${server.id}) with ${TOOLS.length} tools and ${SCRIPTS.length} saved scripts.`);
console.log(`MCP endpoint: ${API}/mcp/${server.id}`);
console.log(`API key (also in ${STATE_FILE}): ${key.key}`);
