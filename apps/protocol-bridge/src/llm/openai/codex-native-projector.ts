import { codexResponseOutputItemToInputItem } from "./codex-response-items"
import { sanitizeResponsesToolCallIntegrity } from "../shared/openai-tool-call-integrity"
import { CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE } from "../../shared/provider-content"
import {
  type CodexConversationTool,
  type CodexExecutionRequest,
  type CodexInputItem,
  type CodexRequest,
  type CodexReasoningInputItem,
  type CodexSystemTextBlock,
  type CodexTool,
} from "./codex-native-types"
import { resolveCodexReasoningEffort } from "./codex-thinking"
import { buildShortNameMap, shortenNameIfNeeded } from "./tool-name-shortener"

export interface CodexNativeProjection {
  instructions: string
  input: CodexInputItem[]
  tools?: CodexTool[]
  serviceTier?: string
  reasoning: CodexRequest["reasoning"]
}

export interface CodexNativeProjectionOptions {
  supportsOriginalImageDetail?: boolean
  supportsImages?: boolean
}

type CodexProjectedToolCallType = "function" | "custom" | "tool_search"

type CodexProjectableMessage = {
  role: "user" | "assistant" | "developer"
  content: unknown
  messageId?: string
}

type CodexProjectableBlock = {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  item?: unknown
  thinking?: string
  signature?: string
  image_url?: string | { url?: string; detail?: string }
  url?: string
  content?:
    | string
    | Array<{
        type: string
        text?: string
        detail?: string
        image_url?: string | { url?: string; detail?: string }
        url?: string
        source?: Record<string, unknown>
      }>
  source?: {
    type?: string
    data?: string
    base64?: string
    url?: string
    media_type?: string
    mime_type?: string
  }
  detail?: string
}

const REMOTE_IMAGE_URL_PLACEHOLDER =
  "image content omitted because remote image URLs are not supported"
const UNSUPPORTED_LOW_DETAIL_PLACEHOLDER =
  "image content omitted because detail 'low' is not supported; use 'high', 'original', or 'auto'"
const IMAGE_PROCESSING_ERROR_PLACEHOLDER =
  "image content omitted because it could not be processed"
const UNSUPPORTED_IMAGE_MODEL_PLACEHOLDER =
  "image content omitted because the selected model does not support image inputs"
const DEFAULT_IMAGE_DETAIL = "high"

const TOOL_SCHEMA_DOC_KEYS = new Set([
  "description",
  "title",
  "examples",
  "example",
  "default",
])

export function projectCodexNativeRequest(
  request: CodexExecutionRequest,
  modelName: string = request.model,
  options: CodexNativeProjectionOptions = {}
): CodexNativeProjection {
  return {
    instructions: buildCodexInstructions(request),
    input: projectCodexInputItems(request, options),
    tools: projectCodexTools(request.tools),
    serviceTier: normalizeCodexServiceTier(request.serviceTier),
    reasoning: buildCodexReasoning(request, modelName),
  }
}

export function buildCodexInstructions(
  request: Pick<CodexExecutionRequest, "system">
): string {
  return serializeCodexInstructions(request.system)
}

