import { requireExactDurableIdentifier } from "../../context/durable-identifier"
import {
  createCodexWsCacheKey,
  isValidCodexCachedWsEntry,
} from "./codex-runtime-cache-store"
import type {
  CodexCachedWsEntry,
  CodexTakenWsEntry,
} from "./codex-runtime-cache-store"
import {
  hashCodexIdentityPart,
  requireCodexSlotKey,
  type CodexSlotKey,
} from "./codex-slot-identity"
import type { CodexTurnContinuationState } from "./codex-turn-state"

/**
 * Mirrors the official Codex CLI ModelClientSession.
 *
 * Turn-scoped management of WebSocket transport plus response-chain state.
 */
export interface CodexTurnContext extends CodexTurnContinuationState {
  /** Current WebSocket session ID (key in wsService.sessions) */
  wsSessionId: string
  /** Exact logical upstream ModelClientSession identity for this chain. */
  modelClientSessionId: string
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
  /** True only when the cache belongs to this exact conversation and turn. */
  reuseCachedLogicalSession?: boolean
}

export interface CodexScopedWsCacheKeyInput {
  slotKey: CodexSlotKey
  modelName: string
  conversationId?: string
}

export function buildCodexScopedWsCacheKey(
  input: CodexScopedWsCacheKeyInput
): string {
  const slotKey = requireCodexSlotKey(input.slotKey, "Codex cache slot key")
  const conversationId =
    input.conversationId === undefined
      ? undefined
      : requireExactDurableIdentifier(
          input.conversationId,
          "Codex cache conversation id"
        )
  return createCodexWsCacheKey({
    slotKeyHash: hashCodexIdentityPart(slotKey),
    modelName: input.modelName,
    conversationIdHash:
      conversationId === undefined
        ? undefined
        : hashCodexIdentityPart(conversationId),
  })
}

export function reuseCodexActiveTurnContext(
  context: CodexTurnContext,
  conversationId: string,
  turnKey?: string
): CodexTurnContext {
  if (context.turnKey !== turnKey) {
    context.turnKey = turnKey
    context.turnState = undefined
    context.lastRequest = undefined
    context.lastResponse = undefined
    context.modelClientSessionId = buildCodexTurnWsSessionId(
      conversationId,
      turnKey
    )
    context.connectionReused = true
  }
  return context
}

export function createCodexTurnContext(
  options: CreateCodexTurnContextOptions
): CodexTurnContext {
  const conversationId = requireExactDurableIdentifier(
    options.conversationId,
    "Codex turn conversation id"
  )
  const turnKey =
    options.turnKey === undefined
      ? undefined
      : requireExactDurableIdentifier(options.turnKey, "Codex turn key")
  const cached = options.takenCache?.entry
  if (cached) {
    if (!isValidCodexCachedWsEntry(cached)) {
      throw new Error(
        "Codex turn context rejected a cached entry without an exact ModelClientSession identity"
      )
    }
    const reuseLogicalSession =
      options.reuseCachedLogicalSession === true && cached.turnKey === turnKey
    return {
      wsSessionId: cached.wsSessionId,
      modelClientSessionId: reuseLogicalSession
        ? cached.modelClientSessionId
        : buildCodexTurnWsSessionId(conversationId, turnKey),
      turnKey,
      turnState: reuseLogicalSession ? cached.turnState : undefined,
      lastResponse: reuseLogicalSession ? cached.lastResponse : undefined,
      lastRequest: reuseLogicalSession ? cached.lastRequest : undefined,
      connectionReused: true,
    }
  }

  return {
    wsSessionId: buildCodexTurnWsSessionId(conversationId, turnKey),
    modelClientSessionId: buildCodexTurnWsSessionId(conversationId, turnKey),
    turnKey,
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
  const exactConversationId = requireExactDurableIdentifier(
    conversationId,
    "Codex WebSocket conversation id"
  )
  if (turnKey === undefined) {
    return `${exactConversationId}:turn:unkeyed`
  }
  return `${exactConversationId}:turn:${hashCodexIdentityPart(
    requireExactDurableIdentifier(turnKey, "Codex WebSocket turn key")
  )}`
}

export function codexTurnContextToCachedWsEntry(
  context: CodexTurnContext,
  updatedAt: number
): CodexCachedWsEntry {
  return {
    wsSessionId: context.wsSessionId,
    modelClientSessionId: context.modelClientSessionId,
    turnKey: context.turnKey,
    turnState: context.turnState,
    lastResponse: context.lastResponse,
    lastRequest: context.lastRequest,
    updatedAt,
  }
}
