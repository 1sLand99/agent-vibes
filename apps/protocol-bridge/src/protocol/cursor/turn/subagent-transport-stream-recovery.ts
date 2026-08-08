import {
  decideTransportStreamRecovery,
  type TransportStreamRecoveryDecision,
} from "./transport-stream-recovery"

export interface SubagentTransportRecoveryBarrier {
  readonly hasVisibleText: boolean
  readonly hasToolUseBlocks: boolean
}

/**
 * Sub-agent turns prepare tools only after the provider stream finishes.
 * Mid-stream transport recovery therefore never sees prepared tools; it uses
 * the same pre-tool_use / pre-visible-text barrier as the main assistant turn.
 */
export function decideSubagentTransportStreamRecovery(input: {
  readonly error: unknown
  readonly barrier: SubagentTransportRecoveryBarrier
  readonly transportRecoveryRound: number
  readonly maxTransportRecoveries?: number
}): TransportStreamRecoveryDecision {
  return decideTransportStreamRecovery({
    error: input.error,
    hasPreparedTools: false,
    hasVisibleText: input.barrier.hasVisibleText,
    hasToolUseBlocks: input.barrier.hasToolUseBlocks,
    transportRecoveryRound: input.transportRecoveryRound,
    maxTransportRecoveries: input.maxTransportRecoveries,
  })
}
