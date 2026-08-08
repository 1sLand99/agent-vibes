import { requireExactDurableIdentifier } from "../../context/durable-identifier"

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
    return this.sessions.get(this.requireConversationId(conversationId))
  }

  getOrCreate(conversationId: string): CodexConversationSession<TActive> {
    const exactConversationId = this.requireConversationId(conversationId)

    const existing = this.sessions.get(exactConversationId)
    if (existing) {
      existing.updatedAt = Date.now()
      return existing
    }

    const created: CodexConversationSession<TActive> = {
      conversationId: exactConversationId,
      active: null,
      streamTail: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.sessions.set(exactConversationId, created)
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
    this.sessions.delete(this.requireConversationId(conversationId))
  }

  async acquireStreamLock(conversationId: string): Promise<() => void> {
    const exactConversationId = this.requireConversationId(conversationId)

    const session = this.getOrCreate(exactConversationId)
    const previousTail = session.streamTail
    let release!: () => void
    const currentTail = new Promise<void>((resolve) => {
      release = resolve
    })
    session.streamTail = currentTail
    session.updatedAt = Date.now()

    if (previousTail) {
      await previousTail
    }

    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.get(exactConversationId)
      if (current && current.streamTail === currentTail) {
        current.streamTail = null
        current.updatedAt = Date.now()
        this.purgeIfIdle(exactConversationId)
      }
      release()
    }
  }

  private purgeIfIdle(conversationId: string): void {
    const exactConversationId = this.requireConversationId(conversationId)
    const session = this.sessions.get(exactConversationId)
    if (!session) return
    if (session.active === null && session.streamTail === null) {
      this.sessions.delete(exactConversationId)
    }
  }

  private requireConversationId(conversationId: string): string {
    return requireExactDurableIdentifier(
      conversationId,
      "Codex conversation id"
    )
  }
}
