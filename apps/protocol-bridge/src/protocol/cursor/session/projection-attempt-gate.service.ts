import { Injectable } from "@nestjs/common"
import {
  assertProjectionOwner,
  projectionOwnerStorageKey,
  type ProjectionOwner,
} from "./projection-owner"

/**
 * Exclusive admission for provider attempts that share one durable projection
 * owner. The gate deliberately knows nothing about branch/head validity: the
 * request scope validates those durable facts before it uses a lease.
 */
export interface ProjectionAttemptLease {
  release(): void
  abort(): void
}

/**
 * Raised when an owner is being moved to a successor execution. Callers that
 * own the outgoing execution may observe its settlement, re-check durable
 * execution ownership, and only resume if the handoff was aborted before it
 * changed owners.
 */
export class ProjectionAttemptHandoffInProgressError extends Error {
  constructor(owner: ProjectionOwner) {
    super(
      `Projection attempt admission is closed for handoff on ${describeOwner(owner)}`
    )
    this.name = "ProjectionAttemptHandoffInProgressError"
  }
}

export type ProjectionAttemptHandoffOutcome = "completed" | "aborted"

/**
 * Owns the closed-admission interval around a foreground/background handoff.
 * Either terminal operation reopens the owner for its next execution.
 */
export interface ProjectionAttemptHandoffToken {
  complete(): void
  abort(): void
}

interface ActiveAttempt {
  terminalAction?: "released" | "aborted"
}

interface QueuedAttempt {
  settled: boolean
  readonly resolve: (lease: ProjectionAttemptLease) => void
  readonly reject: (error: Error) => void
  readonly removeAbortListener: () => void
}

interface HandoffWaiter {
  settled: boolean
  readonly resolve: (token: ProjectionAttemptHandoffToken) => void
  readonly reject: (error: Error) => void
  readonly removeAbortListener: () => void
}

interface PendingHandoff {
  tokenIssued: boolean
  outcomeSettled: boolean
  readonly outcome: Promise<ProjectionAttemptHandoffOutcome>
  readonly resolveOutcome: (outcome: ProjectionAttemptHandoffOutcome) => void
  waiter?: HandoffWaiter
}

interface OwnerGateState {
  active?: ActiveAttempt
  readonly queue: QueuedAttempt[]
  handoff?: PendingHandoff
}

/**
 * A process-local concurrency boundary for immutable provider request scopes.
 *
 * Durable branch snapshots and provider heads remain outside this class. Its
 * only responsibility is to ensure that one owner cannot prepare or accept
 * overlapping attempts while unrelated owners continue independently.
 */
@Injectable()
export class ProjectionAttemptGate {
  private readonly states = new Map<string, OwnerGateState>()

  acquire(
    owner: ProjectionOwner,
    signal: AbortSignal
  ): Promise<ProjectionAttemptLease> {
    const key = this.assertInput(owner, signal, "acquire")
    if (signal.aborted) {
      return rejected(abortedError("projection attempt admission"))
    }

    const existing = this.states.get(key)
    if (existing?.handoff) {
      return rejected(drainingError(owner))
    }

    const state = existing ?? this.createState(key)
    if (!state.active) {
      return Promise.resolve(this.grantLease(key, state))
    }

    return this.enqueueAttempt(key, state, owner, signal)
  }

  beginHandoff(
    owner: ProjectionOwner,
    signal: AbortSignal
  ): Promise<ProjectionAttemptHandoffToken> {
    const key = this.assertInput(owner, signal, "beginHandoff")
    if (signal.aborted) {
      return rejected(abortedError("projection handoff admission"))
    }

    const state = this.states.get(key) ?? this.createState(key)
    if (state.handoff) {
      return rejected(
        new Error(
          `Projection attempt handoff is already draining ${describeOwner(owner)}`
        )
      )
    }

    const handoff = this.createPendingHandoff()
    state.handoff = handoff
    this.rejectQueuedAttempts(state, owner)

    if (!state.active) {
      return Promise.resolve(this.createHandoffToken(key, state, handoff))
    }

    return this.waitForActiveRelease(key, state, owner, handoff, signal)
  }

