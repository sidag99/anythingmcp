#!/usr/bin/env node
/**
 * Benchmark: the three demo questions answered two ways, against the running demo.
 *
 *   conventional  the tool calls an agent has to make when every intermediate
 *                 result travels back through the model (best effort: it uses
 *                 every filter the tools offer, e.g. status=delayed)
 *   raw SQL       a SQL-capable agent that aggregates in the database with the
 *                 connector's own execute_query tool: one call, a small answer
 *   sandbox       one sandbox_run_script call; the rows stay inside the gateway
 *
 *   node scripts/sandbox-demo/benchmark.mjs        (after generate-db.mjs and seed.mjs)
 *
 * MEASURED: tool calls, bytes that reach the model (the text content of each MCP
 * response), wall-clock time (median of 3 runs), and whether the sandbox answer
 * equals the ground truth.
 * ESTIMATED: tokens, as bytes / 4. No language model is involved, so how well a
 * model would read and add up the conventional pages is NOT measured; for that
 * path the check is only that the retrieved data suffices to derive the right answer.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEMO = resolve(ROOT, 'packages/backend/demo');
const state = JSON.parse(readFileSync(`${DEMO}/demo-state.json`, 'utf8'));
const truth = JSON.parse(readFileSync(`${DEMO}/ground-truth.json`, 'utf8'));
const API = state.api;
const RUNS = 3;
const PAGE = 1000; // the tools' default page

// ---- MCP client (JSON-RPC over HTTP, as an agent talks to the endpoint) ------
let id = 0;
async function mcp(token, method, params) {
  const started = performance.now();
  const res = await fetch(`${API}/mcp/${state.serverId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data:'));
  const payload = JSON.parse(data ? data.slice(5).trim() : text);
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return { result: payload.result, ms: performance.now() - started };
}
const modelBytes = (result) => (result.content ?? []).reduce((n, c) => n + Buffer.byteLength(c.text ?? '', 'utf8'), 0);

// Use the demo client's API key, as an agent would.
const token = state.apiKey;
await mcp(token, 'tools/list', {}); // fails early if the key is not accepted

async function direct(name, args) {
  const { result, ms } = await mcp(token, 'tools/call', { name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
  return { body: JSON.parse(result.content[0].text), bytes: modelBytes(result), ms };
}
async function paged(name, args) {
  const rows = [];
  const cost = { calls: 0, bytes: 0, ms: 0 };
  for (let offset = 0; ; offset += PAGE) {
    const r = await direct(name, { ...args, limit: PAGE, offset });
    cost.calls++; cost.bytes += r.bytes; cost.ms += r.ms;
    rows.push(...r.body.rows);
    if (r.body.rows.length < PAGE) break;
  }
  return { rows, cost };
}
const add = (a, b) => ({ calls: a.calls + b.calls, bytes: a.bytes + b.bytes, ms: a.ms + b.ms });

// ---- the answers a model could derive from what it was shown -----------------
const cents = (x) => Math.round(x * 100) / 100;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

const conventional = {
  async q1() {
    const { rows, cost } = await paged('erp_orders_list', { from: truth.q1.from, to: truth.q1.to, status: 'delayed' });
    return { cost, derived: { from: truth.q1.from, to: truth.q1.to, delayedOrders: rows.length, revenue: cents(rows.reduce((s, o) => s + o.total, 0)) } };
  },
  async q2() {
    const p = await direct('erp_products_list', {});
    const items = await paged('erp_order_items_list', { from: truth.q2.from, to: truth.q2.to });
    const category = Object.fromEntries(p.body.rows.map((x) => [x.id, x.category]));
    const totals = {};
    for (const i of items.rows) totals[category[i.product_id]] = (totals[category[i.product_id]] ?? 0) + i.qty * i.price;
    const cost = add(items.cost, { calls: 1, bytes: p.bytes, ms: p.ms });
    return { cost, derived: { from: truth.q2.from, to: truth.q2.to, revenueByCategory: Object.fromEntries(Object.entries(totals).map(([c, v]) => [c, cents(v)])) } };
  },
  async q3() {
    const year = truth.q3.year;
    const late = await paged('erp_orders_list', { from: `${year}-01-01`, to: `${year + 1}-01-01`, status: 'delayed' });
    const c = await direct('erp_customers_list', {});
    const per = new Map();
    for (const o of late.rows) {
      const e = per.get(o.customer_id) ?? { customerId: o.customer_id, delayDays: 0, delayedOrders: 0 };
      e.delayDays += days(o.promised_at, o.delivered_at); e.delayedOrders++; per.set(o.customer_id, e);
    }
    const name = Object.fromEntries(c.body.rows.map((x) => [x.id, x.name]));
    const top10 = [...per.values()].sort((a, b) => b.delayDays - a.delayDays || a.customerId - b.customerId).slice(0, 10).map((t) => ({ ...t, name: name[t.customerId] }));
    return { cost: add(late.cost, { calls: 1, bytes: c.bytes, ms: c.ms }), derived: { year, top10 } };
  },
};

// The strongest baseline for a SQL database: let the database do the arithmetic.
// (A REST, SOAP or OData source has no such tool, which is where a script earns its place.)
const SQL = {
  q1: (t) => `SELECT COUNT(*) AS delayedOrders, ROUND(SUM(total), 2) AS revenue FROM orders WHERE ordered_at >= '${t.q1.from}' AND ordered_at < '${t.q1.to}' AND delivered_at > promised_at`,
  q2: (t) => `SELECT p.category AS category, ROUND(SUM(i.qty * i.price), 2) AS revenue FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id WHERE o.ordered_at >= '${t.q2.from}' AND o.ordered_at < '${t.q2.to}' GROUP BY p.category ORDER BY revenue DESC`,
  q3: (t) => `SELECT o.customer_id AS customerId, CAST(SUM(julianday(o.delivered_at) - julianday(o.promised_at)) AS INTEGER) AS delayDays, COUNT(*) AS delayedOrders, c.name AS name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.ordered_at >= '${t.q3.year}-01-01' AND o.ordered_at < '${t.q3.year + 1}-01-01' AND o.delivered_at > o.promised_at GROUP BY o.customer_id ORDER BY delayDays DESC, o.customer_id ASC LIMIT 10`,
};
const sqlDerive = {
  q1: (rows) => ({ delayedOrders: rows[0].delayedOrders, revenue: rows[0].revenue }),
  q2: (rows) => ({ revenueByCategory: Object.fromEntries(rows.map((r) => [r.category, r.revenue])) }),
  q3: (rows) => ({ top10: rows }),
};
const sqlTruth = {
  q1: (t) => ({ delayedOrders: t.q1.delayedOrders, revenue: t.q1.revenue }),
  q2: (t) => ({ revenueByCategory: t.q2.revenueByCategory }),
  q3: (t) => ({ top10: t.q3.top10 }),
};
async function viaSql(key) {
  const r = await direct('execute_query', { query: SQL[key](truth) });
  return { cost: { calls: 1, bytes: r.bytes, ms: r.ms }, derived: sqlDerive[key](r.body.rows) };
}

async function viaSandbox(scriptName) {
  const { result, ms } = await mcp(token, 'tools/call', { name: 'sandbox_run_script', arguments: { scriptName, args: { asOf: truth.asOf } } });
  const sc = result.structuredContent;
  return { ok: sc.ok, answer: sc.result, error: sc.error, meta: sc.meta, bytes: modelBytes(result), ms };
}

// order-insensitive for objects, order-sensitive for arrays
const same = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const estTokens = (bytes) => Math.ceil(bytes / 4);

const QUESTIONS = [
  { key: 'q1', script: 'delayed_orders_last_month', text: 'How many orders were delayed last month, and what revenue did they carry?' },
  { key: 'q2', script: 'revenue_by_category_q3', text: 'Revenue by product category for the last quarter' },
  { key: 'q3', script: 'top10_customers_by_delay_days', text: 'Top 10 customers by cumulative delay days this year' },
];

const results = [];
for (const q of QUESTIONS) {
  const conv = [], sand = [], sql = [];
  for (let i = 0; i < RUNS; i++) {
    conv.push(await conventional[q.key]());
    sand.push(await viaSandbox(q.script));
    sql.push(await viaSql(q.key));
  }
  // Calls and bytes must not vary between runs; only time does.
  for (const c of conv) if (c.cost.calls !== conv[0].cost.calls || c.cost.bytes !== conv[0].cost.bytes) throw new Error(`${q.key}: conventional cost varies between runs`);
  // The response embeds meta.ms, so its size moves by a few bytes with the timing; what the
  // run did must not move at all.
  for (const s of sand) {
    if (s.meta.connectorCalls !== sand[0].meta.connectorCalls || s.meta.bytesFromConnectors !== sand[0].meta.bytesFromConnectors || Math.abs(s.bytes - sand[0].bytes) > 16) {
      throw new Error(`${q.key}: sandbox cost varies between runs`);
    }
  }

  const c0 = conv[0], s0 = sand[0];
  results.push({
    key: q.key,
    question: q.text,
    conventional: {
      toolCalls: c0.cost.calls,
      bytesToModel: c0.cost.bytes,
      estTokens: estTokens(c0.cost.bytes),
      wallMs: Math.round(median(conv.map((c) => c.cost.ms))),
      fitsIn200kTokenWindow: estTokens(c0.cost.bytes) < 200_000,
      dataSufficesForCorrectAnswer: same(c0.derived, truth[q.key]),
    },
    rawSql: {
      toolCalls: sql[0].cost.calls,
      bytesToModel: sql[0].cost.bytes,
      estTokens: estTokens(sql[0].cost.bytes),
      wallMs: Math.round(median(sql.map((c) => c.cost.ms))),
      correct: same(sql[0].derived, sqlTruth[q.key](truth)),
    },
    sandbox: {
      ok: s0.ok,
      correct: s0.ok && same(s0.answer, truth[q.key]),
      mcpCalls: 1,
      connectorCalls: s0.meta.connectorCalls,
      bytesToModel: s0.bytes,
      estTokens: estTokens(s0.bytes),
      bytesKeptInGateway: s0.meta.bytesFromConnectors,
      serverMs: s0.meta.ms,
      wallMs: Math.round(median(sand.map((s) => s.ms))),
      error: s0.error ?? null,
    },
  });
}

const reduction = (a, b) => (a === 0 ? 0 : cents((1 - b / a) * 100));
for (const r of results) r.reductionBytesPct = reduction(r.conventional.bytesToModel, r.sandbox.bytesToModel);

const out = { measuredAt: 'runtime', asOf: truth.asOf, runsPerMeasurement: RUNS, tokenNote: 'estTokens = bytes / 4 (an estimate; no tokenizer was run)', results };
writeFileSync(`${DEMO}/benchmark-results.json`, JSON.stringify(out, null, 2) + '\n');

// ---- report -------------------------------------------------------------------
const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);
console.log(`\nAs of ${truth.asOf}; ${RUNS} runs each (median time). Tokens are ESTIMATES (bytes / 4).\n`);
for (const r of results) {
  const c = r.conventional, s = r.sandbox, q = r.rawSql;
  console.log(`${r.key.toUpperCase()}  ${r.question}`);
  console.log(`  conventional: ${String(c.toolCalls).padStart(3)} tool calls | ${kb(c.bytesToModel).padStart(9)} to the model | ~${c.estTokens.toLocaleString()} tokens | ${c.wallMs} ms | fits 200k window: ${c.fitsIn200kTokenWindow} | data suffices: ${c.dataSufficesForCorrectAnswer}`);
  console.log(`  raw SQL:      ${String(q.toolCalls).padStart(3)} tool call  | ${kb(q.bytesToModel).padStart(9)} to the model | ~${q.estTokens.toLocaleString()} tokens | ${q.wallMs} ms | correct: ${q.correct}`);
  console.log(`  sandbox:      ${String(s.mcpCalls).padStart(3)} tool call  | ${kb(s.bytesToModel).padStart(9)} to the model | ~${s.estTokens.toLocaleString()} tokens | ${s.wallMs} ms (server ${s.serverMs} ms) | ${s.connectorCalls} connector call(s), ${kb(s.bytesKeptInGateway)} kept in the gateway | correct: ${s.correct}`);
  console.log(`  -> ${r.reductionBytesPct}% fewer bytes reach the model\n`);
}
if (results.some((r) => !r.sandbox.correct)) {
  console.error('A sandbox answer differs from the ground truth.');
  process.exit(1);
}
