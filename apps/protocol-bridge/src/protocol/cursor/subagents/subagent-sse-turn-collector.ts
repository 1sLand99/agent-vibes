import {
  CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE,
  requireExactDurableIdentifier,
} from "../../../context"
import { CODEX_RESPONSE_TERMINAL_EVENT } from "../../../llm/openai/codex-compact-payload"
import type { BackendType } from "../../../llm/shared/model-router.service"

export interface SubAgentSseToolCall {
  id: string
  name: string
  inputJson: string
}

/** Parse the provider's completed tool arguments without inventing a repair. */
export function parseSubAgentToolInput(
  toolCall: Pick<SubAgentSseToolCall, "id" | "name" | "inputJson">
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(toolCall.inputJson)
  } catch (error) {
    throw new Error(
      `Sub-agent tool ${toolCall.name} (${toolCall.id}) emitted invalid JSON input: ${String(error)}`
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Sub-agent tool ${toolCall.name} (${toolCall.id}) input must be a JSON object`
    )
  }
  return parsed as Record<string, unknown>
}

export interface SubAgentSseTurnResult {
  fullText: string
  toolCalls: SubAgentSseToolCall[]
  /** Accepted provider blocks in their original index order. */
  assistantContent: SubAgentAssistantContentBlock[]
  /** Exact native Codex item that rendered each accepted graph fragment. */
  assistantNativeSources: SubAgentAssistantNativeSource[]
  rawResponseItems: Record<string, unknown>[]
  providerResponseId?: string
}

export interface SubAgentAssistantNativeSource {
  readonly nativeItemId: string
  readonly sourceFragmentIndex: number
}

export type SubAgentAssistantContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | {
      readonly type: "tool_use"
      readonly id: string
      readonly name: string
      readonly input: Record<string, unknown>
    }

export interface SubAgentSseEvent {
  type: string
  data: {
    index?: number
    item_id?: string
    status?: string
    responseId?: string
    incompleteReason?: string
    errorCode?: string
    errorMessage?: string
    message?: { id?: string }
    content_block?: {
      type?: string
      id?: string
      name?: string
    }
    delta?: {
      type?: string
      text?: string
      thinking?: string
      partial_json?: string
    }
    item?: Record<string, unknown>
  }
}

export interface SubAgentSseTurnUpdate {
  textDelta?: string
  thinkingDelta?: string
  completedToolCall?: SubAgentSseToolCall
}

type OpenBlock =
  | { kind: "text"; text: string; nativeItemId?: string }
  | { kind: "thinking"; thinking: string; nativeItemId?: string }
  | {
      kind: "tool_use"
      toolCall: SubAgentSseToolCall
      nativeItemId?: string
    }
  | { kind: "other" }

type ClosedBlock = Exclude<OpenBlock, { kind: "other" }>

type NativeTerminal =
  | { status: "completed"; responseId?: string }
  | { status: "incomplete"; reason: string; responseId?: string }
  | {
      status: "failed"
      code: string
      message: string
      responseId?: string
    }

/**
 * Strict structural reducer for sub-agent provider streams.
 *
 * It deliberately stages every assistant block and Codex response item until
 * `finish()` proves that the provider emitted one complete structured message
 * and, for Codex, one successful native Responses terminal. Callers must not
 * persist or execute anything returned by `apply()`.
 */
export class SubAgentSseTurnCollector {
  private readonly toolCalls: SubAgentSseToolCall[] = []
  private readonly rawResponseItems: Record<string, unknown>[] = []
  private readonly openBlocks = new Map<number, OpenBlock>()
  private readonly closedBlocks = new Map<number, ClosedBlock>()
  private readonly closedBlockIndices = new Set<number>()
  private messageStarted = false
  private messageStopped = false
  private messageId?: string
  private nativeTerminal?: NativeTerminal

  /**
   * Snapshot used by mid-stream transport recovery. Thinking-only progress does
   * not close the barrier; any trimmed visible text or tool_use does.
   */
  transportRecoveryBarrier(): {
    hasVisibleText: boolean
    hasToolUseBlocks: boolean
  } {
    let hasVisibleText = false
    let hasToolUseBlocks = false
    const inspect = (block: OpenBlock | ClosedBlock): void => {
      if (block.kind === "tool_use") {
        hasToolUseBlocks = true
        return
      }
      if (block.kind === "text" && block.text.trim().length > 0) {
        hasVisibleText = true
      }
    }
    for (const block of this.openBlocks.values()) {
      if (block.kind !== "other") {
        inspect(block)
      }
    }
    for (const block of this.closedBlocks.values()) {
      inspect(block)
    }
    return { hasVisibleText, hasToolUseBlocks }
  }

  apply(event: SubAgentSseEvent): SubAgentSseTurnUpdate {
    if (this.messageStopped) {
      throw new Error(
        `Sub-agent provider emitted ${event.type} after message_stop`
      )
    }

    if (event.type === "error") {
      throw new Error(
        event.data.errorMessage?.trim() ||
          "Sub-agent provider emitted an error event"
      )
    }

    if (event.type === CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE) {
      if (event.data.item && typeof event.data.item === "object") {
        this.rawResponseItems.push({ ...event.data.item })
      }
      return {}
    }

    if (event.type === CODEX_RESPONSE_TERMINAL_EVENT) {
      if (this.nativeTerminal) {
        throw new Error("Sub-agent Codex stream emitted duplicate terminal")
      }
      const responseId =
        event.data.responseId === undefined
          ? undefined
          : requireExactDurableIdentifier(
              event.data.responseId,
              "Sub-agent Codex response id"
            )
      switch (event.data.status) {
        case "completed":
          this.nativeTerminal = { status: "completed", responseId }
          break
        case "incomplete":
          this.nativeTerminal = {
            status: "incomplete",
            reason: event.data.incompleteReason?.trim() || "unknown",
            responseId,
          }
          break
        case "failed":
          this.nativeTerminal = {
            status: "failed",
            code: event.data.errorCode?.trim() || "unknown_error",
            message: event.data.errorMessage?.trim() || "Response failed",
            responseId,
          }
          break
        default:
          throw new Error("Sub-agent Codex terminal has no valid status")
      }
      return {}
    }

    if (event.type === "message_start") {
      if (this.messageStarted) {
        throw new Error("Sub-agent provider emitted duplicate message_start")
      }
      this.messageStarted = true
      this.messageId =
        event.data.message?.id === undefined
          ? undefined
          : requireExactDurableIdentifier(
              event.data.message.id,
              "Sub-agent provider message id"
            )
      return {}
    }

    if (event.type === "content_block_start") {
      if (!this.messageStarted || !Number.isSafeInteger(event.data.index)) {
        throw new Error(
          "Sub-agent content_block_start requires message_start and an index"
        )
      }
      const index = event.data.index!
      if (this.openBlocks.has(index) || this.closedBlockIndices.has(index)) {
        throw new Error(`Sub-agent provider reopened content block ${index}`)
      }
      const block = event.data.content_block
      const nativeItemId =
        event.data.item_id === undefined
          ? undefined
          : requireExactDurableIdentifier(
              event.data.item_id,
              `Sub-agent content block ${index} native item id`
            )
      if (block?.type === "tool_use") {
        if (block.id === undefined || block.name === undefined) {
          throw new Error(`Sub-agent tool block ${index} is missing id or name`)
        }
        const toolId = requireExactDurableIdentifier(
          block.id,
          `Sub-agent tool block ${index} id`
        )
        const toolName = requireExactDurableIdentifier(
          block.name,
          `Sub-agent tool block ${index} name`
        )
        this.openBlocks.set(index, {
          kind: "tool_use",
          toolCall: {
            id: toolId,
            name: toolName,
            inputJson: "",
          },
          nativeItemId,
        })
      } else if (block?.type === "text") {
        this.openBlocks.set(index, { kind: "text", text: "", nativeItemId })
      } else if (block?.type === "thinking") {
        this.openBlocks.set(index, {
          kind: "thinking",
          thinking: "",
          nativeItemId,
        })
      } else {
        this.openBlocks.set(index, { kind: "other" })
      }
      return {}
    }

    if (event.type === "content_block_delta") {
      if (!Number.isSafeInteger(event.data.index)) {
        throw new Error("Sub-agent content_block_delta is missing its index")
      }
      const index = event.data.index!
      const block = this.openBlocks.get(index)
      if (!block) {
        throw new Error(`Sub-agent delta targets unopened block ${index}`)
      }
      const delta = event.data.delta
      if (delta?.type === "text_delta") {
        if (block.kind !== "text") {
          throw new Error(`Sub-agent text delta targets ${block.kind} block`)
        }
        if (delta.text) {
          block.text += delta.text
          return { textDelta: delta.text }
        }
      } else if (delta?.type === "thinking_delta") {
        if (block.kind !== "thinking") {
          throw new Error(
            `Sub-agent thinking delta targets ${block.kind} block`
          )
        }
        if (delta.thinking) {
          block.thinking += delta.thinking
          return { thinkingDelta: delta.thinking }
        }
      } else if (delta?.type === "input_json_delta") {
        if (block.kind !== "tool_use") {
          throw new Error(
            `Sub-agent tool input delta targets ${block.kind} block`
          )
        }
        block.toolCall.inputJson += delta.partial_json || ""
      }
      return {}
    }

    if (event.type === "content_block_stop") {
      if (!Number.isSafeInteger(event.data.index)) {
        throw new Error("Sub-agent content_block_stop is missing its index")
      }
      const index = event.data.index!
      const block = this.openBlocks.get(index)
      if (!block) {
        throw new Error(`Sub-agent provider closed unknown block ${index}`)
      }
      this.openBlocks.delete(index)
      this.closedBlockIndices.add(index)
      if (block.kind === "tool_use") {
        const completedToolCall = { ...block.toolCall }
        this.toolCalls.push(completedToolCall)
        this.closedBlocks.set(index, {
          kind: "tool_use",
          toolCall: completedToolCall,
          nativeItemId: block.nativeItemId,
        })
        return { completedToolCall }
      }
      if (block.kind !== "other") {
        this.closedBlocks.set(index, block)
      }
      return {}
    }

    if (event.type === "message_stop") {
      if (!this.messageStarted || this.openBlocks.size > 0) {
        throw new Error(
          "Sub-agent message_stop arrived before the structured message completed"
        )
      }
      this.messageStopped = true
    }
    return {}
  }

  finish(backend: BackendType): SubAgentSseTurnResult {
    if (!this.messageStarted || !this.messageStopped) {
      throw new Error(
        "Sub-agent provider stream closed without a complete message"
      )
    }
    if (backend === "codex") {
      if (!this.nativeTerminal) {
        throw new Error(
          "Sub-agent Codex stream closed without a native response terminal"
        )
      }
      if (
        this.nativeTerminal.responseId === undefined ||
        this.messageId === undefined ||
        this.nativeTerminal.responseId !== this.messageId
      ) {
        throw new Error(
          "Sub-agent Codex terminal response id does not match message_start"
        )
      }
      if (this.nativeTerminal.status === "failed") {
        throw new Error(
          `Sub-agent Codex response failed (${this.nativeTerminal.code}): ${this.nativeTerminal.message}`
        )
      }
      if (this.nativeTerminal.status === "incomplete") {
        throw new Error(
          `Sub-agent Codex response incomplete (${this.nativeTerminal.reason})`
        )
      }
    }
    const toolCallIds = new Set<string>()
    for (const toolCall of this.toolCalls) {
      if (toolCallIds.has(toolCall.id)) {
        throw new Error(
          `Sub-agent provider emitted duplicate tool call id ${toolCall.id}`
        )
      }
      toolCallIds.add(toolCall.id)
      parseSubAgentToolInput(toolCall)
    }
    const acceptedBlocks = [...this.closedBlocks.entries()].sort(
      ([left], [right]) => left - right
    )
    const assistantContent = acceptedBlocks.map(
      ([, block]): SubAgentAssistantContentBlock => {
        switch (block.kind) {
          case "text":
            return { type: "text", text: block.text }
          case "thinking":
            return { type: "thinking", thinking: block.thinking }
          case "tool_use":
            return {
              type: "tool_use",
              id: block.toolCall.id,
              name: block.toolCall.name,
              input: parseSubAgentToolInput(block.toolCall),
            }
        }
      }
    )
    const assistantNativeSources =
      backend === "codex"
        ? acceptedBlocks.map(([, block], sourceFragmentIndex) => {
            if (!block.nativeItemId) {
              throw new Error(
                `Sub-agent Codex content fragment ${sourceFragmentIndex} has no native item id`
              )
            }
            return {
              nativeItemId: block.nativeItemId,
              sourceFragmentIndex,
            }
          })
        : []
    const fullText = assistantContent
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
    return {
      fullText,
      toolCalls: this.toolCalls.map((toolCall) => ({ ...toolCall })),
      assistantContent,
      assistantNativeSources,
      rawResponseItems: this.rawResponseItems.map((item) => ({ ...item })),
      providerResponseId: this.nativeTerminal?.responseId ?? this.messageId,
    }
  }
}
