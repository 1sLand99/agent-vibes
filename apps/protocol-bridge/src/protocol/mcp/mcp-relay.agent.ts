import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "node:crypto"
import * as os from "node:os"
import WebSocket from "ws"
import { McpCursorToolsProvider } from "./mcp-cursor-tools.provider"

/**
 * The editor half of the relay: a socket that carries Cursor's tools out to
 * the public MCP endpoint.
 *
 * It runs no tools of its own. Everything a caller can reach through it is
 * Cursor's own tool set, executed by the editor — the bridge only carries the
 * call there and the answer back. A second, hand-written file toolset lived
 * here once; it duplicated `read_file` and `list_directory` under different
 * schemas and could do a fraction of what the editor already does, so it is
 * gone.
 *
 * The agent dials out, so the machine running the editor never opens a port
 * and the relay never learns how to reach it.
 *
 * Enabled by setting MCP_RELAY_URL.
 */

const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000

@Injectable()
export class McpRelayAgent implements OnModuleInit {
  private readonly logger = new Logger(McpRelayAgent.name)
  private ws: WebSocket | null = null
  private reconnectDelay = RECONNECT_BASE_MS
  private readonly sessionId = crypto.randomUUID()

  constructor(
    private readonly configService: ConfigService,
    private readonly cursorTools: McpCursorToolsProvider
  ) {}

  onModuleInit(): void {
    const url = this.configService.get<string>("MCP_RELAY_URL", "").trim()
    if (!url) return
    this.connect(url)
  }

  private connect(url: string): void {
    const secret = this.configService.get<string>("MCP_API_KEY", "").trim()
    if (!secret) {
      this.logger.error("MCP_API_KEY is required to attach to the relay")
      return
    }

    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${secret}` },
    })
    this.ws = ws

    ws.on("open", () => {
      this.reconnectDelay = RECONNECT_BASE_MS
      // The tool list is read once per connection and never depends on whether
      // a turn is in flight: a ChatGPT connector discovers tools when it is
      // registered and has no way to refresh, so a manifest that came and went
      // with the editor's attention would be a manifest nobody could rely on.
      const tools = this.cursorTools.listTools()
      ws.send(
        JSON.stringify({
          type: "register",
          sessionId: this.sessionId,
          label: `${os.hostname()}:cursor`,
          tools,
        })
      )
      this.logger.warn(`Attached to relay at ${url} with ${tools.length} tools`)
    })

    ws.on("message", (data) => {
      void this.onMessage(ws, decodeFrame(data))
    })

    ws.on("close", () => {
      this.logger.warn(
        `Relay connection closed; retrying in ${this.reconnectDelay}ms`
      )
      setTimeout(() => this.connect(url), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    })

    ws.on("error", (error) => this.logger.warn(`Relay error: ${error.message}`))
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let frame: {
      type?: string
      callId?: string
      name?: string
      arguments?: unknown
    }
    try {
      frame = JSON.parse(raw) as typeof frame
    } catch {
      return
    }
    if (frame.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }))
      return
    }
    if (frame.type !== "call" || !frame.callId || !frame.name) return

    const args =
      frame.arguments && typeof frame.arguments === "object"
        ? (frame.arguments as Record<string, unknown>)
        : {}
    this.logger.warn(`Relay call: ${frame.name}`)
    try {
      // The provider answers a call with no editor attached by saying so, so
      // this resolves rather than throwing in the ordinary "no turn is running"
      // case, and the model reads why instead of a generic failure.
      const result = await this.cursorTools.callTool(frame.name, args)
      ws.send(JSON.stringify({ type: "result", callId: frame.callId, result }))
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "result",
          callId: frame.callId,
          error: error instanceof Error ? error.message : String(error),
        })
      )
    }
  }
}

/** Normalise a ws payload, which may arrive as a Buffer or fragment array. */
function decodeFrame(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8")
  if (Buffer.isBuffer(data)) return data.toString("utf8")
  return Buffer.from(data).toString("utf8")
}
