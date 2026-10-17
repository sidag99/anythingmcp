import { buildToolsSignature, TOOLS_SIGNATURE_MAX_CHARS, type SignatureTool } from './tool-signature.util';

const ordersList: SignatureTool = {
  name: 'orders_list',
  description: 'List orders for a period. Returns at most `limit` rows.',
  parameters: {
    type: 'object',
    properties: {
      month: { type: 'number' },
      status: { type: 'string', enum: ['open', 'delayed'] },
    },
    required: [],
  },
  outputSchema: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string' },
        amount: { type: 'number' },
        delivered_at: { type: ['string', 'null'] },
      },
      required: ['id', 'status'],
    },
  },
};

describe('buildToolsSignature', () => {
  it('renders arguments, result shape and the first description sentence', () => {
    const text = buildToolsSignature([ordersList]);
    expect(text).toContain('// List orders for a period.');
    expect(text).not.toContain('Returns at most');
    expect(text).toContain(
      'tools.orders_list({ month?: number, status?: "open" | "delayed" }): ' +
        'Promise<Array<{ id: number; status: string; amount?: number; delivered_at?: string | null }>>',
    );
  });

  it('marks required arguments without a question mark', () => {
    const text = buildToolsSignature([
      {
        name: 'customers_get',
        description: 'Get one customer.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    ]);
    expect(text).toContain('tools.customers_get({ id: string }): Promise<unknown>');
  });

  it('renders a tool without parameters as a bare call', () => {
    const text = buildToolsSignature([
      { name: 'ping', description: '', parameters: { type: 'object', properties: {} } },
    ]);
    expect(text).toContain('tools.ping(): Promise<unknown>');
  });

  it('always documents describe, list, helpers and console', () => {
    const text = buildToolsSignature([]);
    expect(text).toContain('tools.describe(name)');
    expect(text).toContain('tools.list(): string[]');
    expect(text).toContain('util.groupBy');
    expect(text).toContain('console.log(...)');
    expect(text).toContain('no connector tools are available');
  });

  it('uses bracket access for names that are not identifiers', () => {
    const text = buildToolsSignature([
      { name: 'get-order.v2', description: 'x', parameters: {} },
    ]);
    expect(text).toContain('tools["get-order.v2"]()');
  });

  it('quotes property names that are not identifiers', () => {
    const text = buildToolsSignature([
      {
        name: 't',
        description: 'x',
        parameters: { type: 'object', properties: { 'date-from': { type: 'string' } } },
      },
    ]);
    expect(text).toContain('{ "date-from"?: string }');
  });

  it('survives hostile and recursive-looking schemas', () => {
    const deep: any = { type: 'object', properties: {} };
    let cursor = deep;
    for (let i = 0; i < 50; i++) {
      cursor.properties.next = { type: 'object', properties: {} };
      cursor = cursor.properties.next;
    }
    const text = buildToolsSignature([
      { name: 'deep', description: 'x', parameters: deep, outputSchema: deep },
      { name: 'junk', description: 'y', parameters: null as any, outputSchema: 42 },
      { name: 'arr', description: 'z', parameters: { type: 'object', properties: { a: 'nope' } } },
    ]);
    expect(text).toContain('tools.deep(');
    expect(text).toContain('tools.junk()');
    expect(text).toContain('tools.arr(');
  });

  it('keeps a very wide tool to a bounded line', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) properties[`field_${i}`] = { type: 'string' };
    const text = buildToolsSignature([
      { name: 'wide', description: 'x', parameters: { type: 'object', properties } },
    ]);
    const line = text.split('\n').find((l) => l.includes('tools.wide'))!;
    expect(line.length).toBeLessThanOrEqual(520);
  });

  it('truncates a long tool list and says how many were left out', () => {
    const tools: SignatureTool[] = Array.from({ length: 300 }, (_, i) => ({
      name: `tool_${String(i).padStart(3, '0')}`,
      description: 'Does something useful for the caller.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, limit: { type: 'number' } } },
      outputSchema: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } },
    }));
    const text = buildToolsSignature(tools);
    expect(text.length).toBeLessThanOrEqual(TOOLS_SIGNATURE_MAX_CHARS);
    expect(text).toMatch(/… and \d+ more; call tools\.list\(\)/);
    expect(text).toContain('tools.tool_000');
    expect(text).toContain('console.log(...)');
  });

  it('is stable regardless of input order (it feeds a session signature)', () => {
    const a = buildToolsSignature([ordersList, { ...ordersList, name: 'a_first' }]);
    const b = buildToolsSignature([{ ...ordersList, name: 'a_first' }, ordersList]);
    expect(a).toBe(b);
  });
});
