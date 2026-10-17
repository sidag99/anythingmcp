/**
 * Renders the tools a script can call as a TypeScript-ish API listing. It is
 * embedded in the `sandbox_run_script` description so the model knows each tool's
 * arguments and result shape without a discovery round-trip.
 */

export interface SignatureTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  outputSchema?: unknown;
}

/** Upper bound for the whole tool listing; the rest is "… and N more". */
export const TOOLS_SIGNATURE_MAX_CHARS = 6_000;
const MAX_LINE_CHARS = 500;
const MAX_PROPS = 12;
const MAX_UNION = 8;
const COMMENT_MAX_CHARS = 120;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

type Schema = Record<string, unknown>;

const isSchema = (v: unknown): v is Schema =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function propKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null
    ? JSON.stringify(value)
    : 'unknown';
}

/** JSON Schema -> TypeScript-ish type. `sep` separates object members. */
function toTs(schema: unknown, depth: number, maxDepth: number, sep: string): string {
  if (!isSchema(schema)) return 'unknown';

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.length > MAX_UNION) return typeof schema.enum[0] === 'number' ? 'number' : 'string';
    return schema.enum.map(literal).join(' | ');
  }
  if ('const' in schema) return literal(schema.const);

  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0) {
      const parts = [...new Set(options.slice(0, 4).map((o) => toTs(o, depth, maxDepth, sep)))];
      return parts.join(' | ');
    }
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    const parts = [...new Set(type.map((t) => toTs({ ...schema, type: t }, depth, maxDepth, sep)))];
    return parts.join(' | ') || 'unknown';
  }

  const kind = type ?? (isSchema(schema.properties) ? 'object' : undefined);
  switch (kind) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const inner = toTs(schema.items, depth + 1, maxDepth, sep);
      return inner === 'unknown' ? 'unknown[]' : `Array<${inner}>`;
    }
    case 'object': {
      const props = isSchema(schema.properties) ? Object.entries(schema.properties) : [];
      if (props.length === 0) return 'Record<string, unknown>';
      if (depth >= maxDepth) return 'object';
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const shown = props.slice(0, MAX_PROPS).map(
        ([name, sub]) =>
          `${propKey(name)}${required.has(name) ? '' : '?'}: ${toTs(sub, depth + 1, maxDepth, sep)}`,
      );
      if (props.length > MAX_PROPS) shown.push('…');
      return `{ ${shown.join(sep)} }`;
    }
    default:
      return 'unknown';
  }
}

/** First sentence of a description, flattened to one short line. */
function firstSentence(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.length > COMMENT_MAX_CHARS ? `${sentence.slice(0, COMMENT_MAX_CHARS - 1)}…` : sentence;
}

function callName(name: string): string {
  return IDENTIFIER.test(name) ? `tools.${name}` : `tools[${JSON.stringify(name)}]`;
}

function renderTool(tool: SignatureTool, maxDepth: number): string {
  const params = isSchema(tool.parameters) ? tool.parameters : {};
  const hasParams = isSchema(params.properties) && Object.keys(params.properties).length > 0;
  const argType = hasParams ? toTs({ ...params, type: 'object' }, 0, maxDepth, ', ') : '';
  const returns = tool.outputSchema ? toTs(tool.outputSchema, 0, maxDepth, '; ') : 'unknown';
  const comment = tool.description ? `  // ${firstSentence(tool.description)}\n` : '';
  return `${comment}  ${callName(tool.name)}(${argType}): Promise<${returns}>`;
}

/** Full-detail rendering, simplified step by step if a single tool runs long. */
function renderFitted(tool: SignatureTool): string {
  let text = '';
  for (const depth of [3, 2, 1]) {
    text = renderTool(tool, depth);
    const code = text.slice(text.lastIndexOf('\n') + 1);
    if (code.length <= MAX_LINE_CHARS) return text;
  }
  const cut = text.lastIndexOf('\n') + 1;
  return `${text.slice(0, cut)}${text.slice(cut, cut + MAX_LINE_CHARS)}…`;
}

const HEADER = 'Available in your script (all async, all return parsed JSON):';
const FIXED_LINES = [
  '  tools.describe(name): Promise<{ name, description, parameters, outputSchema }>',
  '  tools.list(): string[]',
  'Helpers: util.daysAgo(n), util.startOfMonth(), util.endOfMonth(), util.groupBy(rows, r => r.key), util.sum(rows, r => r.amount)',
  'console.log(...) is captured and returned in meta.logs.',
];

export function buildToolsSignature(
  tools: SignatureTool[],
  opts: { maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? TOOLS_SIGNATURE_MAX_CHARS;
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const fixed = FIXED_LINES.join('\n');
  // Leave room for the header, the fixed lines and a possible "more" line.
  let budget = maxChars - HEADER.length - fixed.length - 80;

  const lines: string[] = [];
  let shown = 0;
  for (const tool of sorted) {
    const rendered = renderFitted(tool);
    if (rendered.length + 1 > budget) break;
    lines.push(rendered);
    budget -= rendered.length + 1;
    shown++;
  }
  const hidden = sorted.length - shown;
  if (sorted.length === 0) {
    lines.push('  (no connector tools are available to scripts on this server)');
  } else if (hidden > 0) {
    lines.push(`  … and ${hidden} more; call tools.list()`);
  }
  return [HEADER, ...lines, fixed].join('\n');
}
