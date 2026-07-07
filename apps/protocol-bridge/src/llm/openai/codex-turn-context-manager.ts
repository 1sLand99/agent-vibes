import { CodexConversationSessionStore } from "./codex-conversation-session-store"
import type { CodexRuntimeCacheStore } from "./codex-runtime-cache-store"
import type { CodexInputItem } from "./codex-native-types"
import {
  buildCodexScopedWsCacheKey,
  buildCodexTurnWsSessionId,
  codexTurnContextToCachedWsEntry,
  createCodexTurnContext,
  type CodexTurnContext,
} from "./codex-turn-context"
import {
  captureCodexTurnResponse,
  hasCodexTurnContinuationState,
  prepareCodexTurnStateRequest,
  resetCodexTurnContinuationState,
  startCodexFullResponseChain,
  type CodexPreparedTurnRequest,
} from "./codex-turn-state"
import { hashCodexIdentityPart } from "./codex-slot-identity"

export interface CodexTurnContextManagerOptions {
  runtimeCache: CodexRuntimeCacheStore
  closeWsSession: (sessionId: string) => void
  now?: () => number
}

export interface CodexTurnContextCacheScope {
  slotKey: string
  modelName: string
  conversationId?: string
}

export interface CodexGetOrCreateTurnContextInput extends CodexTurnContextCacheScope {
  conversationId: string
  turnKey?: string
}

export interface CodexResetContinuationInput {
  conversationId: string | undefined
  modelName?: string
  slotKeys?: string[]
}

export interface CodexResetContinuationResult {
  conversationId: string | undefined
  modelName: string | undefined
  resetCount: number
  discardedActivePreviousResponseId: string | undefined
}

export interface CodexClearContinuationBaselineInput {
  conversationId: string | undefined
  modelName?: string
  slotKeys?: string[]
}

export interface CodexClearContinuationBaselineResult {
  conversationId: string | undefined
  modelName: string | undefined
  resetCount: number
  discardedPreviousResponseId: string | undefined
}

export interface CodexTransportReconnectInput extends CodexTurnContextCacheScope {
  conversationId: string | undefined
}

export interface CodexTransportReconnectResult {
  conversationId: string | undefined
  hadContinuationBaseline: boolean
  discardedPreviousResponseId: string | undefined
}

export interface CodexHttpTransportTurnInput extends CodexTurnContextCacheScope {
  conversationId: string | undefined
  persistHttpFallback?: boolean
}

export interface CodexHttpTransportTurnResult {
  conversationId: string | undefined
  httpFallbackActivated: boolean
  clearedActiveContext: boolean
  deletedCachedContext: boolean
  discardedPreviousResponseId: string | undefined
  closedSessionIds: string[]
}

export interface CodexPreparedWarmupContext {
  cacheKey: string
  sessionId: string
  reusedCache: boolean
}

export interface CodexWarmPoolAvailabilityInput extends Omit<
  CodexTurnContextCacheScope,
  "conversationId"
> {
  wsUrl: string
  hasOpenSessionConnection: (sessionId: string, wsUrl: string) => boolean
}

export type CodexWarmPoolAvailability =
  | {
      available: true
      sessionId: string
      source: "cached_entry" | "cache_key"
    }
  | {
      available: false
    }

/**
 * Owns Codex logical turn lifecycle.
 *
 * This mirrors Codex CLI's separation between a logical ModelClientSession and
 * the physical WebSocket transport. The manager is deliberately framework-free:
 * callers provide the shared runtime cache and transport close primitive.
 */
export class CodexTurnContextManager {
  private readonly sessions =
    new CodexConversationSessionStore<CodexTurnContext>()
  private readonly httpFallbackTransports = new Set<string>()
  private readonly runtimeCache: CodexRuntimeCacheStore
  private readonly closeWsSession: (sessionId: string) => void
  private readonly now: () => number

  constructor(options: CodexTurnContextManagerOptions) {
    this.runtimeCache = options.runtimeCache
    this.closeWsSession = options.closeWsSession
    this.now = options.now ?? (() => Date.now())
  }

