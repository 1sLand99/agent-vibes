import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { McpService } from "./mcp.service"
import type { McpTool, McpToolProvider, McpToolResult } from "./mcp-types"

/**
 * A single harmless tool, used to prove an MCP client can discover and call
 * through to this bridge.
 *
 * It reads nothing and runs nothing: it echoes its argument back with a
 * timestamp. That is enough to confirm a connector's full round trip —
 * discovery, invocation, result — without putting any capability on a
 * publicly reachable endpoint.
 *
 * Off unless MCP_DIAGNOSTIC_TOOL is set, so a normal deployment keeps the
 * property that an endpoint with no editor session attached is inert.
 */
@Injectable()
export class McpDiagnosticProvider implements McpToolProvider, OnModuleInit {
  private readonly logger = new Logger(McpDiagnosticProvider.name)
  readonly id = "diagnostic"

  constructor(
    private readonly configService: ConfigService,
    private readonly mcp: McpService
  ) {}

  onModuleInit(): void {
    const flag = this.configService
      .get<string>("MCP_DIAGNOSTIC_TOOL", "")
      .trim()
      .toLowerCase()
    if (!["1", "true", "yes", "on"].includes(flag)) return
    this.mcp.registerProvider(this)
    this.logger.warn(
      "MCP diagnostic tool is enabled — unset MCP_DIAGNOSTIC_TOOL once the " +
        "connector round trip has been verified"
    )
  }

  listTools(): McpTool[] {
    return [
      {
        name: "agent_vibes_ping",
        description:
          "Echo a short message back, to confirm the agent-vibes connector " +
          "is reachable. Use this when asked to test the connection.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Text to echo back",
            },
          },
          required: ["message"],
        },
      },
    ]
  }

  callTool(name: string, args: Record<string, unknown>): McpToolResult {
    const message =
      typeof args.message === "string" ? args.message.slice(0, 500) : ""
    this.logger.log(`MCP diagnostic tool invoked: ${name}`)
    return {
      content: [
        {
          type: "text",
          text: `agent-vibes pong at ${new Date().toISOString()} — received: ${message}`,
        },
      ],
    }
  }
}
