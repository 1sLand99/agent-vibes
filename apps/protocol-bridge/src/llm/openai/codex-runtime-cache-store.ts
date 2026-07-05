import type { CodexTurnContinuationState } from "./codex-turn-state"

export interface CodexCachedWsEntry extends CodexTurnContinuationState {
  wsSessionId: string
  turnKey: string | undefined
  turnState: string | undefined
  updatedAt: number
}

export interface CodexWarmupPayloadCacheEntry {
  payload: Record<string, unknown>
  updatedAt: number
}

export interface CodexWsCacheKeyInput {
  slotKeyHash: string
  modelName: string
  conversationIdHash?: string
}

export interface CodexTakenWsEntry {
  cacheKey: string
  entry: CodexCachedWsEntry
}

export interface CodexRuntimeCacheStoreOptions {
  wsSessionTtlMs?: number
  warmupPayloadTtlMs?: number
  maxWsSessions?: number
  maxWarmupPayloads?: number
  now?: () => number
}

const DEFAULT_WS_SESSION_TTL_MS = 10 * 60 * 1000
const DEFAULT_WARMUP_PAYLOAD_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_WS_SESSIONS = 128
const DEFAULT_MAX_WARMUP_PAYLOADS = 256

export function createCodexWsCacheKey(input: CodexWsCacheKeyInput): string {
  const normalizedModel = input.modelName.toLowerCase().trim() || "unknown"
  const scope = input.conversationIdHash
    ? `conversation:${input.conversationIdHash}`
    : "global"
  return `ws:${normalizedModel}:${input.slotKeyHash}:${scope}`
}

export class CodexRuntimeCacheStore {
  private readonly cachedWsSessions = new Map<string, CodexCachedWsEntry>()
  private readonly warmupPayloadCache = new Map<
    string,
    CodexWarmupPayloadCacheEntry
  >()

  private readonly wsSessionTtlMs: number
  private readonly warmupPayloadTtlMs: number
  private readonly maxWsSessions: number
  private readonly maxWarmupPayloads: number
  private readonly now: () => number

  constructor(options: CodexRuntimeCacheStoreOptions = {}) {
    this.wsSessionTtlMs = options.wsSessionTtlMs ?? DEFAULT_WS_SESSION_TTL_MS
    this.warmupPayloadTtlMs =
      options.warmupPayloadTtlMs ?? DEFAULT_WARMUP_PAYLOAD_TTL_MS
    this.maxWsSessions = options.maxWsSessions ?? DEFAULT_MAX_WS_SESSIONS
    this.maxWarmupPayloads =
      options.maxWarmupPayloads ?? DEFAULT_MAX_WARMUP_PAYLOADS
    this.now = options.now ?? (() => Date.now())
  }

  prune(now: number = this.now()): void {
    for (const [key, entry] of this.cachedWsSessions) {
      if (entry.updatedAt + this.wsSessionTtlMs <= now) {
        this.cachedWsSessions.delete(key)
      }
    }
    this.pruneMapToMaxSize(this.cachedWsSessions, this.maxWsSessions)

    for (const [conversationId, entry] of this.warmupPayloadCache) {
      if (entry.updatedAt + this.warmupPayloadTtlMs <= now) {
        this.warmupPayloadCache.delete(conversationId)
      }
    }
    this.pruneMapToMaxSize(this.warmupPayloadCache, this.maxWarmupPayloads)
  }

  getWs(cacheKey: string): CodexCachedWsEntry | undefined {
    if (!cacheKey) return undefined
    this.prune()
    return this.cachedWsSessions.get(cacheKey)
  }

  setWs(cacheKey: string, entry: CodexCachedWsEntry): void {
    if (!cacheKey) return
    this.prune()
    this.cachedWsSessions.set(cacheKey, {
      ...entry,
      updatedAt: this.now(),
    })
    this.pruneMapToMaxSize(this.cachedWsSessions, this.maxWsSessions)
  }

  takeWs(cacheKey: string): CodexTakenWsEntry | undefined {
    if (!cacheKey) return undefined
    this.prune()
    const entry = this.cachedWsSessions.get(cacheKey)
    if (!entry) return undefined
    this.cachedWsSessions.delete(cacheKey)
    return { cacheKey, entry }
  }

  takeConversationWsWithGlobalFallback(
    conversationCacheKey: string,
    globalCacheKey: string
  ): CodexTakenWsEntry | undefined {
    const exact = this.takeWs(conversationCacheKey)
    if (exact || !globalCacheKey || globalCacheKey === conversationCacheKey) {
      return exact
    }

    const global = this.getWs(globalCacheKey)
    if (!global || !isPristineCodexCachedWsEntry(global)) {
      return undefined
    }

    this.cachedWsSessions.delete(globalCacheKey)
    return { cacheKey: globalCacheKey, entry: global }
  }

  deleteWs(cacheKey: string): CodexCachedWsEntry | undefined {
    if (!cacheKey) return undefined
    this.prune()
    const entry = this.cachedWsSessions.get(cacheKey)
    if (entry) {
      this.cachedWsSessions.delete(cacheKey)
    }
    return entry
  }

  deleteWsEntriesBySessionId(sessionId: string): number {
    if (!sessionId) return 0
    let deleted = 0
    for (const [key, entry] of this.cachedWsSessions) {
      if (entry.wsSessionId === sessionId) {
        this.cachedWsSessions.delete(key)
        deleted++
      }
    }
    return deleted
  }

  setWarmupPayload(
    conversationId: string,
    payload: Record<string, unknown>
  ): void {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId) return
    this.prune()
    this.warmupPayloadCache.set(normalizedConversationId, {
      payload,
      updatedAt: this.now(),
    })
    this.pruneMapToMaxSize(this.warmupPayloadCache, this.maxWarmupPayloads)
  }

  getWarmupPayload(
    conversationId: string | undefined
  ): Record<string, unknown> | undefined {
    const normalizedConversationId = conversationId?.trim()
    if (!normalizedConversationId) return undefined
    this.prune()
    const entry = this.warmupPayloadCache.get(normalizedConversationId)
    if (!entry) return undefined

    entry.updatedAt = this.now()
    this.warmupPayloadCache.delete(normalizedConversationId)
    this.warmupPayloadCache.set(normalizedConversationId, entry)
    return entry.payload
  }

  deleteWarmupPayload(conversationId: string): boolean {
    const normalizedConversationId = conversationId.trim()
    return normalizedConversationId
      ? this.warmupPayloadCache.delete(normalizedConversationId)
      : false
  }

  private pruneMapToMaxSize<K, V>(map: Map<K, V>, maxSize: number): void {
    while (map.size > maxSize) {
      const oldestKey = map.keys().next().value
      if (oldestKey === undefined) return
      map.delete(oldestKey)
    }
  }
}

export function isPristineCodexCachedWsEntry(
  entry: CodexCachedWsEntry
): boolean {
  return !entry.lastResponse && !entry.lastRequest
}
