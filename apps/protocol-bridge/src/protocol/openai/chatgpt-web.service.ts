import { Injectable, Logger } from "@nestjs/common"
import * as crypto from "node:crypto"
import {
  ChatGptWebConversationService,
  ChatGptWebError,
  type ChatGptWebMessage,
} from "../../llm/openai/chatgpt-web-conversation.service"
import type {
  OpenAiChatCompletionRequest,
  OpenAiChatCompletionResponse,
  OpenAiChatMessage,
  OpenAiContentPart,
  OpenAiResponsesRequest,
} from "./openai-types"

/**
 * Adapts the ChatGPT Web text backend onto the OpenAI-compatible surface
 * served at `/v1/web-gpt/*`.
 *
 * The upstream conversation API has no native function calling — a `tools`
 * array in the request is accepted and then ignored by upstream — so requests
 * carrying tools are rejected here rather than silently answered without
 * them, which would strand an agent waiting for a tool call that can never
 * arrive. Text and reasoning stream through unchanged.
 */

@Injectable()
export class ChatGptWebProtocolService {
  private readonly logger = new Logger(ChatGptWebProtocolService.name)

  constructor(private readonly conversation: ChatGptWebConversationService) {}

  listModelSlugs(): Promise<string[]> {
    return this.conversation.listModelSlugs()
  }

  private rejectToolUse(hasTools: boolean): void {
    if (!hasTools) return
    throw new ChatGptWebError(
      400,
      "chatgpt_web_tools_unsupported",
      "ChatGPT Web has no native function calling: upstream ignores the " +
        "`tools` field, so a tool-using request cannot be served here. Use a " +
        "Codex-backed model for agent turns."
    )
  }

  // ── Chat Completions ──────────────────────────────────────────────────

  async createChatCompletion(
    req: OpenAiChatCompletionRequest
  ): Promise<OpenAiChatCompletionResponse> {
    this.rejectToolUse((req.tools?.length ?? 0) > 0)
    const messages = normalizeChatMessages(req.messages)

    let text = ""
    let reasoning = ""
    for await (const event of this.conversation.stream({
      model: req.model,
      messages,
    })) {
      if (event.kind === "text") text += event.delta
      else if (event.kind === "reasoning") reasoning += event.delta
    }

    return {
      id: `chatcmpl-${randomId()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1_000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    } as OpenAiChatCompletionResponse
  }

  async *createChatCompletionStream(
    req: OpenAiChatCompletionRequest
  ): AsyncGenerator<string, void, unknown> {
    this.rejectToolUse((req.tools?.length ?? 0) > 0)
    const messages = normalizeChatMessages(req.messages)
    const id = `chatcmpl-${randomId()}`
    const created = Math.floor(Date.now() / 1_000)

    const frame = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: req.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`

    yield frame({ role: "assistant", content: "" }, null)
    for await (const event of this.conversation.stream({
      model: req.model,
      messages,
    })) {
      if (event.kind === "text") yield frame({ content: event.delta }, null)
      else if (event.kind === "reasoning")
        yield frame({ reasoning_content: event.delta }, null)
    }
    yield frame({}, "stop")
    yield "data: [DONE]\n\n"
  }

  // ── Responses API ─────────────────────────────────────────────────────

  async createResponse(
    req: OpenAiResponsesRequest
  ): Promise<Record<string, unknown>> {
    this.rejectToolUse((req.tools?.length ?? 0) > 0)
    const messages = normalizeResponsesInput(req)

    let text = ""
    for await (const event of this.conversation.stream({
      model: req.model,
      messages,
    })) {
      if (event.kind === "text") text += event.delta
    }

    return {
      id: `resp_${randomId()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1_000),
      status: "completed",
      model: req.model,
      output: [
        {
          type: "message",
          id: `msg_${randomId()}`,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    }
  }

  async *createResponseStream(
    req: OpenAiResponsesRequest,
    signal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    this.rejectToolUse((req.tools?.length ?? 0) > 0)
    const messages = normalizeResponsesInput(req)
    const responseId = `resp_${randomId()}`
    const itemId = `msg_${randomId()}`
    const createdAt = Math.floor(Date.now() / 1_000)
    let sequence = 0

    const emit = (type: string, payload: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({
        type,
        sequence_number: sequence++,
        ...payload,
      })}\n\n`

    const envelope = (status: string, text: string) => ({
      id: responseId,
      object: "response",
      created_at: createdAt,
      status,
      model: req.model,
      output: [
        {
          type: "message",
          id: itemId,
          status: status === "completed" ? "completed" : "in_progress",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    })

    yield emit("response.created", { response: envelope("in_progress", "") })
    yield emit("response.in_progress", {
      response: envelope("in_progress", ""),
    })
    yield emit("response.output_item.added", {
      output_index: 0,
      item: {
        type: "message",
        id: itemId,
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    })
    yield emit("response.content_part.added", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    })

    let text = ""
    for await (const event of this.conversation.stream({
      model: req.model,
      messages,
      signal,
    })) {
      if (event.kind !== "text") continue
      text += event.delta
      yield emit("response.output_text.delta", {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: event.delta,
      })
    }

    yield emit("response.output_text.done", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    })
    yield emit("response.content_part.done", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    })
    yield emit("response.output_item.done", {
      output_index: 0,
      item: {
        type: "message",
        id: itemId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    })
    yield emit("response.completed", { response: envelope("completed", text) })
  }
}

// ── request normalisation ───────────────────────────────────────────────

/** Flatten OpenAI content parts down to the plain text upstream accepts. */
function flattenContent(
  content: string | OpenAiContentPart[] | null | undefined
): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || !("text" in part)) return ""
      const text = (part as { text?: unknown }).text
      return typeof text === "string" ? text : ""
    })
    .filter(Boolean)
    .join("\n")
}

function normalizeChatMessages(
  messages: readonly OpenAiChatMessage[]
): ChatGptWebMessage[] {
  const normalized: ChatGptWebMessage[] = []
  for (const message of messages ?? []) {
    // `developer` is OpenAI's newer spelling of a system message; `tool`
    // results cannot occur here because tool use is rejected upstream.
    const role =
      message.role === "developer"
        ? "system"
        : message.role === "assistant"
          ? "assistant"
          : message.role === "system"
            ? "system"
            : "user"
    const content = flattenContent(message.content)
    if (content) normalized.push({ role, content })
  }
  return normalized
}

function normalizeResponsesInput(
  req: OpenAiResponsesRequest
): ChatGptWebMessage[] {
  const messages: ChatGptWebMessage[] = []
  if (req.instructions?.trim())
    messages.push({ role: "system", content: req.instructions })

  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input })
    return messages
  }

  for (const item of req.input ?? []) {
    const record = item as unknown as Record<string, unknown>
    if (record.type && record.type !== "message") continue
    const role = record.role === "assistant" ? "assistant" : "user"
    const content = flattenContent(
      record.content as string | OpenAiContentPart[] | null
    )
    if (content) messages.push({ role, content })
  }
  return messages
}

function randomId(): string {
  return crypto.randomBytes(12).toString("hex")
}