export function projectCodexInputItems(
  request: Pick<
    CodexExecutionRequest,
    | "contextMessages"
    | "messages"
    | "tools"
    | "pendingToolUseIds"
    | "inputToolIntegrity"
  >,
  options: CodexNativeProjectionOptions = {}
): CodexInputItem[] {
  const shortenName = buildToolNameShortener(request.tools)
  const toolTypeByName = buildToolTypeLookup(request.tools)
  const toolCallTypeById = new Map<string, CodexProjectedToolCallType>()
  const input: CodexInputItem[] = []

  const appendMessages = (messages: CodexProjectableMessage[]) => {
    const assistantMessageIdsWithRawItems = new Set<string>()
    const assistantMessageIndexesInRawRuns = new Set<number>()
    let currentAssistantRunIndexes: number[] = []
    let currentAssistantRunHasRawItems = false
    const flushAssistantRun = () => {
      if (currentAssistantRunHasRawItems) {
        for (const index of currentAssistantRunIndexes) {
          assistantMessageIndexesInRawRuns.add(index)
        }
      }
      currentAssistantRunIndexes = []
      currentAssistantRunHasRawItems = false
    }

    for (let index = 0; index < messages.length; index++) {
      const msg = messages[index]!
      if (msg.role !== "assistant") {
        flushAssistantRun()
        continue
      }
      currentAssistantRunIndexes.push(index)
      const messageId =
        typeof msg.messageId === "string" ? msg.messageId.trim() : ""
      if (messageHasRawCodexResponseItems(msg)) {
        currentAssistantRunHasRawItems = true
        if (messageId) {
          assistantMessageIdsWithRawItems.add(messageId)
        }
      }
    }
    flushAssistantRun()

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const msg = messages[messageIndex]!
      const role = msg.role
      const messageContent: Array<Record<string, unknown>> = []
      let hasContent = false

      const flushMessage = () => {
        if (!hasContent) {
          return
        }
        input.push({
          type: "message",
          role,
          content: [...messageContent],
        })
        messageContent.length = 0
        hasContent = false
      }

      const appendTextContent = (text: string) => {
        const partType = role === "assistant" ? "output_text" : "input_text"
        messageContent.push({ type: partType, text })
        hasContent = true
      }

      const appendProjectedContent = (part: Record<string, unknown>) => {
        messageContent.push(part)
        hasContent = true
      }

      if (typeof msg.content === "string") {
        if (msg.content) {
          appendTextContent(msg.content)
        }
        flushMessage()
        continue
      }

      if (!Array.isArray(msg.content)) {
        continue
      }

      const blocks = msg.content as CodexProjectableBlock[]
      const hasRawResponseItems =
        role === "assistant" && blocks.some(isRawCodexResponseItemBlock)
      const messageId =
        typeof msg.messageId === "string" ? msg.messageId.trim() : ""
      if (
        role === "assistant" &&
        messageId &&
        assistantMessageIdsWithRawItems.has(messageId) &&
        !hasRawResponseItems
      ) {
        continue
      }
      if (
        role === "assistant" &&
        !messageId &&
        assistantMessageIndexesInRawRuns.has(messageIndex) &&
        !hasRawResponseItems
      ) {
        continue
      }

      for (const block of blocks) {
        if (
          hasRawResponseItems &&
          block.type !== CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE
        ) {
          continue
        }

        switch (block.type) {
          case "text":
            if (block.text) {
              appendTextContent(block.text)
            }
            break

          case "image":
          case "image_url":
          case "input_image": {
            const content = projectImageContent(block, "message", options)
            if (content) appendProjectedContent(content)
            break
          }

          case "tool_use":
            flushMessage()
            appendToolCallItem(input, block, {
              shortenName,
              toolTypeByName,
              toolCallTypeById,
            })
            break

          case "tool_result":
            flushMessage()
            appendToolOutputItem(input, block, toolCallTypeById, options)
            break

          case "thinking":
            flushMessage()
            {
              const reasoningItem = projectReasoningItemFromThinkingBlock(block)
              if (reasoningItem) {
                input.push(reasoningItem)
              }
            }
            break

          case CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE:
            flushMessage()
            {
              const rawItem =
                block.item && typeof block.item === "object"
                  ? codexResponseOutputItemToInputItem(
                      block.item as Record<string, unknown>
                    )
                  : undefined
              if (rawItem) {
                input.push(rawItem)
              }
            }
            break

          default:
            if (block.text) {
              appendTextContent(block.text)
            }
            break
        }
      }

      flushMessage()
    }
  }

  appendMessages((request.contextMessages || []) as CodexProjectableMessage[])
  appendMessages(request.messages as CodexProjectableMessage[])

  if (request.inputToolIntegrity === "preserve") {
    return input
  }

  return sanitizeResponsesToolCallIntegrity(input, request.pendingToolUseIds)
    .items
}

function projectReasoningItemFromThinkingBlock(
  block: CodexProjectableBlock
): CodexReasoningInputItem | undefined {
  const thinking = typeof block.thinking === "string" ? block.thinking : ""
  const signature = typeof block.signature === "string" ? block.signature : ""
  if (!thinking && !signature) {
    return undefined
  }

  return {
    type: "reasoning",
    summary: thinking ? [{ type: "summary_text", text: thinking }] : [],
    encrypted_content: signature || null,
  }
}

function messageHasRawCodexResponseItems(
  message: CodexProjectableMessage
): boolean {
  return (
    Array.isArray(message.content) &&
    (message.content as CodexProjectableBlock[]).some(
      isRawCodexResponseItemBlock
    )
  )
}

