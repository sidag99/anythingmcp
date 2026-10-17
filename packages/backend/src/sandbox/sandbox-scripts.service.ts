import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { boundPayload } from '../audit/bound-payload';
import { PrismaService } from '../common/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { SCRIPT_NAME_MESSAGE, SCRIPT_NAME_PATTERN } from './sandbox-scripts.dto';
import type { SandboxRunResult } from './types';

const RESULT_PREVIEW_BYTES = 16 * 1024;
const ARGS_PREVIEW_BYTES = 8 * 1024;
const MAX_RUNS_PAGE = 200;

/** The columns a list row needs; `code` is added only on request. */
const SUMMARY_SELECT = {
  id: true,
  createdById: true,
  name: true,
  description: true,
  version: true,
  lastRunAt: true,
  lastRunOk: true,
  lastRunMeta: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface RecordRunInput {
  /** The run's id, when it was handed out before the run (the audit rows carry it). */
  id?: string;
  organizationId: string;
  mcpServerId: string;
  scriptId?: string;
  userId?: string;
  code: string;
  args?: Record<string, unknown>;
  result: SandboxRunResult;
}

/** Json column input: JS null must be spelled Prisma.JsonNull. */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === undefined || value === null
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue);
}

/**
 * Saved sandbox scripts and their run history. Scripts belong to one MCP server;
 * every query is filtered by organizationId so a caller can only ever reach their
 * own workspace's rows.
 */
@Injectable()
export class SandboxScriptsService {
  private readonly logger = new Logger(SandboxScriptsService.name);

  constructor(private readonly prisma: PrismaService) {}

  list(organizationId: string, mcpServerId: string, opts: { includeCode?: boolean } = {}) {
    return this.prisma.sandboxScript.findMany({
      where: { organizationId, mcpServerId },
      orderBy: { name: 'asc' },
      select: { ...SUMMARY_SELECT, code: opts.includeCode === true },
    });
  }

  async get(organizationId: string, id: string) {
    const script = await this.prisma.sandboxScript.findFirst({ where: { id, organizationId } });
    if (!script) throw new NotFoundException('Script not found');
    return script;
  }

  /** One script of one MCP server; a script id from another server is not found. */
  async getForServer(organizationId: string, mcpServerId: string, id: string) {
    const script = await this.prisma.sandboxScript.findFirst({
      where: { id, organizationId, mcpServerId },
    });
    if (!script) throw new NotFoundException('Script not found');
    return script;
  }

  getByName(organizationId: string, mcpServerId: string, name: string) {
    return this.prisma.sandboxScript.findFirst({
      where: { organizationId, mcpServerId, name },
    });
  }

