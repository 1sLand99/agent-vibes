import { Module } from "@nestjs/common"
import { McpAuthGuard } from "./mcp-auth.guard"
import { McpController } from "./mcp.controller"
import { McpDiagnosticProvider } from "./mcp-diagnostic.provider"
import { McpService } from "./mcp.service"

/**
 * McpModule — the bridge's Model Context Protocol surface.
 *
 * Exports McpService so a workspace session can attach itself as a tool
 * provider; without one the endpoint serves an empty tool list.
 */
@Module({
  controllers: [McpController],
  providers: [McpService, McpAuthGuard, McpDiagnosticProvider],
  exports: [McpService],
})
export class McpModule {}