function isRawCodexResponseItemBlock(
  block: CodexProjectableBlock | undefined
): boolean {
  return block?.type === CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE
}

export function projectCodexTools(
  tools: CodexConversationTool[] | undefined
): CodexTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  const shortenName = buildToolNameShortener(tools)
  const codexTools: CodexTool[] = []
  for (const tool of tools) {
    if (tool.type === "tool_search") {
      codexTools.push({
        type: "tool_search",
        execution: tool.execution || "client",
        description: tool.description,
        parameters: normalizeToolParameters(tool.input_schema),
      })
      continue
    }

    if (tool.type === "web_search_20250305" || tool.type === "web_search") {
      codexTools.push({
        type: "web_search",
        external_web_access:
          typeof tool.external_web_access === "boolean"
            ? tool.external_web_access
            : true,
        ...(tool.search_context_size
          ? { search_context_size: tool.search_context_size }
          : {}),
        ...(Array.isArray(tool.search_content_types)
          ? { search_content_types: tool.search_content_types }
          : {}),
      })
      continue
    }

    if (tool.type === "custom") {
      codexTools.push({
        type: "custom",
        name: shortenName(tool.name || ""),
        description: tool.description,
        format: tool.format,
      })
      continue
    }

    if (tool.type === "image_generation") {
      codexTools.push({
        type: "image_generation",
        output_format: tool.output_format || "png",
      })
      continue
    }

    codexTools.push({
      type: "function",
      name: shortenName(tool.name || ""),
      description: tool.description,
      parameters: normalizeToolParameters(tool.input_schema),
      strict: false,
    })
  }

  return sortCodexToolsForStableRequests(codexTools)
}

export function normalizeCodexServiceTier(
  serviceTier?: string
): string | undefined {
  const normalized = serviceTier?.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }
  if (normalized === "fast") {
    return "priority"
  }
  return normalized
}

function buildCodexReasoning(
  request: Pick<
    CodexExecutionRequest,
    "thinkingIntent" | "includeThinkingSummary"
  >,
  modelName: string
): CodexRequest["reasoning"] {
  const reasoning: CodexRequest["reasoning"] = {
    effort: resolveCodexReasoningEffort(request.thinkingIntent, modelName),
  }
  if (request.includeThinkingSummary) {
    reasoning.summary = "auto"
  }
  return reasoning
}

function appendToolCallItem(
  input: CodexInputItem[],
  block: CodexProjectableBlock,
  options: {
    shortenName: (name: string) => string
    toolTypeByName: Map<string, CodexConversationTool["type"]>
    toolCallTypeById: Map<string, CodexProjectedToolCallType>
  }
): void {
  const originalName = block.name || ""
  const shortName = options.shortenName(originalName)
  const toolType =
    options.toolTypeByName.get(originalName) ||
    normalizeToolCallTypeHint((block as Record<string, unknown>).tool_call_type)
  const callId = block.id || ""

  if (toolType === "tool_search" || originalName === "tool_search") {
    input.push({
      type: "tool_search_call",
      call_id: callId,
      status: "completed",
      execution: "client",
      arguments: block.input || {},
    })
    options.toolCallTypeById.set(callId, "tool_search")
    return
  }

  if (toolType === "custom") {
    input.push({
      type: "custom_tool_call",
      call_id: callId,
      name: shortName,
      input: serializeCustomToolInput(block.input),
    })
    options.toolCallTypeById.set(callId, "custom")
    return
  }

  input.push({
    type: "function_call",
    call_id: callId,
    name: shortName,
    arguments:
      typeof block.input === "string"
        ? block.input
        : JSON.stringify(block.input || {}),
  })
  options.toolCallTypeById.set(callId, "function")
}

function appendToolOutputItem(
  input: CodexInputItem[],
  block: CodexProjectableBlock,
  toolCallTypeById: Map<string, CodexProjectedToolCallType>,
  options: CodexNativeProjectionOptions
): void {
  const output = projectToolResultOutput(block.content, options)
  const callId = block.tool_use_id || ""
  const callType =
    toolCallTypeById.get(callId) ||
    normalizeToolCallTypeHint((block as Record<string, unknown>).tool_call_type)

  if (callType === "tool_search") {
    input.push({
      type: "tool_search_output",
      call_id: callId,
      status: "completed",
      execution: "client",
      tools: projectToolSearchOutputTools(block.content),
    })
    return
  }

  if (callType === "custom") {
    input.push({
      type: "custom_tool_call_output",
      call_id: callId,
      output: serializeCustomToolOutput(output),
    })
    return
  }

  input.push({
    type: "function_call_output",
    call_id: callId,
    output,
  })
}

