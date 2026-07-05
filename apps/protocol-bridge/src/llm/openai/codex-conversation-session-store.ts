export interface CodexConversationSession<TActive> {
  conversationId: string
  active: TActive | null
  streamTail: Promise<void> | null
  createdAt: number
  updatedAt: number
}

export class CodexConversationSessionStore<TActive> {
  private readonly sessions = new Map<
    string,
    CodexConversationSession<TActive>
  >()

  get(conversationId: string): CodexConversationSession<TActive> | undefined {
    const normalized = this.normalizeConversationId(conversationId)
    return normalized ? this.sessions.get(normalized) : undefined
  }

  getOrCreate(conversationId: string): CodexConversationSession<TActive> {
    const normalized = this.normalizeConversationId(conversationId)
    if (!normalized) {
      throw new Error(
        "[CodexConversationSessionStore] empty conversationId passed to getOrCreate"
      )
    }

    const existing = this.sessions.get(normalized)
    if (existing) {
      existing.updatedAt = Date.now()
      return existing
    }

    const created: CodexConversationSession<TActive> = {
      conversationId: normalized,
      active: null,
      streamTail: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.sessions.set(normalized, created)
    return created
  }

  getActive(conversationId: string): TActive | undefined {
    return this.get(conversationId)?.active ?? undefined
  }

  setActive(conversationId: string, active: TActive): void {
    const session = this.getOrCreate(conversationId)
    session.active = active
    session.updatedAt = Date.now()
  }

  clearActive(conversationId: string): void {
    const session = this.get(conversationId)
    if (!session) return
    session.active = null
    session.updatedAt = Date.now()
    this.purgeIfIdle(conversationId)
  }

  touch(conversationId: string): void {
    const session = this.get(conversationId)
    if (session) {
      session.updatedAt = Date.now()
    }
  }

  delete(conversationId: string): void {
    const normalized = this.normalizeConversationId(conversationId)
    if (normalized) {
      this.sessions.delete(normalized)
    }
  }

  async acquireStreamLock(conversationId: string): Promise<() => void> {
    const normalized = this.normalizeConversationId(conversationId)
    if (!normalized) {
      return () => {}
    }

    const session = this.getOrCreate(normalized)
    const previousTail = session.streamTail
    let release!: () => void
    const currentTail = new Promise<void>((resolve) => {
      release = resolve
    })
    session.streamTail = currentTail
    session.updatedAt = Date.now()

    if (previousTail) {
      try {
        await previousTail
      } catch {
        // Stream lock tails resolve during normal flow; ignore defensive rejects
        // so a broken prior turn cannot block the conversation forever.
      }
    }

    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.get(normalized)
      if (current && current.streamTail === currentTail) {
        current.streamTail = null
        current.updatedAt = Date.now()
        this.purgeIfIdle(normalized)
      }
      release()
    }
  }

  private purgeIfIdle(conversationId: string): void {
    const normalized = this.normalizeConversationId(conversationId)
    if (!normalized) return
    const session = this.sessions.get(normalized)
    if (!session) return
    if (session.active === null && session.streamTail === null) {
      this.sessions.delete(normalized)
    }
  }

  private normalizeConversationId(conversationId: string): string {
    return conversationId.trim()
  }
}
