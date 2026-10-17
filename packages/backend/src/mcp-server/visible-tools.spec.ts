import type { RegisteredTool } from './tool-registry';
import { isReadOnlyTool, toSandboxTools, visibleServerTools } from './visible-tools';

function tool(over: Partial<RegisteredTool> & { id: string; name: string }): RegisteredTool {
  return {
    connectorId: 'conn-1',
    organizationId: 'org-a',
    description: `${over.name} tool`,
    parameters: { type: 'object', properties: {} },
    connectorType: 'REST',
    connectorConfig: { baseUrl: 'https://api.example.com', authType: 'NONE' },
    endpointMapping: { method: 'GET', path: '/x' },
    ...over,
  };
}

const orders = tool({ id: 't1', name: 'shop_list_orders' });
const refunds = tool({ id: 't2', name: 'shop_create_refund' });
const customers = tool({ id: 't3', name: 'shop_list_customers' });

describe('visibleServerTools', () => {
  it('keeps every tool when the caller is unrestricted (null allow-list)', () => {
    expect(visibleServerTools([orders, refunds, customers], null)).toEqual([
      orders,
      refunds,
      customers,
    ]);
  });

  it('keeps only the tools the role allows, in registration order', () => {
    expect(visibleServerTools([orders, refunds, customers], ['t3', 't1'])).toEqual([
      orders,
      customers,
    ]);
  });

  it('gives a caller with an empty allow-list nothing (fail closed)', () => {
    expect(visibleServerTools([orders, refunds], [])).toEqual([]);
  });

  it('drops tools whose connector is not set up, and keeps ones with no status', () => {
    const pending = tool({ id: 't4', name: 'erp_pending', setupStatus: 'needs_credentials' as any });
    const ready = tool({ id: 't5', name: 'erp_ready', setupStatus: 'ready' });
    expect(visibleServerTools([pending, ready, orders], null)).toEqual([ready, orders]);
  });

  it('keeps the first tool of a duplicated name and reports the skipped copy', () => {
    const copy = tool({ id: 't9', name: 'shop_list_orders', connectorId: 'conn-2' });
    const skipped: RegisteredTool[] = [];
    const out = visibleServerTools([orders, copy], null, (t) => skipped.push(t));
    expect(out).toEqual([orders]);
    expect(skipped).toEqual([copy]);
  });

  it('does not report a duplicate that the role filter already hid', () => {
    const copy = tool({ id: 't9', name: 'shop_list_orders', connectorId: 'conn-2' });
    const skipped: RegisteredTool[] = [];
    // Only the copy is allowed: it becomes the visible one, and nothing is a duplicate.
    const out = visibleServerTools([orders, copy], ['t9'], (t) => skipped.push(t));
    expect(out).toEqual([copy]);
    expect(skipped).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const list = [orders, refunds];
    const allowed = ['t1'];
    visibleServerTools(list, allowed);
    expect(list).toEqual([orders, refunds]);
    expect(allowed).toEqual(['t1']);
  });
});

describe('toSandboxTools', () => {
  it('exposes name, connector, description, schema, output schema and the read-only flag only', () => {
    const t = tool({ id: 't1', name: 'shop_list_orders', outputSchema: { type: 'array' } });
    const [out] = toSandboxTools([t]);
    expect(out).toMatchObject({
      name: 'shop_list_orders',
      connectorId: 'conn-1',
      description: 'shop_list_orders tool',
      parameters: { type: 'object', properties: {} },
      outputSchema: { type: 'array' },
      readOnly: true,
    });
    expect(typeof out.validateArgs).toBe('function');
    expect(Object.keys(out).sort()).toEqual(
      ['connectorId', 'description', 'name', 'outputSchema', 'parameters', 'readOnly', 'validateArgs'],
    );
  });

  it('does not leak connector credentials or endpoints into the script-facing tool', () => {
    const t = tool({
      id: 't1',
      name: 'shop_list_orders',
      connectorConfig: {
        baseUrl: 'https://secret.internal',
        authType: 'API_KEY',
        authConfig: '{"apiKey":"sk-live-123"}',
        headers: { 'X-Token': 'abc' },
      },
    });
    const json = JSON.stringify(toSandboxTools([t]));
    expect(json).not.toContain('sk-live-123');
    expect(json).not.toContain('secret.internal');
    expect(json).not.toContain('X-Token');
  });

  it('hides parameters that the gateway fills from environment variables', () => {
    const t = tool({
      id: 't1',
      name: 'shop_list_orders',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number' }, apiKey: { type: 'string' } },
        required: ['apiKey'],
      },
      connectorConfig: {
        baseUrl: 'https://api.example.com',
        authType: 'NONE',
        envVars: { apiKey: 'from-env' },
      },
    });
    const [out] = toSandboxTools([t]);
    expect(Object.keys((out.parameters as any).properties)).toEqual(['limit']);
  });
});

