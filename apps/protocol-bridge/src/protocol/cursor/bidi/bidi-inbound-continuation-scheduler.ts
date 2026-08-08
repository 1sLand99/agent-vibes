export type BidiInboundEndReason =
  | "turn-terminal"
  | "continuation-failed"
  | "input-ended"
  | "consumer-closed"

export interface BidiInboundContinuationSchedulerOptions {
  /**
   * Re-enters the BiDi umbrella's async context before a queued continuation
   * starts. The scheduler owns ordering; the caller still owns turn identity.
   */
  runInScope: (work: () => Promise<void>) => Promise<void>
  /**
   * Evaluated only at a real FIFO idle edge. Returning true ends this Run RPC;
   * pending client executions and blocking interaction queries keep it open.
   */
  shouldEndWhenIdle: () => boolean
  onTaskError: (label: string, error: Error) => void
}

export type BidiInboundRead<T> =
  | { readonly kind: "input"; readonly value: IteratorResult<T> }
  | { readonly kind: "end"; readonly reason: BidiInboundEndReason }

interface QueuedContinuation {
  readonly label: string
  readonly run: () => Promise<void>
}

/**
 * Per-BiDi FIFO for model/tool continuations.
 *
 * Client terminal frames are deliberately not submitted here. The input pump
 * routes those frames immediately so a continuation may await a Cursor result
 * without also owning the only code path capable of receiving that result.
 */
export class BidiInboundContinuationScheduler {
  private readonly queue: QueuedContinuation[] = []
  private active: QueuedContinuation | undefined
  private accepting = true
  private endReason: BidiInboundEndReason | undefined
  private resolveEnd!: (reason: BidiInboundEndReason) => void
  private readonly endRequested = new Promise<BidiInboundEndReason>(
    (resolve) => {
      this.resolveEnd = resolve
    }
  )
  private idleWaiters = new Set<() => void>()

  constructor(
    private readonly options: BidiInboundContinuationSchedulerOptions
  ) {}

  enqueue(label: string, run: () => Promise<void>): void {
    if (!this.accepting) {
      throw new Error(
        `BiDi inbound continuation scheduler is closed; cannot enqueue ${label}`
      )
    }
    const continuation = { label, run }
    if (!this.active) {
      this.start(continuation)
      return
    }
    this.queue.push(continuation)
  }

  requestEnd(reason: BidiInboundEndReason): void {
    if (this.endReason) return
    this.endReason = reason
    this.accepting = false
    this.queue.splice(0)
    this.resolveEnd(reason)
    this.notifyIdleIfReady()
  }

  whenEndRequested(): Promise<BidiInboundEndReason> {
    return this.endRequested
  }

  /**
   * Read the next client frame without making transport completion depend on
   * another frame arriving. When a continuation ends the turn, the pending
   * iterator is explicitly returned so the HTTP/2 request body is released.
   */
  async nextInput<T>(iterator: AsyncIterator<T>): Promise<BidiInboundRead<T>> {
    const next = await Promise.race([
      iterator.next().then((value) => ({ kind: "input" as const, value })),
      this.whenEndRequested().then((reason) => ({
        kind: "end" as const,
        reason,
      })),
    ])
    if (next.kind === "end" && typeof iterator.return === "function") {
      void iterator.return().catch(() => undefined)
    }
    return next
  }

  /** Recheck transport completion after an immediate terminal route. */
  evaluateIdle(): void {
    if (this.endReason || this.active || this.queue.length > 0) return
    if (this.options.shouldEndWhenIdle()) {
      this.requestEnd("turn-terminal")
    }
  }

  close(
    reason: Extract<BidiInboundEndReason, "input-ended" | "consumer-closed">
  ): void {
    this.requestEnd(reason)
  }

  awaitIdle(): Promise<void> {
    if (!this.active && this.queue.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve)
    })
  }

  snapshot(): {
    readonly accepting: boolean
    readonly activeLabel?: string
    readonly queuedLabels: readonly string[]
    readonly endReason?: BidiInboundEndReason
  } {
    return {
      accepting: this.accepting,
      activeLabel: this.active?.label,
      queuedLabels: this.queue.map((entry) => entry.label),
      endReason: this.endReason,
    }
  }

  private start(continuation: QueuedContinuation): void {
    this.active = continuation
    // runInScope invokes the async body immediately, before its first await.
    // That preserves deterministic admission for the first frame while the
    // input pump remains free as soon as the continuation suspends.
    let execution: Promise<void>
    try {
      execution = this.options.runInScope(continuation.run)
    } catch (error) {
      execution = Promise.reject(
        error instanceof Error ? error : new Error(String(error))
      )
    }
    void execution
      .catch((error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error(String(error))
        this.requestEnd("continuation-failed")
        this.options.onTaskError(continuation.label, normalized)
      })
      .finally(() => {
        if (this.active !== continuation) return
        this.active = undefined
        const next = this.queue.shift()
        if (next && !this.endReason) {
          this.start(next)
          return
        }
        this.evaluateIdle()
        this.notifyIdleIfReady()
      })
  }

  private notifyIdleIfReady(): void {
    if (this.active || this.queue.length > 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = new Set()
    for (const resolve of waiters) resolve()
  }
}
