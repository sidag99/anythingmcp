// Seeds the real-stack scenario through AnythingMCP's own API, plus SQL for the one
// thing the API cannot do on a community instance (a second customer's user).
// Writes .state.json for e2e.mjs.
//
// FOR A THROWAWAY DATABASE ONLY: it creates users, organizations and connectors.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = process.env.AMCP_URL ?? 'http://127.0.0.1:4000';
const DB = process.env.DATABASE_URL ?? 'postgresql://amcp:amcp-test@127.0.0.1:5433/anythingmcp';
const PASSWORD = 'Sup3r-Secret-Pass!';

async function api(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}
const sql = (q) => execFileSync('psql', [DB, '-tAc', q], { encoding: 'utf8' }).trim();

async function account(email, name) {
  // Log in first: the auth endpoints are rate limited, and re-registering is noise.
  try {
    const r = await api('POST', '/api/auth/login', null, { email, password: PASSWORD });
    return { id: r.user.id, token: r.accessToken };
  } catch (e) {
    if (!String(e.message).includes('401')) throw e;
  }
  const r = await api('POST', '/api/auth/register', null, { email, password: PASSWORD, name, acceptTerms: true });
  return { id: r.user.id, token: r.accessToken };
}
const login = async (email) => (await api('POST', '/api/auth/login', null, { email, password: PASSWORD })).accessToken;

const tools = (list) => JSON.stringify(list);
const ORDERS_TOOL = {
  name: 'shop_list_orders',
  description: 'List orders of the web shop. Filter by status (delivered, delayed, shipped, cancelled); limit caps the rows.',
  parameters: { type: 'object', properties: { status: { type: 'string', description: 'Order status' }, limit: { type: 'integer', description: 'Maximum rows' } } },
  endpointMapping: { method: 'GET', path: '/orders', queryParams: { status: '$status', limit: '$limit' } },
};

// ---- accounts -------------------------------------------------------------
const admin = await account('admin@a.test', 'Alice Admin');
const editor = await account('editor@a.test', 'Eddie Editor');
const viewer = await account('viewer@a.test', 'Vera Viewer');

// The community edition caps an instance at 3 users, so Customer B's only user is
// created in the database: a copy of the admin row (same password), in org B.
sql(`INSERT INTO organizations(id,name,created_at,updated_at) VALUES ('org-customer-b','Customer B',now(),now()) ON CONFLICT DO NOTHING`);
if (sql(`SELECT count(*) FROM users WHERE email='bob@b.test'`) === '0') {
  sql(`CREATE TEMP TABLE bob_row AS SELECT * FROM users WHERE email='admin@a.test';
       UPDATE bob_row SET id='user-bob', email='bob@b.test', name='Bob (Customer B)', organization_id='org-customer-b', role='ADMIN';
       INSERT INTO users SELECT * FROM bob_row;`);
  sql(`INSERT INTO organization_members(id,user_id,organization_id,role,joined_at) VALUES ('om-bob','user-bob','org-customer-b','ADMIN',now()) ON CONFLICT DO NOTHING`);
}
const bob = { id: 'user-bob' };

await api('PUT', `/api/users/${viewer.id}/role`, admin.token, { role: 'VIEWER' });

// Tokens from the first login are reused (the JWT strategy reads the role from the
// database on every request, so the viewer's token already reflects the demotion).
const tok = {
  admin: admin.token,
  editor: editor.token,
  viewer: viewer.token,
  bob: await login('bob@b.test'),
};
const orgA = sql(`SELECT organization_id FROM users WHERE id='${admin.id}'`);

// ---- customer A: shop connectors, one server ------------------------------
const connShop = await api('POST', '/api/connectors', tok.admin, {
  name: 'Shop API (A)', type: 'REST', baseUrl: 'http://127.0.0.1:9101', authType: 'NONE',
});
await api('POST', `/api/connectors/${connShop.id}/import`, tok.admin, {
  source: 'json',
  content: tools([
    ORDERS_TOOL,
    {
      name: 'shop_create_refund',
      description: 'Refund an order. Changes data.',
      parameters: { type: 'object', properties: { orderId: { type: 'integer' } }, required: ['orderId'] },
      endpointMapping: { method: 'POST', path: '/refunds', bodyMapping: { orderId: '$orderId' } },
    },
  ]),
});

