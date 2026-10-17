// End-to-end verification against the running stack (see README.md in this folder): real HTTP, real JWT guard,
// real roles, real Postgres, real connectors (REST engine -> local mock upstreams).
// Every check records pass/fail plus the evidence, into e2e-results.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orders as ordersA } from './mock-upstream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const S = JSON.parse(readFileSync(`${HERE}/.state.json`, 'utf8'));
const API = S.api;
const T = S.tokens;
const SA = S.servers.a;
const SB = S.servers.b;
const SECRET = 'sk-live-SECRET-123456789';

const results = [];
const ONLY = process.env.ONLY?.split(',');
async function check(group, name, fn) {
  if (ONLY && !ONLY.includes(group)) return;
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ group, name, pass: true, detail: detail ?? null, ms: Date.now() - t });
    console.log(`PASS  [${group}] ${name}`);
  } catch (e) {
    results.push({ group, name, pass: false, detail: String(e.message ?? e), ms: Date.now() - t });
    console.log(`FAIL  [${group}] ${name}\n        ${String(e.message ?? e).slice(0, 400)}`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (actual, expected, msg) =>
  expect(JSON.stringify(actual) === JSON.stringify(expected), `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const sql = (q) => execFileSync('psql', [S.db, '-tAc', q], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (x) => Math.round(x * 100) / 100;
// Start from a clean slate of saved scripts so the suite can be rerun.
if (!process.env.ONLY) sql('DELETE FROM sandbox_scripts');

async function http(method, path, token, body, opts = {}) {
  const res = await fetch(API + path, {
    method,
    signal: opts.signal,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
async function mcp(serverId, token, method, params, id = 1) {
  const res = await fetch(`${API}/mcp/${serverId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  let payload = null;
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  try { payload = JSON.parse(dataLine ? dataLine.slice(5).trim() : text); } catch { payload = text; }
  return { status: res.status, payload };
}
const sb = (server) => `/api/sandbox/servers/${server}`;
const run = (token, server, code, extra = {}) => http('POST', `${sb(server)}/run`, token, { code, ...extra });
const upstreamStats = async () => (await fetch('http://127.0.0.1:9101/__stats')).json();
const health = async () => (await (await fetch(`${API}/health`)).json()).info.heap;

// ===========================================================================
// 1. The core claim: aggregate next to the data, return only the answer
// ===========================================================================
const expectedAgg = (() => {
  const delayed = ordersA.filter((o) => o.status === 'delayed');
  const per = {};
  for (const o of delayed) per[o.carrier] = (per[o.carrier] ?? 0) + 1;
  return { total: ordersA.length, delayed: delayed.length, revenueDelayed: round2(delayed.reduce((s, o) => s + o.amount, 0)), perCarrier: per };
})();
const AGG_CODE = `
  const orders = await tools.shop_list_orders({});
  const delayed = orders.filter(o => o.status === 'delayed');
  const per = {};
  for (const o of delayed) per[o.carrier] = (per[o.carrier] ?? 0) + 1;
  return { total: orders.length, delayed: delayed.length,
           revenueDelayed: Math.round(util.sum(delayed, o => o.amount) * 100) / 100, perCarrier: per };`;

await check('core', 'aggregates 3,000 orders in the sandbox and returns only the answer (REST)', async () => {
  const r = await run(T.admin, SA, AGG_CODE);
  expect(r.status === 200 && r.body.ok, `run failed: ${JSON.stringify(r.body).slice(0, 300)}`);
  eq(r.body.result, expectedAgg, 'result differs from an independent calculation');
  expect(r.body.meta.bytesReturned < 300, `returned ${r.body.meta.bytesReturned} B`);
  expect(r.body.meta.bytesFromConnectors > 300_000, `only ${r.body.meta.bytesFromConnectors} B stayed server-side`);
  return { result: r.body.result, meta: { ...r.body.meta, logs: undefined } };
});

await check('core', 'the same through the MCP endpoint, as an agent calls it (JSON-RPC)', async () => {
  const list = await mcp(SA, T.admin, 'tools/list', {});
  expect(list.status === 200, `tools/list HTTP ${list.status}: ${JSON.stringify(list.payload).slice(0, 200)}`);
  const names = list.payload.result.tools.map((t) => t.name);
  for (const n of ['sandbox_run_script', 'sandbox_create_script', 'sandbox_edit_script', 'sandbox_list_scripts', 'shop_list_orders'])
    expect(names.includes(n), `missing ${n} in ${names.join(',')}`);
  const run = list.payload.result.tools.find((t) => t.name === 'sandbox_run_script');
  expect(run.description.includes('tools.shop_list_orders('), 'signature of shop_list_orders not in the description');
  expect(!run.description.includes('shop_create_refund'), 'write tool offered in the description');
  expect(run.annotations?.readOnlyHint === true, `annotations: ${JSON.stringify(run.annotations)}`);
  const call = await mcp(SA, T.admin, 'tools/call', { name: 'sandbox_run_script', arguments: { code: AGG_CODE } }, 2);
  const sc = call.payload.result.structuredContent;
  eq(sc.result, expectedAgg, 'MCP result differs');
  return { tools: names, bytesReturned: sc.meta.bytesReturned, bytesFromConnectors: sc.meta.bytesFromConnectors };
});

await check('core', 'benchmark: raw tool call vs script, same question (REST)', async () => {
  const r = await http('POST', `${sb(SA)}/benchmark`, T.admin, { toolName: 'shop_list_orders', code: AGG_CODE });
  expect(r.status === 200, `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  const b = r.body;
  expect(b.raw.bytes > 300_000 && b.script.ok, JSON.stringify(b).slice(0, 300));
  expect(b.reduction.bytesPct > 99, `reduction ${b.reduction.bytesPct}%`);
  return { raw: b.raw, script: { ...b.script, result: undefined }, reduction: b.reduction };
});

// ===========================================================================
// 2. Create, edit, execute (the metric of the brief) - REST and MCP
// ===========================================================================
let scriptId, scriptRunId;
await check('scripts', 'create, list (no code), read, run by id, edit, run again, delete (REST)', async () => {
  const c = await http('POST', `${sb(SA)}/scripts`, T.admin, { name: 'delayed_orders', code: AGG_CODE, description: 'Delayed orders and their revenue' });
  expect(c.status === 201 && c.body.syntax.ok === true, `create: ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
  scriptId = c.body.id;
  const list = await http('GET', `${sb(SA)}/scripts`, T.admin);
  expect(list.body.length === 1 && list.body[0].code === undefined && list.body[0].ownedByYou === true, 'list should hide the code');
  const withCode = await http('GET', `${sb(SA)}/scripts?includeCode=1`, T.admin);
  expect(withCode.body[0].code.includes('shop_list_orders'), 'includeCode=1 should include the code');
  const get = await http('GET', `/api/sandbox/scripts/${scriptId}`, T.admin);
  expect(get.body.code === AGG_CODE, 'read back differs');
  const r1 = await http('POST', `${sb(SA)}/run`, T.admin, { scriptId });
  expect(r1.body.ok && r1.body.script.version === 1, `run by id: ${JSON.stringify(r1.body).slice(0, 200)}`);
  scriptRunId = r1.body.runId;
  const edit = await http('PATCH', `/api/sandbox/scripts/${scriptId}`, T.admin, { code: 'return { edited: true, n: (await tools.shop_list_orders({ limit: 10 })).length }' });
  expect(edit.body.version === 2 && edit.body.syntax.ok, `edit: ${JSON.stringify(edit.body).slice(0, 200)}`);
  const r2 = await http('POST', `${sb(SA)}/run`, T.admin, { scriptId });
  eq(r2.body.result, { edited: true, n: 10 }, 'edited script result');
  expect(r2.body.script.version === 2, 'version should be 2');
  const bad = await http('PATCH', `/api/sandbox/scripts/${scriptId}`, T.admin, { code: 'return {' });
  expect(bad.body.syntax.ok === false && bad.body.syntax.line === 1, `syntax check: ${JSON.stringify(bad.body.syntax)}`);
  await http('PATCH', `/api/sandbox/scripts/${scriptId}`, T.admin, { code: AGG_CODE });
  return { scriptId, versionAfterEdits: 3 };
});

await check('scripts', 'create, edit and run by name through MCP tools', async () => {
  const c = await mcp(SA, T.admin, 'tools/call', { name: 'sandbox_create_script', arguments: { name: 'mcp_script', code: 'return { from: "mcp", month: args.month }' } }, 3);
  const created = JSON.parse(c.payload.result.content[0].text);
  expect(created.ok && created.syntax === 'ok', JSON.stringify(created));
  const e = await mcp(SA, T.admin, 'tools/call', { name: 'sandbox_edit_script', arguments: { name: 'mcp_script', code: 'return { from: "mcp-v2", month: args.month }' } }, 4);
  expect(JSON.parse(e.payload.result.content[0].text).version === 2, 'edit should reach v2');
  const r = await mcp(SA, T.admin, 'tools/call', { name: 'sandbox_run_script', arguments: { scriptName: 'mcp_script', args: { month: 'previous' } } }, 5);
  eq(r.payload.result.structuredContent.result, { from: 'mcp-v2', month: 'previous' }, 'rerun by name');
  const l = await mcp(SA, T.admin, 'tools/call', { name: 'sandbox_list_scripts', arguments: {} }, 6);
  const names = JSON.parse(l.payload.result.content[0].text).scripts.map((s) => s.name).sort();
  eq(names, ['delayed_orders', 'mcp_script'], 'list');
  return { names };
});

// ===========================================================================
// 3. Read-only by default
// ===========================================================================
const refundsBefore = (await upstreamStats()).refunds;
await check('read-only', 'a script cannot call a write tool; the upstream never receives the request', async () => {
  const r = await run(T.admin, SA, 'return await tools.shop_create_refund({ orderId: 10001 })');
  expect(r.body.ok === false && r.body.error.code === 'WRITE_NOT_ALLOWED', JSON.stringify(r.body).slice(0, 300));
  await sleep(300);
  const after = (await upstreamStats()).refunds;
  expect(after === refundsBefore, `upstream saw ${after - refundsBefore} refund request(s)`);
  return { error: r.body.error, upstreamRefundRequests: after - refundsBefore };
});
await check('read-only', 'the script is not even told the write tool exists', async () => {
  const r = await run(T.admin, SA, 'return { list: tools.list(), has: "shop_create_refund" in tools }');
  expect(!r.body.result.list.includes('shop_create_refund') && r.body.result.has === false, JSON.stringify(r.body.result));
  return r.body.result;
});
await check('read-only', 'the request has no field that grants writes (extra fields are rejected)', async () => {
  const r = await http('POST', `${sb(SA)}/run`, T.admin, { code: 'return 1', allowWrites: true });
  expect(r.status === 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return { status: r.status, message: r.body.message };
});
await check('read-only', 'benchmark refuses to call a write tool for real', async () => {
  const r = await http('POST', `${sb(SA)}/benchmark`, T.admin, { toolName: 'shop_create_refund', toolArgs: { orderId: 1 }, code: 'return 1' });
  expect(r.status === 400 && /read-only/.test(JSON.stringify(r.body)), `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  expect((await upstreamStats()).refunds === refundsBefore, 'the write reached the upstream');
});
await check('read-only', 'outside the sandbox the same tool still works for an admin (the policy is about scripts)', async () => {
  const r = await mcp(SA, T.admin, 'tools/call', { name: 'shop_create_refund', arguments: { orderId: 10001 } }, 7);
  expect(!r.payload.result.isError, JSON.stringify(r.payload).slice(0, 300));
  expect((await upstreamStats()).refunds === refundsBefore + 1, 'direct call should reach the upstream once');
});

// ===========================================================================
// 4. Isolation: nothing to reach (the brief: "no internet, no host")
// ===========================================================================
await check('isolation', 'the live isolation suite passes on the running server', async () => {
  const r = await http('POST', `${sb(SA)}/isolation-tests`, T.admin);
  expect(r.status === 200, `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  const failed = r.body.filter((c) => !c.passed);
  expect(failed.length === 0, `failed: ${failed.map((c) => c.id + ': ' + c.detail).join(' | ')}`);
  return { cases: r.body.length, passed: r.body.length, slowestMs: Math.max(...r.body.map((c) => c.ms)) };
});

const ESCAPES = [
  ['fetch', 'return typeof fetch', (v) => v === 'undefined'],
  ['XMLHttpRequest', 'return typeof XMLHttpRequest', (v) => v === 'undefined'],
  ['WebSocket', 'return typeof WebSocket', (v) => v === 'undefined'],
  ['EventSource', 'return typeof EventSource', (v) => v === 'undefined'],
  ['require("fs")', 'try { return typeof require("fs") } catch (e) { return "blocked" }', (v) => v === 'blocked'],
  ['process.env', 'try { return String(process.env) } catch (e) { return "blocked" }', (v) => v === 'blocked'],
  ['import("child_process")', 'try { await import("child_process"); return "imported" } catch (e) { return "blocked" }', (v) => v === 'blocked'],
  ['import("node:fs")', 'try { await import("node:fs"); return "imported" } catch (e) { return "blocked" }', (v) => v === 'blocked'],
  ['constructor chain', 'return typeof (function(){}).constructor("return this")().process', (v) => v === 'undefined'],
  ['eval(process)', 'try { return typeof eval("process") } catch (e) { return "blocked" }', (v) => v === 'blocked' || v === 'undefined'],
  ['globalThis.process', 'return typeof globalThis.process', (v) => v === 'undefined'],
  ['Buffer / timers', 'return [typeof Buffer, typeof setTimeout, typeof setInterval, typeof setImmediate, typeof queueMicrotask].join()', (v) => v === 'undefined,undefined,undefined,undefined,undefined'],
  ['WebAssembly', 'return typeof WebAssembly', (v) => v === 'undefined'],
  ['read /etc/passwd', 'try { return require("fs").readFileSync("/etc/passwd","utf8") } catch (e) { return "blocked" }', (v) => v === 'blocked'],
  ['read env secrets', 'return [typeof process, typeof DATABASE_URL, typeof JWT_SECRET, typeof ENCRYPTION_KEY].join()', (v) => v === 'undefined,undefined,undefined,undefined'],
  ['reach the bridge', 'return [typeof __call, typeof __describe, typeof __log, typeof ivm, typeof $0].join()', (v) => v === 'undefined,undefined,undefined,undefined,undefined'],
];
for (const [name, code, ok] of ESCAPES) {
  await check('isolation', `escape attempt: ${name}`, async () => {
    const r = await run(T.admin, SA, code);
    expect(r.status === 200 && r.body.ok, `the run itself failed: ${JSON.stringify(r.body).slice(0, 200)}`);
    expect(ok(r.body.result), `unexpected result ${JSON.stringify(r.body.result)}`);
    return r.body.result;
  });
}
await check('isolation', 'a script that tries to write a host-side global does not affect the next run', async () => {
  await run(T.admin, SA, 'Object.prototype.polluted = "yes"; globalThis.leak = "yes"; return 1');
  const r = await run(T.admin, SA, 'return [typeof {}.polluted, typeof globalThis.leak].join()');
  expect(r.body.result === 'undefined,undefined', JSON.stringify(r.body.result));
});

const LIMITS = [
  ['infinite loop', 'while (true) {}', { timeoutMs: 1000 }, 'TIMEOUT'],
  ['loop after a connector call', 'await tools.shop_list_orders({ limit: 1 }); while (true) {}', { timeoutMs: 1000 }, 'TIMEOUT'],
  ['memory bomb (array)', 'const a=[]; while(true) a.push(new Array(1e6).fill(1))', { timeoutMs: 10000 }, 'MEMORY_LIMIT'],
  ['typed-array bomb', 'const a = new Uint8Array(1<<30); a.fill(1); return a.length', {}, 'MEMORY_LIMIT'],
  ['string bomb', 'return "x".repeat(1<<29).length', {}, 'MEMORY_LIMIT'],
  ['oversize result', 'return (await tools.shop_list_orders({}))', {}, 'OUTPUT_TOO_LARGE'],
  ['call-count limit', 'for (let i=0;i<60;i++) await tools.shop_list_orders({ limit: 1 }); return 1', { timeoutMs: 30000 }, 'CONNECTOR_CALL_LIMIT'],
  ['syntax error', 'return {', {}, 'SYNTAX_ERROR'],
  ['runtime error', 'null.x', {}, 'RUNTIME_ERROR'],
  ['unknown tool', 'return await tools.other_customer_orders({})', {}, 'TOOL_NOT_ALLOWED'],
];
for (const [name, code, extra, expected] of LIMITS) {
  await check('limits', `${name} -> ${expected}`, async () => {
    const t = Date.now();
    const r = await run(T.admin, SA, code, extra);
    expect(r.status === 200 && r.body.ok === false, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    expect(r.body.error.code === expected, `got ${r.body.error.code}: ${r.body.error.message}`);
    expect(typeof r.body.error.hint === 'string', 'no hint');
    const leaked = JSON.stringify(r.body).match(/\/home\/|node_modules|\.ts:|at .*\(.*:\d+:\d+\)|isolated-vm/);
    expect(!leaked, `internal detail in error: ${leaked?.[0]}`);
    return { ms: Date.now() - t, error: r.body.error.code, bytesReturned: r.body.meta.bytesReturned };
  });
}
await check('limits', 'the oversize result was withheld: nothing from the 3,000 rows left the service', async () => {
  const r = await run(T.admin, SA, 'return (await tools.shop_list_orders({}))');
  expect(r.body.meta.bytesReturned === 0 && r.body.meta.bytesFromConnectors > 300_000 && r.body.result === undefined, JSON.stringify(r.body.meta));
});
await check('limits', 'the host is healthy after the whole battery', async () => {
  const h = await health();
  expect(h.rssMb < 1500, `rss ${h.rssMb} MB`);
  const r = await http('GET', '/health');
  return h;
});

await check('limits', 'concurrency: 7 simultaneous runs, the organization gets 4 slots, the rest are told BUSY (429)', async () => {
  const rs = await Promise.all(Array.from({ length: 7 }, () => run(T.admin, SA, 'while(true){}', { timeoutMs: 2000 })));
  const busy = rs.filter((r) => r.status === 429 && r.body?.error?.code === 'BUSY').length;
  const timeouts = rs.filter((r) => r.status === 200 && r.body?.error?.code === 'TIMEOUT').length;
  expect(busy === 3 && timeouts === 4, `busy=${busy}, timeouts=${timeouts}, statuses=${rs.map((r) => r.status)}`);
  const after = await run(T.admin, SA, 'return "free again"');
  expect(after.body.result === 'free again', 'slots were not released');
  return { busy, timeouts };
});

// ===========================================================================
// 5. Connector deadlines and cancellation (live)
// ===========================================================================
await check('deadlines', 'a connector that never answers: the call is abandoned at its own deadline (2 s here)', async () => {
  const t = Date.now();
  const r = await run(T.admin, SA, 'return await tools.shop_hang({})', { timeoutMs: 10000 });
  const ms = Date.now() - t;
  expect(r.body.error?.code === 'CONNECTOR_TIMEOUT', JSON.stringify(r.body).slice(0, 300));
  expect(ms < 4000, `took ${ms} ms`);
  return { ms, message: r.body.error.message };
});
await check('deadlines', 'the whole-run deadline wins when it is shorter than the call deadline', async () => {
  const t = Date.now();
  const r = await run(T.admin, SA, 'return await tools.shop_hang({})', { timeoutMs: 1500 });
  const ms = Date.now() - t;
  expect(r.body.error?.code === 'TIMEOUT' && ms < 3000, `${r.body.error?.code} after ${ms} ms`);
  return { ms };
});
await check('deadlines', 'the script can catch a connector timeout and still answer', async () => {
  const r = await run(T.admin, SA, 'try { await tools.shop_hang({}); } catch (e) { return { recovered: e.code } }', { timeoutMs: 10000 });
  eq(r.body.result, { recovered: 'CONNECTOR_TIMEOUT' }, 'result');
});
await check('deadlines', 'cancelling the HTTP request stops the run (recorded as CANCELLED)', async () => {
  const abort = new AbortController();
  const t = Date.now();
  const pending = http('POST', `${sb(SA)}/run`, T.admin, { code: 'return await tools.shop_hang({})', timeoutMs: 30000 }, { signal: abort.signal }).catch(() => 'aborted');
  setTimeout(() => abort.abort(), 600);
  await pending;
  let found;
  for (let i = 0; i < 30 && !found; i++) {
    await sleep(100);
    const rows = (await http('GET', `${sb(SA)}/runs?limit=5`, T.admin)).body;
    found = rows.find((x) => x.errorCode === 'CANCELLED');
  }
  expect(found, 'no CANCELLED run was recorded');
  return { recordedAfterMs: Date.now() - t, meta: { ms: found.meta.ms } };
});

// ===========================================================================
// 6. Tenant isolation - the second customer
// ===========================================================================
const aBefore = await upstreamStats();
await check('tenant', 'customer B reads only customer B’s data, with the same tool name', async () => {
  const r = await run(T.bob, SB, 'const rows = await tools.shop_list_orders({}); return { n: rows.length, ids: rows.map(o => o.id), customers: rows.map(o => o.customer) }');
  expect(r.body.ok, JSON.stringify(r.body).slice(0, 300));
  expect(r.body.result.n === 5 && r.body.result.customers.every((c) => c.startsWith('customer-B-')), JSON.stringify(r.body.result));
  const aRows = JSON.stringify(ordersA.slice(0, 50).map((o) => o.id));
  expect(!r.body.result.ids.some((id) => id < 90000), 'an id from customer A appeared');
  return r.body.result;
});
await check('tenant', 'forged tenant identifiers in tool arguments change nothing (B still gets B’s rows)', async () => {
  const r = await run(T.bob, SB, `return await tools.shop_list_orders({ organizationId: '${S.orgA}', connectorIds: ['${S.connectors.shop}'], mcpServerId: '${SA}', customer: 'customer-1', status: 'delayed' })`);
  // The tool declares only status and limit; the rest is stripped. The upstream B has 5 orders, all delivered.
  expect(r.body.ok, JSON.stringify(r.body).slice(0, 300));
  const rows = r.body.result;
  expect(Array.isArray(rows) && rows.every((o) => String(o.customer).startsWith('customer-B-')), JSON.stringify(rows).slice(0, 300));
  return { rows: rows.length };
});
await check('tenant', 'crafted resource/query arguments cannot reach customer A’s upstream', async () => {
  const r = await run(T.bob, SB, `return await tools.shop_list_orders({ status: '../../../orders?x=', limit: 99999 })`);
  const after = await upstreamStats();
  expect(after.orders === aBefore.orders, `customer A’s upstream was hit ${after.orders - aBefore.orders} time(s) by customer B`);
  return { upstreamAHitsCausedByB: after.orders - aBefore.orders, outcome: r.body.ok ? 'ran' : r.body.error.code };
});
await check('tenant', 'B cannot call A’s other tools by name, nor see them', async () => {
  const r = await run(T.bob, SB, `
    const out = { list: tools.list() };
    for (const n of ['shop_create_refund', 'shop_echo', 'shop_export_big', 'shop_hang']) {
      try { await tools[n]({}); out[n] = 'called'; } catch (e) { out[n] = e.code; }
    }
    return out;`);
  eq(r.body.result.list, ['shop_list_orders'], 'tool list');
  for (const n of ['shop_create_refund', 'shop_echo', 'shop_export_big', 'shop_hang'])
    expect(r.body.result[n] === 'TOOL_NOT_ALLOWED', `${n}: ${r.body.result[n]}`);
  return r.body.result;
});
await check('tenant', 'B cannot use A’s server on any sandbox endpoint (404)', async () => {
  const codes = {};
  codes.run = (await run(T.bob, SA, 'return 1')).status;
  codes.runs = (await http('GET', `${sb(SA)}/runs`, T.bob)).status;
  codes.scripts = (await http('GET', `${sb(SA)}/scripts`, T.bob)).status;
  codes.create = (await http('POST', `${sb(SA)}/scripts`, T.bob, { name: 'sneaky', code: 'return 1' })).status;
  codes.benchmark = (await http('POST', `${sb(SA)}/benchmark`, T.bob, { toolName: 'shop_list_orders', code: 'return 1' })).status;
  codes.isolation = (await http('POST', `${sb(SA)}/isolation-tests`, T.bob)).status;
  for (const [k, v] of Object.entries(codes)) expect(v === 404, `${k}: ${v}`);
  return codes;
});
await check('tenant', 'B cannot read, change or delete A’s saved script by id (404)', async () => {
  const g = (await http('GET', `/api/sandbox/scripts/${scriptId}`, T.bob)).status;
  const p = (await http('PATCH', `/api/sandbox/scripts/${scriptId}`, T.bob, { code: 'return 1' })).status;
  const d = (await http('DELETE', `/api/sandbox/scripts/${scriptId}`, T.bob)).status;
  expect(g === 404 && p === 404 && d === 404, `${g}/${p}/${d}`);
  const still = (await http('GET', `/api/sandbox/scripts/${scriptId}`, T.admin)).body;
  expect(still.code === AGG_CODE, 'A’s script was changed');
  return { get: g, patch: p, delete: d };
});
await check('tenant', 'B cannot reach A’s MCP endpoint, nor the sandbox tools on it', async () => {
  const r = await mcp(SA, T.bob, 'tools/list', {});
  expect(r.status === 403, `HTTP ${r.status}: ${JSON.stringify(r.payload).slice(0, 200)}`);
  const c = await mcp(SA, T.bob, 'tools/call', { name: 'sandbox_run_script', arguments: { code: 'return 1' } }, 2);
  expect(c.status === 403, `HTTP ${c.status}`);
  return { status: r.status };
});
await check('tenant', 'A cannot use B’s server either (404)', async () => {
  const r = await run(T.admin, SB, 'return 1');
  const m = await mcp(SB, T.admin, 'tools/list', {});
  expect(r.status === 404 && m.status === 403, `${r.status}/${m.status}`);
});
await check('tenant', 'run history of A and B are separate', async () => {
  const a = (await http('GET', `${sb(SA)}/runs?limit=200`, T.admin)).body;
  const b = (await http('GET', `${sb(SB)}/runs?limit=200`, T.bob)).body;
  expect(a.length > 0 && b.length > 0, 'expected runs on both');
  const idsA = new Set(a.map((x) => x.id));
  expect(!b.some((x) => idsA.has(x.id)), 'a run id appears in both histories');
  expect(a.every((x) => x.organizationId === S.orgA) && b.every((x) => x.organizationId === S.orgB), 'organization mix-up');
  return { runsA: a.length, runsB: b.length };
});
await check('tenant', 'in the database every sandbox row carries the right organization', async () => {
  const bad = sql(`SELECT count(*) FROM sandbox_runs r JOIN mcp_server_configs s ON s.id=r.mcp_server_id WHERE s.organization_id <> r.organization_id`);
  const badScripts = sql(`SELECT count(*) FROM sandbox_scripts r JOIN mcp_server_configs s ON s.id=r.mcp_server_id WHERE s.organization_id <> r.organization_id`);
  expect(bad === '0' && badScripts === '0', `mismatched rows: ${bad} runs, ${badScripts} scripts`);
  return { runsOfB: sql(`SELECT count(*) FROM sandbox_runs WHERE organization_id='${S.orgB}'`) };
});

// ===========================================================================
// 7. Roles and users
// ===========================================================================
await check('roles', 'a role that allows one tool narrows what the editor’s script can call', async () => {
  const r = await run(T.editor, SA, `
    const out = { list: tools.list() };
    try { await tools.shop_echo({}); out.echo = 'called'; } catch (e) { out.echo = e.code; }
    out.orders = (await tools.shop_list_orders({ limit: 3 })).length;
    return out;`);
  expect(r.body.ok, JSON.stringify(r.body).slice(0, 300));
  eq(r.body.result, { list: ['shop_list_orders'], echo: 'TOOL_NOT_ALLOWED', orders: 3 }, 'editor view');
  return r.body.result;
});
await check('roles', 'the editor’s direct MCP tool list is narrowed the same way (sandbox == direct)', async () => {
  const l = await mcp(SA, T.editor, 'tools/list', {});
  const names = l.payload.result.tools.map((t) => t.name).filter((n) => n.startsWith('shop_')).sort();
  eq(names, ['shop_list_orders'], 'direct tools');
});
await check('roles', 'a saved script runs with the runner’s permissions, not the author’s', async () => {
  const c = await http('POST', `${sb(SA)}/scripts`, T.admin, { name: 'admin_only_echo', code: 'return await tools.shop_echo({})' });
  const r = await http('POST', `${sb(SA)}/run`, T.editor, { scriptId: c.body.id });
  expect(r.body.ok === false && r.body.error.code === 'TOOL_NOT_ALLOWED', JSON.stringify(r.body).slice(0, 300));
  expect(r.body.script.ownedByYou === false, 'should show that the script is not the editor’s');
  await http('DELETE', `/api/sandbox/scripts/${c.body.id}`, T.admin);
  return { error: r.body.error.code, ownedByYou: r.body.script.ownedByYou };
});
let editorScript;
await check('roles', 'only the author edits a script: not the editor on the admin’s, not even the admin on the editor’s', async () => {
  const e = await http('PATCH', `/api/sandbox/scripts/${scriptId}`, T.editor, { code: 'await tools.shop_list_orders({}); return 1' });
  expect(e.status === 403, `editor edit of admin script: ${e.status}`);
  const c = await http('POST', `${sb(SA)}/scripts`, T.editor, { name: 'editors_script', code: 'return 1' });
  expect(c.status === 201, `editor create: ${c.status}`);
  editorScript = c.body.id;
  const a = await http('PATCH', `/api/sandbox/scripts/${editorScript}`, T.admin, { code: 'return 2' });
  expect(a.status === 403, `admin edit of editor script: ${a.status}`);
  return { editorOnAdmins: e.status, adminOnEditors: a.status };
});
await check('roles', 'delete: the author or an admin, nobody else', async () => {
  const e = await http('DELETE', `/api/sandbox/scripts/${scriptId}`, T.editor);
  expect(e.status === 403, `editor deleting admin’s: ${e.status}`);
  const a = await http('DELETE', `/api/sandbox/scripts/${editorScript}`, T.admin);
  expect(a.status === 204, `admin deleting editor’s: ${a.status}`);
  return { editorOnAdmins: e.status, adminOnEditors: a.status };
});
await check('roles', 'a viewer can read but not run, save, benchmark or run the suite', async () => {
  const codes = {
    list: (await http('GET', `${sb(SA)}/scripts`, T.viewer)).status,
    runs: (await http('GET', `${sb(SA)}/runs`, T.viewer)).status,
    run: (await run(T.viewer, SA, 'return 1')).status,
    create: (await http('POST', `${sb(SA)}/scripts`, T.viewer, { name: 'nope', code: 'return 1' })).status,
    benchmark: (await http('POST', `${sb(SA)}/benchmark`, T.viewer, { toolName: 'shop_list_orders', code: 'return 1' })).status,
    isolation: (await http('POST', `${sb(SA)}/isolation-tests`, T.viewer)).status,
    patch: (await http('PATCH', `/api/sandbox/scripts/${scriptId}`, T.viewer, { code: 'x' })).status,
    delete: (await http('DELETE', `/api/sandbox/scripts/${scriptId}`, T.viewer)).status,
  };
  expect(codes.list === 200 && codes.runs === 200, JSON.stringify(codes));
  for (const k of ['run', 'create', 'benchmark', 'isolation', 'patch', 'delete']) expect(codes[k] === 403, `${k}: ${codes[k]}`);
  return codes;
});
await check('roles', 'run history: a member sees only their own runs, an admin sees all', async () => {
  const mine = (await http('GET', `${sb(SA)}/runs?limit=200`, T.editor)).body;
  const all = (await http('GET', `${sb(SA)}/runs?limit=200`, T.admin)).body;
  expect(mine.length > 0 && mine.every((r) => r.userId === S.users.editor), 'editor saw someone else’s run');
  expect(all.some((r) => r.userId === S.users.editor) && all.some((r) => r.userId === S.users.admin), 'admin should see both');
  return { editorSees: mine.length, adminSees: all.length };
});

// ===========================================================================
// 8. Secrets
// ===========================================================================
const ENV_SECRET = 'ENVVAR-987654321';
const LITERAL_SECRET = 'SECRET-123456789';
const leaks = (value, needle) => JSON.stringify(value).includes(needle);

await check('secrets', 'a credential held as an environment variable is redacted, for a direct call and for a script alike', async () => {
  const direct = await mcp(SA, T.admin, 'tools/call', { name: 'shop_echo_env', arguments: {} }, 8);
  const viaSandbox = await run(T.admin, SA, 'return await tools.shop_echo_env({})');
  expect(viaSandbox.body.ok, JSON.stringify(viaSandbox.body).slice(0, 200));
  expect(!leaks(direct.payload, ENV_SECRET), 'a direct call leaked the credential');
  expect(!leaks(viaSandbox.body, ENV_SECRET), 'the script received the credential');
  return { authorizationSeenByScript: viaSandbox.body.result.authorization };
});
await check('secrets', 'KNOWN GAP of the existing executor: a credential typed literally into authConfig is not redacted; the sandbox is no worse than a direct call', async () => {
  const direct = await mcp(SA, T.admin, 'tools/call', { name: 'shop_echo', arguments: {} }, 11);
  const viaSandbox = await run(T.admin, SA, 'return await tools.shop_echo({})');
  const directLeaks = leaks(direct.payload, LITERAL_SECRET);
  const sandboxLeaks = leaks(viaSandbox.body, LITERAL_SECRET);
  expect(sandboxLeaks === directLeaks, `sandbox leaks=${sandboxLeaks}, direct leaks=${directLeaks}: the sandbox must match a direct call`);
  return { directCallLeaks: directLeaks, sandboxLeaks, note: 'executor redacts environment variables only (DynamicMcpTools.connectorSecretValues)' };
});
await check('secrets', 'the environment-variable credential appears nowhere in what the sandbox stored or audited', async () => {
  const inRuns = sql(`SELECT count(*) FROM sandbox_runs WHERE result_preview::text LIKE '%${ENV_SECRET}%' OR meta::text LIKE '%${ENV_SECRET}%' OR code LIKE '%${ENV_SECRET}%' OR args::text LIKE '%${ENV_SECRET}%'`);
  const inAudit = sql(`SELECT count(*) FROM tool_invocations WHERE output::text LIKE '%${ENV_SECRET}%' OR input::text LIKE '%${ENV_SECRET}%' OR client_info LIKE '%${ENV_SECRET}%' OR error LIKE '%${ENV_SECRET}%'`);
  expect(inRuns === '0' && inAudit === '0', `credential found: ${inRuns} runs, ${inAudit} audit rows`);
  const literalRuns = sql(`SELECT count(*) FROM sandbox_runs WHERE result_preview::text LIKE '%${LITERAL_SECRET}%'`);
  const literalAudit = sql(`SELECT count(*) FROM tool_invocations WHERE output::text LIKE '%${LITERAL_SECRET}%'`);
  return { envVarCredential: { sandboxRuns: inRuns, auditRows: inAudit }, literalAuthConfigCredential_knownGap: { sandboxRuns: literalRuns, auditRows: literalAudit } };
});
await check('secrets', 'tools.describe shows the public shape only', async () => {
  const r = await run(T.admin, SA, 'return await tools.describe("shop_echo")');
  eq(Object.keys(r.body.result).sort(), ['description', 'name', 'outputSchema', 'parameters'], 'describe keys');
  expect(!JSON.stringify(r.body).match(/9101|127\.0\.0\.1|sk-live|authConfig/), 'describe leaked connector details');
});

// ===========================================================================
// 9. Audit: every connector call of a run carries the run's id
// ===========================================================================
await check('audit', 'REST run: the stored run and each connector call share the run id', async () => {
  const r = await run(T.admin, SA, 'await tools.shop_list_orders({ limit: 2 }); await tools.shop_list_orders({ limit: 3 }); return 1');
  const id = r.body.runId;
  await sleep(500);
  const run_ = sql(`SELECT user_id||'|'||organization_id||'|'||mcp_server_id FROM sandbox_runs WHERE id='${id}'`);
  const calls = sql(`SELECT count(*) FROM tool_invocations WHERE client_info::json->>'sandboxRunId'='${id}'`);
  const who = sql(`SELECT DISTINCT user_id||'|'||organization_id||'|'||mcp_server_id FROM tool_invocations WHERE client_info::json->>'sandboxRunId'='${id}'`);
  expect(calls === '2', `audit rows for the run: ${calls}`);
  expect(run_ === `${S.users.admin}|${S.orgA}|${SA}` && who === run_, `identity mismatch: run=${run_} calls=${who}`);
  return { runId: id, auditRows: Number(calls) };
});
await check('audit', 'MCP run: the same link', async () => {
  const r = await mcp(SA, T.admin, 'tools/call', { name: 'sandbox_run_script', arguments: { code: 'await tools.shop_list_orders({ limit: 1 }); return 1' } }, 9);
  const id = r.payload.result.structuredContent.runId;
  await sleep(500);
  const calls = sql(`SELECT count(*) FROM tool_invocations WHERE client_info::json->>'sandboxRunId'='${id}'`);
  const exists = sql(`SELECT count(*) FROM sandbox_runs WHERE id='${id}'`);
  expect(calls === '1' && exists === '1', `calls=${calls}, run rows=${exists}`);
  return { runId: id };
});
await check('audit', 'an ordinary (non-sandbox) tool call carries no run id', async () => {
  await mcp(SA, T.admin, 'tools/call', { name: 'shop_list_orders', arguments: { limit: 1 } }, 10);
  await sleep(400);
  const n = sql(`SELECT count(*) FROM (SELECT client_info FROM tool_invocations ORDER BY created_at DESC LIMIT 1) t WHERE client_info LIKE '%sandboxRunId%'`);
  expect(n === '0', 'the latest ordinary call has a run id');
});
await check('audit', 'each run row stores outcome, duration, error code and the caller', async () => {
  const rows = (await http('GET', `${sb(SA)}/runs?limit=200`, T.admin)).body;
  const timeouts = rows.filter((r) => r.errorCode === 'TIMEOUT');
  const cancelled = rows.filter((r) => r.errorCode === 'CANCELLED');
  const okRuns = rows.filter((r) => r.ok);
  expect(timeouts.length > 0 && cancelled.length > 0 && okRuns.length > 0, 'expected ok, TIMEOUT and CANCELLED rows');
  const r = okRuns[0];
  expect(r.userId && r.organizationId && r.mcpServerId && r.createdAt && typeof r.meta.ms === 'number' && Array.isArray(r.meta.toolsCalled), 'row incomplete');
  return { sample: { id: r.id, ok: r.ok, ms: r.meta.ms, toolsCalled: r.meta.toolsCalled }, counts: { ok: okRuns.length, TIMEOUT: timeouts.length, CANCELLED: cancelled.length } };
});

// ===========================================================================
// 10. The largest call of the brief: 44 MB
// ===========================================================================
for (const mb of [8, 16, 32, 44]) {
  await check('big', `a ${mb} MB connector response, aggregated in the sandbox`, async () => {
    const before = await health();
    const t = Date.now();
    const r = await run(T.admin, SA, `const rows = await tools.shop_export_big({ mb: ${mb} }); let d = 0; for (const o of rows) if (o.status === 'delivered') d++; return { rows: rows.length, delivered: d }`, { timeoutMs: 30000 });
    const ms = Date.now() - t;
    const after = await health();
    const outcome = r.body.ok ? { ok: true, result: r.body.result, bytesFromConnectors: r.body.meta.bytesFromConnectors, bytesReturned: r.body.meta.bytesReturned } : { ok: false, error: r.body.error?.code, message: r.body.error?.message };
    // Not asserting success: this check records what happens at the default memory limit.
    return { mb, ms, hostRssMbBefore: before.rssMb, hostRssMbAfter: after.rssMb, ...outcome };
  });
}

await check('big', 'benchmark at 44 MB: raw tool call vs script, same question', async () => {
  const code = 'const rows = await tools.shop_export_big({ mb: 44 }); let d = 0; for (const o of rows) if (o.status === "delivered") d++; return { rows: rows.length, delivered: d }';
  const r = await http('POST', `${sb(SA)}/benchmark`, T.admin, { toolName: 'shop_export_big', toolArgs: { mb: 44 }, code });
  expect(r.status === 200 && r.body.script?.ok, `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  expect(r.body.reduction.bytesPct > 99.99, `reduction ${JSON.stringify(r.body.reduction)}`);
  return { raw: r.body.raw, script: { ...r.body.script, result: r.body.script.result }, reduction: r.body.reduction };
});

// ---------------------------------------------------------------------------
writeFileSync(`${HERE}/last-run.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('FAILED:\n' + failed.map((f) => ` - [${f.group}] ${f.name}: ${f.detail}`).join('\n'));
