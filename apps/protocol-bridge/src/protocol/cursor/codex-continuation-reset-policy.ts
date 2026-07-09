import type { ContextCompactionResult } from "../../context"

export function shouldResetCodexContinuationAfterProjection(
  result: ContextCompactionResult
): boolean {
  return result.wasCompacted || result.snipCompaction?.changed === true
}
