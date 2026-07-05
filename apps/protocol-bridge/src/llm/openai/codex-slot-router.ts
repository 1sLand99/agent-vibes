import {
  findCodexAccountFromIndex,
  type CodexAccountSelection,
} from "./codex-account-selection"
import { CodexSlotAffinityStore } from "./codex-slot-affinity-store"

export interface CodexSlotRouterOptions {
  affinityTtlMs: number
  now?: () => number
}

export interface CodexSlotLookupOptions<TSlot> {
  candidates: readonly TSlot[]
  isSlotUsable: (slot: TSlot, index: number) => boolean
}

export interface CodexStickySlotRouterLookupOptions<TSlot> {
  candidates: TSlot[]
  getSlotKey: (slot: TSlot) => string
  isSlotUsable: (slot: TSlot) => boolean
}

export class CodexSlotRouter {
  private readonly affinity: CodexSlotAffinityStore
  private accountIndex = 0

  constructor(options: CodexSlotRouterOptions) {
    this.affinity = new CodexSlotAffinityStore({
      ttlMs: options.affinityTtlMs,
      now: options.now,
    })
  }

  normalizeAccountIndex(accountCount: number): void {
    this.accountIndex = accountCount > 0 ? this.accountIndex % accountCount : 0
  }

  findFromCurrentIndex<TSlot>(
    options: CodexSlotLookupOptions<TSlot>
  ): CodexAccountSelection<TSlot> | null {
    return findCodexAccountFromIndex(
      options.candidates,
      this.accountIndex,
      options.isSlotUsable
    )
  }

  pickFromCurrentIndex<TSlot>(
    options: CodexSlotLookupOptions<TSlot>
  ): TSlot | null {
    const selection = this.findFromCurrentIndex(options)
    if (!selection) {
      return null
    }

    this.accountIndex = selection.nextIndex
    return selection.account
  }

  bindConversation(conversationId: string, slotKey: string): void {
    this.affinity.bindConversation(conversationId, slotKey)
  }

  getStickySlot<TSlot>(
    conversationId: string,
    options: CodexStickySlotRouterLookupOptions<TSlot>
  ): TSlot | null {
    return this.affinity.getStickySlot(conversationId, options)
  }

  pruneExpiredBindings(
    now?: number,
    onExpire?: (conversationId: string) => void
  ): number {
    return this.affinity.pruneExpired(now, onExpire)
  }

  pruneBindingsForSlotKeys(slotKeys: Iterable<string>): number {
    return this.affinity.pruneBindingsForSlotKeys(slotKeys)
  }

  get bindingCount(): number {
    return this.affinity.size
  }
}
