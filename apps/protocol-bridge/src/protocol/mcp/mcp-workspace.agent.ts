import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { execFile } from "node:child_process"
import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import WebSocket from "ws"
import type { McpTool, McpToolResult } from "./mcp-types"

/**
 * Workspace half of the relay: the process that actually touches files.
 *
 * It dials out to the public relay, advertises what it can do, and runs the
 * calls that come back. Everything here is scoped to one configured root:
 *
 *   - Every path argument is resolved and then checked to still sit inside
 *     the root, so `../` and absolute paths cannot walk out of it. Symlinks
 *     are resolved before the check for the same reason.
 *   - Writing is off unless MCP_WORKSPACE_WRITABLE is set.
 *   - Running commands is off unless MCP_WORKSPACE_EXEC is set, and even then
 *     the command runs without a shell, so there is no quoting or metacharacter
 *     path to a second command.
 *
 * The tools advertised depend on those flags, so a read-only deployment never
 * even tells the model that writing is possible.
 *
 * Enabled by setting MCP_RELAY_URL.
 */

const MAX_READ_BYTES = 256 * 1024
const MAX_OUTPUT_CHARS = 30_000
const EXEC_TIMEOUT_MS = 60_000
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000

@Injectable()
export class McpWorkspaceAgent implements OnModuleInit {
  private readonly logger = new Logger(McpWorkspaceAgent.name)
  private ws: WebSocket | null = null
  private reconnectDelay = RECONNECT_BASE_MS
  private root = ""
  /** `root` with symlinks resolved; compared against, and cached on first use. */
  private realRoot: string | null = null
  private writable = false
  private execEnabled = false
  private readonly sessionId = crypto.randomUUID()

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const url = this.configService.get<string>("MCP_RELAY_URL", "").trim()
    if (!url) return

    const configuredRoot = this.configService
      .get<string>("MCP_WORKSPACE_ROOT", "")
      .trim()
    if (!configuredRoot) {
      this.logger.error(
        "MCP_RELAY_URL is set but MCP_WORKSPACE_ROOT is not — refusing to " +
          "expose a workspace without an explicit root"
      )
      return
    }
    this.root = path.resolve(configuredRoot)
    this.writable = flag(this.configService, "MCP_WORKSPACE_WRITABLE")
    this.execEnabled = flag(this.configService, "MCP_WORKSPACE_EXEC")