  async create(
    organizationId: string,
    mcpServerId: string,
    userId: string | undefined,
    input: { name: string; code: string; description?: string },
  ) {
    if (!SCRIPT_NAME_PATTERN.test(input.name)) {
      throw new BadRequestException(SCRIPT_NAME_MESSAGE);
    }
    const server = await this.prisma.mcpServerConfig.findFirst({
      where: { id: mcpServerId, organizationId },
      select: { id: true },
    });
    if (!server) throw new NotFoundException('MCP server not found');
    try {
      return await this.prisma.sandboxScript.create({
        data: {
          organizationId,
          mcpServerId,
          createdById: userId ?? null,
          name: input.name,
          code: input.code,
          description: input.description ?? null,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Script '${input.name}' already exists`);
      }
      throw err;
    }
  }

  async update(
    organizationId: string,
    id: string,
    patch: { code?: string; description?: string },
  ) {
    if (patch.code === undefined && patch.description === undefined) {
      throw new BadRequestException('Provide code and/or description');
    }
    try {
      return await this.prisma.sandboxScript.update({
        where: { id, organizationId },
        data: {
          // The version tracks the code, so a description edit leaves it alone.
          ...(patch.code !== undefined && { code: patch.code, version: { increment: 1 } }),
          ...(patch.description !== undefined && { description: patch.description }),
        },
      });
    } catch (err) {
      if (isRecordMissing(err)) throw new NotFoundException('Script not found');
      throw err;
    }
  }

  /**
   * Edit on behalf of an agent session. Only the script's author may change it:
   * a saved script runs with the authority of whoever runs it, so letting any
   * member of the server edit another member's script would let a user with
   * fewer permissions plant code that a more privileged user's agent then runs.
   * Anyone else saves their own copy under a new name.
   */
  async updateByName(
    organizationId: string,
    mcpServerId: string,
    name: string,
    patch: { code?: string; description?: string },
    editorUserId: string | undefined,
  ) {
    const script = await this.getByName(organizationId, mcpServerId, name);
    if (!script) throw new NotFoundException(`Script '${name}' not found`);
    if (!isAuthor(script, editorUserId)) {
      throw new ForbiddenException(
        `Script '${name}' was created by someone else, so only they can edit it. ` +
          'Save your own copy under a new name with sandbox_create_script.',
      );
    }
    return this.update(organizationId, script.id, patch);
  }

  /** `updateByName` for the dashboard API: same author-only rule, addressed by id. */
  async updateByIdAsAuthor(
    organizationId: string,
    id: string,
    patch: { code?: string; description?: string },
    editorUserId: string | undefined,
  ) {
    const script = await this.get(organizationId, id);
    if (!isAuthor(script, editorUserId)) {
      throw new ForbiddenException(
        `Script '${script.name}' was created by someone else, so only they can edit it. ` +
          'Save your own copy under a new name.',
      );
    }
    return this.update(organizationId, script.id, patch);
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const { count } = await this.prisma.sandboxScript.deleteMany({
      where: { id, organizationId },
    });
    if (count === 0) throw new NotFoundException('Script not found');
  }

  /**
   * Delete for the dashboard API. The author may delete their script and an
   * administrator may clear out anyone's; deleting plants no code, so unlike
   * editing it needs no author-only rule for administrators.
   */
  async removeAsUser(
    organizationId: string,
    id: string,
    actor: { userId: string | undefined; isAdmin: boolean },
  ): Promise<void> {
    const script = await this.get(organizationId, id);
    if (!actor.isAdmin && !isAuthor(script, actor.userId)) {
      throw new ForbiddenException('Only the script\'s author or an administrator can delete it');
    }
    await this.remove(organizationId, script.id);
  }

  /**
   * Newest runs first. A run keeps a preview of what the connectors returned, so
   * `onlyUserId` narrows the list to one caller's own runs; a caller whose tool
   * access is narrower than another's must not read that other's results.
   */
  listRuns(organizationId: string, mcpServerId: string, limit = 50, onlyUserId?: string) {
    return this.prisma.sandboxRun.findMany({
      where: { organizationId, mcpServerId, ...(onlyUserId !== undefined && { userId: onlyUserId }) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Math.trunc(limit) || 50, 1), MAX_RUNS_PAGE),
    });
  }

  /**
   * Persist one run and, for a saved script, refresh its last-run summary.
   * Best effort: a storage failure is logged and never turns a finished run
   * into an error for the caller. Returns the run id, or null if not stored.
   */
  async recordRun(input: RecordRunInput): Promise<string | null> {
    const { result } = input;
    try {
      const run = await this.prisma.sandboxRun.create({
        data: {
          ...(input.id && { id: input.id }),
          organizationId: input.organizationId,
          mcpServerId: input.mcpServerId,
          scriptId: input.scriptId ?? null,
          userId: input.userId ?? null,
          code: input.code,
          args: toJson(
            input.args ? boundPayload(input.args, { maxBytes: ARGS_PREVIEW_BYTES }) : null,
          ),
          ok: result.ok,
          errorCode: result.error?.code ?? null,
          errorMessage: result.error?.message ?? null,
          resultPreview: toJson(
            result.ok ? boundPayload(result.result, { maxBytes: RESULT_PREVIEW_BYTES }) : null,
          ),
          meta: result.meta as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      if (input.scriptId) {
        await this.prisma.sandboxScript.updateMany({
          where: { id: input.scriptId, organizationId: input.organizationId },
          data: {
            lastRunAt: new Date(),
            lastRunOk: result.ok,
            lastRunMeta: {
              ms: result.meta.ms,
              connectorCalls: result.meta.connectorCalls,
              bytesFromConnectors: result.meta.bytesFromConnectors,
              bytesReturned: result.meta.bytesReturned,
            },
          },
        });
      }
      return run.id;
    } catch (err) {
      this.logger.warn(`Could not store sandbox run: ${(err as Error)?.message ?? err}`);
      return null;
    }
  }
}

/** A script with no recorded author is editable only by a caller with no identity either. */
function isAuthor(script: { createdById: string | null }, userId: string | undefined): boolean {
  return (script.createdById ?? null) === (userId ?? null);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

function isRecordMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2025';
}
