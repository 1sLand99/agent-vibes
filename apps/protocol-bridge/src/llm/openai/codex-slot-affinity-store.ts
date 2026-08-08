import { requireExactDurableIdentifier } from "../../context/durable-identifier"
import { requireCodexSlotKey, type CodexSlotKey } from "./codex-slot-identity"

export interface CodexSlotBinding {
  slotKey: CodexSlotKey
  expire: number
}

export interface CodexSlotAffinityStoreOptions {
  ttlMs: number
  now?: () => number
}

export interface CodexStickySlotLookupOptions<TSlot> {
  candidates: TSlot[]
  getSlotKey: (slot: TSlot) => CodexSlotKey
  isSlotUsable: (slot: TSlot) => boolean
}

export class CodexSlotAffinityStore {
  private readonly bindings = new Map<string, CodexSlotBinding>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: CodexSlotAffinityStoreOptions) {
    this.ttlMs = options.ttlMs
    this.now = options.now ?? (() => Date.now())
  }

  get size(): number {
    return this.bindings.size
  }

  bindConversation(conversationId: string, slotKey: CodexSlotKey): void {
    const exactConversationId = requireExactDurableIdentifier(
      conversationId,
      "Codex slot-affinity conversation id"
    )
    const exactSlotKey = requireCodexSlotKey(
      slotKey,
      "Codex slot-affinity slot key"
    )

    this.pruneExpired()
    this.bindings.set(exactConversationId, {
      slotKey: exactSlotKey,
      expire: this.now() + this.ttlMs,
    })
  }

  getStickySlot<TSlot>(
    conversationId: string,
    options: CodexStickySlotLookupOptions<TSlot>
  ): TSlot | null {
    const exactConversationId = requireExactDurableIdentifier(
      conversationId,
      "Codex slot-affinity conversation id"
    )

    const now = this.now()
    this.pruneExpired(now)

    const binding = this.bindings.get(exactConversationId)
    if (!binding) {
      return null
    }

    const slot =
      options.candidates.find(
        (candidate) => options.getSlotKey(candidate) === binding.slotKey
      ) || null
    if (!slot || !options.isSlotUsable(slot)) {
      this.bindings.delete(exactConversationId)
      return null
    }

    binding.expire = now + this.ttlMs
    this.bindings.set(exactConversationId, binding)
    return slot
  }

  pruneExpired(
    now: number = this.now(),
    onExpire?: (conversationId: string) => void
  ): number {
    let removed = 0
    for (const [conversationId, binding] of this.bindings) {
      if (binding.expire <= now) {
        this.bindings.delete(conversationId)
        onExpire?.(conversationId)
        removed++
      }
    }
    return removed
  }

  pruneBindingsForSlotKeys(slotKeys: Iterable<CodexSlotKey>): number {
    const staleKeys = new Set(
      [...slotKeys].map((slotKey) =>
        requireCodexSlotKey(slotKey, "Codex slot-affinity slot key")
      )
    )
    if (staleKeys.size === 0 || this.bindings.size === 0) {
      return 0
    }

    let removed = 0
    for (const [conversationId, binding] of this.bindings) {
      if (staleKeys.has(binding.slotKey)) {
        this.bindings.delete(conversationId)
        removed++
      }
    }
    return removed
  }
}
