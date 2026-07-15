import { Injectable } from "@nestjs/common"
import type { ContextModelProfile } from "./context-model-profile"
import { TokenCounterService } from "./token-counter.service"
import { UnifiedMessage, isToolResultBlock, normalizeContent } from "./types"

export type ContextNativeEditStrategy =
  | {
      type: "clear_tool_uses_20250919"
      trigger?: {
        type: "input_tokens"
        value: number
      }
      keep?: {
        type: "tool_uses"
        value: number
      }
      clear_tool_inputs?: boolean | string[]
      exclude_tools?: string[]
      clear_at_least?: {
        type: "input_tokens"
        value: number
      }
    }
  | {
      type: "clear_thinking_20251015"
      keep: { type: "thinking_turns"; value: number } | "all"
    }

export interface ContextNativeManagementConfig {
  edits: ContextNativeEditStrategy[]
}

export interface AnthropicNativeContextManagementInput {
  backend: string
  messages: UnifiedMessage[]
  maxTokens: number
  systemPromptTokens?: number
  contextProfile?: ContextModelProfile
  autoCompactTokenLimit?: number
}

const CLEARABLE_TOOL_RESULT_NAMES = [
  "read_file",
  "read_file_v2",
  "view_file",
  "run_terminal_command",
  "grep_search",
  "glob_search",
  "web_search",
  "web_fetch",
  "edit_file",
  "file_edit",
  "write_file",
  "file_write",
]

const DEFAULT_CONTEXT_MANAGEMENT_TRIGGER_TOKENS = 180_000
const DEFAULT_CONTEXT_MANAGEMENT_TARGET_TOKENS = 40_000
const MIN_CONTEXT_MANAGEMENT_CLEAR_TOKENS = 4_000

@Injectable()
export class ContextNativeManagementService {
  constructor(private readonly tokenCounter: TokenCounterService) {}

  buildAnthropicContextManagement(
    input: AnthropicNativeContextManagementInput
  ): ContextNativeManagementConfig | undefined {
    if (input.backend !== "claude-api") {
      return undefined
    }

    const messages = input.messages || []
    const hasClearableToolResults = this.hasClearableToolResults(messages)
    const hasThinking = this.hasThinkingBlocks(messages)
    if (!hasClearableToolResults && !hasThinking) {
      return undefined
    }

    const triggerThreshold = this.resolveTriggerThreshold(input)
    const targetTokens = this.resolveTargetTokens(triggerThreshold)
    const edits: ContextNativeEditStrategy[] = []

    if (hasThinking) {
      const estimatedVisibleTokens =
        this.tokenCounter.countMessages(
          messages,
          true,
          input.contextProfile?.tokenizer ?? "claude"
        ) + Math.max(0, input.systemPromptTokens || 0)
      edits.push({
        type: "clear_thinking_20251015",
        keep:
          estimatedVisibleTokens >= triggerThreshold
            ? { type: "thinking_turns", value: 1 }
            : "all",
      })
    }

    if (hasClearableToolResults && triggerThreshold > targetTokens) {
      edits.push({
        type: "clear_tool_uses_20250919",
        trigger: {
          type: "input_tokens",
          value: triggerThreshold,
        },
        clear_at_least: {
          type: "input_tokens",
          value: Math.max(
            MIN_CONTEXT_MANAGEMENT_CLEAR_TOKENS,
            triggerThreshold - targetTokens
          ),
        },
        clear_tool_inputs: CLEARABLE_TOOL_RESULT_NAMES,
      })
    }

    return edits.length > 0 ? { edits } : undefined
  }

  private resolveTriggerThreshold(
    input: AnthropicNativeContextManagementInput
  ): number {
    const hardInputBudget = Math.max(
      1,
      Math.floor(input.maxTokens - Math.max(0, input.systemPromptTokens || 0))
    )
    const autoCompactLimit = this.normalizePositiveInteger(
      input.autoCompactTokenLimit
    )
    const pressureLimit = autoCompactLimit
      ? Math.max(
          1,
          Math.floor(
            autoCompactLimit - Math.max(0, input.systemPromptTokens || 0)
          )
        )
      : Math.floor(hardInputBudget * 0.9)

    return Math.max(
      1,
      Math.min(
        hardInputBudget,
        pressureLimit,
        DEFAULT_CONTEXT_MANAGEMENT_TRIGGER_TOKENS
      )
    )
  }

  private resolveTargetTokens(triggerThreshold: number): number {
    return Math.max(
      DEFAULT_CONTEXT_MANAGEMENT_TARGET_TOKENS,
      Math.floor(triggerThreshold * 0.25)
    )
  }

  private hasClearableToolResults(
    messages: readonly UnifiedMessage[]
  ): boolean {
    for (const message of messages) {
      if (message.role !== "user") {
        continue
      }
      for (const block of normalizeContent(message.content)) {
        if (!isToolResultBlock(block)) {
          continue
        }
        if (this.getToolResultTextLength(block) > 0) {
          return true
        }
      }
    }
    return false
  }

  private hasThinkingBlocks(messages: readonly UnifiedMessage[]): boolean {
    for (const message of messages) {
      if (message.role !== "assistant") {
        continue
      }
      for (const block of normalizeContent(message.content)) {
        const type = (block as { type?: string }).type
        if (type === "thinking" || type === "redacted_thinking") {
          return true
        }
      }
    }
    return false
  }

  private getToolResultTextLength(block: unknown): number {
    const content = (block as { content?: unknown }).content
    if (typeof content === "string") {
      return content.trim().length
    }
    if (Array.isArray(content)) {
      return (content as unknown[]).reduce<number>((sum, item) => {
        if (typeof item === "string") return sum + item.trim().length
        if (item && typeof item === "object") {
          const text = (item as { text?: unknown }).text
          return sum + (typeof text === "string" ? text.trim().length : 0)
        }
        return sum
      }, 0)
    }
    return 0
  }

  private normalizePositiveInteger(value: unknown): number | undefined {
    if (typeof value !== "number") return undefined
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
  }
}
