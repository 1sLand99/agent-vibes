import { Module } from "@nestjs/common"
import { McpAuthGuard } from "./mcp-auth.guard"
import { McpController } from "./mcp.controller"
import { McpCursorToolsProvider } from "./mcp-cursor-tools.provider"
import { McpDiagnosticProvider } from "./mcp-diagnostic.provider"
import { McpRelayGateway } from "./mcp-relay.gateway"
import { McpRelayAgent } from "./mcp-relay.agent"
import { McpService } from "./mcp.service"

/**
 * McpModule — the bridge's Model Context Protocol surface.
 *
 * Nothing here implements a tool. The endpoint serves whatever providers are
 * attached to McpService, and McpRelayAgent carries Cursor's own tools out to
 * a public relay; without either, the tool list is empty.
 */
@Module({
  controllers: [McpController],
  providers: [
    McpService,
    McpAuthGuard,
    McpDiagnosticProvider,
    McpRelayGateway,
    McpRelayAgent,
    McpCursorToolsProvider,
  ],
  exports: [McpService, McpCursorToolsProvider],
})
export class McpModule {}
