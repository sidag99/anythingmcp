import { Module } from '@nestjs/common';
import { SandboxScriptsService } from './sandbox-scripts.service';
import { SandboxService } from './sandbox.service';

/**
 * Code mode services: the isolate runtime and saved-script storage. They depend
 * only on Prisma (global), never on the MCP module, so McpServerModule can
 * import this one. The dashboard REST API that does need the MCP module lives
 * in SandboxApiModule.
 */
@Module({
  providers: [SandboxService, SandboxScriptsService],
  exports: [SandboxService, SandboxScriptsService],
})
export class SandboxModule {}
