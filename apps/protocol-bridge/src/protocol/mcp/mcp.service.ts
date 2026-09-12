import { Injectable, Logger } from "@nestjs/common"
import {
  MCP_PROTOCOL_VERSION,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_NO_SESSION,
  rpcFailure,
  rpcSuccess,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpTool,
  type McpToolProvider,
  type McpToolResult,
} from "./mcp-types"

/**
 * MCP server for the bridge, spoken over Streamable HTTP.
 *
 * Security model — the endpoint is internet-reachable, so it is built to be
 * inert on its own:
 *
 *   - It registers no tools of its own. Everything callable arrives from a
 *     provider (in the deployed topology, a connected local session). With no
 *     provider attached, `tools/list` is empty and every `tools/call` fails.
 *     An attacker who defeats the credential still reaches nothing that can
 *     touch a workspace.
 *   - Tool dispatch is by exact name against the provider's own manifest, so
 *     a caller cannot reach anything the local side did not advertise.
 *   - Arguments must be a JSON object; anything else is rejected before it
 *     reaches a provider.
 *
 * Errors are returned as JSON-RPC failures rather than thrown, so a malformed
 * or hostile request never produces a stack trace or a 5xx that would leak
 * internal shape.
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name)
  private readonly providers = new Map<string, McpToolProvider>()

  // Capability changes and tool calls are logged at warn, not log. The bridge
  // runs at "warn" and above unless LOG_DEBUG is set, so a log-level line is
  // invisible on a normal deployment — and this endpoint is reachable from the
  // internet and reaches a workspace, so its audit trail cannot depend on a
  // debug switch being on.

  /** Attach a tool source. Called when a local session connects. */
  registerProvider(provider: McpToolProvider): void {
    this.providers.set(provider.id, provider)
    this.logger.warn(`MCP provider attached: ${provider.id}`)
  }

  unregisterProvider(id: string): void {
    if (this.providers.delete(id)) {
      this.logger.warn(`MCP provider detached: ${id}`)
    }
  }

  get providerCount(): number {
    return this.providers.size
  }

  /**
   * Handle one JSON-RPC message. Returns null for notifications, which the
   * spec says must not be answered.
   */
  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isRecord(message)) {
      return rpcFailure(null, RPC_INVALID_REQUEST, "Request must be an object")
    }

    const request = message as unknown as JsonRpcRequest
    const id = request.id ?? null
    const isNotification = !("id" in message) || request.id === undefined

    if (typeof request.method !== "string") {
      return isNotification
        ? null
        : rpcFailure(id, RPC_INVALID_REQUEST, "Missing method")
    }

    try {
      switch (request.method) {
        case "initialize":
          return rpcSuccess(id, this.initialize(request.params))
        case "tools/list":
          return rpcSuccess(id, { tools: await this.listTools() })
        case "tools/call":
          return await this.callTool(id, request.params)
        case "ping":
          return isNotification ? null : rpcSuccess(id, {})
        default:
          // Notifications for methods we do not implement (for example
          // `notifications/initialized`) are simply acknowledged by silence.
          return isNotification
            ? null
            : rpcFailure(
                id,
                RPC_METHOD_NOT_FOUND,
                `Method not found: ${request.method}`
              )
      }
    } catch (error) {
      this.logger.error(
        `MCP ${request.method} failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return isNotification
        ? null
        : rpcFailure(id, RPC_INTERNAL_ERROR, "Internal error")
    }
  }

  private initialize(params: unknown): Record<string, unknown> {
    const requested = isRecord(params) ? params.protocolVersion : undefined
    return {
      // Echo the client's revision when it pins one, so a client on an older
      // revision is not forced onto ours.
      protocolVersion:
        typeof requested === "string" ? requested : MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "agent-vibes", version: "0.1.0" },
    }
  }

  private async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    for (const provider of this.providers.values()) {
      tools.push(...(await provider.listTools()))
    }
    return tools
  }

  private async callTool(
    id: string | number | null,
    params: unknown
  ): Promise<JsonRpcResponse> {
    if (!isRecord(params) || typeof params.name !== "string") {
      return rpcFailure(id, RPC_INVALID_PARAMS, "tools/call requires a name")
    }
    const args = params.arguments
    if (args !== undefined && !isRecord(args)) {
      return rpcFailure(
        id,
        RPC_INVALID_PARAMS,
        "tools/call arguments must be an object"
      )
    }

    if (this.providers.size === 0) {
      return rpcFailure(
        id,
        RPC_NO_SESSION,
        "No workspace session is attached to this MCP endpoint"
      )
    }

    for (const provider of this.providers.values()) {
      const offered = await provider.listTools()
      if (!offered.some((tool) => tool.name === params.name)) continue
      // A tool call is the one MCP operation with an outside effect, so it is
      // always recorded. The arguments are not: they carry workspace content.
      this.logger.warn(`MCP tools/call ${params.name} via ${provider.id}`)
      const result: McpToolResult = await provider.callTool(
        params.name,
        (args as Record<string, unknown>) ?? {}
      )
      return rpcSuccess(id, result as unknown as Record<string, unknown>)
    }

    return rpcFailure(
      id,
      RPC_INVALID_PARAMS,
      `Unknown tool: ${String(params.name).slice(0, 80)}`
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
