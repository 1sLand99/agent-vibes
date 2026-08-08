import type { TurnHandle } from "./turn-handle"

/**
 * Decide whether a tool result belongs to the turn currently executing in
 * this async scope. A conversation may have several live BiDi attachments,
 * so conversation-wide turn stacks are not evidence that this callback is
 * nested inside any one of those turns.
 */
export function canContinueToolResultInline(input: {
  conversationId: string
  contextHandle: TurnHandle | undefined
  isHandleActive: (handle: TurnHandle) => boolean
}): boolean {
  const { contextHandle } = input
  if (!contextHandle) return false
  if (String(contextHandle.conversationId) !== input.conversationId) {
    return false
  }
  return input.isHandleActive(contextHandle)
}
