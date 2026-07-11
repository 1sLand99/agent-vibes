import {
  appendLanguageDirectiveToAnthropicSystem,
  appendStableLanguageDirectiveToAnthropicSystem,
} from "../../llm/shared/language-directive"
import type { CodexExecutionRequest } from "../../llm/openai/codex-native-types"
import { resolveThinkingIntentFromDto } from "../../llm/shared/thinking-intent"
import type { CreateMessageDto } from "./dto/create-message.dto"

function resolveParallelToolCalls(toolChoice: unknown): boolean {
  if (!toolChoice || typeof toolChoice !== "object") {
    return true
  }

  const disableParallelToolUse = (
    toolChoice as { disable_parallel_tool_use?: unknown }
  ).disable_parallel_tool_use

  return typeof disableParallelToolUse === "boolean"
    ? !disableParallelToolUse
    : true
}

export function adaptAnthropicMessageToCodexExecutionRequest(
  dto: CreateMessageDto,
  modelName: string = dto.model,
  options: { languageDirectiveMode?: "stable" | "dynamic" } = {}
): CodexExecutionRequest {
  const metadata = dto.metadata as { user_id?: unknown } | undefined
  const cacheUserId =
    typeof metadata?.user_id === "string" ? metadata.user_id.trim() : ""
  const languageOptions = { skip: dto._clientIsClaudeCode === true }
  const system =
    options.languageDirectiveMode === "dynamic"
      ? appendLanguageDirectiveToAnthropicSystem(
          dto.system,
          dto.messages,
          languageOptions
        )
      : appendStableLanguageDirectiveToAnthropicSystem(
          dto.system,
          languageOptions
        )

  return {
    model: modelName,
    system: system as CodexExecutionRequest["system"],
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
  }
}
