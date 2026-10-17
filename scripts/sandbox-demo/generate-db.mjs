#!/usr/bin/env node
/**
 * Generates the Codebound demo ERP: a SQLite file big enough to make the "large
 * tool result" problem real, plus the ground-truth answers to the benchmark
 * questions.
 *
 *   node scripts/sandbox-demo/generate-db.mjs [--out packages/backend/demo]
 *
 * Deterministic: the same seed gives the same file and the same answers, on any
 * machine and on any day. "Today" is a fixed anchor date (below); the questions
 * are asked "as of" that date, so the ground truth never goes stale.
 *
 * The ground truth is computed here, in plain JavaScript, from the generated
 * arrays, not by querying the database. It is therefore independent of the SQL,
 * the connector, the sandbox and the scripts that are checked against it.
 */
import { mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outArg = process.argv.indexOf('--out');
const OUT_DIR = resolve(ROOT, outArg > -1 ? process.argv[outArg + 1] : 'packages/backend/demo');

export const SEED = 20261017;
export const ANCHOR = '2026-10-15'; // "today" for the demo data and its questions
const N = { customers: 2_000, products: 500, orders: 150_000, itemsPerOrder: 3 };
const HISTORY_DAYS = 548; // about 18 months

// ---- deterministic random numbers (mulberry32) ------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];
const cents = (x) => Math.round(x * 100) / 100;

// ---- dates as YYYY-MM-DD (strings compare correctly) ------------------------
const DAY = 86_400_000;
const toTime = (iso) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (iso, n) => toIso(toTime(iso) + n * DAY);
const daysBetween = (a, b) => Math.round((toTime(b) - toTime(a)) / DAY);

// ---- the data ---------------------------------------------------------------
const COUNTRIES = ['DE', 'AT', 'CH', 'FR', 'IT', 'ES', 'NL', 'PL', 'SE', 'DK'];
const CITIES = ['Freiburg', 'Berlin', 'Vienna', 'Zurich', 'Lyon', 'Milan', 'Madrid', 'Utrecht', 'Krakow', 'Malmö', 'Aarhus', 'Munich'];
const SEGMENTS = ['Enterprise', 'SMB', 'Retail'];
const CATEGORIES = ['Fasteners', 'Tools', 'Electrical', 'Plumbing', 'Safety', 'Packaging', 'Lighting', 'Automotive'];

const customers = Array.from({ length: N.customers }, (_, i) => ({
  id: i + 1,
  name: `Customer ${String(i + 1).padStart(4, '0')} GmbH`,
  city: pick(CITIES),
  country: pick(COUNTRIES),
  segment: pick(SEGMENTS),
}));
const products = Array.from({ length: N.products }, (_, i) => ({
  id: i + 1,
  sku: `SKU-${String(i + 1).padStart(5, '0')}`,
  name: `Product ${i + 1}`,
  category: CATEGORIES[i % CATEGORIES.length],
  unit_price: cents(2.5 + rand() * 397.5),
}));

const orders = [];
const items = [];
for (let id = 1; id <= N.orders; id++) {
  const ordered_at = addDays(ANCHOR, -int(0, HISTORY_DAYS - 1));
  const promised_at = addDays(ordered_at, int(3, 10));
  const r = rand();
  let delivered_at = null;
  if (r >= 0.03) {
    // 3% still open; of the rest, 12 points of 97 are late.
    delivered_at = r < 0.15 ? addDays(promised_at, int(1, 14)) : addDays(promised_at, -int(0, 2));
    if (delivered_at <= ordered_at) delivered_at = addDays(ordered_at, 1);
    if (delivered_at > ANCHOR) delivered_at = null; // not yet delivered "today"
  }
  const status = delivered_at === null ? 'open' : delivered_at > promised_at ? 'delayed' : 'delivered';
  let total = 0;
  for (let k = 0; k < N.itemsPerOrder; k++) {
    const p = products[int(0, N.products - 1)];
    const qty = int(1, 5);
    items.push({ order_id: id, product_id: p.id, qty, price: p.unit_price });
    total += qty * p.unit_price;
  }
  orders.push({ id, customer_id: int(1, N.customers), ordered_at, promised_at, delivered_at, status, total: cents(total) });
}

// ---- write the SQLite file ---------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, 'koch-demo.sqlite');
rmSync(file, { force: true });
const db = new Database(file);
db.pragma('journal_mode = OFF');
db.exec(`
  CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT, country TEXT, segment TEXT);
  CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT, name TEXT, category TEXT, unit_price REAL);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, ordered_at TEXT, promised_at TEXT, delivered_at TEXT, status TEXT, total REAL);
  CREATE TABLE order_items (order_id INTEGER, product_id INTEGER, qty INTEGER, price REAL);
`);
const load = (sql, rows, fields) => {
  const stmt = db.prepare(sql);
  db.transaction(() => rows.forEach((r) => stmt.run(...fields.map((f) => r[f]))))();
};
load('INSERT INTO customers VALUES (?,?,?,?,?)', customers, ['id', 'name', 'city', 'country', 'segment']);
load('INSERT INTO products VALUES (?,?,?,?,?)', products, ['id', 'sku', 'name', 'category', 'unit_price']);
load('INSERT INTO orders VALUES (?,?,?,?,?,?,?)', orders, ['id', 'customer_id', 'ordered_at', 'promised_at', 'delivered_at', 'status', 'total']);
load('INSERT INTO order_items VALUES (?,?,?,?)', items, ['order_id', 'product_id', 'qty', 'price']);
db.exec(`
  CREATE INDEX orders_ordered_at ON orders(ordered_at);
  CREATE INDEX orders_customer ON orders(customer_id);
  CREATE INDEX items_order ON order_items(order_id);
`);
db.close();

// ---- ground truth, from the arrays above ------------------------------------
const asOf = new Date(`${ANCHOR}T00:00:00Z`);
const y = asOf.getUTCFullYear();
const m = asOf.getUTCMonth();
const q = Math.floor(m / 3);
const monthStart = toIso(Date.UTC(y, m - 1, 1));
const monthEnd = toIso(Date.UTC(y, m, 1));
const quarterStart = toIso(Date.UTC(y, (q - 1) * 3, 1));
const quarterEnd = toIso(Date.UTC(y, q * 3, 1));
const yearStart = `${y}-01-01`;
const yearEnd = `${y + 1}-01-01`;
const within = (o, from, to) => o.ordered_at >= from && o.ordered_at < to;
const isLate = (o) => o.delivered_at !== null && o.delivered_at > o.promised_at;

// 1. Orders delivered late, ordered last month, and the revenue they carried.
const lateLastMonth = orders.filter((o) => within(o, monthStart, monthEnd) && isLate(o));
const q1 = { from: monthStart, to: monthEnd, delayedOrders: lateLastMonth.length, revenue: cents(lateLastMonth.reduce((s, o) => s + o.total, 0)) };

// 2. Revenue by product category for the last full quarter.
const orderById = new Map(orders.map((o) => [o.id, o]));
const productById = new Map(products.map((p) => [p.id, p]));
const perCategory = {};
for (const it of items) {
  if (!within(orderById.get(it.order_id), quarterStart, quarterEnd)) continue;
  const c = productById.get(it.product_id).category;
  perCategory[c] = (perCategory[c] ?? 0) + it.qty * it.price;
}
const q2 = {
  from: quarterStart,
  to: quarterEnd,
  revenueByCategory: Object.fromEntries(Object.entries(perCategory).map(([c, v]) => [c, cents(v)]).sort((a, b) => b[1] - a[1])),
};

// 3. Top 10 customers by cumulative delay days this year.
const perCustomer = new Map();
for (const o of orders) {
  if (!within(o, yearStart, yearEnd) || !isLate(o)) continue;
  const c = perCustomer.get(o.customer_id) ?? { customerId: o.customer_id, delayDays: 0, delayedOrders: 0 };
  c.delayDays += daysBetween(o.promised_at, o.delivered_at);
  c.delayedOrders++;
  perCustomer.set(o.customer_id, c);
}
const q3 = {
  year: y,
  top10: [...perCustomer.values()]
    .sort((a, b) => b.delayDays - a.delayDays || a.customerId - b.customerId)
    .slice(0, 10)
    .map((c) => ({ ...c, name: customers[c.customerId - 1].name })),
};

const counts = {
  customers: customers.length,
  products: products.length,
  orders: orders.length,
  order_items: items.length,
  delayedOrders: orders.filter(isLate).length,
  openOrders: orders.filter((o) => o.delivered_at === null).length,
};
const groundTruth = { seed: SEED, asOf: ANCHOR, counts, q1, q2, q3 };
writeFileSync(join(OUT_DIR, 'ground-truth.json'), JSON.stringify(groundTruth, null, 2) + '\n');

const mb = (statSync(file).size / 1048576).toFixed(1);
console.log(`Wrote ${file} (${mb} MB)`);
console.log(`  ${counts.customers} customers, ${counts.products} products, ${counts.orders} orders, ${counts.order_items} order items`);
console.log(`  delayed: ${counts.delayedOrders} (${((counts.delayedOrders / counts.orders) * 100).toFixed(1)}%), open: ${counts.openOrders} (${((counts.openOrders / counts.orders) * 100).toFixed(1)}%)`);
console.log(`Wrote ${join(OUT_DIR, 'ground-truth.json')} (as of ${ANCHOR})`);
