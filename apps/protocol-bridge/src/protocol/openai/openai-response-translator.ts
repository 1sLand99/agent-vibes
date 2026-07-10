/**
 * Anthropic Messages response/SSE → OpenAI Chat Completions response/SSE.
 *
 * The bridge routes every inbound request through MessagesService, whose
 * canonical output is the Anthropic shape:
 *   - non-streaming: AnthropicResponse (content blocks + usage)
 *   - streaming: a sequence of Anthropic SSE strings
 *       (`event: <type>\ndata: <json>\n\n`)
 *
 * This module reverses that into the OpenAI surface so OpenAI SDK clients
 * see native `chat.completion` / `chat.completion.chunk` payloads.
 *
 * Anthropic thinking blocks map to the de-facto `reasoning_content` field
 * used by OpenAI-compatible providers (DeepSeek, one-api, etc.).
 */

import type { AnthropicResponse } from "../../shared/anthropic"
import type {
  OpenAiChatChoice,
  OpenAiChatCompletionChunk,
  OpenAiChatCompletionResponse,
  OpenAiCompletionResponse,
  OpenAiFinishReason,
  OpenAiResponseOutputItem,
  OpenAiResponsesRequest,
  OpenAiResponsesResponse,
  OpenAiResponsesUsage,
  OpenAiToolCall,
  OpenAiUsage,
} from "./openai-types"

// ── stop_reason mapping ─────────────────────────────────────────────────

export function mapStopReason(
  stopReason: string | null | undefined,
  hasToolCalls: boolean
): OpenAiFinishReason {
  if (hasToolCalls && (stopReason === "tool_use" || stopReason == null)) {
    return "tool_calls"
  }
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop"
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool_calls"
    case "refusal":
      return "content_filter"
    case null:
    case undefined:
      return "stop"
    default:
      return "stop"
  }
}

function mapUsage(usage: AnthropicResponse["usage"]): OpenAiUsage {
  const promptTokens =
    (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0)
  const completionTokens = usage.output_tokens || 0
  const result: OpenAiUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  }
  if (usage.cache_read_input_tokens) {
    result.prompt_tokens_details = {
      cached_tokens: usage.cache_read_input_tokens,
    }
  }
  return result
}

// ── Non-streaming ───────────────────────────────────────────────────────

/**
 * Translate a complete AnthropicResponse into an OpenAI chat.completion.
 */
export function translateAnthropicToOpenAiChat(
  response: AnthropicResponse,
  model: string,
  created: number
): OpenAiChatCompletionResponse {
  let text = ""
  let reasoning = ""
  const toolCalls: OpenAiToolCall[] = []

  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text
    } else if (block.type === "thinking") {
      reasoning += block.thinking
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      })
    }
  }

  const finishReason = mapStopReason(response.stop_reason, toolCalls.length > 0)

  const choice: OpenAiChatChoice = {
    index: 0,
    message: {
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    finish_reason: finishReason,
    logprobs: null,
  }

  return {
    id: response.id || `chatcmpl-${cryptoRandomId()}`,
    object: "chat.completion",
    created,
    model,
    choices: [choice],
    usage: mapUsage(response.usage),
  }
}

function mapResponsesUsage(
  usage: AnthropicResponse["usage"]
): OpenAiResponsesUsage {
  const cachedTokens = usage.cache_read_input_tokens || 0
  const inputTokens = (usage.input_tokens || 0) + cachedTokens
  const outputTokens = usage.output_tokens || 0
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  }
}

function buildResponsesEnvelope(
  id: string,
  createdAt: number,
  request: OpenAiResponsesRequest,
  output: OpenAiResponseOutputItem[],
  usage: OpenAiResponsesUsage,
  status: OpenAiResponsesResponse["status"]
): OpenAiResponsesResponse {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    error: null,
    incomplete_details:
      status === "incomplete" ? { reason: "max_output_tokens" } : null,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    model: request.model,
    output,
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: request.previous_response_id ?? null,
    reasoning: request.reasoning ?? null,
    store: request.store ?? false,
    temperature: request.temperature ?? null,
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    top_p: request.top_p ?? null,
    metadata: request.metadata ?? {},
    usage,
  }
}

