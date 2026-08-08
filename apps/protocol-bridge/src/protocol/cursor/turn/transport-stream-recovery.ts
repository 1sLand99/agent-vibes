import {
  isProviderAttemptRetryableError,
  type ProviderAttemptRetryableError,
} from "../../../llm/shared/provider-physical-dispatch"

/** Cap mid-stream transport recoveries for a single assistant generation. */
export const MAX_TRANSPORT_STREAM_RECOVERIES = 1

export type TransportStreamRecoveryDecision =
  | { action: "recover"; error: ProviderAttemptRetryableError }
  | { action: "rethrow" }

export interface TransportStreamRecoveryInput {
  readonly error: unknown
  readonly hasPreparedTools: boolean
  readonly hasVisibleText: boolean
  readonly hasToolUseBlocks: boolean
  readonly transportRecoveryRound: number
  readonly maxTransportRecoveries?: number
}

/**
 * Decide whether a mid-stream provider failure can reopen the same assistant
 * generation on a fresh physical attempt (typically Codex WS → HTTP).
 *
 * Safe only before any tool_use or user-visible text crossed the turn. Partial
 * thinking may already have been shown in the IDE; recovery excludes those
 * draft assistant messages from the next provider projection.
 */
export function decideTransportStreamRecovery(
  input: TransportStreamRecoveryInput
): TransportStreamRecoveryDecision {
  if (!isProviderAttemptRetryableError(input.error)) {
    return { action: "rethrow" }
  }
  if (
    input.hasPreparedTools ||
    input.hasVisibleText ||
    input.hasToolUseBlocks
  ) {
    return { action: "rethrow" }
  }
  const max = input.maxTransportRecoveries ?? MAX_TRANSPORT_STREAM_RECOVERIES
  if (input.transportRecoveryRound >= max) {
    return { action: "rethrow" }
  }
  return { action: "recover", error: input.error }
}
