import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { HttpAdapterHost } from "@nestjs/core"
import * as crypto from "node:crypto"
import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import { McpService } from "./mcp.service"
import { parseRelayFrame } from "./mcp-relay.protocol"
import type { McpTool, McpToolProvider, McpToolResult } from "./mcp-types"

/**
 * Public half of the workspace relay.
 *
 * An editor agent dials in over WebSocket, proves it holds MCP_API_KEY, and
 * advertises the tools it can run. Only then does the MCP endpoint offer any
 * tools at all; when the socket drops, the endpoint goes back to being inert.
 *
 * The relay never executes anything itself and never learns how to reach the
 * workspace — it answers calls on a socket the workspace opened. That keeps
 * the internet-facing side of this system incapable of touching a machine on
 * its own, which is the property the whole design rests on.
 *
 * Enabled with MCP_RELAY_SERVER, so only the deployed instance listens.
 */

const RELAY_PATH = "/mcp/agent"
const CALL_TIMEOUT_MS = 120_000
const HEARTBEAT_MS = 30_000

interface PendingCall {
  resolve: (result: McpToolResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

@Injectable()
export class McpRelayGateway implements OnModuleInit {
  private readonly logger = new Logger(McpRelayGateway.name)
  private wss: WebSocketServer | null = null

  constructor(
    private readonly configService: ConfigService,
    private readonly adapterHost: HttpAdapterHost,
    private readonly mcp: McpService
  ) {}

  onModuleInit(): void {
    const enabled = this.configService
      .get<string>("MCP_RELAY_SERVER", "")
      .trim()
      .toLowerCase()
    if (!["1", "true", "yes", "on"].includes(enabled)) return

    const secret = this.configService.get<string>("MCP_API_KEY", "").trim()
    if (!secret) {
      this.logger.error(
        "MCP_RELAY_SERVER is set but MCP_API_KEY is not — refusing to accept " +
          "editor agents rather than accepting them unauthenticated"
      )
      return
    }

    const server = this.adapterHost.httpAdapter?.getHttpServer() as
      | Server
      | undefined
    if (!server) {
      this.logger.error("No HTTP server available; relay not started")
      return
    }

    this.wss = new WebSocketServer({ noServer: true })
    server.on("upgrade", (request, socket, head) =>
      this.handleUpgrade(request, socket, head, secret)
    )
    this.logger.warn(`MCP workspace relay listening on ${RELAY_PATH}`)
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    secret: string
  ): void {
    const url = request.url || ""
    if (!url.split("?")[0]?.startsWith(RELAY_PATH)) return

    if (!authorized(request, secret)) {
      this.logger.warn(
        `Relay upgrade rejected (${request.socket.remoteAddress || "unknown"})`
      )
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }

    this.wss?.handleUpgrade(request, socket, head, (ws) => this.attach(ws))
  }

  /** Bind one agent socket to a provider for as long as it stays open. */
  private attach(ws: WebSocket): void {
    const pending = new Map<string, PendingCall>()
    let tools: McpTool[] = []
    let providerId: string | null = null

    const detach = () => {
      if (providerId) this.mcp.unregisterProvider(providerId)
      providerId = null
      for (const call of pending.values()) {
        clearTimeout(call.timer)
        call.reject(new Error("Editor session disconnected"))
      }
      pending.clear()
    }

    const heartbeat = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "ping" }))
    }, HEARTBEAT_MS)

    ws.on("message", (data) => {
      const frame = parseRelayFrame(decodeFrame(data))
      if (!frame) return

      if (frame.type === "register") {
        tools = [...frame.tools]
        providerId = `editor:${frame.sessionId}`
        const provider: McpToolProvider = {
          id: providerId,
          listTools: () => tools,
          callTool: (name, args) => this.dispatch(ws, pending, name, args),
        }
        this.mcp.registerProvider(provider)
        this.logger.warn(
          `Editor session attached: ${frame.label} (${tools.length} tools)`
        )
        return
      }

      if (frame.type === "result") {
        const call = pending.get(frame.callId)
        if (!call) return
        pending.delete(frame.callId)
        clearTimeout(call.timer)
        if (frame.error) {
          // A refusal authored by the editor ("no editor session is attached",
          // "that file is outside the workspace") is information the model should
          // act on, and it carries nothing internal — so surface it as a tool
          // error rather than collapsing it into a generic internal failure.
          call.resolve({
            content: [{ type: "text", text: frame.error }],
            isError: true,
          })
        } else if (frame.result) call.resolve(frame.result)
        else call.reject(new Error("Editor returned no result"))
        return
      }

      if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }))
    })

    ws.on("close", () => {
      clearInterval(heartbeat)
      detach()
      this.logger.warn("Editor session detached")
    })
    ws.on("error", (error) => {
      this.logger.warn(`Workspace socket error: ${error.message}`)
    })
  }

  /** Send one call down the socket and wait for its matching result. */
  private dispatch(
    ws: WebSocket,
    pending: Map<string, PendingCall>,
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    if (ws.readyState !== ws.OPEN) {
      return Promise.reject(new Error("Editor session is not connected"))
    }
    const callId = crypto.randomUUID()
    return new Promise<McpToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(callId)
        reject(
          new Error(`Workspace did not answer within ${CALL_TIMEOUT_MS}ms`)
        )
      }, CALL_TIMEOUT_MS)
      pending.set(callId, { resolve, reject, timer })
      ws.send(JSON.stringify({ type: "call", callId, name, arguments: args }))
    })
  }
}

/** Normalise a ws payload (Buffer, ArrayBuffer or fragment list) to text. */
function decodeFrame(data: unknown): string {
  if (typeof data === "string") return data
  if (Buffer.isBuffer(data)) return data.toString("utf8")
  if (Array.isArray(data))
    return Buffer.concat(data as Buffer[]).toString("utf8")
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8")
  return ""
}

/** Constant-time credential check on the upgrade request. */
function authorized(request: IncomingMessage, secret: string): boolean {
  // IncomingHttpHeaders types `authorization` as a single string.
  const header: string = request.headers.authorization ?? ""
  const presented = header.replace(/^Bearer\s+/i, "")
  const a = crypto.createHash("sha256").update(presented).digest()
  const b = crypto.createHash("sha256").update(secret).digest()
  return crypto.timingSafeEqual(a, b)
}