  buildWsCacheKey(input: CodexTurnContextCacheScope): string {
    return buildCodexScopedWsCacheKey(input)
  }

  isHttpFallbackTransport(input: CodexTurnContextCacheScope): boolean {
    const cacheKey = this.buildHttpFallbackTransportKey(input)
    return cacheKey ? this.httpFallbackTransports.has(cacheKey) : false
  }

  beginHttpTransportTurn(
    input: CodexHttpTransportTurnInput
  ): CodexHttpTransportTurnResult {
    const conversationId = this.normalizeConversationId(input.conversationId)
    if (!conversationId) {
      return {
        conversationId: undefined,
        httpFallbackActivated: false,
        clearedActiveContext: false,
        deletedCachedContext: false,
        discardedPreviousResponseId: undefined,
        closedSessionIds: [],
      }
    }

    const fallbackKey = this.buildHttpFallbackTransportKey({
      conversationId,
      slotKey: input.slotKey,
      modelName: input.modelName,
    })
    const httpFallbackActivated =
      !!input.persistHttpFallback &&
      !this.httpFallbackTransports.has(fallbackKey)
    if (input.persistHttpFallback) {
      this.httpFallbackTransports.add(fallbackKey)
    }

    let discardedPreviousResponseId: string | undefined
    let clearedActiveContext = false
    const closedSessionIds = new Set<string>()

    const activeContext = this.sessions.getActive(conversationId)
    if (activeContext) {
      discardedPreviousResponseId =
        resetCodexTurnContinuationState(activeContext)
      activeContext.connectionReused = false
      closedSessionIds.add(activeContext.wsSessionId)
      this.sessions.clearActive(conversationId)
      clearedActiveContext = true
    }

    const cached = this.runtimeCache.deleteWs(
      this.buildWsCacheKey({
        conversationId,
        slotKey: input.slotKey,
        modelName: input.modelName,
      })
    )
    if (cached) {
      discardedPreviousResponseId =
        discardedPreviousResponseId || cached.lastResponse?.responseId
      closedSessionIds.add(cached.wsSessionId)
    }

    this.runtimeCache.deleteWarmupPayload(conversationId)

    for (const sessionId of closedSessionIds) {
      this.closeWsSession(sessionId)
    }

    return {
      conversationId,
      httpFallbackActivated,
      clearedActiveContext,
      deletedCachedContext: !!cached,
      discardedPreviousResponseId,
      closedSessionIds: Array.from(closedSessionIds),
    }
  }

  prepareWarmupContext(
    input: CodexTurnContextCacheScope & { turnKey?: string }
  ): CodexPreparedWarmupContext {
    const conversationId = this.normalizeConversationId(input.conversationId)
    const turnKey = input.turnKey?.trim() || undefined
    const cacheKey = this.buildWsCacheKey({
      slotKey: input.slotKey,
      modelName: input.modelName,
      conversationId: conversationId || undefined,
    })
    let cached = this.runtimeCache.getWs(cacheKey)
    if (cached && cached.turnKey !== turnKey) {
      this.runtimeCache.deleteWs(cacheKey)
      this.closeWsSession(cached.wsSessionId)
      cached = undefined
    }
    const sessionId =
      cached?.wsSessionId ||
      (conversationId
        ? buildCodexTurnWsSessionId(conversationId, turnKey)
        : cacheKey)

    if (!cached) {
      this.runtimeCache.setWs(cacheKey, {
        wsSessionId: sessionId,
        turnKey,
        turnState: undefined,
        lastResponse: undefined,
        lastRequest: undefined,
        updatedAt: this.now(),
      })
    }

    return {
      cacheKey,
      sessionId,
      reusedCache: !!cached,
    }
  }

  getWarmPoolAvailability(
    input: CodexWarmPoolAvailabilityInput
  ): CodexWarmPoolAvailability {
    const cacheKey = this.buildWsCacheKey({
      slotKey: input.slotKey,
      modelName: input.modelName,
    })
    const cached = this.runtimeCache.getWs(cacheKey)
    if (
      cached &&
      input.hasOpenSessionConnection(cached.wsSessionId, input.wsUrl)
    ) {
      return {
        available: true,
        sessionId: cached.wsSessionId,
        source: "cached_entry",
      }
    }

    if (input.hasOpenSessionConnection(cacheKey, input.wsUrl)) {
      return {
        available: true,
        sessionId: cacheKey,
        source: "cache_key",
      }
    }

    return { available: false }
  }

