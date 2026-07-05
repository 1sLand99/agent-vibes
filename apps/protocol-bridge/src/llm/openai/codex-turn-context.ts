import type {
  CodexCachedWsEntry,
  CodexTakenWsEntry,
} from "./codex-runtime-cache-store"
import { createCodexWsCacheKey } from "./codex-runtime-cache-store"
import { hashCodexIdentityPart } from "./codex-slot-identity"
import type { CodexTurnContinuationState } from "./codex-turn-state"

/**
 * Mirrors the official Codex CLI ModelClientSession.
 *
 * Turn-scoped management of WebSocket transport plus response-chain state.
 */
export interface CodexTurnContext extends CodexTurnContinuationState {
  /** Current WebSocket session ID (key in wsService.sessions) */
  wsSessionId: string
  /** Stable Codex turn metadata key used to scope sticky routing state */
  turnKey: string | undefined
  /** x-codex-turn-state captured from the WebSocket upgrade response */
  turnState: string | undefined
  /** Whether the connection was reused from cache */
  connectionReused: boolean
}

export interface CreateCodexTurnContextOptions {
  conversationId: string
  turnKey?: string
  takenCache?: CodexTakenWsEntry
}

export interface CodexScopedWsCacheKeyInput {
  slotKey: string
  modelName: string
  conversationId?: string
}

export function buildCodexScopedWsCacheKey(
  input: CodexScopedWsCacheKeyInput
): string {
  const normalizedConversationId = input.conversationId?.trim()
  return createCodexWsCacheKey({
    slotKeyHash: hashCodexIdentityPart(input.slotKey),
    modelName: input.modelName,
    conversationIdHash: normalizedConversationId
      ? hashCodexIdentityPart(normalizedConversationId)
      : undefined,
  })
}

export function reuseCodexActiveTurnContext(
  context: CodexTurnContext,
  turnKey?: string
): CodexTurnContext {
  if (context.turnKey !== turnKey) {
    context.turnKey = turnKey
    context.turnState = undefined
    context.lastRequest = undefined
    context.lastResponse = undefined
    context.connectionReused = false
  }
  return context
}

export function createCodexTurnContext(
  options: CreateCodexTurnContextOptions
): CodexTurnContext {
  const cached = options.takenCache?.entry
  if (cached) {
    const turnKeyMatches = cached.turnKey === options.turnKey
    return {
      wsSessionId: cached.wsSessionId,
      turnKey: options.turnKey,
      turnState: turnKeyMatches ? cached.turnState : undefined,
      lastResponse: turnKeyMatches ? cached.lastResponse : undefined,
      lastRequest: turnKeyMatches ? cached.lastRequest : undefined,
      connectionReused: turnKeyMatches,
    }
  }

  return {
    wsSessionId: buildCodexTurnWsSessionId(
      options.conversationId,
      options.turnKey
    ),
    turnKey: options.turnKey,
    turnState: undefined,
    lastResponse: undefined,
    lastRequest: undefined,
    connectionReused: false,
  }
}

export function buildCodexTurnWsSessionId(
  conversationId: string,
  turnKey?: string
): string {
  const normalizedConversationId = conversationId.trim()
  const normalizedTurnKey = turnKey?.trim()
  if (!normalizedTurnKey) {
    return `${normalizedConversationId}:turn:unkeyed`
  }
  return `${normalizedConversationId}:turn:${hashCodexIdentityPart(normalizedTurnKey)}`
}

export function codexTurnContextToCachedWsEntry(
  context: CodexTurnContext,
  updatedAt: number
): CodexCachedWsEntry {
  return {
    wsSessionId: context.wsSessionId,
    turnKey: context.turnKey,
    turnState: context.turnState,
    lastResponse: context.lastResponse,
    lastRequest: context.lastRequest,
    updatedAt,
  }
}
