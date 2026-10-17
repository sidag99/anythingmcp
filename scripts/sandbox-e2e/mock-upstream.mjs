// Mock "shop" API used as the upstream of a REST connector in the end-to-end run.
// 3,000 deterministic orders, so every aggregate the script computes can be
// cross-checked against an independent calculation.
import http from 'node:http';

const CARRIERS = ['DHL', 'UPS', 'DPD', 'GLS'];
const STATUSES = ['delivered', 'delayed', 'shipped', 'cancelled'];

export const orders = Array.from({ length: 3000 }, (_, i) => ({
  id: 10000 + i,
  customer: `customer-${i % 250}`,
  carrier: CARRIERS[i % 4],
  status: STATUSES[(i * 7) % 4],
  amount: Math.round((10 + ((i * 37) % 490) + ((i % 13) / 10)) * 100) / 100,
  createdAt: new Date(Date.UTC(2026, 8, 1 + (i % 30), i % 24)).toISOString(),
  note: 'Order placed through the web shop; items packed at the Leipzig warehouse.',
}));

export const stats = { orders: 0, refunds: 0, echo: 0, hang: 0 };

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__stats') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(stats));
    }
    if (url.pathname === '/echo') {
      // An upstream that reflects the credentials it was sent, the way a careless API does.
      stats.echo++;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, query: url.search }));
    }
    if (url.pathname === '/hang') {
      stats.hang++; // never answers
      return;
    }
    if (url.pathname === '/orders' && req.method === 'GET') {
      stats.orders++;
      let rows = orders;
      const status = url.searchParams.get('status');
      if (status) rows = rows.filter((o) => o.status === status);
      const limit = Number(url.searchParams.get('limit') || 0);
      if (limit > 0) rows = rows.slice(0, limit);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(rows));
    }
    if (url.pathname === '/big' && req.method === 'GET') {
      // Streams ~mb megabytes of JSON, the "largest call in production" of the brief.
      const mb = Number(url.searchParams.get('mb') || 44);
      res.setHeader('content-type', 'application/json');
      const row = JSON.stringify({ id: 0, customer: 'customer-x', carrier: 'DHL', status: 'delivered', amount: 12.5, createdAt: '2026-09-01T00:00:00.000Z', note: 'x'.repeat(40) });
      const rows = Math.ceil((mb * 1024 * 1024) / (row.length + 1));
      res.write('[');
      let i = 0;
      const pump = () => {
        let ok = true;
        while (i < rows && ok) {
          ok = res.write((i ? ',' : '') + row.replace('"id":0', `"id":${i}`));
          i++;
        }
        if (i < rows) res.once('drain', pump); else res.end(']');
      };
      return pump();
    }
    if (url.pathname === '/refunds' && req.method === 'POST') {
      stats.refunds++;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ refunded: true }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  server.listen(9101, '127.0.0.1', () => console.log('mock shop api (customer A) on :9101'));

  // Customer B: a different tenant whose connector uses the SAME tool names but
  // returns different data. A script must only ever see its own tenant's.
  const ordersB = Array.from({ length: 5 }, (_, i) => ({ id: 90000 + i, customer: 'customer-B-' + i, carrier: 'DHL', status: 'delivered', amount: 1000 + i, createdAt: '2026-09-02T00:00:00.000Z' }));
  http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url.startsWith('/orders') ? JSON.stringify(ordersB) : '{}');
  }).listen(9102, '127.0.0.1', () => console.log('mock shop api (customer B) on :9102'));
}
