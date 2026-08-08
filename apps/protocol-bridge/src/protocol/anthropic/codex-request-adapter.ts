import {
  appendLanguageDirectiveToAnthropicSystem,
  appendStableLanguageDirectiveToAnthropicSystem,
} from "../../llm/shared/language-directive"
import { requireOptionalExactDurableIdentifier } from "../../context/durable-identifier"
import { randomUUID } from "crypto"
import type { CodexExecutionRequest } from "../../llm/openai/codex-native-types"
import { createCodexRootProviderIdentity } from "../../llm/openai/codex-provider-identity"
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
  // This adapter is the root boundary for a generic Anthropic request. The
  // generated identity is retained by the request object through transport
  // retries; `_conversationId` remains only a local continuation key.
  const upstreamIdentity = createCodexRootProviderIdentity()
  const localProjectionKey =
    requireOptionalExactDurableIdentifier(
      dto._conversationId,
      "Anthropic Codex local projection key"
    ) ?? `anthropic:${randomUUID()}`
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
    upstreamIdentity,
    localProjectionKey,
    thinkingIntent: resolveThinkingIntentFromDto(dto),
    includeThinkingSummary: dto._includeThinkingSummary === true,
    serviceTier: dto.service_tier,
    parallelToolCalls: resolveParallelToolCalls(dto.tool_choice),
  }
}
