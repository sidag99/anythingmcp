import { z } from 'zod';
import type { SandboxArgsCheck, SandboxTool } from '../sandbox/types';
import { deriveToolAnnotations } from './tool-annotations';
import { isListable, type RegisteredTool } from './tool-registry';
import { jsonSchemaToZodShape, stripEnvVarParams } from './tool-schema.util';

/**
 * The tools of one MCP server that a caller may use, in registration order:
 * the connector is set up, the caller's role allows the tool, and the first tool
 * of each name wins (the SDK throws on a second registration of a name).
 *
 * `allowedToolIds === null` means unrestricted. `onDuplicate` is told about each
 * skipped copy so the caller can log it.
 *
 * Every surface that offers tools to a caller selects them here, so a sandbox
 * script can never reach a tool that the caller's own tool list hides.
 */
export function visibleServerTools(
  serverTools: readonly RegisteredTool[],
  allowedToolIds: readonly string[] | null,
  onDuplicate?: (tool: RegisteredTool) => void,
): RegisteredTool[] {
  const allowed = allowedToolIds === null ? null : new Set(allowedToolIds);
  const names = new Set<string>();
  const visible: RegisteredTool[] = [];
  for (const tool of serverTools) {
    // A connector that is not set up yet would only produce errors.
    if (!isListable(tool)) continue;
    if (allowed !== null && !allowed.has(tool.id)) continue;
    if (names.has(tool.name)) {
      onDuplicate?.(tool);
      continue;
    }
    names.add(tool.name);
    visible.push(tool);
  }
  return visible;
}

/**
 * True only for a tool known not to change anything: a GET-like REST call, a
 * read-only database, or an explicit annotation. A tool whose kind cannot be
 * told is treated as a write, so the safe default needs no list to keep current.
 */
export function isReadOnlyTool(tool: RegisteredTool): boolean {
  return deriveToolAnnotations(tool).readOnlyHint === true;
}

const MAX_ARG_ERROR_CHARS = 300;

/**
 * Checks a script's arguments with the schema the MCP endpoint uses for a direct
 * call: the tool's JSON Schema as a Zod object, which the SDK validates and
 * strips of unknown keys before the tool runs. Built on first use, because most
 * tools of a server are never called in a given run.
 */
function argsValidator(schema: Record<string, unknown>): (args: Record<string, unknown>) => SandboxArgsCheck {
  let compiled: z.ZodObject<Record<string, z.ZodType>> | undefined;
  return (args) => {
    compiled ??= z.object(jsonSchemaToZodShape(schema));
    const parsed = compiled.safeParse(args);
    if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
    const problems = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
      .join('; ');
    const more = parsed.error.issues.length > 3 ? ` (and ${parsed.error.issues.length - 3} more)` : '';
    // Names and reasons only, never the values the script sent.
    return { ok: false, message: `Invalid arguments: ${problems}${more}`.slice(0, MAX_ARG_ERROR_CHARS) };
  };
}

/** What a sandbox script is told about each tool it may call. */
export function toSandboxTools(tools: readonly RegisteredTool[]): SandboxTool[] {
  return tools.map((tool) => {
    // Environment-variable parameters are filled by the gateway, not the caller.
    const parameters = stripEnvVarParams(tool.parameters, tool.connectorConfig.envVars);
    return {
      name: tool.name,
      connectorId: tool.connectorId,
      description: tool.description,
      parameters,
      outputSchema: tool.outputSchema,
      readOnly: isReadOnlyTool(tool),
      validateArgs: argsValidator(parameters),
    };
  });
}
