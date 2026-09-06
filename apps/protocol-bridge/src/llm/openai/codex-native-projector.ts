import {
  assertCodexPromptToolPairs,
  projectCodexPrompt,
  type CodexProjectionManifest,
} from "./codex-projection-state"
import { requireExactDurableIdentifier } from "../../context/durable-identifier"
import {
  type CodexConversationTool,
  type CodexConversationMessage,
  type CodexExecutionRequest,
  type CodexInputItem,
  type CodexNativeInputExecutionRequest,
  type CodexProviderExecutionRequest,
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
  /** Provider-native provenance for a request built from Codex rollout state. */
  manifest?: CodexProjectionManifest
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

/** One durable source record and the exact Cursor message it contributes. */
export interface CodexInputProjectionSource {
  sourceRecordId: string
  message: CodexConversationMessage
}

/** Exact source-to-native-items output for Codex projection persistence. */
export interface CodexProjectedInputBinding {
  sourceRecordId: string
  items: CodexInputItem[]
}

type CodexProjectableBlock = {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  structuredContent?: Record<string, unknown>
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
  request: CodexProviderExecutionRequest,
  modelName: string = request.model,
  options: CodexNativeProjectionOptions = {}
): CodexNativeProjection {
  if (request.nativeInput !== undefined) {
    assertExclusiveCodexNativeInputRequest(request)
    return {
      instructions: buildCodexInstructions(request),
      input: cloneCodexNativeInput(request.nativeInput),
      tools: projectCodexTools(request.tools),
      serviceTier: normalizeCodexServiceTier(request.serviceTier),
      reasoning: buildCodexReasoning(request, modelName),
    }
  }

  const tools = projectCodexTools(request.tools)
  const projectedInput = projectCodexInputItems(request, options)
  const projection = request.projectionState
    ? projectCodexPrompt(request.projectionState, {
        reinjectedItems: projectedInput,
        tools,
        settings: buildCodexProjectionSettings(request, modelName),
      })
    : undefined
  if (!projection) {
    assertCodexPromptToolPairs(projectedInput)
  }
  return {
    instructions: buildCodexInstructions(request),
    input: projection?.input ?? projectedInput,
    tools,
    serviceTier: normalizeCodexServiceTier(request.serviceTier),
    reasoning: buildCodexReasoning(request, modelName),
    manifest: projection?.manifest,
  }
}

/**
 * Native rollout input is a separate source of truth. In particular, a
 * Remote Compaction V2 request must not silently append UnifiedMessage output
 * or a stale projection-state history to the exact provider-native prompt.
 * The native request contract excludes projected fields at compile time; this
 * check protects the same boundary when a caller crosses it with untyped data.
 */
function assertExclusiveCodexNativeInputRequest(
  request: CodexNativeInputExecutionRequest
): void {
  if (!Array.isArray(request.nativeInput)) {
    throw new Error("Codex native input must be an array")
  }
  const untypedRequest: {
    messages?: unknown
    contextMessages?: unknown
    projectionState?: unknown
  } = request
  const messages = untypedRequest.messages
  if (Array.isArray(messages) && messages.length > 0) {
    throw new Error(
      "Codex native input cannot be combined with projected messages"
    )
  }
  const contextMessages = untypedRequest.contextMessages
  if (Array.isArray(contextMessages) && contextMessages.length > 0) {
    throw new Error(
      "Codex native input cannot be combined with projected context messages"
    )
  }
  if (untypedRequest.projectionState !== undefined) {
    throw new Error(
      "Codex native input cannot be combined with a projection state"
    )
  }
}

/**
 * Responses input is JSON wire data. Clone it before request assembly so the
 * transport, retry, or sanitizer path cannot mutate the persisted rollout
 * source owned by the caller. Non-JSON input is a protocol error rather than
 * an opportunity to synthesize a replacement representation.
 */
function cloneCodexNativeInput(
  input: readonly CodexInputItem[]
): CodexInputItem[] {
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Codex native input item ${index} must be an object`)
    }
    assertExactNativeInputIdentifiers(item, index)
    try {
      return JSON.parse(JSON.stringify(item)) as CodexInputItem
    } catch (error) {
      throw new Error(
        `Codex native input item ${index} is not JSON-serializable: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  })
}