export function translateAnthropicToOpenAiResponse(
  response: AnthropicResponse,
  request: OpenAiResponsesRequest,
  createdAt: number
): OpenAiResponsesResponse {
  let text = ""
  const output: OpenAiResponseOutputItem[] = []

  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text
      continue
    }
    if (block.type === "tool_use") {
      output.push({
        id: block.id,
        type: "function_call",
        status: "completed",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      })
    }
  }

  if (text) {
    output.unshift({
      id: response.id || `msg_${cryptoRandomId()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    })
  }

  const status =
    response.stop_reason === "max_tokens" ? "incomplete" : "completed"
  return buildResponsesEnvelope(
    response.id || `resp_${cryptoRandomId()}`,
    createdAt,
    request,
    output,
    mapResponsesUsage(response.usage),
    status
  )
}

/**
 * Translate a complete AnthropicResponse into a legacy text completion.
 */
export function translateAnthropicToOpenAiCompletion(
  response: AnthropicResponse,
  model: string,
  created: number
): OpenAiCompletionResponse {
  let text = ""
  for (const block of response.content) {
    if (block.type === "text") text += block.text
  }
  return {
    id: response.id || `cmpl-${cryptoRandomId()}`,
    object: "text_completion",
    created,
    model,
    choices: [
      {
        index: 0,
        text,
        finish_reason: mapStopReason(response.stop_reason, false),
        logprobs: null,
      },
    ],
    usage: mapUsage(response.usage),
  }
}

// ── Streaming: Anthropic SSE → OpenAI chunk SSE ─────────────────────────

interface AnthropicSseEvent {
  type: string
  index?: number
  delta?: Record<string, unknown>
  content_block?: Record<string, unknown>
  message?: Record<string, unknown>
  usage?: Record<string, unknown>
}

/**
 * Parse a single Anthropic SSE frame (a `data:`-prefixed block) into its
 * decoded event object. Returns null for keep-alive/blank frames or the
 * `[DONE]` sentinel. Shared by the chat and completion stream translators.
 */
function parseSseFrame(frame: string): AnthropicSseEvent | null {
  const dataLines: string[] = []
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  const payload = dataLines.join("\n")
  if (payload === "[DONE]") return null
  try {
    return JSON.parse(payload) as AnthropicSseEvent
  } catch {
    return null
  }
}

/**
 * Buffers raw Anthropic SSE text and yields decoded events once complete
 * `\n\n`-terminated frames are available. Shared by stream translators that
 * don't need bespoke buffering logic.
 */
class AnthropicSseFrameBuffer {
  private buffer = ""

  push(raw: string): AnthropicSseEvent[] {
    this.buffer += raw
    const events: AnthropicSseEvent[] = []
    let sepIndex: number
    while ((sepIndex = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, sepIndex)
      this.buffer = this.buffer.slice(sepIndex + 2)
      const event = parseSseFrame(frame)
      if (event) events.push(event)
    }
    return events
  }
}

/**
 * Stateful translator that consumes raw Anthropic SSE text and emits OpenAI
 * chat.completion.chunk SSE strings. Feed each upstream string chunk to
 * `push()`, then call `finish()` once the upstream generator completes.
 */
export class OpenAiChatStreamTranslator {
  private buffer = ""
  private readonly id: string
  private readonly created: number
  private readonly model: string
  private readonly includeUsage: boolean

  private sentRole = false
  private finishReason: OpenAiFinishReason = null
  private hasToolCalls = false
  // Maps Anthropic content-block index → OpenAI tool_call index.
  private toolBlockToIndex = new Map<number, number>()
  private nextToolIndex = 0
  // Tracks the type of each open block so deltas route correctly.
  private blockTypes = new Map<number, string>()
  private usage: OpenAiUsage | null = null

  constructor(opts: {
    id: string
    created: number
    model: string
    includeUsage: boolean
  }) {
    this.id = opts.id
    this.created = opts.created
    this.model = opts.model
    this.includeUsage = opts.includeUsage
  }

  /**
   * Parse a raw Anthropic SSE text chunk and return any OpenAI SSE strings
   * that should be flushed to the client.
   */
  push(raw: string): string[] {
    this.buffer += raw
    const out: string[] = []
    // SSE frames are separated by a blank line.
    let sepIndex: number
    while ((sepIndex = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, sepIndex)
      this.buffer = this.buffer.slice(sepIndex + 2)
      const event = parseSseFrame(frame)
      if (event) out.push(...this.handleEvent(event))
    }
    return out
  }

  private handleEvent(event: AnthropicSseEvent): string[] {
    switch (event.type) {
      case "content_block_start":
        return this.handleBlockStart(event)
      case "content_block_delta":
        return this.handleBlockDelta(event)
      case "message_delta":
        return this.handleMessageDelta(event)
      case "error":
        // Surface upstream mid-stream errors as a terminating chunk; the
        // controller-level error writer handles pre-stream failures.
        return []
      default:
        // message_start / content_block_stop / message_stop / ping → no
        // direct OpenAI chunk; finish() emits the terminal frame.
        return []
    }
  }

  private handleBlockStart(event: AnthropicSseEvent): string[] {
    const index = event.index ?? 0
    const block = event.content_block ?? {}
    const blockType = (block.type as string) || "text"
    this.blockTypes.set(index, blockType)

    if (blockType === "tool_use") {
      this.hasToolCalls = true
      const toolIndex = this.nextToolIndex++
      this.toolBlockToIndex.set(index, toolIndex)
      const toolCall: OpenAiToolCall = {
        index: toolIndex,
        id: (block.id as string) || "",
        type: "function",
        function: {
          name: (block.name as string) || "",
          arguments: "",
        },
      }
      return [this.chunk({ tool_calls: [toolCall] })]
    }
    return []
  }

  private handleBlockDelta(event: AnthropicSseEvent): string[] {
    const index = event.index ?? 0
    const delta = event.delta ?? {}
    const deltaType = delta.type as string

    if (deltaType === "text_delta") {
      const text = (delta.text as string) || ""
      if (!text) return []
      return [this.chunk({ content: text })]
    }
    if (deltaType === "thinking_delta") {
      const thinking = (delta.thinking as string) || ""
      if (!thinking) return []
      return [this.chunk({ reasoning_content: thinking })]
    }
    if (deltaType === "input_json_delta") {
      const partial = (delta.partial_json as string) || ""
      const toolIndex = this.toolBlockToIndex.get(index)
      if (toolIndex == null) return []
      const toolCall: OpenAiToolCall = {
        index: toolIndex,
        id: "",
        type: "function",
        function: { name: "", arguments: partial },
      }
      return [this.chunk({ tool_calls: [toolCall] })]
    }
    return []
  }

  private handleMessageDelta(event: AnthropicSseEvent): string[] {
    const delta = event.delta ?? {}
    const stopReason = delta.stop_reason as string | null | undefined
    if (stopReason !== undefined) {
      this.finishReason = mapStopReason(stopReason, this.hasToolCalls)
    }
    if (this.includeUsage && event.usage) {
      const outputTokens = (event.usage.output_tokens as number) || 0
      const inputTokens = (event.usage.input_tokens as number) || 0
      this.usage = {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      }
    }
    return []
  }

  /**
   * Emit the terminal chunk (with finish_reason), an optional usage-only
   * chunk, and the `[DONE]` sentinel.
   */
  finish(): string[] {
    const out: string[] = []
    const finishReason = this.finishReason ?? "stop"
    out.push(this.terminalChunk(finishReason))
    if (this.includeUsage) {
      out.push(this.usageChunk())
    }
    out.push("data: [DONE]\n\n")
    return out
  }

  // ── chunk builders ────────────────────────────────────────────────────

  private chunk(delta: {
    content?: string
    reasoning_content?: string
    tool_calls?: OpenAiToolCall[]
  }): string {
    const deltaObj: Record<string, unknown> = {}
    if (!this.sentRole) {
      deltaObj.role = "assistant"
      this.sentRole = true
    }
    if (delta.content !== undefined) deltaObj.content = delta.content
    if (delta.reasoning_content !== undefined) {
      deltaObj.reasoning_content = delta.reasoning_content
    }
    if (delta.tool_calls !== undefined) deltaObj.tool_calls = delta.tool_calls

    const chunk: OpenAiChatCompletionChunk = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [
        { index: 0, delta: deltaObj, finish_reason: null, logprobs: null },
      ],
    }
    return formatOpenAiSse(chunk)
  }

  private terminalChunk(finishReason: OpenAiFinishReason): string {
    const chunk: OpenAiChatCompletionChunk = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [
        { index: 0, delta: {}, finish_reason: finishReason, logprobs: null },
      ],
      ...(this.includeUsage ? { usage: null } : {}),
    }
    return formatOpenAiSse(chunk)
  }

  private usageChunk(): string {
    const chunk: OpenAiChatCompletionChunk = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [],
      usage: this.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    }
    return formatOpenAiSse(chunk)
  }
}

type OpenAiResponseMessageItem = Extract<
  OpenAiResponseOutputItem,
  { type: "message" }
>
type OpenAiResponseFunctionItem = Extract<
  OpenAiResponseOutputItem,
  { type: "function_call" }
>
type OpenAiResponseStreamBlock =
  | {
      kind: "text"
      item: OpenAiResponseMessageItem
      outputIndex: number
      done: boolean
    }
  | {
      kind: "tool"
      item: OpenAiResponseFunctionItem
      outputIndex: number
      done: boolean
    }

function emptyResponsesUsage(): OpenAiResponsesUsage {
  return {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 0,
  }
}

export class OpenAiResponsesStreamTranslator {
  private readonly frames = new AnthropicSseFrameBuffer()
  private readonly output: OpenAiResponseOutputItem[] = []
  private readonly usage = emptyResponsesUsage()
  private readonly blocks = new Map<number, OpenAiResponseStreamBlock>()
  private readonly response: OpenAiResponsesResponse
  private sequenceNumber = 0
  private stopReason: string | null = null

  constructor(opts: {
    id: string
    createdAt: number
    request: OpenAiResponsesRequest
  }) {
    this.response = buildResponsesEnvelope(
      opts.id,
      opts.createdAt,
      opts.request,
      this.output,
      this.usage,
      "in_progress"
    )
  }

  start(): string[] {
    return [
      this.event("response.created", { response: this.response }),
      this.event("response.in_progress", { response: this.response }),
    ]
  }

  push(raw: string): string[] {
    const output: string[] = []
    for (const event of this.frames.push(raw)) {
      output.push(...this.handleEvent(event))
    }
    return output
  }

  finish(): string[] {
    const output: string[] = []
    for (const block of this.blocks.values()) {
      if (!block.done) output.push(...this.closeBlock(block))
    }

    this.response.status =
      this.stopReason === "max_tokens" ? "incomplete" : "completed"
    this.response.incomplete_details =
      this.response.status === "incomplete"
        ? { reason: "max_output_tokens" }
        : null
    output.push(this.event("response.completed", { response: this.response }))
    output.push("data: [DONE]\n\n")
    return output
  }

  private handleEvent(event: AnthropicSseEvent): string[] {
    switch (event.type) {
      case "message_start":
        this.updateUsage(
          (event.message?.usage as Record<string, unknown> | undefined) ?? {}
        )
        return []
      case "content_block_start":
        return this.startBlock(event)
      case "content_block_delta":
        return this.updateBlock(event)
      case "content_block_stop": {
        const block = this.blocks.get(event.index ?? 0)
        return block ? this.closeBlock(block) : []
      }
      case "message_delta":
        this.stopReason =
          (event.delta?.stop_reason as string | null | undefined) ??
          this.stopReason
        this.updateUsage(event.usage ?? {})
        return []
      default:
        return []
    }
  }

  private startBlock(event: AnthropicSseEvent): string[] {
    const blockIndex = event.index ?? 0
    const block = event.content_block ?? {}
    const outputIndex = this.output.length

    if (block.type === "tool_use") {
      const callId = (block.id as string) || `call_${cryptoRandomId()}`
      const item: OpenAiResponseFunctionItem = {
        id: callId,
        type: "function_call",
        status: "in_progress",
        call_id: callId,
        name: (block.name as string) || "",
        arguments: "",
      }
      this.output.push(item)
      this.blocks.set(blockIndex, {
        kind: "tool",
        item,
        outputIndex,
        done: false,
      })
      return [
        this.event("response.output_item.added", {
          output_index: outputIndex,
          item,
        }),
      ]
    }

    if (block.type !== "text") return []

    const item: OpenAiResponseMessageItem = {
      id: `msg_${cryptoRandomId()}`,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [] }],
    }
    this.output.push(item)
    this.blocks.set(blockIndex, {
      kind: "text",
      item,
      outputIndex,
      done: false,
    })
    const part = item.content[0]
    const frames = [
      this.event("response.output_item.added", {
        output_index: outputIndex,
        item,
      }),
      this.event("response.content_part.added", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part,
      }),
    ]
    const initialText = (block.text as string) || ""
    if (initialText) {
      part.text += initialText
      frames.push(
        this.event("response.output_text.delta", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          delta: initialText,
          logprobs: [],
        })
      )
    }
    return frames
  }

  private updateBlock(event: AnthropicSseEvent): string[] {
    const block = this.blocks.get(event.index ?? 0)
    if (!block || block.done) return []
    const delta = event.delta ?? {}

    if (block.kind === "text" && delta.type === "text_delta") {
      const text = (delta.text as string) || ""
      if (!text) return []
      block.item.content[0].text += text
      return [
        this.event("response.output_text.delta", {
          item_id: block.item.id,
          output_index: block.outputIndex,
          content_index: 0,
          delta: text,
          logprobs: [],
        }),
      ]
    }

    if (block.kind === "tool" && delta.type === "input_json_delta") {
      const partial = (delta.partial_json as string) || ""
      if (!partial) return []
      block.item.arguments += partial
      return [
        this.event("response.function_call_arguments.delta", {
          item_id: block.item.id,
          output_index: block.outputIndex,
          delta: partial,
        }),
      ]
    }

    return []
  }

  private closeBlock(block: OpenAiResponseStreamBlock): string[] {
    if (block.done) return []
    block.done = true
    block.item.status = "completed"

    if (block.kind === "tool") {
      return [
        this.event("response.function_call_arguments.done", {
          item_id: block.item.id,
          output_index: block.outputIndex,
          arguments: block.item.arguments,
        }),
        this.event("response.output_item.done", {
          output_index: block.outputIndex,
          item: block.item,
        }),
      ]
    }

    const part = block.item.content[0]
    return [
      this.event("response.output_text.done", {
        item_id: block.item.id,
        output_index: block.outputIndex,
        content_index: 0,
        text: part.text,
        logprobs: [],
      }),
      this.event("response.content_part.done", {
        item_id: block.item.id,
        output_index: block.outputIndex,
        content_index: 0,
        part,
      }),
      this.event("response.output_item.done", {
        output_index: block.outputIndex,
        item: block.item,
      }),
    ]
  }

  private updateUsage(raw: Record<string, unknown>): void {
    const cachedTokens = Number(raw.cache_read_input_tokens || 0)
    if (raw.input_tokens !== undefined || cachedTokens > 0) {
      this.usage.input_tokens = Number(raw.input_tokens || 0) + cachedTokens
      this.usage.input_tokens_details.cached_tokens = cachedTokens
    }
    if (raw.output_tokens !== undefined) {
      this.usage.output_tokens = Number(raw.output_tokens || 0)
    }
    this.usage.total_tokens = this.usage.input_tokens + this.usage.output_tokens
  }

  private event(type: string, fields: Record<string, unknown>): string {
    return formatOpenAiResponseSse(type, {
      type,
      sequence_number: this.sequenceNumber++,
      ...fields,
    })
  }
}

/**
 * Stateful translator for the legacy `/v1/completions` streaming surface.
 * Only text deltas are surfaced (thinking/tool_use blocks have no place in
 * the legacy text-completion schema). Emits `text_completion` chunks.
 */
export class OpenAiCompletionStreamTranslator {
  private readonly frames = new AnthropicSseFrameBuffer()
  private readonly id: string
  private readonly created: number
  private readonly model: string
  private finishReason: OpenAiFinishReason = null

  constructor(opts: { id: string; created: number; model: string }) {
    this.id = opts.id
    this.created = opts.created
    this.model = opts.model
  }

  push(raw: string): string[] {
    const out: string[] = []
    for (const event of this.frames.push(raw)) {
      if (event.type === "content_block_delta") {
        const delta = event.delta ?? {}
        if ((delta.type as string) === "text_delta") {
          const text = (delta.text as string) || ""
          if (text) out.push(this.chunk(text, null))
        }
      } else if (event.type === "message_delta") {
        const stopReason = (event.delta ?? {}).stop_reason as
          | string
          | null
          | undefined
        if (stopReason !== undefined) {
          this.finishReason = mapStopReason(stopReason, false)
        }
      }
    }
    return out
  }

  finish(): string[] {
    return [this.chunk("", this.finishReason ?? "stop"), "data: [DONE]\n\n"]
  }

  private chunk(text: string, finishReason: OpenAiFinishReason): string {
    return formatOpenAiSse({
      id: this.id,
      object: "text_completion",
      created: this.created,
      model: this.model,
      choices: [
        { index: 0, text, finish_reason: finishReason, logprobs: null },
      ],
    })
  }
}

function formatOpenAiResponseSse(eventType: string, payload: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`
}

function formatOpenAiSse(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 12)
}
