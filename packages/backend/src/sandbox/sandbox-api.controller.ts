import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DynamicMcpTools } from '../mcp-server/dynamic-mcp-tools';
import { deriveToolAnnotations } from '../mcp-server/tool-annotations';
import { ToolRegistry } from '../mcp-server/tool-registry';
import { toSandboxTools, visibleServerTools } from '../mcp-server/visible-tools';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { RolesService } from '../roles/roles.service';
import { runIsolationSuite } from './isolation-suite';
import { areSandboxWritesAllowed, isSandboxEnabled } from './limits';
import {
  BenchmarkDto,
  CreateSandboxScriptDto,
  ListSandboxRunsQueryDto,
  ListSandboxScriptsQueryDto,
  RunSandboxDto,
  UpdateSandboxScriptDto,
} from './sandbox-scripts.dto';
import { SandboxScriptsService } from './sandbox-scripts.service';
import { SandboxService } from './sandbox.service';
import type {
  SandboxInvocationContext,
  SandboxRunResult,
  SandboxSyntaxCheck,
  SandboxToolResult,
} from './types';

/** What the JWT strategy leaves on the request: the active membership's role. */
interface DashboardRequest {
  user: { sub: string; email?: string; role: string; organizationId: string };
}

interface ServerRow {
  id: string;
  name: string;
  organizationId: string;
  isActive: boolean;
}

const formatSyntax = (check: SandboxSyntaxCheck) =>
  check.ok ? { ok: true } : { ok: false, line: check.line, column: check.column, message: check.message };

/** The brief's benchmark estimate: four bytes to a token. Always labelled "est." in the UI. */
const estTokens = (bytes: number) => Math.ceil(bytes / 4);
const percent = (fraction: number) => Math.round(fraction * 10_000) / 100;

/**
 * Dashboard API of code mode: run a script, keep saved scripts, read the run
 * history, run the live isolation suite, and measure how much a script saves over
 * the raw tool call.
 *
 * Same authority as the MCP surface. A script sees exactly the tools the caller's
 * MCP tool list shows (`visibleServerTools`, the function the MCP endpoint uses),
 * runs under the caller's own identity, and a saved script can be edited only by
 * its author. Anything that executes or changes a script needs a role above VIEWER,
 * because a script can call write tools.
 *
 * Behaves the same in Cloud and self-hosted deployments. `SANDBOX_ENABLED=false`
 * turns the whole API off with a 404, like the MCP tools.
 */
@ApiTags('Sandbox')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/sandbox')
export class SandboxApiController {
  private readonly logger = new Logger(SandboxApiController.name);

  constructor(
    private readonly sandbox: SandboxService,
    private readonly scripts: SandboxScriptsService,
    private readonly servers: McpServersService,
    private readonly roles: RolesService,
    private readonly registry: ToolRegistry,
    private readonly executor: DynamicMcpTools,
  ) {}

  // ---- run ---------------------------------------------------------------