function assertExactNativeInputIdentifiers(
  item: CodexInputItem,
  index: number
): void {
  const record = item as Record<string, unknown>
  if (record.id !== undefined) {
    requireExactDurableIdentifier(
      record.id,
      `Codex native input item ${index} id`
    )
  }
  if (record.call_id !== undefined) {
    requireExactDurableIdentifier(
      record.call_id,
      `Codex native input item ${index} call_id`
    )
  }
  if (record.sourceUuid !== undefined) {
    requireExactDurableIdentifier(
      record.sourceUuid,
      `Codex native input item ${index} sourceUuid`
    )
  }
  if (record.messageId !== undefined) {
    requireExactDurableIdentifier(
      record.messageId,
      `Codex native input item ${index} messageId`
    )
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
    "contextMessages" | "messages" | "tools"
  >,
  options: CodexNativeProjectionOptions = {}
): CodexInputItem[] {
  const entries = projectCodexInputEntries(
    request,
    [
      ...(request.contextMessages || []).map((message) => ({ message })),
      ...request.messages.map((message) => ({ message })),
    ],
    options
  )
  return entries.map(({ item }) => item)
}

/**
 * Projects all sources in one pass so tool-call/output typing remains shared
 * across message boundaries, while preserving an exact binding for every
 * generated native item. This deliberately skips prompt-only normalization.
 */
export function projectCodexInputBindings(
  request: Pick<CodexExecutionRequest, "tools">,
  sources: readonly CodexInputProjectionSource[],
  options: CodexNativeProjectionOptions = {}
): CodexProjectedInputBinding[] {
  const exactSources = sources.map((source, index) => ({
    ...source,
    sourceRecordId: requireExactDurableIdentifier(
      source.sourceRecordId,
      `Codex input projection sourceRecordId at index ${index}`
    ),
  }))
  const seenSourceIds = new Set<string>()
  for (const source of exactSources) {
    const sourceRecordId = source.sourceRecordId
    if (seenSourceIds.has(sourceRecordId)) {
      throw new Error(
        `Codex input projection has duplicate sourceRecordId ${sourceRecordId}`
      )
    }
    seenSourceIds.add(sourceRecordId)
  }

  const entries = projectCodexInputEntries(
    request,
    exactSources.map((source) => ({
      sourceRecordId: source.sourceRecordId,
      message: source.message,
    })),
    options
  )
  return exactSources.map((source) => {
    const sourceRecordId = source.sourceRecordId
    const items = entries
      .filter((entry) => entry.sourceRecordId === sourceRecordId)
      .map((entry) => entry.item)
    if (items.length === 0) {
      throw new Error(
        `Codex source record ${sourceRecordId} produced no native input items`
      )
    }
    return { sourceRecordId, items }
  })
}

function projectCodexInputEntries(
  request: Pick<CodexExecutionRequest, "tools">,
  sources: readonly {
    sourceRecordId?: string
    message: CodexProjectableMessage
  }[],
  options: CodexNativeProjectionOptions
): Array<{ item: CodexInputItem; sourceRecordId?: string }> {
  const shortenName = buildToolNameShortener(request.tools)
  const toolTypeByName = buildToolTypeLookup(request.tools)
  const toolCallTypeById = new Map<string, CodexProjectedToolCallType>()
  const input: CodexInputItem[] = []
  const sourceRecordIds: Array<string | undefined> = []

  for (const source of sources) {
    if (source.sourceRecordId !== undefined) {
      requireExactDurableIdentifier(
        source.sourceRecordId,
        "Codex projected source record id"
      )
    }
    const msg = source.message
    const initialItemCount = input.length
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
    } else if (Array.isArray(msg.content)) {
      const blocks = msg.content as CodexProjectableBlock[]

      for (const block of blocks) {
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

          // Raw Codex ResponseItems belong to CodexProjectionState. Older
          // bridge sessions can still contain this block, but it is never
          // promoted into the next prompt through a UnifiedMessage fallback.
          case "codex_response_item":
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

    for (let index = initialItemCount; index < input.length; index++) {
      sourceRecordIds[index] = source.sourceRecordId
    }
  }
  return input.map((item, index) => ({
    item,
    ...(sourceRecordIds[index]
      ? { sourceRecordId: sourceRecordIds[index] }
      : {}),
  }))
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
    "thinkingIntent" | "includeThinkingSummary" | "modelProfile"
  >,
  modelName: string
): CodexRequest["reasoning"] {
  const reasoning: CodexRequest["reasoning"] = {
    effort: resolveCodexReasoningEffort(
      request.thinkingIntent,
      modelName,
      request.modelProfile
    ),
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
  const callId = requireExactDurableIdentifier(
    block.id,
    "Codex tool-use block id"
  )

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
  const callId = requireExactDurableIdentifier(
    block.tool_use_id,
    "Codex tool-result block tool_use_id"
  )
  const callType =
    toolCallTypeById.get(callId) ||
    normalizeToolCallTypeHint((block as Record<string, unknown>).tool_call_type)

  if (callType === "tool_search") {
    input.push({
      type: "tool_search_output",
      call_id: callId,
      status: "completed",
      execution: "client",
      tools: projectToolSearchOutputTools(block),
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

function projectToolSearchOutputTools(block: CodexProjectableBlock): unknown[] {
  const structuredContent = block.structuredContent
  if (!structuredContent || !Array.isArray(structuredContent.tools)) {
    throw new Error(
      "Codex tool_search result requires durable structuredContent.tools"
    )
  }
  const tools: unknown[] = structuredContent.tools
  return tools.slice()
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
  // A custom tool's input is a freeform provider payload. Do not infer a
  // bridge-private patch grammar from object keys such as `patch` or `text`.
  return JSON.stringify(input ?? {})
}

function buildCodexProjectionSettings(
  request: CodexExecutionRequest,
  modelName: string
): Record<string, unknown> {
  return {
    model: modelName,
    instructions: buildCodexInstructions(request),
    serviceTier: normalizeCodexServiceTier(request.serviceTier),
    reasoning: buildCodexReasoning(request, modelName),
    parallelToolCalls: request.parallelToolCalls !== false,
    textVerbosity: request.textVerbosity?.trim() || undefined,
  }
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