const connAuth = await api('POST', '/api/connectors', tok.admin, {
  name: 'Shop API (A, authenticated)', type: 'REST', baseUrl: 'http://127.0.0.1:9101',
  authType: 'BEARER_TOKEN', authConfig: { token: 'sk-live-SECRET-123456789' },
});
await api('POST', `/api/connectors/${connAuth.id}/import`, tok.admin, {
  source: 'json',
  content: tools([
    { name: 'shop_echo', description: 'Echoes the request headers (an upstream that reflects credentials).', parameters: { type: 'object', properties: {} }, endpointMapping: { method: 'GET', path: '/echo' } },
    { name: 'shop_hang', description: 'An endpoint that never answers.', parameters: { type: 'object', properties: {} }, endpointMapping: { method: 'GET', path: '/hang' } },
    { name: 'shop_export_big', description: 'Exports about `mb` megabytes of orders.', parameters: { type: 'object', properties: { mb: { type: 'integer' } } }, endpointMapping: { method: 'GET', path: '/big', queryParams: { mb: '$mb' } } },
  ]),
});

const serverA = await api('POST', '/api/mcp-servers', tok.admin, { name: 'Shop A', description: 'Customer A shop' });
await api('PUT', `/api/mcp-servers/${serverA.id}/connectors`, tok.admin, { connectorIds: [connShop.id, connAuth.id] });

// ---- a connector that holds its credential the documented way (an environment
// variable referenced from authConfig), next to the literal-token one above ----
const connEnv = await api('POST', '/api/connectors', tok.admin, {
  name: 'Shop API (A, env-var token)', type: 'REST', baseUrl: 'http://127.0.0.1:9101',
  authType: 'BEARER_TOKEN', authConfig: { token: '{{SHOP_TOKEN}}' },
});
await api('PUT', `/api/connectors/${connEnv.id}/env-vars`, tok.admin, { envVars: { SHOP_TOKEN: 'sk-live-ENVVAR-987654321' } });
await api('POST', `/api/connectors/${connEnv.id}/import`, tok.admin, { source: 'json', content: tools([
  { name: 'shop_echo_env', description: 'Echoes the request headers (credential held as an environment variable).', parameters: { type: 'object', properties: {} }, endpointMapping: { method: 'GET', path: '/echo' } },
]) });
await api('PUT', `/api/mcp-servers/${serverA.id}/connectors`, tok.admin, { connectorIds: [connShop.id, connAuth.id, connEnv.id] });

// ---- customer B: same tool name, different data ---------------------------
const connB = await api('POST', '/api/connectors', tok.bob, {
  name: 'Shop API (B)', type: 'REST', baseUrl: 'http://127.0.0.1:9102', authType: 'NONE',
});
await api('POST', `/api/connectors/${connB.id}/import`, tok.bob, { source: 'json', content: tools([ORDERS_TOOL]) });
const serverB = await api('POST', '/api/mcp-servers', tok.bob, { name: 'Shop B' });
await api('PUT', `/api/mcp-servers/${serverB.id}/connectors`, tok.bob, { connectorIds: [connB.id] });

// ---- a role that lets the editor call the orders tool only ----------------
const full = await api('GET', `/api/connectors/${connShop.id}`, tok.admin);
const ordersToolId = full.tools.find((t) => t.name === 'shop_list_orders').id;
const role = await api('POST', '/api/roles', tok.admin, { name: 'orders-only', description: 'May read orders, nothing else' });
await api('PUT', `/api/roles/${role.id}/tools`, tok.admin, { toolIds: [ordersToolId] });
await api('PUT', `/api/roles/assignments/${editor.id}`, tok.admin, { roleIds: [role.id] });

const state = {
  api: API, db: DB, password: PASSWORD, orgA, orgB: 'org-customer-b',
  users: { admin: admin.id, editor: editor.id, viewer: viewer.id, bob: bob.id },
  tokens: tok,
  connectors: { shop: connShop.id, auth: connAuth.id, authEnv: connEnv.id, b: connB.id },
  servers: { a: serverA.id, b: serverB.id },
  ordersToolId, roleId: role.id,
};
writeFileSync(`${HERE}/.state.json`, JSON.stringify(state, null, 2));
console.log('seeded:', JSON.stringify({ orgA, serverA: serverA.id, serverB: serverB.id }));
