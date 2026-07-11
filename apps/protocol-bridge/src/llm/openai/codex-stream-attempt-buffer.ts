const REPLAY_SAFE_CODEX_STREAM_EVENT_TYPES = new Set([
  "message_start",
  "ping",
  "content_block_start",
  "content_block_stop",
  "codex_response_item",
])

function getSseEventType(event: string): string | undefined {
  const match = /^event:\s*([^\r\n]+)$/m.exec(event)
  return match?.[1]?.trim() || undefined
}

/**
 * Holds events that have not produced user-visible output yet. If a transport
 * attempt disconnects before its first content delta, these events can be
 * discarded and the request can be replayed without duplicating text or tool
 * execution state downstream.
 */
export class CodexStreamAttemptBuffer {
  private bufferedEvents: string[] = []
  private committed = false

  push(event: string): string[] {
    if (
      !this.committed &&
      REPLAY_SAFE_CODEX_STREAM_EVENT_TYPES.has(getSseEventType(event) || "")
    ) {
      this.bufferedEvents.push(event)
      return []
    }

    this.committed = true
    const ready = [...this.bufferedEvents, event]
    this.bufferedEvents = []
    return ready
  }

  finish(): string[] {
    const ready = this.bufferedEvents
    this.bufferedEvents = []
    return ready
  }

  hasCommittedOutput(): boolean {
    return this.committed
  }
}