  setWarmupPayload(
    conversationId: string,
    payload: Record<string, unknown>
  ): void {
    this.runtimeCache.setWarmupPayload(conversationId, payload)
  }

  getWarmupPayload(
    conversationId: string | undefined
  ): Record<string, unknown> | undefined {
    return this.runtimeCache.getWarmupPayload(conversationId)
  }

  pruneRuntimeState(): void {
    this.runtimeCache.prune()
  }

  getOrCreateContext(
    input: CodexGetOrCreateTurnContextInput
  ): CodexTurnContext {
    const conversationId = this.normalizeConversationId(input.conversationId)
    this.sessions.getOrCreate(conversationId)

    const existing = this.sessions.getActive(conversationId)
    if (existing) {
      if (existing.turnKey === input.turnKey) {
        return existing
      }

      this.closeWsSession(existing.wsSessionId)
      this.sessions.clearActive(conversationId)
    }

    const cacheKey = this.buildWsCacheKey({
      slotKey: input.slotKey,
      modelName: input.modelName,
      conversationId,
    })
    const globalCacheKey = this.buildWsCacheKey({
      slotKey: input.slotKey,
      modelName: input.modelName,
    })
    let takenCache = this.runtimeCache.takeConversationWsWithGlobalFallback(
      cacheKey,
      globalCacheKey
    )
    if (takenCache && takenCache.entry.turnKey !== input.turnKey) {
      // A WebSocket session id is immutable inside CodexWebSocketService. A
      // connection opened by startup/model-picker warmup has no Codex turn key,
      // so promoting it into a keyed ModelClientSession would replay sticky
      // routing on the wrong logical turn. Match Codex CLI by starting a fresh
      // turn-scoped session whenever the turn key changes.
      this.closeWsSession(takenCache.entry.wsSessionId)
      takenCache = undefined
    }
    const context = createCodexTurnContext({
      conversationId,
      turnKey: input.turnKey,
      takenCache,
    })

    this.sessions.setActive(conversationId, context)
    return context
  }

  getActiveContext(
    conversationId: string | undefined
  ): CodexTurnContext | undefined {
    const normalizedConversationId =
      this.normalizeConversationId(conversationId)
    return normalizedConversationId
      ? this.sessions.getActive(normalizedConversationId)
      : undefined
  }

  disposeContext(input: CodexTurnContextCacheScope): void {
    const conversationId = this.normalizeConversationId(input.conversationId)
    if (!conversationId) return

    const context = this.sessions.getActive(conversationId)
    if (!context) return

    if (
      this.isHttpFallbackTransport({
        conversationId,
        slotKey: input.slotKey,
        modelName: input.modelName,
      })
    ) {
      this.sessions.clearActive(conversationId)
      return
    }

    this.runtimeCache.setWs(
      this.buildWsCacheKey({
        slotKey: input.slotKey,
        modelName: input.modelName,
        conversationId,
      }),
      codexTurnContextToCachedWsEntry(context, this.now())
    )
    this.sessions.clearActive(conversationId)
  }

  prepareRequest(
    request: Record<string, unknown>,
    context: CodexTurnContext,
    allowEmptyDelta: boolean = true
  ): CodexPreparedTurnRequest {
    return prepareCodexTurnStateRequest(request, context, allowEmptyDelta)
  }

  beginFullResponseChain(
    context: CodexTurnContext | undefined,
    request: Record<string, unknown>
  ): string | undefined {
    return context ? startCodexFullResponseChain(context, request) : undefined
  }

  captureResponse(
    conversationId: string,
    responseId: string,
    itemsAdded: CodexInputItem[]
  ): boolean {
    const normalizedConversationId =
      this.normalizeConversationId(conversationId)
    if (!normalizedConversationId || !responseId) return false

    const context = this.sessions.getActive(normalizedConversationId)
    if (!context) return false

    captureCodexTurnResponse(context, responseId, itemsAdded)
    this.sessions.touch(normalizedConversationId)
    return true
  }

