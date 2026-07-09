import { randomUUID } from "crypto"
import { HttpStatus } from "@nestjs/common"
import type { AnthropicResponse, ContentBlock } from "../../shared/anthropic"
import type { CountTokensDto } from "../anthropic/dto/count-tokens.dto"
import type { CreateMessageDto } from "../anthropic/dto/create-message.dto"
import { googleHttpException } from "./google-error"
import { normalizeGoogleModelId } from "./google-models"

export type GoogleGenerateContentRequest = Record<string, unknown>

interface GoogleContent {
  role?: string
  parts?: GooglePart[]
}

interface GooglePart {
  text?: string
  inlineData?: {
    mimeType?: string
    data?: string
  }
  inline_data?: {
    mime_type?: string
    data?: string
  }
  functionCall?: {
    id?: string
    name?: string
    args?: Record<string, unknown>
  }
  function_call?: {
    id?: string
    name?: string
    args?: Record<string, unknown>
  }
  functionResponse?: {
    id?: string
    name?: string
    response?: unknown
  }
  function_response?: {
    id?: string
    name?: string
    response?: unknown
  }
  thought?: boolean
  thoughtSignature?: string
  thought_signature?: string
  fileData?: unknown
  file_data?: unknown
}

interface AnthropicContentBlock extends Record<string, unknown> {
  type: string
}

interface AnthropicSseEvent {
  type: string
  index?: number
  delta?: Record<string, unknown>
  content_block?: Record<string, unknown>
  message?: Record<string, unknown>
  usage?: Record<string, unknown>
}

const GOOGLE_GENERATION_CONFIG_FIELDS = new Set([
  "responseMimeType",
  "responseSchema",
  "responseJsonSchema",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
  "responseLogprobs",
  "logprobs",
  "enableEnhancedCivicAnswers",
  "responseModalities",
  "mediaResolution",
  "speechConfig",
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null
}

function asContentArray(value: unknown): GoogleContent[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is GoogleContent => Boolean(asRecord(item)))
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema)
  const record = asRecord(value)
  if (!record) return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (key === "type" && typeof child === "string") {
      out[key] = child.toLowerCase()
    } else {
      out[key] = normalizeSchema(child)
    }
  }
  return out
}

function textFromParts(parts: GooglePart[]): string {
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n")
}

function convertGoogleRole(role: string | undefined): "user" | "assistant" {
  return role === "model" ? "assistant" : "user"
}

function convertPartToAnthropicBlock(
  part: GooglePart,
  role: "user" | "assistant"
): AnthropicContentBlock | null {
  if (typeof part.text === "string") {
    if (part.thought && role === "assistant") {
      return {
        type: "thinking",
        thinking: part.text,
        signature: part.thoughtSignature || part.thought_signature,
      }
    }
    return { type: "text", text: part.text }
  }

  const inlineData =
    part.inlineData ||
    (part.inline_data
      ? {
          mimeType: part.inline_data.mime_type,
          data: part.inline_data.data,
        }
      : undefined)
  if (inlineData) {
    if (!inlineData.mimeType?.startsWith("image/") || !inlineData.data) {
      throw googleHttpException(
        HttpStatus.BAD_REQUEST,
        "Only inline image data is supported for Gemini content parts",
        "INVALID_ARGUMENT"
      )
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: inlineData.mimeType,
        data: inlineData.data,
      },
    }
  }

  const functionCall = part.functionCall || part.function_call
  if (functionCall) {
    if (!functionCall.name) {
      throw googleHttpException(
        HttpStatus.BAD_REQUEST,
        "functionCall.name is required",
        "INVALID_ARGUMENT"
      )
    }
    return {
      type: "tool_use",
      id: functionCall.id || `call_${randomUUID().replace(/-/g, "")}`,
      name: functionCall.name,
      input: functionCall.args || {},
      signature: part.thoughtSignature || part.thought_signature,
    }
  }

  const functionResponse = part.functionResponse || part.function_response
  if (functionResponse) {
    if (!functionResponse.name) {
      throw googleHttpException(
        HttpStatus.BAD_REQUEST,
        "functionResponse.name is required",
        "INVALID_ARGUMENT"
      )
    }
    const response = functionResponse.response ?? {}
    return {
      type: "tool_result",
      tool_use_id: functionResponse.id || functionResponse.name,
      name: functionResponse.name,
      structuredContent: asRecord(response) || undefined,
      content:
        typeof response === "string" ? response : JSON.stringify(response),
    }
  }

  if (part.fileData || part.file_data) {
    throw googleHttpException(
      HttpStatus.NOT_IMPLEMENTED,
      "fileData parts require the Google Files API, which is not implemented by this bridge",
      "UNIMPLEMENTED"
    )
  }

  return null
}

