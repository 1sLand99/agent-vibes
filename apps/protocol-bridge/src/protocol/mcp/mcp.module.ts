import { Module } from "@nestjs/common"
import { McpAuthGuard } from "./mcp-auth.guard"
import { McpController } from "./mcp.controller"
import { McpCursorToolsProvider } from "./mcp-cursor-tools.provider"
import { McpDiagnosticProvider } from "./mcp-diagnostic.provider"
import { McpRelayGateway } from "./mcp-relay.gateway"
import { McpWorkspaceAgent } from "./mcp-workspace.agent"
import { McpService } from "./mcp.service"

/**
 * McpModule — the bridge's Model Context Protocol surface.
 *
 * Exports McpService so a workspace session can attach itself as a tool
 * provider; without one the endpoint serves an empty tool list.
 */
@Module({
  controllers: [McpController],
  providers: [
    McpService,
    McpAuthGuard,
    McpDiagnosticProvider,
    McpRelayGateway,
    McpWorkspaceAgent,
    McpCursorToolsProvider,
  ],
  exports: [McpService, McpCursorToolsProvider],
})
export class McpModule {}
