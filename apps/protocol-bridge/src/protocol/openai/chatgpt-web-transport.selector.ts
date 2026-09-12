import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { ChatGptWebBrowserService } from "../../llm/openai/chatgpt-web-browser.service"
import { ChatGptWebV1Decoder } from "../../llm/openai/chatgpt-web-v1-stream"
import {
  ChatGptWebError,
  type ChatGptWebEvent,
  type ChatGptWebMessage,
} from "../../llm/openai/chatgpt-web-conversation.service"

/**
 * The browser-backed way to reach ChatGPT Web.
 *
 * Two transports answer `/v1/web-gpt/*` and they are not interchangeable:
 *
 *   - `http` speaks to `backend-api/conversation` directly. It is fast, has no
 *     moving parts, and offers every model in the web catalogue — but the model
 *     gets no tools, because a connector only activates for a request the web
 *     app itself issued.
 *   - `browser` drives a real tab, which is the only way found to make a
 *     connector-backed turn happen. It costs a Chrome process, serialises
 *     turns, and depends on the page's DOM.
 *
 * So the choice is really "do I need the workspace tools", and the default
 * stays on `http` because the browser transport is the one that can break when
 * ChatGPT ships a redesign.
 */

export type ChatGptWebTransport = "http" | "browser"

@Injectable()
export class ChatGptWebTransportSelector {
  private readonly logger = new Logger(ChatGptWebTransportSelector.name)

  constructor(
    private readonly configService: ConfigService,
    private readonly browser: ChatGptWebBrowserService
  ) {}

  /** Which transport a request should take. */
  resolve(model: string): ChatGptWebTransport {
    // An explicit `browser/` prefix wins, so one request can opt in without
    // changing the deployment's default.
    if (/^browser[/:]/i.test(model.trim())) return "browser"
    const configured = this.configService
      .get<string>("CHATGPT_WEB_TRANSPORT", "")
      .trim()
      .toLowerCase()
    return configured === "browser" ? "browser" : "http"
  }

  /** Strip a transport prefix, leaving the model id upstream expects. */
  static stripPrefix(model: string): string {
    return model.trim().replace(/^browser[/:]/i, "")
  }

  private connectorId(): string {
    const id = this.configService
      .get<string>("CHATGPT_WEB_CONNECTOR_ID", "")
      .trim()
    if (!id) {
      throw new ChatGptWebError(
        503,
        "chatgpt_web_connector_unset",
        "The browser transport needs CHATGPT_WEB_CONNECTOR_ID — the ChatGPT " +
          "connector whose tools the model should be offered"
      )
    }
    return id
  }

  /**
   * Run a turn through the browser, translated into the same event shape the
   * HTTP transport emits so callers do not branch on transport.
   */
  async *stream(
    model: string,
    messages: readonly ChatGptWebMessage[],
    signal?: AbortSignal
  ): AsyncGenerator<ChatGptWebEvent> {
    const connectorId = this.connectorId()
    const decoder = new ChatGptWebV1Decoder()
    let conversationId: string | undefined
    const slug = ChatGptWebTransportSelector.stripPrefix(model)

    for await (const chunk of this.browser.streamTurn({
      prompt: flatten(messages),
      connectorId,
      model: slug,
      // This surface has no depth of its own to express — an OpenAI-shaped
      // request carries no Cursor effort — so the model's own default stands.
      signal,
    })) {
      for (const event of decoder.push(chunk)) {
        if (event.kind === "text") yield { kind: "text", delta: event.delta }
        else if (event.kind === "reasoning")
          yield { kind: "reasoning", delta: event.delta }
        else if (event.kind === "tool_call") {
          // The tool ran on the workspace already; the model will narrate the
          // result. Surfacing the call keeps it out of the visible answer while
          // leaving a trace for the caller's logs.
          this.logger.warn(`ChatGPT Web tool call via ${event.tool}`)
        }
      }
    }
    yield { kind: "done", conversationId }
  }
}

/**
 * Collapse a conversation into one prompt.
 *
 * A browser turn is a single composer submission: there is no way to hand the
 * page a multi-message history, so prior turns are folded in as labelled text.
 * A caller that needs real multi-turn state should use the HTTP transport.
 */
function flatten(messages: readonly ChatGptWebMessage[]): string {
  if (messages.length === 1) return messages[0]!.content
  return messages
    .map((message) => {
      if (message.role === "user") return message.content
      const label = message.role === "system" ? "Instructions" : "Assistant"
      return `[${label}]\n${message.content}`
    })
    .join("\n\n")
}
