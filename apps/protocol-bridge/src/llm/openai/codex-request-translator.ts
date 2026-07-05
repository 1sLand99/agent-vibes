/**
 * Codex Anthropic Adapter
 *
 * Keeps Anthropic-compatible entrypoints working by adapting CreateMessageDto
 * into the native Codex execution request used by the core Codex service.
 */

import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import { resolveThinkingIntentFromDto } from "../shared/thinking-intent"
import type { CodexExecutionRequest, CodexRequest } from "./codex-native-types"
import { buildCodexRequest } from "./codex-request-builder"

function resolveParallelToolCalls(toolChoice: unknown): boolean {
  if (!toolChoice || typeof toolChoice !== "object") {
    return true
  }

  const disableParallelToolUse = (
    toolChoice as { disable_parallel_tool_use?: unknown }
  ).disable_parallel_tool_use

  if (typeof disableParallelToolUse !== "boolean") {
    return true
  }

  return !disableParallelToolUse
}

export function createCodexExecutionRequestFromClaude(
  dto: CreateMessageDto,
  modelName: string = dto.model
): CodexExecutionRequest {
  const metadata = dto.metadata as { user_id?: unknown } | undefined
  const cacheUserId =
    typeof metadata?.user_id === "string" ? metadata.user_id.trim() : ""

  return {
    model: modelName,
    system: dto.system,
    messages: dto.messages as CodexExecutionRequest["messages"],
    tools: dto.tools as CodexExecutionRequest["tools"],
    conversationId:
      typeof dto._conversationId === "string" ? dto._conversationId : undefined,
    pendingToolUseIds: dto._pendingToolUseIds,
    thinkingIntent: resolveThinkingIntentFromDto(dto),
    includeThinkingSummary: dto._includeThinkingSummary === true,
    serviceTier: dto.service_tier,
    parallelToolCalls: resolveParallelToolCalls(dto.tool_choice),
    cacheUserId: cacheUserId || undefined,
    clientIsClaudeCode: dto._clientIsClaudeCode === true,
  }
}

export function translateClaudeToCodex(
  dto: CreateMessageDto,
  modelName: string
): CodexRequest {
  return buildCodexRequest(
    createCodexExecutionRequestFromClaude(dto, modelName),
    modelName
  )
}