function projectToolResultOutput(
  content: CodexProjectableBlock["content"],
  options: CodexNativeProjectionOptions
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return ""
  }

  const parts: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (part.type === "text" && part.text) {
      parts.push({ type: "input_text", text: part.text })
      continue
    }
    if (
      part.type === "image" ||
      part.type === "image_url" ||
      part.type === "input_image"
    ) {
      const content = projectImageContent(part, "tool_output", options)
      if (content) parts.push(content)
    }
  }

  return parts.length > 0 ? parts : ""
}

function projectToolSearchOutputTools(
  content: CodexProjectableBlock["content"]
): unknown[] {
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "tool_search_output" &&
        Array.isArray((part as Record<string, unknown>).tools)
      ) {
        return [...((part as Record<string, unknown>).tools as unknown[])]
      }
    }
  }

  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>
      if (Array.isArray(parsed.tools)) {
        return [...(parsed.tools as unknown[])]
      }
    } catch {
      return []
    }
  }

  return []
}

function projectImageContent(
  block: Pick<CodexProjectableBlock, "detail" | "image_url" | "source" | "url">,
  mode: "message" | "tool_output",
  options: CodexNativeProjectionOptions
): Record<string, unknown> | undefined {
  const imageUrl = resolveImageUrl(block)
  if (!imageUrl) {
    return undefined
  }
  if (options.supportsImages === false) {
    return { type: "input_text", text: UNSUPPORTED_IMAGE_MODEL_PLACEHOLDER }
  }
  if (isRemoteImageUrl(imageUrl)) {
    return { type: "input_text", text: REMOTE_IMAGE_URL_PLACEHOLDER }
  }

  const detail = normalizeImageDetail(resolveImageDetail(block), mode, options)
  if (isDataUrl(imageUrl)) {
    if (detail === "low") {
      return { type: "input_text", text: UNSUPPORTED_LOW_DETAIL_PLACEHOLDER }
    }
    if (!hasDecodableBase64DataUrlPayload(imageUrl)) {
      return { type: "input_text", text: IMAGE_PROCESSING_ERROR_PLACEHOLDER }
    }
  }

  return {
    type: "input_image",
    image_url: imageUrl,
    ...(detail ? { detail } : {}),
  }
}

function resolveImageUrl(
  block: Pick<CodexProjectableBlock, "image_url" | "source" | "url">
): string | undefined {
  const source = block.source
  if (source) {
    const data = pickNonEmptyString(source.data, source.base64)
    if (data) {
      const mediaType =
        pickNonEmptyString(source.media_type, source.mime_type) ||
        "application/octet-stream"
      return `data:${mediaType};base64,${data}`
    }

    const sourceUrl = pickNonEmptyString(source.url)
    if (sourceUrl) {
      return sourceUrl
    }
  }

  const imageUrl = block.image_url
  if (typeof imageUrl === "string") {
    return nonEmptyString(imageUrl)
  }
  if (imageUrl && typeof imageUrl === "object") {
    return nonEmptyString(imageUrl.url)
  }

  return nonEmptyString(block.url)
}

function normalizeImageDetail(
  detail: string | undefined,
  mode: "message" | "tool_output",
  options: CodexNativeProjectionOptions
): string | undefined {
  const normalized = detail?.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }

  if (normalized === "original") {
    if (options.supportsOriginalImageDetail === true) {
      return "original"
    }
    return mode === "tool_output" ? DEFAULT_IMAGE_DETAIL : undefined
  }

  if (normalized === "auto" || normalized === "low" || normalized === "high") {
    return normalized
  }

  return detail
}

function resolveImageDetail(
  block: Pick<CodexProjectableBlock, "detail" | "image_url">
): string | undefined {
  const detail = nonEmptyString(block.detail)
  if (detail) {
    return detail
  }

  const imageUrl = block.image_url
  if (imageUrl && typeof imageUrl === "object") {
    return nonEmptyString(imageUrl.detail)
  }
  return undefined
}