describe('isReadOnlyTool: only a tool known not to change anything counts', () => {
  const rest = (method: string) => tool({ id: 'x', name: 'x_tool', endpointMapping: { method, path: '/x' } });
  const db = (path: string, config?: Record<string, unknown>) =>
    tool({
      id: 'x',
      name: 'x_tool',
      connectorType: 'DATABASE',
      endpointMapping: { method: 'query', path },
      connectorConfig: { baseUrl: 'sqlite://x', authType: 'NONE', config },
    });

  it.each(['GET', 'HEAD'])('treats REST %s as read-only', (method) => {
    expect(isReadOnlyTool(rest(method))).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('treats REST %s as a write', (method) => {
    expect(isReadOnlyTool(rest(method))).toBe(false);
  });

  it('treats a database connector set to readOnly as read-only, whatever the statement', () => {
    expect(isReadOnlyTool(db('${query}', { readOnly: true }))).toBe(true);
  });

  it('treats a SELECT statement as read-only and a DELETE as a write', () => {
    expect(isReadOnlyTool(db('SELECT id FROM orders'))).toBe(true);
    expect(isReadOnlyTool(db('DELETE FROM orders'))).toBe(false);
  });

  it('treats raw SQL on a connector that does not say it is read-only as unknown, so as a write', () => {
    expect(isReadOnlyTool(db('${query}'))).toBe(false);
  });

  it('treats a kind it cannot tell (SOAP, remote MCP) as a write', () => {
    expect(isReadOnlyTool(tool({ id: 'x', name: 'get_thing', connectorType: 'SOAP' }))).toBe(false);
    expect(isReadOnlyTool(tool({ id: 'x', name: 'get_thing', connectorType: 'MCP' }))).toBe(false);
  });

  it('follows an explicit annotation, which an administrator can set either way', () => {
    expect(isReadOnlyTool(tool({ id: 'x', name: 'x', connectorType: 'SOAP', annotations: { readOnlyHint: true } }))).toBe(true);
    expect(isReadOnlyTool(tool({ id: 'x', name: 'x', annotations: { readOnlyHint: false } }))).toBe(false);
  });
});

describe('toSandboxTools: arguments are checked on the host, like a direct call', () => {
  const withParams = (properties: Record<string, unknown>, required: string[] = []) =>
    toSandboxTools([
      tool({ id: 't1', name: 'shop_list_orders', parameters: { type: 'object', properties, required } }),
    ])[0];

  it('accepts arguments that fit the schema and hands on the parsed value', () => {
    const t = withParams({ limit: { type: 'number' }, status: { type: 'string' } });
    expect(t.validateArgs!({ limit: 10, status: 'delayed' })).toEqual({
      ok: true,
      args: { limit: 10, status: 'delayed' },
    });
  });

  it('drops keys the tool does not declare, as the MCP endpoint does', () => {
    const t = withParams({ limit: { type: 'number' } });
    const checked = t.validateArgs!({ limit: 5, organizationId: 'org-b', connectorIds: ['c'] });
    expect(checked).toEqual({ ok: true, args: { limit: 5 } });
  });

  it('rejects a value of the wrong type, naming the field and not the value', () => {
    const t = withParams({ limit: { type: 'number' } });
    const checked = t.validateArgs!({ limit: { $gt: 0, secret: 'sk-live-123' } });
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.message).toMatch(/limit/);
      expect(checked.message).not.toContain('sk-live-123');
    }
  });

  it('rejects a missing required argument', () => {
    const t = withParams({ id: { type: 'string' } }, ['id']);
    expect(t.validateArgs!({}).ok).toBe(false);
  });

  it('keeps the message short however many arguments are wrong', () => {
    const props = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${i}`, { type: 'number' }]));
    const t = withParams(props, Object.keys(props));
    const checked = t.validateArgs!({});
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.message.length).toBeLessThanOrEqual(300);
      expect(checked.message).toMatch(/and \d+ more/);
    }
  });

  it('can be called again and again without rebuilding anything observable', () => {
    const t = withParams({ limit: { type: 'number' } });
    expect(t.validateArgs!({ limit: 1 }).ok).toBe(true);
    expect(t.validateArgs!({ limit: 'x' }).ok).toBe(false);
    expect(t.validateArgs!({ limit: 2 }).ok).toBe(true);
  });
});
