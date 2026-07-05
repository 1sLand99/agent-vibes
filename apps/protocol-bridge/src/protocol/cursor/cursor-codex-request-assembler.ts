import type {
  CodexConversationTool,
  CodexExecutionRequest,
} from "../../llm/openai/codex-native-types"

export interface CursorCodexThinkingSummaryInput {
  backend: string
  thinkingLevel?: number
  thinkingDetailsRequested?: boolean
  requestedReasoningEffort?: string
  suppressThinkingSummary?: boolean
}

export interface CursorCodexRequestAssemblyInput {
  model: string
  systemPrompt: string
  contextMessages?: CodexExecutionRequest["contextMessages"]
  messages: CodexExecutionRequest["messages"]
  conversationId?: string
  pendingToolUseIds?: string[]
  tools?: CodexConversationTool[]
  includeThinkingSummary: boolean
  serviceTier?: string
  clientMetadata?: Record<string, string>
  thinkingIntent?: CodexExecutionRequest["thinkingIntent"]
  textVerbosity?: string
}

export interface CursorCodexClientMetadataInput {
  conversationId?: string
  requestOrdinal: number
  installationId: string
  workspaceRootPath?: string
}

export function resolveCursorCodexServiceTier(
  requestedModelParameters: Record<string, string> | undefined,
  defaultServiceTier: string | undefined
): string | undefined {
  if (!requestedModelParameters) {
    return defaultServiceTier
  }

  const normalizeValue = (rawValue?: string): string | undefined => {
    if (!rawValue) {
      return undefined
    }

    const normalized = rawValue
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")

    switch (normalized) {
      case "priority":
      case "fast":
      case "true":
      case "on":
      case "enabled":
      case "1":
        return "priority"
      default:
        return undefined
    }
  }

  const exactIds = ["service_tier", "fast_mode", "fast"]
  for (const id of exactIds) {
    const resolved = normalizeValue(requestedModelParameters[id])
    if (resolved) {
      return resolved
    }
  }

  for (const [id, rawValue] of Object.entries(requestedModelParameters)) {
    if (!id.includes("fast") && !id.includes("tier") && !id.includes("speed")) {
      continue
    }
    const resolved = normalizeValue(rawValue)
    if (resolved) {
      return resolved
    }
  }

  return defaultServiceTier
}

export function shouldSuppressCursorCodexThinkingSummary(
  input: CursorCodexThinkingSummaryInput & {
    requestedModelParameters?: Record<string, string>
    defaultServiceTier?: string
  }
): boolean {
  if (input.suppressThinkingSummary) {
    return true
  }
  if (input.backend !== "codex") {
    return false
  }
  return (
    resolveCursorCodexServiceTier(
      input.requestedModelParameters,
      input.defaultServiceTier
    ) === "priority"
  )
}

export function mergeCodexSystemPrompt(
  basePrompt: string,
  additionalPrompt?: string
): string {
  if (!additionalPrompt) {
    return basePrompt
  }
  return [basePrompt, additionalPrompt]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join("\n\n")
}

export function shouldRequestCursorCodexThinkingSummary(
  input: CursorCodexThinkingSummaryInput
): boolean {
  if (input.suppressThinkingSummary) {
    return false
  }
  if (input.thinkingDetailsRequested === true) {
    return true
  }
  if (input.backend !== "codex") {
    return false
  }
  const thinkingLevel = input.thinkingLevel || 0
  const effort = input.requestedReasoningEffort?.trim()
  return thinkingLevel > 0 || (!!effort && effort !== "none")
}

export function assembleCursorCodexExecutionRequest(
  input: CursorCodexRequestAssemblyInput
): CodexExecutionRequest {
  const request: CodexExecutionRequest = {
    model: input.model,
    system: input.systemPrompt || undefined,
    contextMessages:
      input.contextMessages && input.contextMessages.length > 0
        ? input.contextMessages
        : undefined,
    messages: input.messages,
    conversationId: input.conversationId,
    pendingToolUseIds:
      input.pendingToolUseIds && input.pendingToolUseIds.length > 0
        ? input.pendingToolUseIds
        : undefined,
    includeThinkingSummary: input.includeThinkingSummary,
    serviceTier: input.serviceTier,
    clientMetadata: input.clientMetadata,
    textVerbosity: input.textVerbosity || "low",
  }

  if (input.tools && input.tools.length > 0) {
    request.tools = input.tools
  }

  if (input.thinkingIntent) {
    request.thinkingIntent = input.thinkingIntent
  }

  return request
}

export function buildCursorCodexClientMetadata(
  input: CursorCodexClientMetadataInput
): Record<string, string> | undefined {
  const conversationId = input.conversationId?.trim()
  if (!conversationId) {
    return undefined
  }

  const requestOrdinal = Math.max(1, Math.floor(input.requestOrdinal))
  const turnMetadata: Record<string, unknown> = {
    session_id: conversationId,
    thread_source: "user",
    turn_id: `${conversationId}:${requestOrdinal}`,
    sandbox: "none",
  }

  const rootPath = input.workspaceRootPath?.trim()
  if (rootPath) {
    turnMetadata.workspaces = {
      [rootPath]: {},
    }
  }

  return {
    session_id: conversationId,
    thread_id: conversationId,
    turn_id: `${conversationId}:${requestOrdinal}`,
    "x-codex-window-id": `${conversationId}:${requestOrdinal}`,
    "x-codex-turn-metadata": JSON.stringify(turnMetadata),
    "x-codex-installation-id": input.installationId,
  }
}