  @Post('servers/:serverId/run')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run a script in the sandbox',
    description:
      'Provide exactly one of `code` or `scriptId`. A script that fails still returns 200 with ' +
      '`ok: false` and an `error`; 429 means the organization already has the maximum number of ' +
      'scripts running.',
  })
  async run(
    @Req() req: DashboardRequest,
    @Param('serverId') serverId: string,
    @Body() dto: RunSandboxDto,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const server = await this.serverFor(req, serverId, { write: true, active: true });
    const hasCode = typeof dto.code === 'string' && dto.code.length > 0;
    const hasId = typeof dto.scriptId === 'string' && dto.scriptId.length > 0;
    if (hasCode === hasId) {
      throw new BadRequestException('Provide exactly one of "code" or "scriptId".');
    }

    let code = dto.code as string;
    const saved = hasId
      ? await this.scripts.getForServer(server.organizationId, server.id, dto.scriptId as string)
      : undefined;
    if (saved) code = saved.code;

    const scope = await this.toolScope(req, server);
    // One id for the run: its row in sandbox_runs and the mark on the audit row
    // of each connector call it makes.
    const runId = randomUUID();
    const result = await this.sandbox.run({
      code,
      args: dto.args,
      allowedTools: toSandboxTools(scope.visible),
      allowWrites: areSandboxWritesAllowed(),
      signal: abortOnDisconnect(res),
      invocationContext: { ...scope.invocationContext, sandboxRunId: runId },
      executeTool: this.executeTool,
      limits: dto.timeoutMs ? { timeoutMs: dto.timeoutMs } : undefined,
    });
    await this.scripts.recordRun({
      id: runId,
      organizationId: server.organizationId,
      mcpServerId: server.id,
      scriptId: saved?.id,
      userId: req.user.sub,
      code,
      args: dto.args,
      result,
    });

    const body = {
      runId,
      ...result,
      // Whose code ran: it runs with the caller's authority but may be someone else's.
      ...(saved && {
        script: {
          id: saved.id,
          name: saved.name,
          version: saved.version,
          ownedByYou: saved.createdById === req.user.sub,
        },
      }),
    };
    return this.respond(result, body);
  }

  @Post('servers/:serverId/benchmark')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Compare a raw tool call with a script that answers the same question',
    description:
      'Calls `toolName` once for real and runs `code` once, and reports how much data each ' +
      'path returned to the model. Only read-only tools can be measured. Tokens are estimated ' +
      'as bytes / 4.',
  })
  async benchmark(
    @Req() req: DashboardRequest,
    @Param('serverId') serverId: string,
    @Body() dto: BenchmarkDto,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const server = await this.serverFor(req, serverId, { write: true, active: true });
    const scope = await this.toolScope(req, server);

    const tool = scope.visible.find((t) => t.name === dto.toolName);
    if (!tool) {
      throw new NotFoundException(`Tool '${dto.toolName}' is not available on this MCP server`);
    }
    if (deriveToolAnnotations(tool).readOnlyHint !== true) {
      throw new BadRequestException(
        `'${tool.name}' is not a read-only tool. A benchmark calls it for real, so only read-only tools can be measured.`,
      );
    }

    // The raw path: what the model would receive if it called the tool itself.
    // It carries the run's id, so both halves of the comparison are traceable.
    const runId = randomUUID();
    const rawStarted = Date.now();
    let raw: SandboxToolResult | undefined;
    try {
      raw = await this.executeTool(tool.name, dto.toolArgs ?? {}, {
        ...scope.invocationContext,
        sandboxRunId: runId,
        connectorIds: [tool.connectorId],
      });
    } catch (err) {
      this.logger.warn(
        `Benchmark call of "${tool.name}" threw: ${(err as Error)?.constructor?.name ?? 'error'}`,
      );
    }
    const rawMs = Date.now() - rawStarted;
    if (!raw || raw.isError) {
      return {
        raw: { ok: false, ms: rawMs, error: rawErrorText(raw) },
        script: null,
        reduction: null,
      };
    }
    const rawBytes = Buffer.byteLength(raw.content.map((c) => c.text ?? '').join(''));

    const result = await this.sandbox.run({
      code: dto.code,
      args: dto.args,
      allowedTools: toSandboxTools(scope.visible),
      allowWrites: areSandboxWritesAllowed(),
      signal: abortOnDisconnect(res),
      invocationContext: { ...scope.invocationContext, sandboxRunId: runId },
      executeTool: this.executeTool,
    });
    await this.scripts.recordRun({
      id: runId,
      organizationId: server.organizationId,
      mcpServerId: server.id,
      userId: req.user.sub,
      code: dto.code,
      args: dto.args,
      result,
    });

    const scriptBytes = result.meta.bytesReturned;
    const body = {
      runId,
      raw: { ok: true, bytes: rawBytes, ms: rawMs, estTokens: estTokens(rawBytes) },
      script: {
        ok: result.ok,
        bytes: scriptBytes,
        ms: result.meta.ms,
        estTokens: estTokens(scriptBytes),
        connectorCalls: result.meta.connectorCalls,
        bytesFromConnectors: result.meta.bytesFromConnectors,
        ...(result.ok ? { result: result.result } : { error: result.error }),
      },
      // Share of the raw payload that no longer reaches the model.
      reduction:
        result.ok && rawBytes > 0
          ? {
              bytesPct: percent(1 - scriptBytes / rawBytes),
              tokensPct: percent(1 - estTokens(scriptBytes) / estTokens(rawBytes)),
            }
          : null,
    };
    return this.respond(result, body);
  }

  @Post('servers/:serverId/isolation-tests')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run the fixed isolation and limits suite live',
    description:
      'Runs the spec\'s negative tests (no host modules, no network, no secrets, timeout, memory, ' +
      'output size, cross-tenant tool, call limit, syntax error) against the live sandbox with ' +
      'synthetic tools. It touches no connector and no customer data.',
  })
  async isolationTests(@Req() req: DashboardRequest, @Param('serverId') serverId: string) {
    const server = await this.serverFor(req, serverId, { write: true });
    const results = await runIsolationSuite(this.sandbox, { organizationId: server.organizationId });
    // At the concurrency limit every case would read as a failure; say so instead.
    if (results.some((r) => r.actualCode === 'BUSY')) {
      throw new HttpException(results, HttpStatus.TOO_MANY_REQUESTS);
    }
    return results;
  }

  // ---- run history -------------------------------------------------------

  @Get('servers/:serverId/runs')
  @ApiOperation({
    summary: 'Recent runs of this MCP server, newest first',
    description:
      'A run keeps a preview of what the connectors returned, so an administrator sees every ' +
      'run and anyone else sees only their own.',
  })
  async runs(
    @Req() req: DashboardRequest,
    @Param('serverId') serverId: string,
    @Query() query: ListSandboxRunsQueryDto,
  ) {
    const server = await this.serverFor(req, serverId);
    return this.scripts.listRuns(
      server.organizationId,
      server.id,
      query.limit,
      req.user.role === 'ADMIN' ? undefined : req.user.sub,
    );
  }

  // ---- saved scripts -----------------------------------------------------

  @Get('servers/:serverId/scripts')
  @ApiOperation({
    summary: 'Saved scripts of this MCP server',
    description: 'Without their code unless `includeCode=1`.',
  })
  async listScripts(
    @Req() req: DashboardRequest,
    @Param('serverId') serverId: string,
    @Query() query: ListSandboxScriptsQueryDto,
  ) {
    const server = await this.serverFor(req, serverId);
    const includeCode = query.includeCode === '1' || query.includeCode === 'true';
    const rows = await this.scripts.list(server.organizationId, server.id, { includeCode });
    return rows.map((row) => ({ ...row, ownedByYou: row.createdById === req.user.sub }));
  }

  @Post('servers/:serverId/scripts')
  @ApiOperation({
    summary: 'Save a script',
    description: 'The code is syntax-checked, not executed; the result says whether it parses.',
  })
  async createScript(
    @Req() req: DashboardRequest,
    @Param('serverId') serverId: string,
    @Body() dto: CreateSandboxScriptDto,
  ) {
    const server = await this.serverFor(req, serverId, { write: true });
    const script = await this.scripts.create(server.organizationId, server.id, req.user.sub, dto);
    const syntax = await this.sandbox.checkSyntax(script.code);
    return { ...script, ownedByYou: true, syntax: formatSyntax(syntax) };
  }

  @Get('scripts/:scriptId')
  @ApiOperation({ summary: 'One saved script, with its code' })
  async getScript(@Req() req: DashboardRequest, @Param('scriptId') scriptId: string) {
    this.requireEnabled();
    const script = await this.scripts.get(req.user.organizationId, scriptId);
    return { ...script, ownedByYou: script.createdById === req.user.sub };
  }

  @Patch('scripts/:scriptId')
  @ApiOperation({
    summary: 'Change a saved script',
    description:
      'Only the script\'s author can change it, because a saved script runs with the authority ' +
      'of whoever runs it. To change someone else\'s script, save your own copy under a new name.',
  })
  async updateScript(
    @Req() req: DashboardRequest,
    @Param('scriptId') scriptId: string,
    @Body() dto: UpdateSandboxScriptDto,
  ) {
    this.requireWriter(req);
    const script = await this.scripts.updateByIdAsAuthor(
      req.user.organizationId,
      scriptId,
      dto,
      req.user.sub,
    );
    const syntax = await this.sandbox.checkSyntax(script.code);
    return { ...script, ownedByYou: true, syntax: formatSyntax(syntax) };
  }

  @Delete('scripts/:scriptId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a saved script (its author, or an administrator)' })
  async deleteScript(
    @Req() req: DashboardRequest,
    @Param('scriptId') scriptId: string,
  ): Promise<void> {
    this.requireWriter(req);
    await this.scripts.removeAsUser(req.user.organizationId, scriptId, {
      userId: req.user.sub,
      isAdmin: req.user.role === 'ADMIN',
    });
  }

  // ---- helpers -----------------------------------------------------------

  /** The connector executor the sandbox bridge calls; bound once for every run. */
  private readonly executeTool = (
    name: string,
    args: Record<string, unknown>,
    context: SandboxInvocationContext,
  ) => this.executor.executeTool(name, args, context);

  private requireEnabled(): void {
    if (!isSandboxEnabled()) {
      throw new NotFoundException('Sandbox code mode is turned off on this instance');
    }
  }

  /** Code mode is on and the caller may run or change scripts (not a VIEWER). */
  private requireWriter(req: DashboardRequest): void {
    this.requireEnabled();
    if (req.user.role === 'VIEWER') {
      throw new ForbiddenException('Viewers cannot run or change sandbox scripts');
    }
  }

  /**
   * The MCP server the caller may act on: it exists in their active organization
   * (otherwise it is "not found", never "forbidden", so ids do not leak across
   * organizations).
   */
  private async serverFor(
    req: DashboardRequest,
    serverId: string,
    opts: { write?: boolean; active?: boolean } = {},
  ): Promise<ServerRow> {
    if (opts.write) this.requireWriter(req);
    else this.requireEnabled();
    const server = await this.servers.findById(serverId);
    if (!server || server.organizationId !== req.user.organizationId) {
      throw new NotFoundException('MCP server not found');
    }
    if (opts.active && !server.isActive) {
      throw new ForbiddenException('MCP server is inactive');
    }
    return server;
  }

  /**
   * What the caller's MCP tool list shows for this server, and the identity the
   * tools run under. The role allow-list is read for the server's organization.
   */
  private async toolScope(req: DashboardRequest, server: ServerRow) {
    const [connectorIds, allowedToolIds] = await Promise.all([
      this.servers.getConnectorIds(server.id),
      this.roles.getAllowedToolIds(req.user.sub, server.organizationId),
    ]);
    const assigned = new Set(connectorIds);
    const serverTools = this.registry.getAllTools().filter((t) => assigned.has(t.connectorId));
    const invocationContext: SandboxInvocationContext = {
      userId: req.user.sub,
      userEmail: req.user.email,
      organizationId: server.organizationId,
      authMethod: 'jwt',
      mcpServerId: server.id,
      mcpServerName: server.name,
      connectorIds,
    };
    return { visible: visibleServerTools(serverTools, allowedToolIds), invocationContext };
  }

  /** 429 when the organization has no free slot; any other outcome is a 200 body. */
  private respond<T>(result: SandboxRunResult, body: T): T {
    if (!result.ok && result.error?.code === 'BUSY') {
      throw new HttpException(body as object, HttpStatus.TOO_MANY_REQUESTS);
    }
    return body;
  }
}

/**
 * A signal that fires when the client goes away before the response is done, so
 * the run stops instead of finishing for nobody. (`close` on the response, not
 * on the request: the request closes as soon as its body has been read.)
 */
function abortOnDisconnect(res: Response | undefined): AbortSignal | undefined {
  if (!res) return undefined;
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

function rawErrorText(raw: SandboxToolResult | undefined): string {
  const text = raw?.content?.[0]?.text;
  return text ? text.slice(0, 500) : 'The tool call failed.';
}
