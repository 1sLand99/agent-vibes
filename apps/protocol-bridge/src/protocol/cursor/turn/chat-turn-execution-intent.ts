/**
 * Distinguishes a user-root request, a Cursor control continuation, and a
 * provider recovery retry before a chat parent turn is spawned. This is
 * bridge execution ownership, not a Cursor wire field: neither a control
 * action nor a retry may replace the existing top-level task owner.
 */
export type ChatTurnExecutionIntent =
  | "new_top_level"
  | "control_existing_top_level"
  | "retry_existing_top_level"

export interface ChatTurnExecutionIntentInput {
  chatTurnExecutionIntent?: ChatTurnExecutionIntent
  syntheticGraphInput?:
    | { kind: "current_user" }
    | { kind: "control_notification" }
    | { kind: "continue_existing_graph" }
}

export interface ResolvedChatTurnExecution<TTurnId extends string> {
  intent: ChatTurnExecutionIntent
  topLevelTurnId: TTurnId
}

/**
 * Resolve only explicitly declared ownership. There is deliberately no
 * default: treating a recovery retry as a user root replaces its top-level
 * execution state and identity, while treating a user root as a retry leaks
 * the previous task into the new request.
 */
export function requireChatTurnExecutionIntent(
  input: ChatTurnExecutionIntentInput
): ChatTurnExecutionIntent {
  const intent = input.chatTurnExecutionIntent
  if (!intent) {
    throw new Error(
      "Chat execution entry must explicitly declare new_top_level, control_existing_top_level, or retry_existing_top_level"
    )
  }

  if (intent === "retry_existing_top_level") {
    if (input.syntheticGraphInput?.kind !== "continue_existing_graph") {
      throw new Error(
        "A retry_existing_top_level entry must continue the existing durable graph"
      )
    }
    return intent
  }

  if (intent === "control_existing_top_level") {
    if (input.syntheticGraphInput?.kind !== "control_notification") {
      throw new Error(
        "A control_existing_top_level entry must append one typed control notification"
      )
    }
    return intent
  }

  if (
    input.syntheticGraphInput?.kind === "continue_existing_graph" ||
    input.syntheticGraphInput?.kind === "control_notification"
  ) {
    throw new Error(
      "A new_top_level entry cannot continue an existing durable graph or append a control notification"
    )
  }

  return intent
}

/**
 * Give every graph execution a top-level owner without changing an existing
 * owner for a recovery retry. The caller supplies the active owner from
 * durable turn state; absence is a hard error, never a new-root fallback.
 */
export function resolveChatTurnExecution<TTurnId extends string>(input: {
  intent: ChatTurnExecutionIntent
  graphTurnId: TTurnId
  activeTopLevelTurnId?: TTurnId
}): ResolvedChatTurnExecution<TTurnId> {
  if (input.intent === "new_top_level") {
    return {
      intent: input.intent,
      topLevelTurnId: input.graphTurnId,
    }
  }

  if (!input.activeTopLevelTurnId) {
    throw new Error(`A ${input.intent} entry requires an active top-level turn`)
  }

  return {
    intent: input.intent,
    topLevelTurnId: input.activeTopLevelTurnId,
  }
}
