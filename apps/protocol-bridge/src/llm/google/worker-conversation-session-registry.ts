import { randomUUID } from "crypto"
import {
  requireExactDurableIdentifier,
  requireOptionalExactDurableIdentifier,
} from "../../context/durable-identifier"

/**
 * Cloud Code keeps request lineage on a worker. The worker-local lineage is
 * only a transport cache: Cursor's complete request projection remains the
 * source of truth, so an expired entry must start a fresh upstream lineage
 * instead of sharing an unrelated fallback session.
 */
export interface WorkerConversationSession {
  uuid: string
  seq: number
}

interface WorkerConversationSessionEntry extends WorkerConversationSession {
  lastAccessedAt: number
}

export const GOOGLE_WORKER_CONVERSATION_SESSION_TTL_MS = 30 * 60 * 1_000
export const GOOGLE_WORKER_CONVERSATION_SESSION_MAX_ENTRIES = 512

/**
 * The sole lifecycle owner for worker-local Cloud Code conversation lineage.
 * It applies the same expiry and least-recently-used capacity policy to every
 * Google worker, and releases all retained state when that worker exits.
 */
export class WorkerConversationSessionRegistry {
  private readonly entries = new Map<string, WorkerConversationSessionEntry>()
  private disposed = false

  constructor(
    private readonly options: {
      ttlMs: number
      maxEntries: number
      now?: () => number
    }
  ) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("Google worker conversation session TTL must be positive")
    }
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error(
        "Google worker conversation session capacity must be a positive integer"
      )
    }
  }

  acquire(scopeKey: string | undefined): WorkerConversationSession {
    const now = this.getNow()
    if (this.disposed) {
      throw new Error("Google worker conversation registry is disposed")
    }
    this.evictExpired(now)

    const exactScopeKey = requireOptionalExactDurableIdentifier(
      scopeKey,
      "Google worker conversation key"
    )
    if (exactScopeKey === undefined) {
      return this.createEntry(now)
    }

    const existing = this.entries.get(exactScopeKey)
    if (existing) {
      existing.lastAccessedAt = now
      return existing
    }

    const created = this.createEntry(now)
    this.entries.set(exactScopeKey, created)
    this.evictOverflow()
    return created
  }

  delete(scopeKey: string): boolean {
    if (this.disposed) return false
    return this.entries.delete(
      requireExactDurableIdentifier(scopeKey, "Google worker conversation key")
    )
  }

  /** Refreshes an existing entry only; disposal must never recreate lineage. */
  touch(scopeKey: string): boolean {
    if (this.disposed) return false
    const entry = this.entries.get(
      requireExactDurableIdentifier(scopeKey, "Google worker conversation key")
    )
    if (!entry) return false
    entry.lastAccessedAt = this.getNow()
    return true
  }

  dispose(): void {
    this.disposed = true
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  private createEntry(now: number): WorkerConversationSessionEntry {
    return {
      uuid: randomUUID(),
      seq: 0,
      lastAccessedAt: now,
    }
  }

  private getNow(): number {
    return this.options.now?.() ?? Date.now()
  }

  private evictExpired(now: number): void {
    for (const [scopeKey, entry] of this.entries) {
      if (now - entry.lastAccessedAt >= this.options.ttlMs) {
        this.entries.delete(scopeKey)
      }
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.options.maxEntries) {
      let leastRecentlyUsedKey: string | undefined
      let leastRecentlyUsedAt = Number.POSITIVE_INFINITY
      for (const [scopeKey, entry] of this.entries) {
        if (entry.lastAccessedAt < leastRecentlyUsedAt) {
          leastRecentlyUsedAt = entry.lastAccessedAt
          leastRecentlyUsedKey = scopeKey
        }
      }
      if (leastRecentlyUsedKey === undefined) {
        throw new Error("Google worker conversation registry overflow")
      }
      this.entries.delete(leastRecentlyUsedKey)
    }
  }
}
