export interface CodexWarmupPayloadDecisionInput {
  warmupPayloadAvailable: boolean
  reusedConnection: boolean
  warmupReason: string
  conversationHasContinuation: boolean
}

export type CodexWarmupPayloadDecision =
  | { sendPayload: true }
  | {
      sendPayload: false
      reason:
        | "no_payload"
        | "reused_connection"
        | "continuation_warmup"
        | "conversation_has_continuation"
    }

export function shouldSendCodexWarmupPayload(
  input: CodexWarmupPayloadDecisionInput
): CodexWarmupPayloadDecision {
  if (!input.warmupPayloadAvailable) {
    return { sendPayload: false, reason: "no_payload" }
  }
  if (input.reusedConnection) {
    return { sendPayload: false, reason: "reused_connection" }
  }
  if (isCodexContinuationWarmupReason(input.warmupReason)) {
    return { sendPayload: false, reason: "continuation_warmup" }
  }
  if (input.conversationHasContinuation) {
    return { sendPayload: false, reason: "conversation_has_continuation" }
  }
  return { sendPayload: true }
}

export function isCodexContinuationWarmupReason(reason: string): boolean {
  const normalizedReason = reason.toLowerCase()
  return (
    normalizedReason.includes("continuation") ||
    normalizedReason.includes("shell") ||
    normalizedReason.includes("tool")
  )
}