function convertContents(
  contents: GoogleContent[]
): CreateMessageDto["messages"] {
  return contents.map((content) => {
    const role = convertGoogleRole(content.role)
    const parts = Array.isArray(content.parts) ? content.parts : []
    const blocks = parts
      .map((part) => convertPartToAnthropicBlock(part, role))
      .filter((block): block is AnthropicContentBlock => block !== null)

    return {
      role,
      content: blocks.length > 0 ? blocks : [{ type: "text", text: "." }],
    }
  }) as CreateMessageDto["messages"]
}

function convertSystemInstruction(value: unknown): CreateMessageDto["system"] {
  const record = asRecord(value)
  if (!record) return undefined
  const parts = Array.isArray(record.parts)
    ? (record.parts as GooglePart[])
    : []
  const text = textFromParts(parts).trim()
  return text || undefined
}

function convertTools(value: unknown): CreateMessageDto["tools"] {
  if (!Array.isArray(value)) return undefined

  const tools: NonNullable<CreateMessageDto["tools"]> = []
  for (const tool of value) {
    const record = asRecord(tool)
    const declarations = Array.isArray(record?.functionDeclarations)
      ? record.functionDeclarations
      : []
    for (const declaration of declarations) {
      const item = asRecord(declaration)
      if (!item || typeof item.name !== "string") continue
      tools.push({
        type: "custom",
        name: item.name,
        description:
          typeof item.description === "string" ? item.description : undefined,
        input_schema: asRecord(item.parameters)
          ? (normalizeSchema(item.parameters) as Record<string, unknown>)
          : { type: "object", properties: {} },
      })
    }
  }

  return tools.length > 0 ? tools : undefined
}

function convertToolChoice(value: unknown): CreateMessageDto["tool_choice"] {
  const record = asRecord(value)
  const config = asRecord(record?.functionCallingConfig)
  const mode = typeof config?.mode === "string" ? config.mode : undefined
  const allowed = Array.isArray(config?.allowedFunctionNames)
    ? config.allowedFunctionNames.filter(
        (name): name is string => typeof name === "string" && name.length > 0
      )
    : []

  switch (mode) {
    case "NONE":
      return "none"
    case "ANY":
    case "VALIDATED":
      return allowed.length === 1 ? { type: "tool", name: allowed[0] } : "any"
    case "AUTO":
      return "auto"
    default:
      return undefined
  }
}

function convertThinkingConfig(
  generationConfig: Record<string, unknown>
): CreateMessageDto["thinking"] {
  const thinkingConfig = asRecord(generationConfig.thinkingConfig)
  if (!thinkingConfig) return undefined

  const budget = thinkingConfig.thinkingBudget
  if (typeof budget === "number" && budget === 0) {
    return { type: "disabled" }
  }

  return {
    type: "enabled",
    ...(typeof budget === "number" ? { budget_tokens: budget } : {}),
  }
}

