export interface CodexSlotBinding {
  slotKey: string
  expire: number
}

export interface CodexSlotAffinityStoreOptions {
  ttlMs: number
  now?: () => number
}

export interface CodexStickySlotLookupOptions<TSlot> {
  candidates: TSlot[]
  getSlotKey: (slot: TSlot) => string
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

  bindConversation(conversationId: string, slotKey: string): void {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId || !slotKey) return

    this.pruneExpired()
    this.bindings.set(normalizedConversationId, {
      slotKey,
      expire: this.now() + this.ttlMs,
    })
  }

  getStickySlot<TSlot>(
    conversationId: string,
    options: CodexStickySlotLookupOptions<TSlot>
  ): TSlot | null {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId) {
      return null
    }

    const now = this.now()
    this.pruneExpired(now)

    const binding = this.bindings.get(normalizedConversationId)
    if (!binding) {
      return null
    }

    const slot =
      options.candidates.find(
        (candidate) => options.getSlotKey(candidate) === binding.slotKey
      ) || null
    if (!slot || !options.isSlotUsable(slot)) {
      this.bindings.delete(normalizedConversationId)
      return null
    }

    binding.expire = now + this.ttlMs
    this.bindings.set(normalizedConversationId, binding)
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

  pruneBindingsForSlotKeys(slotKeys: Iterable<string>): number {
    const staleKeys = new Set([...slotKeys].filter(Boolean))
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