  resetResponseState(conversationId: string): string | undefined {
    const normalizedConversationId =
      this.normalizeConversationId(conversationId)
    if (!normalizedConversationId) return undefined

    const context = this.sessions.getActive(normalizedConversationId)
    if (!context) return undefined

    const previousResponseId = resetCodexTurnContinuationState(context)
    this.sessions.touch(normalizedConversationId)
    return previousResponseId
  }

  clearContinuationBaseline(
    input: CodexClearContinuationBaselineInput
  ): CodexClearContinuationBaselineResult {
    const conversationId = this.normalizeConversationId(input.conversationId)
    const modelName = input.modelName?.trim() || undefined
    if (!conversationId) {
      return {
        conversationId: undefined,
        modelName,
        resetCount: 0,
        discardedPreviousResponseId: undefined,
      }
    }

    let resetCount = 0
    let discardedPreviousResponseId: string | undefined
    const activeContext = this.sessions.getActive(conversationId)
    if (activeContext) {
      const hadContinuationBaseline =
        !!activeContext.lastRequest || !!activeContext.lastResponse
      discardedPreviousResponseId =
        resetCodexTurnContinuationState(activeContext)
      activeContext.connectionReused = false
      this.sessions.touch(conversationId)
      if (hadContinuationBaseline) {
        resetCount++
      }
    }

    if (modelName) {
      for (const slotKey of input.slotKeys ?? []) {
        const cacheKey = this.buildWsCacheKey({
          slotKey,
          modelName,
          conversationId,
        })
        const cached = this.runtimeCache.getWs(cacheKey)
        if (!cached) {
          continue
        }
        const hadContinuationBaseline =
          !!cached.lastRequest || !!cached.lastResponse
        if (!hadContinuationBaseline) {
          continue
        }
        discardedPreviousResponseId =
          discardedPreviousResponseId || cached.lastResponse?.responseId
        this.runtimeCache.setWs(cacheKey, {
          ...cached,
          lastRequest: undefined,
          lastResponse: undefined,
          updatedAt: this.now(),
        })
        resetCount++
      }
    }

    this.runtimeCache.deleteWarmupPayload(conversationId)

    return {
      conversationId,
      modelName,
      resetCount,
      discardedPreviousResponseId,
    }
  }

  recordTransportReconnect(
    input: CodexTransportReconnectInput
  ): CodexTransportReconnectResult {
    const conversationId = this.normalizeConversationId(input.conversationId)
    if (!conversationId) {
      return {
        conversationId: undefined,
        hadContinuationBaseline: false,
        discardedPreviousResponseId: undefined,
      }
    }

    const activeContext = this.sessions.getActive(conversationId)
    if (activeContext) {
      const hadContinuationBaseline =
        !!activeContext.lastRequest || !!activeContext.lastResponse
      const discardedPreviousResponseId =
        resetCodexTurnContinuationState(activeContext)
      activeContext.connectionReused = false
      this.sessions.touch(conversationId)
      return {
        conversationId,
        hadContinuationBaseline,
        discardedPreviousResponseId,
      }
    }

    const cacheKey = this.buildWsCacheKey({
      conversationId,
      slotKey: input.slotKey,
      modelName: input.modelName,
    })
    const cached = this.runtimeCache.getWs(cacheKey)
    if (!cached) {
      return {
        conversationId,
        hadContinuationBaseline: false,
        discardedPreviousResponseId: undefined,
      }
    }

    const hadContinuationBaseline =
      !!cached.lastRequest || !!cached.lastResponse
    if (!hadContinuationBaseline) {
      return {
        conversationId,
        hadContinuationBaseline: false,
        discardedPreviousResponseId: undefined,
      }
    }

    const discardedPreviousResponseId = cached.lastResponse?.responseId
    this.runtimeCache.setWs(cacheKey, {
      ...cached,
      lastRequest: undefined,
      lastResponse: undefined,
      updatedAt: this.now(),
    })

    return {
      conversationId,
      hadContinuationBaseline: true,
      discardedPreviousResponseId,
    }
  }