function isRemoteImageUrl(imageUrl: string): boolean {
  return /^https?:/i.test(imageUrl)
}

function isDataUrl(imageUrl: string): boolean {
  return /^data:/i.test(imageUrl)
}

function hasDecodableBase64DataUrlPayload(imageUrl: string): boolean {
  const match = /^data:[^,]*;base64,(.*)$/is.exec(imageUrl)
  if (!match) {
    return false
  }

  const payload = match[1]?.replace(/\s+/g, "") ?? ""
  if (!payload || payload.length % 4 === 1) {
    return false
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    return false
  }
  return Buffer.from(payload, "base64").length > 0
}

function pickNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = nonEmptyString(value)
    if (text) return text
  }
  return undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function serializeCodexInstructions(
  system?: string | CodexSystemTextBlock[]
): string {
  if (typeof system === "string") {
    return system.trim()
  }

  if (!Array.isArray(system)) {
    return ""
  }

  return system
    .flatMap((block) => {
      if (block.type !== "text" || typeof block.text !== "string") {
        return []
      }
      if (block.text.startsWith("x-anthropic-billing-header: ")) {
        return []
      }
      const text = block.text.trim()
      return text ? [text] : []
    })
    .join("\n\n")
}

function buildToolNameShortener(
  tools: CodexConversationTool[] | undefined
): (name: string) => string {
  const toolNames: string[] = []
  if (tools) {
    for (const tool of tools) {
      if (tool.name) {
        toolNames.push(tool.name)
      }
    }
  }

  const shortMap =
    toolNames.length > 0
      ? buildShortNameMap(toolNames)
      : new Map<string, string>()

  return (name: string): string => {
    const short = shortMap.get(name)
    if (short) return short
    return shortenNameIfNeeded(name)
  }
}

function buildToolTypeLookup(
  tools: CodexConversationTool[] | undefined
): Map<string, CodexConversationTool["type"]> {
  const lookup = new Map<string, CodexConversationTool["type"]>()
  if (!tools) {
    return lookup
  }

  for (const tool of tools) {
    if (!tool?.name) continue
    lookup.set(tool.name, tool.type)
  }

  return lookup
}

function normalizeToolParameters(
  schema: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} }
  }
  const result = { ...schema }
  if (!result.type) {
    result.type = "object"
  }
  if (result.type === "object" && !result.properties) {
    result.properties = {}
  }
  delete result.$schema
  return compactToolSchemaForCodex(result) as Record<string, unknown>
}

function compactToolSchemaForCodex(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compactToolSchemaForCodex(item))
  }

  if (!value || typeof value !== "object") {
    return value
  }

  const compacted: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (TOOL_SCHEMA_DOC_KEYS.has(key)) {
      continue
    }
    compacted[key] = compactToolSchemaForCodex(nestedValue)
  }
  return compacted
}

function serializeCustomToolInput(input: unknown): string {
  if (typeof input === "string") {
    return input
  }

  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>
    for (const key of ["patch", "input", "content", "text"]) {
      const value = record[key]
      if (typeof value === "string") {
        return value
      }
    }
  }

  return JSON.stringify(input ?? {})
}

function serializeCustomToolOutput(
  output: string | Array<Record<string, unknown>>
): string {
  if (typeof output === "string") {
    return output
  }

  const parts: string[] = []
  for (const part of output) {
    if (part.type === "input_text" && typeof part.text === "string") {
      parts.push(part.text)
    }
  }

  if (parts.length > 0) {
    return parts.join("\n")
  }

  return JSON.stringify(output)
}

function normalizeToolCallTypeHint(
  value: unknown
): CodexProjectedToolCallType | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === "tool_search") {
    return "tool_search"
  }
  if (normalized === "custom") {
    return "custom"
  }
  if (normalized === "function") {
    return "function"
  }
  return undefined
}

function sortCodexToolsForStableRequests(tools: CodexTool[]): CodexTool[] {
  return [...tools].sort((a, b) =>
    stableToolSortKey(a).localeCompare(stableToolSortKey(b))
  )
}

function stableToolSortKey(tool: CodexTool): string {
  return [tool.type || "", tool.name || "", stableJsonStringify(tool)].join(
    "\u0000"
  )
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item))
  }
  if (!value || typeof value !== "object") {
    return value
  }
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortJsonValue((value as Record<string, unknown>)[key])
  }
  return sorted
}
