import type {
  AgentRunRequest,
  RequestContext,
  SystemPromptSpec,
  UserMessage,
} from "../../../gen/agent/v1_pb"

export interface CursorSystemPromptSpec {
  mode: "replace" | "append"
  content: string
}

/** Additive protocol state, separate from bridge-owned turns and tool ledgers. */
export interface CursorProtocolSessionState {
  clientSupportsRoutedModelUpdate?: boolean
  /** null explicitly clears an earlier per-run override. */
  systemPrompt?: CursorSystemPromptSpec | null
  conversation?: {
    completedAskQuestionToolCallIds: string[]
    durableSkillBlocks: string[]
    durableCustomModeId?: string
    messageCountAtLastCompaction?: number
  }
}

export function normalizeCursorSystemPromptSpec(
  value?: SystemPromptSpec
): CursorSystemPromptSpec | null {
  const spec = value?.spec
  return spec?.case === "replace" || spec?.case === "append"
    ? { mode: spec.case, content: spec.value }
    : null
}

export function readCursorProtocolSessionState(
  request: AgentRunRequest,
  context?: RequestContext
): CursorProtocolSessionState {
  const state = request.conversationState
  const systemPrompt = request.systemPromptSpec ?? context?.systemPromptOverride
  return {
    clientSupportsRoutedModelUpdate:
      request.clientSupportsRoutedModelUpdate === true,
    ...(systemPrompt !== undefined
      ? { systemPrompt: normalizeCursorSystemPromptSpec(systemPrompt) }
      : {}),
    ...(state
      ? {
          conversation: {
            completedAskQuestionToolCallIds: [
              ...state.completedAskQuestionToolCallIds,
            ],
            durableSkillBlocks: [...state.durableSkillBlocks],
            durableCustomModeId: state.durableCustomModeId,
            messageCountAtLastCompaction: state.messageCountAtLastCompaction,
          },
        }
      : {}),
  }
}

export function mergeCursorProtocolSessionState(
  previous: CursorProtocolSessionState | undefined,
  incoming: CursorProtocolSessionState | undefined
): CursorProtocolSessionState | undefined {
  if (!incoming) return previous
  return structuredClone({ ...previous, ...incoming })
}

export function applyCursorSystemPromptSpec(
  base: string,
  spec: CursorSystemPromptSpec | null | undefined
): string {
  if (!spec) return base
  if (spec.mode === "replace") return spec.content
  return [base, spec.content].filter((part) => part.length > 0).join("\n\n")
}

/** Restore UI-only message facts without changing bridge task ownership. */
export function readCursorUserMessageMetadata(
  metadata?: Record<string, unknown>
): Pick<UserMessage, "turnSteer" | "startedAtMs" | "completedAtMs"> {
  const uint64 = (value: unknown): bigint | undefined => {
    if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return undefined
    const number = BigInt(value)
    return number <= 0xffff_ffff_ffff_ffffn ? number : undefined
  }
  return {
    turnSteer:
      typeof metadata?.turnSteer === "boolean" ? metadata.turnSteer : undefined,
    startedAtMs: uint64(metadata?.startedAtMs),
    completedAtMs: uint64(metadata?.completedAtMs),
  }
}

/** Validate the durable JSON boundary; no protobuf bigint values live here. */
export function decodeCursorProtocolSessionState(
  input: unknown
): CursorProtocolSessionState {
  const object = (
    value: unknown,
    allowed: readonly string[]
  ): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid Cursor protocol session state")
    }
    const record = value as Record<string, unknown>
    if (Object.keys(record).some((key) => !allowed.includes(key))) {
      throw new Error("Unexpected Cursor protocol session state field")
    }
    return record
  }
  const record = object(input, [
    "clientSupportsRoutedModelUpdate",
    "systemPrompt",
    "conversation",
  ])
  const result: CursorProtocolSessionState = {}
  if (record.clientSupportsRoutedModelUpdate !== undefined) {
    if (typeof record.clientSupportsRoutedModelUpdate !== "boolean") {
      throw new Error("Invalid Cursor routed-model capability")
    }
    result.clientSupportsRoutedModelUpdate =
      record.clientSupportsRoutedModelUpdate
  }
  if (record.systemPrompt === null) result.systemPrompt = null
  else if (record.systemPrompt !== undefined) {
    const spec = object(record.systemPrompt, ["mode", "content"])
    if (
      (spec.mode !== "replace" && spec.mode !== "append") ||
      typeof spec.content !== "string"
    ) {
      throw new Error("Invalid Cursor system prompt specification")
    }
    result.systemPrompt = { mode: spec.mode, content: spec.content }
  }
  if (record.conversation !== undefined) {
    const state = object(record.conversation, [
      "completedAskQuestionToolCallIds",
      "durableSkillBlocks",
      "durableCustomModeId",
      "messageCountAtLastCompaction",
    ])
    const strings = (value: unknown): string[] => {
      if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string")
      ) {
        throw new Error("Invalid Cursor protocol string list")
      }
      return [...(value as string[])]
    }
    if (
      state.durableCustomModeId !== undefined &&
      typeof state.durableCustomModeId !== "string"
    ) {
      throw new Error("Invalid Cursor durable custom mode")
    }
    const count = state.messageCountAtLastCompaction
    if (
      count !== undefined &&
      (typeof count !== "number" ||
        !Number.isInteger(count) ||
        count < 0 ||
        count > 0xffff_ffff)
    ) {
      throw new Error("Invalid Cursor compaction message count")
    }
    result.conversation = {
      completedAskQuestionToolCallIds: strings(
        state.completedAskQuestionToolCallIds
      ),
      durableSkillBlocks: strings(state.durableSkillBlocks),
      ...(state.durableCustomModeId !== undefined
        ? { durableCustomModeId: state.durableCustomModeId }
        : {}),
      ...(count !== undefined ? { messageCountAtLastCompaction: count } : {}),
    }
  }
  return result
}