  resetContinuationState(
    input: CodexResetContinuationInput
  ): CodexResetContinuationResult {
    const conversationId = this.normalizeConversationId(input.conversationId)
    if (!conversationId) {
      return {
        conversationId: undefined,
        modelName: input.modelName?.trim() || undefined,
        resetCount: 0,
        discardedActivePreviousResponseId: undefined,
      }
    }

    let resetCount = 0
    let discardedActivePreviousResponseId: string | undefined
    const activeContext = this.sessions.getActive(conversationId)
    if (activeContext) {
      discardedActivePreviousResponseId =
        resetCodexTurnContinuationState(activeContext)
      this.sessions.touch(conversationId)
      this.closeWsSession(activeContext.wsSessionId)
      activeContext.connectionReused = false
      resetCount++
    }

    const modelName = input.modelName?.trim() || undefined
    if (modelName) {
      for (const slotKey of input.slotKeys ?? []) {
        const cached = this.runtimeCache.deleteWs(
          this.buildWsCacheKey({
            slotKey,
            modelName,
            conversationId,
          })
        )
        if (!cached) {
          continue
        }
        this.closeWsSession(cached.wsSessionId)
        resetCount++
      }
    }

    this.runtimeCache.deleteWarmupPayload(conversationId)

    return {
      conversationId,
      modelName,
      resetCount,
      discardedActivePreviousResponseId,
    }
  }

  hasActiveContext(conversationId: string): boolean {
    return this.hasContinuationState(conversationId)
  }

  hasContinuationState(
    conversationId: string,
    scope?: Omit<CodexTurnContextCacheScope, "conversationId">
  ): boolean {
    const normalizedConversationId =
      this.normalizeConversationId(conversationId)
    if (!normalizedConversationId) {
      return false
    }

    if (
      hasCodexTurnContinuationState(
        this.sessions.getActive(normalizedConversationId)
      )
    ) {
      return true
    }

    if (!scope) {
      return false
    }

    return hasCodexTurnContinuationState(
      this.runtimeCache.getWs(
        this.buildWsCacheKey({
          slotKey: scope.slotKey,
          modelName: scope.modelName,
          conversationId: normalizedConversationId,
        })
      )
    )
  }

  acquireStreamLock(conversationId: string): Promise<() => void> {
    return this.sessions.acquireStreamLock(conversationId)
  }

  clearActiveContext(conversationId: string): void {
    const normalizedConversationId =
      this.normalizeConversationId(conversationId)
    if (!normalizedConversationId) return
    this.sessions.clearActive(normalizedConversationId)
  }

  deleteConversation(conversationId: string): void {
    const normalizedConversationId =
      this.normalizeConversationId(conversationId)
    if (!normalizedConversationId) return

    const activeContext = this.sessions.getActive(normalizedConversationId)
    if (activeContext) {
      this.closeWsSession(activeContext.wsSessionId)
    }
    this.sessions.delete(normalizedConversationId)
    this.runtimeCache.deleteWarmupPayload(normalizedConversationId)
    for (const entry of this.runtimeCache.takeWsEntriesByConversationHash(
      hashCodexIdentityPart(normalizedConversationId)
    )) {
      this.closeWsSession(entry.wsSessionId)
    }
    this.deleteHttpFallbackTransports(normalizedConversationId)
  }

  private normalizeConversationId(conversationId: string | undefined): string {
    return conversationId?.trim() || ""
  }

  private buildHttpFallbackTransportKey(
    input: CodexTurnContextCacheScope
  ): string {
    const conversationId = this.normalizeConversationId(input.conversationId)
    if (!conversationId) return ""
    return this.buildWsCacheKey({
      conversationId,
      slotKey: input.slotKey,
      modelName: input.modelName,
    })
  }

  private deleteHttpFallbackTransports(conversationId: string): void {
    const suffix = `:conversation:${hashCodexIdentityPart(conversationId)}`
    for (const key of Array.from(this.httpFallbackTransports)) {
      if (key.endsWith(suffix)) {
        this.httpFallbackTransports.delete(key)
      }
    }
  }
}