function extractExtraGenerationConfig(
  generationConfig: Record<string, unknown>
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  for (const key of GOOGLE_GENERATION_CONFIG_FIELDS) {
    if (generationConfig[key] !== undefined) out[key] = generationConfig[key]
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function googleGenerateRequestToAnthropic(
  model: string,
  request: GoogleGenerateContentRequest,
  stream: boolean
): CreateMessageDto {
  const generationConfig = asRecord(request.generationConfig) || {}
  const candidateCount = generationConfig.candidateCount
  if (typeof candidateCount === "number" && candidateCount > 1) {
    throw googleHttpException(
      HttpStatus.BAD_REQUEST,
      "candidateCount greater than 1 is not supported by this bridge",
      "INVALID_ARGUMENT"
    )
  }
  if (request.cachedContent) {
    throw googleHttpException(
      HttpStatus.NOT_IMPLEMENTED,
      "cachedContent requires the Google Cached Contents API, which is not implemented by this bridge",
      "UNIMPLEMENTED"
    )
  }

  const dto = {
    model: normalizeGoogleModelId(model),
    messages: convertContents(asContentArray(request.contents)),
    stream,
    system: convertSystemInstruction(request.systemInstruction),
    tools: convertTools(request.tools),
    tool_choice: convertToolChoice(request.toolConfig),
    max_tokens:
      typeof generationConfig.maxOutputTokens === "number"
        ? generationConfig.maxOutputTokens
        : undefined,
    temperature:
      typeof generationConfig.temperature === "number"
        ? generationConfig.temperature
        : undefined,
    top_p:
      typeof generationConfig.topP === "number"
        ? generationConfig.topP
        : undefined,
    top_k:
      typeof generationConfig.topK === "number"
        ? generationConfig.topK
        : undefined,
    stop_sequences: Array.isArray(generationConfig.stopSequences)
      ? generationConfig.stopSequences.filter(
          (value): value is string => typeof value === "string"
        )
      : undefined,
    thinking: convertThinkingConfig(generationConfig),
    _googleGenerationConfig: extractExtraGenerationConfig(generationConfig),
    _googleRequestFields: request.safetySettings
      ? { safetySettings: request.safetySettings }
      : undefined,
  } as CreateMessageDto & {
    _googleGenerationConfig?: Record<string, unknown>
    _googleRequestFields?: Record<string, unknown>
  }

  if (!dto.messages || dto.messages.length === 0) {
    throw googleHttpException(
      HttpStatus.BAD_REQUEST,
      "contents is required",
      "INVALID_ARGUMENT"
    )
  }

  return dto
}

export function googleCountTokensRequestToAnthropic(
  model: string,
  request: GoogleGenerateContentRequest
): CountTokensDto {
  const nested = asRecord(request.generateContentRequest)
  const source = nested || request
  const dto = googleGenerateRequestToAnthropic(model, source, false)
  return {
    model: dto.model,
    messages: dto.messages,
    system: dto.system,
    tools: dto.tools,
  } as CountTokensDto
}

function mapFinishReason(stopReason: string | null | undefined): string {
  switch (stopReason) {
    case "max_tokens":
      return "MAX_TOKENS"
    case "stop_sequence":
    case "end_turn":
    case "tool_use":
    default:
      return "STOP"
  }
}

function contentBlockToGooglePart(
  block: ContentBlock
): Record<string, unknown> | null {
  if (block.type === "text") return { text: block.text }
  if (block.type === "thinking") {
    return {
      text: block.thinking,
      thought: true,
      ...(block.signature ? { thoughtSignature: block.signature } : {}),
    }
  }
  if (block.type === "tool_use") {
    return {
      functionCall: {
        id: block.id,
        name: block.name,
        args: block.input || {},
      },
    }
  }
  return null
}

export function anthropicResponseToGoogleGenerateContent(
  response: AnthropicResponse,
  model: string
): Record<string, unknown> {
  const parts = response.content
    .map(contentBlockToGooglePart)
    .filter((part): part is Record<string, unknown> => part !== null)

  const promptTokenCount = response.usage?.input_tokens || 0
  const candidatesTokenCount = response.usage?.output_tokens || 0
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts,
        },
        finishReason: mapFinishReason(response.stop_reason),
        index: 0,
        safetyRatings: [],
      },
    ],
    usageMetadata: {
      promptTokenCount,
      candidatesTokenCount,
      totalTokenCount: promptTokenCount + candidatesTokenCount,
    },
    modelVersion: normalizeGoogleModelId(model),
    responseId: response.id,
  }
}