  /**
   * Wait for the currently draining handoff, if one exists. This is not an
   * admission queue: callers must re-check their durable execution identity
   * after it settles before trying again.
   */
  awaitHandoffSettlement(
    owner: ProjectionOwner,
    signal: AbortSignal
  ): Promise<ProjectionAttemptHandoffOutcome | undefined> {
    const key = this.assertInput(owner, signal, "awaitHandoffSettlement")
    if (signal.aborted) {
      return rejected(abortedError("projection handoff observation"))
    }
    const handoff = this.states.get(key)?.handoff
    if (!handoff) return Promise.resolve(undefined)

    return new Promise<ProjectionAttemptHandoffOutcome>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort)
        reject(abortedError("projection handoff observation"))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      void handoff.outcome.then((outcome) => {
        signal.removeEventListener("abort", onAbort)
        resolve(outcome)
      })
      if (signal.aborted) onAbort()
    })
  }

  private assertInput(
    owner: ProjectionOwner,
    signal: AbortSignal,
    operation: string
  ): string {
    assertProjectionOwner(owner, `ProjectionAttemptGate.${operation}`)
    assertAbortSignal(signal, `ProjectionAttemptGate.${operation}`)
    return projectionOwnerStorageKey(owner)
  }

  private createState(key: string): OwnerGateState {
    const state: OwnerGateState = { queue: [] }
    this.states.set(key, state)
    return state
  }

  private createPendingHandoff(): PendingHandoff {
    let resolveOutcome!: (outcome: ProjectionAttemptHandoffOutcome) => void
    const outcome = new Promise<ProjectionAttemptHandoffOutcome>((resolve) => {
      resolveOutcome = resolve
    })
    return {
      tokenIssued: false,
      outcomeSettled: false,
      outcome,
      resolveOutcome,
    }
  }

  private grantLease(
    key: string,
    state: OwnerGateState
  ): ProjectionAttemptLease {
    if (state.active) {
      throw new Error(
        "Projection attempt gate tried to grant an occupied lease"
      )
    }
    if (state.handoff) {
      throw new Error("Projection attempt gate tried to grant while draining")
    }

    const active: ActiveAttempt = {}
    state.active = active
    return Object.freeze({
      release: () => this.releaseLease(key, state, active),
      abort: () => this.abortLease(key, state, active),
    })
  }

  private releaseLease(
    key: string,
    state: OwnerGateState,
    active: ActiveAttempt
  ): void {
    this.settleLease(key, state, active, "released")
  }

  private abortLease(
    key: string,
    state: OwnerGateState,
    active: ActiveAttempt
  ): void {
    this.settleLease(key, state, active, "aborted")
  }

  private settleLease(
    key: string,
    state: OwnerGateState,
    active: ActiveAttempt,
    action: "released" | "aborted"
  ): void {
    if (active.terminalAction) {
      throw new Error(
        `Projection attempt lease has already been ${active.terminalAction}`
      )
    }
    if (state.active !== active) {
      throw new Error("Projection attempt lease is no longer active")
    }

    active.terminalAction = action
    state.active = undefined

    if (state.handoff) {
      this.resolveHandoffAfterActiveRelease(key, state, state.handoff)
      return
    }

    this.admitNextQueuedAttempt(key, state)
  }

  private enqueueAttempt(
    key: string,
    state: OwnerGateState,
    owner: ProjectionOwner,
    signal: AbortSignal
  ): Promise<ProjectionAttemptLease> {
    return new Promise<ProjectionAttemptLease>((resolve, reject) => {
      const onAbort = (): void => {
        if (waiter.settled) return
        waiter.settled = true
        waiter.removeAbortListener()
        removeEntry(state.queue, waiter)
        reject(abortedError("queued projection attempt admission"))
        this.deleteStateIfIdle(key, state)
      }
      const waiter: QueuedAttempt = {
        settled: false,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      }
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      if (state.handoff) {
        waiter.settled = true
        waiter.removeAbortListener()
        reject(drainingError(owner))
        return
      }
      state.queue.push(waiter)
    })
  }

  private admitNextQueuedAttempt(key: string, state: OwnerGateState): void {
    while (state.queue.length > 0) {
      const waiter = state.queue.shift()
      if (!waiter || waiter.settled) continue
      waiter.settled = true
      waiter.removeAbortListener()
      waiter.resolve(this.grantLease(key, state))
      return
    }
    this.deleteStateIfIdle(key, state)
  }

  private rejectQueuedAttempts(
    state: OwnerGateState,
    owner: ProjectionOwner
  ): void {
    const queued = state.queue.splice(0)
    for (const waiter of queued) {
      if (waiter.settled) continue
      waiter.settled = true
      waiter.removeAbortListener()
      waiter.reject(
        new Error(
          `Projection attempt was rejected by handoff for ${describeOwner(owner)}`
        )
      )
    }
  }

  private waitForActiveRelease(
    key: string,
    state: OwnerGateState,
    owner: ProjectionOwner,
    handoff: PendingHandoff,
    signal: AbortSignal
  ): Promise<ProjectionAttemptHandoffToken> {
    return new Promise<ProjectionAttemptHandoffToken>((resolve, reject) => {
      const onAbort = (): void => {
        if (waiter.settled || state.handoff !== handoff) return
        waiter.settled = true
        waiter.removeAbortListener()
        handoff.waiter = undefined
        state.handoff = undefined
        this.settleHandoffOutcome(handoff, "aborted")
        reject(abortedError("projection handoff"))
        this.deleteStateIfIdle(key, state)
      }
      const waiter: HandoffWaiter = {
        settled: false,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      }
      handoff.waiter = waiter
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
      if (state.handoff !== handoff) {
        return
      }
      if (!state.active) {
        this.resolveHandoffAfterActiveRelease(key, state, handoff)
      }
    })
  }

  private resolveHandoffAfterActiveRelease(
    key: string,
    state: OwnerGateState,
    handoff: PendingHandoff
  ): void {
    if (state.handoff !== handoff || handoff.tokenIssued) return
    if (state.active) {
      throw new Error(
        "Projection attempt handoff resolved before active lease release"
      )
    }

    const waiter = handoff.waiter
    if (!waiter) {
      return
    }
    handoff.waiter = undefined
    waiter.settled = true
    waiter.removeAbortListener()
    waiter.resolve(this.createHandoffToken(key, state, handoff))
  }

  private createHandoffToken(
    key: string,
    state: OwnerGateState,
    handoff: PendingHandoff
  ): ProjectionAttemptHandoffToken {
    if (state.handoff !== handoff) {
      throw new Error("Projection attempt handoff is no longer current")
    }
    if (state.active) {
      throw new Error(
        "Projection attempt handoff token requires no active lease"
      )
    }
    if (handoff.tokenIssued) {
      throw new Error(
        "Projection attempt handoff token has already been issued"
      )
    }
    handoff.tokenIssued = true

    let terminalAction: "complete" | "abort" | undefined
    const close = (action: "complete" | "abort"): void => {
      if (terminalAction) {
        throw new Error(
          `Projection attempt handoff token has already been ${terminalAction}`
        )
      }
      if (state.handoff !== handoff) {
        throw new Error("Projection attempt handoff token is no longer current")
      }
      terminalAction = action
      state.handoff = undefined
      this.settleHandoffOutcome(
        handoff,
        action === "complete" ? "completed" : "aborted"
      )
      this.admitNextQueuedAttempt(key, state)
    }

    return Object.freeze({
      complete: () => close("complete"),
      abort: () => close("abort"),
    })
  }

  private settleHandoffOutcome(
    handoff: PendingHandoff,
    outcome: ProjectionAttemptHandoffOutcome
  ): void {
    if (handoff.outcomeSettled) return
    handoff.outcomeSettled = true
    handoff.resolveOutcome(outcome)
  }

  private deleteStateIfIdle(key: string, state: OwnerGateState): void {
    if (state.active || state.handoff || state.queue.length > 0) return
    if (this.states.get(key) === state) {
      this.states.delete(key)
    }
  }
}

function assertAbortSignal(signal: AbortSignal, operation: string): void {
  if (
    !signal ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new Error(`${operation}: AbortSignal is required`)
  }
}

function removeEntry<T>(entries: T[], entry: T): void {
  const index = entries.indexOf(entry)
  if (index >= 0) entries.splice(index, 1)
}

function rejected<T>(error: Error): Promise<T> {
  return Promise.reject(error)
}

function abortedError(operation: string): Error {
  const error = new Error(`${operation} was aborted`)
  error.name = "AbortError"
  return error
}

function drainingError(owner: ProjectionOwner): Error {
  return new ProjectionAttemptHandoffInProgressError(owner)
}

function describeOwner(owner: ProjectionOwner): string {
  return `${owner.conversationId}/${owner.ownerKey}`
}