    this.logger.warn(
      `Workspace agent: root=${this.root} writable=${this.writable} exec=${this.execEnabled}`
    )
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
      ws.send(
        JSON.stringify({
          type: "register",
          sessionId: this.sessionId,
          label: `${os.hostname()}:${path.basename(this.root)}`,
          tools: this.tools(),
        })
      )
      this.logger.log(`Attached to relay at ${url}`)
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
    try {
      const result = await this.run(frame.name, args)
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

  // ── tools ─────────────────────────────────────────────────────────────

  private tools(): McpTool[] {
    const tools: McpTool[] = [
      {
        name: "read_file",
        description:
          "Read a UTF-8 text file from the workspace. Paths are relative to " +
          "the workspace root.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "list_directory",
        description:
          "List the entries of a directory in the workspace. Paths are " +
          "relative to the workspace root; omit for the root itself.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ]

    if (this.writable) {
      tools.push({
        name: "write_file",
        description:
          "Create or overwrite a UTF-8 text file in the workspace. Paths are " +
          "relative to the workspace root.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      })
    }

    if (this.execEnabled) {
      tools.push({
        name: "run_command",
        description:
          "Run a program in the workspace root and return its output. The " +
          "program and its arguments are passed separately; no shell is used.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Program to run" },
            args: { type: "array", items: { type: "string" } },
          },
          required: ["command"],
        },
      })
    }

    return tools
  }

  private async run(
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    // warn, not log: this is the record that something outside the machine
    // touched the workspace, and it has to survive the default log level.
    this.logger.warn(`Workspace tool: ${name}`)
    switch (name) {
      case "read_file":
        return this.readFile(str(args.path))
      case "list_directory":
        return this.listDirectory(str(args.path) || ".")
      case "write_file":
        if (!this.writable) throw new Error("Workspace is read-only")
        return this.writeFile(str(args.path), str(args.content))
      case "run_command":
        if (!this.execEnabled) throw new Error("Command execution is disabled")
        return this.runCommand(str(args.command), args.args)
      default:
        throw new Error(`Unknown tool: ${name.slice(0, 60)}`)
    }
  }

  /**
   * Resolve a caller-supplied path inside the workspace.
   *
   * `realpath` collapses symlinks before the containment check, so a link
   * planted inside the workspace cannot point out of it. A path that does not
   * exist yet is checked against its nearest existing parent instead.
   */
  private async resolveInside(relative: string): Promise<string> {
    if (!relative) throw new Error("A path is required")
    const candidate = path.resolve(this.root, relative)

    // The root itself is resolved too. A configured root that sits behind a
    // symlink (on macOS /tmp and /var are, so this is the normal case there)
    // would otherwise never match its own realpath, and every call inside a
    // perfectly legitimate workspace would be refused.
    this.realRoot ??= await fs.realpath(this.root)

    // Walk up to the nearest parent that exists, so a path being created is
    // checked against real ancestors rather than failing outright.
    let probe = candidate
    let real: string | null = null
    for (;;) {
      try {
        real = await fs.realpath(probe)
        break
      } catch {
        const parent = path.dirname(probe)
        if (parent === probe) break
        probe = parent
      }
    }
    if (!real) throw new Error("Path escapes the workspace root")

    const suffix = path.relative(probe, candidate)
    const resolved = suffix ? path.join(real, suffix) : real
    const rel = path.relative(this.realRoot, resolved)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Path escapes the workspace root")
    }
    return resolved
  }

  private async readFile(relative: string): Promise<McpToolResult> {
    const target = await this.resolveInside(relative)
    const stat = await fs.stat(target)
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(
        `File is ${stat.size} bytes; the limit is ${MAX_READ_BYTES}`
      )
    }
    const text = await fs.readFile(target, "utf8")
    return { content: [{ type: "text", text }] }
  }

  private async listDirectory(relative: string): Promise<McpToolResult> {
    const target = await this.resolveInside(relative)
    const entries = await fs.readdir(target, { withFileTypes: true })
    const lines = entries
      .map((e) => `${e.isDirectory() ? "dir " : "file"}  ${e.name}`)
      .sort()
    return { content: [{ type: "text", text: lines.join("\n") || "(empty)" }] }
  }

  private async writeFile(
    relative: string,
    content: string
  ): Promise<McpToolResult> {
    const target = await this.resolveInside(relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, "utf8")
    return {
      content: [
        {
          type: "text",
          text: `Wrote ${Buffer.byteLength(content)} bytes to ${path.relative(this.root, target)}`,
        },
      ],
    }
  }

  private runCommand(
    command: string,
    rawArgs: unknown
  ): Promise<McpToolResult> {
    if (!command) throw new Error("A command is required")
    const args = Array.isArray(rawArgs) ? rawArgs.map((a) => String(a)) : []
    return new Promise((resolve) => {
      // No shell: the program and its arguments stay separate, so quoting and
      // metacharacters cannot turn one command into two.
      execFile(
        command,
        args,
        {
          cwd: this.root,
          timeout: EXEC_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          shell: false,
        },
        (error, stdout, stderr) => {
          const body = [
            stdout && `stdout:\n${stdout}`,
            stderr && `stderr:\n${stderr}`,
            error && `error: ${error.message}`,
          ]
            .filter(Boolean)
            .join("\n\n")
            .slice(0, MAX_OUTPUT_CHARS)
          resolve({
            content: [{ type: "text", text: body || "(no output)" }],
            isError: !!error,
          })
        }
      )
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

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function flag(config: ConfigService, key: string): boolean {
  const value = config.get<string>(key, "").trim().toLowerCase()
  return ["1", "true", "yes", "on"].includes(value)
}
