import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { McpCursorToolsProvider } from "../../protocol/mcp/mcp-cursor-tools.provider"
import type { McpToolResult } from "../../protocol/mcp/mcp-types"
import { ChatGptWebBrowserService } from "./chatgpt-web-browser.service"
import { ChatGptWebError } from "./chatgpt-web-conversation.service"
import { ChatGptWebTurnSession } from "./chatgpt-web-turn-session"

/**
 * Runs a Cursor turn on ChatGPT Web.
 *
 * Holds the browser turn across the several provider requests Cursor makes for
 * one exchange, and owns the correspondence between them:
 *
 *   - The first request starts a browser turn and claims the MCP tool sink, so
 *     a tool call arriving from ChatGPT is routed to this conversation.
 *   - A tool call becomes a `tool_use` in the segment Cursor is reading; that
 *     segment ends, Cursor runs the tool, and comes back.
 *   - The next request hands Cursor's result to the waiting MCP call and
 *     returns the next segment of the same browser turn.
 *
 * Why a single sink rather than a lookup: the browser transport serialises
 * turns on one tab, so at most one ChatGPT turn is ever in flight. There is
 * nothing to disambiguate — and an MCP request carries no Cursor identity to
 * disambiguate with, which is what made every attempt to key this by
 * conversation fail.
 */

const IDLE_SESSION_MS = 10 * 60 * 1_000

/**
 * The model that parks a Cursor turn as a tool host.
 *
 * A tool call can only run inside a live Cursor turn — the editor executes its
 * tools in the stream it opened, and nothing can push one in from outside. So
 * a conversation started in ChatGPT's own web UI, which has no Cursor turn
 * behind it, needs one held open on its behalf: pick this model, send
 * anything, and the turn parks with the sink attached, handing each incoming
 * call to the editor until it is stopped or goes idle.
 */
export const CHATGPT_WEB_TOOL_HOST_MODEL = "tool-host"

interface ActiveTurn {
  readonly conversationId: string
  readonly session: ChatGptWebTurnSession
  readonly detachSink: () => void
  touchedAt: number
}

@Injectable()
export class ChatGptWebCursorBridge {
  private readonly logger = new Logger(ChatGptWebCursorBridge.name)
  private active: ActiveTurn | null = null

  constructor(
    private readonly configService: ConfigService,
    private readonly browser: ChatGptWebBrowserService,
    private readonly cursorTools: McpCursorToolsProvider
  ) {}

  private connectorId(): string {
    const id = this.configService
      .get<string>("CHATGPT_WEB_CONNECTOR_ID", "")
      .trim()
    if (!id) {
      throw new ChatGptWebError(
        503,
        "chatgpt_web_connector_unset",
        "Running a Cursor turn on ChatGPT Web needs CHATGPT_WEB_CONNECTOR_ID — " +
          "the connector that carries Cursor's tools"
      )
    }
    return id
  }

  /**
   * Anthropic SSE for one Cursor provider request.
   *
   * `toolResults` are the outcomes Cursor produced for the previous segment's
   * tool calls; handing them over is what unblocks the MCP requests still
   * holding ChatGPT's connector open.
   */
  async *stream(params: {
    conversationId: string
    model: string
    /** ChatGPT's own depth for this turn, if Cursor asked for one. */
    thinkingEffort?: string | null
    prompt: string
    toolResults: { toolCallId: string; result: McpToolResult }[]
    signal?: AbortSignal
  }): AsyncGenerator<string, void, unknown> {
    const turn = this.resume(params) ?? this.begin(params)

    for (const { toolCallId, result } of params.toolResults) {
      // A result for a call this turn is not waiting on is ignored rather than
      // treated as an error: Cursor replays results during recovery, and a
      // duplicate must not tear down a healthy turn.
      turn.session.submitToolResult(toolCallId, result)
    }

    turn.touchedAt = Date.now()
    try {
      yield* turn.session.segment()
    } catch (error) {
      this.end(turn, `segment failed: ${describe(error)}`)
      throw error
    }

    turn.touchedAt = Date.now()
    // `finished` already accounts for tool calls still waiting on the editor,
    // so a turn paused mid-tool is not torn down here.
    if (turn.session.finished) this.end(turn, "turn complete")
  }

  /** Continue the turn already in flight for this conversation, if any. */
  private resume(params: { conversationId: string }): ActiveTurn | null {
    const turn = this.active
    if (!turn) return null
    if (turn.conversationId !== params.conversationId) {
      // Another conversation wants the tab. The browser transport cannot serve
      // both, so the older turn is ended rather than left half-read with MCP
      // requests hanging off it.
      this.end(turn, "another conversation took the browser")
      return null
    }
    if (Date.now() - turn.touchedAt > IDLE_SESSION_MS) {
      this.end(turn, "idle too long")
      return null
    }
    return turn
  }

  private begin(params: {
    conversationId: string
    model: string
    thinkingEffort?: string | null
    prompt: string
    signal?: AbortSignal
  }): ActiveTurn {
    // A host turn drives no browser and needs no connector of its own: the
    // conversation it serves lives in ChatGPT's UI and already carries one.
    // Its source never yields, so the segment parks in the reader until a tool
    // call arrives or the turn is aborted.
    const host = isToolHost(params.model)
    const session = new ChatGptWebTurnSession({
      source: host
        ? parked(params.signal)
        : this.browser.streamTurn({
            prompt: params.prompt,
            connectorId: this.connectorId(),
            model: params.model,
            thinkingEffort: params.thinkingEffort ?? undefined,
            signal: params.signal,
          }),
    })

    const turn: ActiveTurn = {
      conversationId: params.conversationId,
      session,
      touchedAt: Date.now(),
      detachSink: this.cursorTools.attach({
        dispatch: (name, args) => session.dispatchTool(name, args),
      }),
    }
    this.active = turn
    this.logger.warn(
      `${host ? "Tool host" : "ChatGPT Web turn"} started for ` +
        `${params.conversationId.slice(0, 8)}…`
    )
    return turn
  }

  private end(turn: ActiveTurn, reason: string): void {
    if (this.active === turn) this.active = null
    turn.detachSink()
    turn.session.abort(reason)
    this.logger.warn(
      `ChatGPT Web turn ended for ${turn.conversationId.slice(0, 8)}…: ${reason}`
    )
  }

  /** Drop the turn for a conversation, if it owns the tab. */
  release(conversationId: string, reason: string): void {
    if (this.active?.conversationId === conversationId) {
      this.end(this.active, reason)
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether this backend model asks for a parked tool host. */
function isToolHost(model: string): boolean {
  return model.trim().toLowerCase() === CHATGPT_WEB_TOOL_HOST_MODEL
}

/**
 * A source that yields nothing and ends only when the turn is abandoned.
 *
 * The session treats the end of its source as the end of the turn, so this is
 * what keeps a host segment open: Cursor's stream stays parked, kept alive by
 * the heartbeat wrapper every other backend relies on, until the editor aborts
 * it.
 */
// Yielding nothing is the point: the turn produces no assistant output, it
// only stays open.
// eslint-disable-next-line require-yield
async function* parked(signal?: AbortSignal): AsyncGenerator<string> {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    signal?.addEventListener("abort", () => resolve(), { once: true })
  })
}
