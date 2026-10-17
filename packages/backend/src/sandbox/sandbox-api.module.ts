import { Module } from '@nestjs/common';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { RolesModule } from '../roles/roles.module';
import { SandboxApiController } from './sandbox-api.controller';
import { SandboxModule } from './sandbox.module';

/**
 * Dashboard REST API of code mode. It needs the MCP module (the tool registry
 * and the executor), which SandboxModule must not import: McpServerModule
 * imports SandboxModule for the MCP tools.
 */
@Module({
  imports: [SandboxModule, McpServerModule, McpServersModule, RolesModule],
  controllers: [SandboxApiController],
})
export class SandboxApiModule {}