function parseSseFrame(frame: string): AnthropicSseEvent | null {
  const dataLines: string[] = []
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
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

export class GoogleStreamTranslator {
  private buffer = ""
  private blockTypes = new Map<number, string>()
  private toolJson = new Map<number, string>()
  private toolBlocks = new Map<number, Record<string, unknown>>()
  private promptTokenCount = 0
  private candidatesTokenCount = 0

  constructor(private readonly model: string) {}

  push(raw: string): string[] {
    this.buffer += raw
    const out: string[] = []
    let sepIndex: number
    while ((sepIndex = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, sepIndex)
      this.buffer = this.buffer.slice(sepIndex + 2)
      const event = parseSseFrame(frame)
      if (event) out.push(...this.handleEvent(event))
    }
    return out
  }

  finish(): string[] {
    return []
  }

  private handleEvent(event: AnthropicSseEvent): string[] {
    switch (event.type) {
      case "content_block_start":
        return this.handleBlockStart(event)
      case "content_block_delta":
        return this.handleBlockDelta(event)
      case "content_block_stop":
        return this.handleBlockStop(event)
      case "message_delta":
        return this.handleMessageDelta(event)
      default:
        return []
    }
  }

  private handleBlockStart(event: AnthropicSseEvent): string[] {
    const index = event.index ?? 0
    const block = event.content_block || {}
    const type = typeof block.type === "string" ? block.type : "text"
    this.blockTypes.set(index, type)

    if (type === "tool_use") {
      this.toolBlocks.set(index, block)
      this.toolJson.set(index, "")
    }

    if (type === "text" && typeof block.text === "string" && block.text) {
      return [this.formatChunk([{ text: block.text }])]
    }
    if (
      type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking
    ) {
      return [this.formatChunk([{ text: block.thinking, thought: true }])]
    }
    return []
  }

  private handleBlockDelta(event: AnthropicSseEvent): string[] {
    const index = event.index ?? 0
    const delta = event.delta || {}
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return [this.formatChunk([{ text: delta.text }])]
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      return [this.formatChunk([{ text: delta.thinking, thought: true }])]
    }
    if (
      delta.type === "input_json_delta" &&
      typeof delta.partial_json === "string"
    ) {
      this.toolJson.set(
        index,
        (this.toolJson.get(index) || "") + delta.partial_json
      )
    }
    return []
  }

  private handleBlockStop(event: AnthropicSseEvent): string[] {
    const index = event.index ?? 0
    if (this.blockTypes.get(index) !== "tool_use") return []

    const block = this.toolBlocks.get(index) || {}
    const partialJson = this.toolJson.get(index) || "{}"
    let args: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(partialJson)
      const parsedRecord = asRecord(parsed)
      if (parsedRecord) args = parsedRecord
    } catch {
      args = {}
    }

    this.toolBlocks.delete(index)
    this.toolJson.delete(index)
    return [
      this.formatChunk([
        {
          functionCall: {
            id: typeof block.id === "string" ? block.id : undefined,
            name: typeof block.name === "string" ? block.name : "unknown",
            args,
          },
        },
      ]),
    ]
  }

  private handleMessageDelta(event: AnthropicSseEvent): string[] {
    const usage = asRecord(event.usage)
    if (typeof usage?.input_tokens === "number") {
      this.promptTokenCount = usage.input_tokens
    }
    if (typeof usage?.output_tokens === "number") {
      this.candidatesTokenCount = usage.output_tokens
    }

    const delta = event.delta || {}
    const stopReason =
      typeof delta.stop_reason === "string" ? delta.stop_reason : undefined
    if (!stopReason) return []

    return [
      this.formatChunk([], {
        finishReason: mapFinishReason(stopReason),
        usageMetadata:
          this.promptTokenCount || this.candidatesTokenCount
            ? {
                promptTokenCount: this.promptTokenCount,
                candidatesTokenCount: this.candidatesTokenCount,
                totalTokenCount:
                  this.promptTokenCount + this.candidatesTokenCount,
              }
            : undefined,
      }),
    ]
  }

  private formatChunk(
    parts: Record<string, unknown>[],
    options?: {
      finishReason?: string
      usageMetadata?: Record<string, unknown>
    }
  ): string {
    const body: Record<string, unknown> = {
      candidates: [
        {
          content: {
            role: "model",
            parts,
          },
          index: 0,
          safetyRatings: [],
          ...(options?.finishReason
            ? { finishReason: options.finishReason }
            : {}),
        },
      ],
      modelVersion: normalizeGoogleModelId(this.model),
      ...(options?.usageMetadata
        ? { usageMetadata: options.usageMetadata }
        : {}),
    }
    return `data: ${JSON.stringify(body)}\n\n`
  }
}
