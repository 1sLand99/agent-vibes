import type {
  CodexInputItem,
  CodexNativeInputExecutionRequest,
  CodexProviderExecutionRequest,
} from "../../llm/openai/codex-native-types"
import type { ModelRouteResult } from "../../llm/shared/model-router.service"
import type { CreateMessageDto } from "../anthropic/dto/create-message.dto"
import type {
  ProviderPhysicalAttemptIdentity,
  ProviderPhysicalDispatchAbandonReason,
  ProviderPhysicalDispatchAcceptance,
  ProviderPhysicalDispatch,
  ProviderPhysicalDispatchLifecycle,
  ProviderPhysicalDispatchLifecycleState,
} from "../../llm/shared/provider-physical-dispatch"
import { requireExactDurableIdentifier } from "../../context/durable-identifier"
import type { TurnId } from "./turn/turn.types"

export interface BackendStreamHints {
  budgetOverride?: { maxTokens?: number }
  maxOutputTokensOverride?: number
}

/**
 * Cursor's logical candidate identity is also the shared physical-dispatch
 * identity. There is no second transport-local numbering scheme.
 */
export type ProviderAttemptIdentity = ProviderPhysicalAttemptIdentity

/**
 * Immutable authority fact attached to one prepared provider candidate.
 * Most root requests do not need one. Consumers that do (for example a
 * child worker's workspace authority) must construct it from the same
 * `ProviderAttemptIdentity`; the coordinator preserves that exact object
 * through the acceptance barrier.
 */
export interface ProviderAttemptRequestReceipt {
  readonly attempt: ProviderAttemptIdentity
}

/** Why an attempt that never reached its logical response boundary was discarded. */
export type ProviderAttemptAbandonReason = ProviderPhysicalDispatchAbandonReason

export type ProviderAttemptAcceptance = ProviderPhysicalDispatchAcceptance

/**
 * Hooks supplied by the request builder. They deliberately have no state of
 * their own: the coordinator owns the one authoritative lifecycle state
 * machine for the immutable attempt identity.
 */
export interface ProviderAttemptLifecycleHooks {
  /** Runs once immediately before the exact prepared request is dispatched. */
  activate(): void | Promise<void>
  /** Commits projection/ledger state once the attempt crosses its response boundary. */
  accept(input: ProviderAttemptAcceptance): void | Promise<void>
  /** Discards only state staged for an attempt that never crossed that boundary. */
  abandon(reason: ProviderAttemptAbandonReason): void | Promise<void>
}

export interface ProviderAttemptTurnOwnership {
  readonly topLevelTurnId: TurnId
  readonly graphTurnId: TurnId
}

export function assertProviderAttemptTurnOwnership(input: {
  readonly contextLabel: string
  readonly expected: ProviderAttemptTurnOwnership
  readonly current: Partial<ProviderAttemptTurnOwnership>
}): void {
  if (
    input.current.topLevelTurnId !== input.expected.topLevelTurnId ||
    input.current.graphTurnId !== input.expected.graphTurnId
  ) {
    throw new Error(
      `Prepared provider attempt belongs to a superseded turn (${input.contextLabel}): ` +
        `expected=${input.expected.topLevelTurnId}/${input.expected.graphTurnId}, ` +
        `active=${input.current.topLevelTurnId || "none"}/${input.current.graphTurnId || "none"}`
    )
  }
}

/**
 * Binds projection side effects to the root/graph turn that built them.
 * Superseded attempts may still be abandoned, but they can never activate or
 * accept against a newer turn's context state.
 */
export function bindProviderAttemptTurnOwnership(input: {
  readonly contextLabel: string
  readonly expected: ProviderAttemptTurnOwnership
  readonly resolveCurrent: () => Partial<ProviderAttemptTurnOwnership>
  readonly lifecycle: ProviderAttemptLifecycleHooks
}): ProviderAttemptLifecycleHooks {
  const assertCurrent = (): void => {
    assertProviderAttemptTurnOwnership({
      contextLabel: input.contextLabel,
      expected: input.expected,
      current: input.resolveCurrent(),
    })
  }
  return {
    activate: async () => {
      assertCurrent()
      await input.lifecycle.activate()
    },
    accept: async (acceptance) => {
      assertCurrent()
      await input.lifecycle.accept(acceptance)
    },
    abandon: (reason) => input.lifecycle.abandon(reason),
  }
}

export type ProviderAttemptLifecycleState =
  ProviderPhysicalDispatchLifecycleState

/**
 * The executor-facing lifecycle. `acceptanceStarted` is intentionally a
 * separate, monotonic barrier: once true, neither fallback nor abandon is
 * safe, including when durable acceptance itself reports an error.
 */
export interface ProviderAttemptLifecycle
  extends ProviderAttemptLifecycleHooks, ProviderPhysicalDispatchLifecycle {}

export const NOOP_PROVIDER_ATTEMPT_LIFECYCLE: ProviderAttemptLifecycleHooks =
  Object.freeze({
    activate: () => undefined,
    accept: () => undefined,
    abandon: () => undefined,
  })

/** Exact immutable metrics from the candidate that is actually dispatched. */
export interface ProviderAttemptProjection {
  /** Exact provider-input count used by the compaction pressure gate. */
  readonly tokenCount: number
}

export interface CodexProviderAttemptProjection extends ProviderAttemptProjection {
  /** Exact V2-native prompt before any compaction trigger is appended. */
  readonly nativeInput: readonly CodexInputItem[]
}

/**
 * Builder output before the coordinator binds the hooks to an attempt state
 * machine. The builder must not mutate durable projection state while making
 * this value; its hooks own the later state transition.
 */
export type ProviderRequestCandidate =
  | {
      readonly kind: "standard"
      readonly attempt: ProviderAttemptIdentity
      readonly request: Readonly<CreateMessageDto>
      readonly projection: ProviderAttemptProjection
      readonly lifecycle: ProviderAttemptLifecycleHooks
      readonly receipt?: ProviderAttemptRequestReceipt
    }
  | {
      readonly kind: "codex"
      readonly attempt: ProviderAttemptIdentity
      readonly request: Readonly<CodexNativeInputExecutionRequest>
      readonly projection: CodexProviderAttemptProjection
      readonly lifecycle: ProviderAttemptLifecycleHooks
      readonly receipt?: ProviderAttemptRequestReceipt
    }

/**
 * Coordinator output. Only this type is allowed to reach the backend stream:
 * its lifecycle is tied to one immutable attempt identity and cannot be
 * committed or abandoned twice.
 */
export type PreparedProviderRequest =
  | {
      readonly kind: "standard"
      readonly attempt: ProviderAttemptIdentity
      readonly request: Readonly<CreateMessageDto>
      readonly projection: ProviderAttemptProjection
      readonly lifecycle: ProviderAttemptLifecycle
      readonly receipt?: ProviderAttemptRequestReceipt
    }
  | {
      readonly kind: "codex"
      readonly attempt: ProviderAttemptIdentity
      readonly request: Readonly<CodexNativeInputExecutionRequest>
      readonly projection: CodexProviderAttemptProjection
      readonly lifecycle: ProviderAttemptLifecycle
      readonly receipt?: ProviderAttemptRequestReceipt
    }

export function asProviderPhysicalDispatch<TRequest extends object>(input: {
  readonly attempt: ProviderAttemptIdentity
  readonly request: Readonly<TRequest>
  readonly lifecycle: ProviderAttemptLifecycle
}): ProviderPhysicalDispatch<TRequest> {
  return Object.freeze({
    attempt: input.attempt,
    request: input.request,
    lifecycle: input.lifecycle,
  })
}

export type ProviderRequestPreparer = (
  route: ModelRouteResult,
  hints: BackendStreamHints | undefined,
  attempt: ProviderAttemptIdentity,
  /**
   * Owned by this exact provider attempt. Builders must observe it while
   * preparing expensive candidate projections so a consumer close cannot
   * leave an undispatched candidate alive behind a pending preparation.
   */
  signal: AbortSignal
) => Promise<ProviderRequestCandidate> | ProviderRequestCandidate

class ProviderAttemptLifecycleTransitionError extends Error {
  constructor(
    attempt: ProviderAttemptIdentity,
    action: string,
    state: ProviderAttemptLifecycleState
  ) {
    super(
      `Cannot ${action} provider attempt ${attempt.scope}#${attempt.ordinal} while lifecycle is ${state}`
    )
  }
}

function rejected<T>(error: Error): Promise<T> {
  return Promise.reject(error)
}

function normalizeAcceptance(
  input: ProviderAttemptAcceptance
): ProviderAttemptAcceptance {
  const responseId = input.responseId
  if (responseId === undefined) {
    return Object.freeze({})
  }
  return Object.freeze({
    responseId: requireExactDurableIdentifier(
      responseId,
      "Provider attempt acceptance responseId"
    ),
  })
}

function sameAcceptance(
  left: ProviderAttemptAcceptance,
  right: ProviderAttemptAcceptance
): boolean {
  return left.responseId === right.responseId
}

function isAbandonReason(value: string): value is ProviderAttemptAbandonReason {
  return (
    value === "reactive_retry" ||
    value === "backend_fallback" ||
    value === "transport_error" ||
    value === "aborted" ||
    value === "consumer_cancelled"
  )
}

function cloneAndFreezeProviderRequest<T>(value: T, contextLabel: string): T {
  let clone: T
  try {
    clone = structuredClone(value)
  } catch (error) {
    throw new Error(
      `Prepared provider request is not cloneable (${contextLabel})`,
      {
        cause: error,
      }
    )
  }
  return freezeProviderRequestValue(clone, contextLabel, new WeakSet())
}

function freezeProviderRequestValue<T>(
  value: T,
  contextLabel: string,
  ancestors: WeakSet<object>
): T {
  if (value === null || typeof value !== "object") return value
  const objectValue = value as object
  if (ancestors.has(objectValue)) {
    throw new Error(
      `Prepared provider request must not contain circular data (${contextLabel})`
    )
  }
  const prototype = Object.getPrototypeOf(objectValue) as unknown
  if (
    prototype !== Object.prototype &&
    prototype !== Array.prototype &&
    prototype !== null
  ) {
    throw new Error(
      `Prepared provider request must contain only plain JSON containers (${contextLabel})`
    )
  }
  ancestors.add(objectValue)
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeProviderRequestValue(child, contextLabel, ancestors)
  }
  ancestors.delete(objectValue)
  return Object.freeze(value)
}

function freezeProjection(
  candidate: ProviderRequestCandidate,
  frozenRequest:
    | Readonly<CreateMessageDto>
    | Readonly<CodexProviderExecutionRequest>
): ProviderAttemptProjection | CodexProviderAttemptProjection {
  const tokenCount = candidate.projection.tokenCount
  if (!Number.isSafeInteger(tokenCount) || tokenCount < 0) {
    throw new Error(
      `Prepared provider projection has a non-negative safe integer token count requirement for ${candidate.attempt.backend}/${candidate.attempt.model}`
    )
  }

  if (candidate.kind !== "codex") {
    return Object.freeze({ tokenCount })
  }

  if (!Array.isArray(candidate.projection.nativeInput)) {
    throw new Error(
      `Prepared Codex request has no native input projection (${candidate.attempt.model})`
    )
  }
  if (
    !("nativeInput" in frozenRequest) ||
    !Array.isArray(frozenRequest.nativeInput)
  ) {
    throw new Error(
      `Prepared Codex request has no native input payload (${candidate.attempt.model})`
    )
  }
  if (candidate.request.nativeInput !== candidate.projection.nativeInput) {
    throw new Error(
      `Prepared Codex request and projection must share one native input source (${candidate.attempt.model})`
    )
  }
  return Object.freeze({
    tokenCount,
    nativeInput: frozenRequest.nativeInput,
  })
}

function assertLifecycleHooks(
  hooks: ProviderAttemptLifecycleHooks,
  attempt: ProviderAttemptIdentity
): void {
  if (
    !hooks ||
    typeof hooks.activate !== "function" ||
    typeof hooks.accept !== "function" ||
    typeof hooks.abandon !== "function"
  ) {
    throw new Error(
      `Prepared provider request has an invalid lifecycle for ${attempt.backend}/${attempt.model}`
    )
  }
}

function createLifecycle(
  attempt: ProviderAttemptIdentity,
  hooks: ProviderAttemptLifecycleHooks
): ProviderAttemptLifecycle {
  let state: ProviderAttemptLifecycleState = "pending"
  let activation: Promise<void> | undefined
  let acceptance: Promise<void> | undefined
  let abandonment: Promise<void> | undefined
  let acceptedInput: ProviderAttemptAcceptance | undefined
  let abandonedReason: ProviderAttemptAbandonReason | undefined

  const lifecycle: ProviderAttemptLifecycle = {
    get state(): ProviderAttemptLifecycleState {
      return state
    },
    get acceptanceStarted(): boolean {
      return (
        state === "accepting" ||
        state === "accepted" ||
        state === "accept_failed"
      )
    },
    activate(): Promise<void> {
      switch (state) {
        case "pending": {
          state = "activating"
          activation = Promise.resolve()
            .then(() => hooks.activate())
            .then(
              () => {
                state = "active"
              },
              (error: unknown) => {
                state = "activation_failed"
                throw error
              }
            )
          return activation
        }
        case "activating":
          return activation!
        case "active":
          return Promise.resolve()
        case "activation_failed":
          return activation!
        default:
          return rejected(
            new ProviderAttemptLifecycleTransitionError(
              attempt,
              "activate",
              state
            )
          )
      }
    },
    accept(input: ProviderAttemptAcceptance): Promise<void> {
      switch (state) {
        case "active": {
          let normalized: ProviderAttemptAcceptance
          state = "accepting"
          try {
            normalized = normalizeAcceptance(input)
          } catch (error) {
            state = "accept_failed"
            acceptance = rejected(error as Error)
            return acceptance
          }
          acceptedInput = normalized
          acceptance = Promise.resolve()
            .then(() => hooks.accept(normalized))
            .then(
              () => {
                state = "accepted"
              },
              (error: unknown) => {
                state = "accept_failed"
                throw error
              }
            )
          return acceptance
        }
        case "accepting":
        case "accepted":
        case "accept_failed": {
          let normalized: ProviderAttemptAcceptance
          try {
            normalized = normalizeAcceptance(input)
          } catch (error) {
            return rejected(error as Error)
          }
          if (!acceptedInput || !sameAcceptance(acceptedInput, normalized)) {
            return rejected(
              new Error(
                `Provider attempt ${attempt.scope}#${attempt.ordinal} received conflicting acceptance identities`
              )
            )
          }
          return acceptance ?? Promise.resolve()
        }
        default:
          return rejected(
            new ProviderAttemptLifecycleTransitionError(
              attempt,
              "accept",
              state
            )
          )
      }
    },
    abandon(reason: ProviderAttemptAbandonReason): Promise<void> {
      if (!isAbandonReason(reason)) {
        return rejected(
          new Error(
            `Unknown provider attempt abandon reason: ${String(reason)}`
          )
        )
      }

      switch (state) {
        case "activating":
          return activation!.then(
            () => lifecycle.abandon(reason),
            () => lifecycle.abandon(reason)
          )
        case "pending":
        case "active":
        case "activation_failed": {
          state = "abandoning"
          abandonedReason = reason
          abandonment = Promise.resolve()
            .then(() => hooks.abandon(reason))
            .then(
              () => {
                state = "abandoned"
              },
              (error: unknown) => {
                state = "abandon_failed"
                throw error
              }
            )
          return abandonment
        }
        case "abandoning":
        case "abandoned":
        case "abandon_failed":
          if (abandonedReason !== reason) {
            return rejected(
              new Error(
                `Provider attempt ${attempt.scope}#${attempt.ordinal} received conflicting abandon reasons`
              )
            )
          }
          return abandonment ?? Promise.resolve()
        case "accepting":
        case "accepted":
        case "accept_failed":
          return rejected(
            new Error(
              `Cannot abandon provider attempt ${attempt.scope}#${attempt.ordinal} after accept started`
            )
          )
      }
    },
  }

  return Object.freeze(lifecycle)
}

/**
 * Creates one immutable identity and invokes the request builder exactly once
 * for each transport attempt. The coordinator is shared by the stream service,
 * so reactive retries, backend switches and higher-level retries cannot reuse
 * an ordinal or accidentally return a request built for another attempt. The
 * attempt-owned signal is checked on both sides of preparation so a cancelled
 * candidate can never cross into transport dispatch.
 */
export class ProviderAttemptCoordinator {
  private nextOrdinal = 0

  async prepare(
    scope: string,
    route: ModelRouteResult,
    hints: BackendStreamHints | undefined,
    prepareRequest: ProviderRequestPreparer,
    signal: AbortSignal
  ): Promise<PreparedProviderRequest> {
    const attempt: ProviderAttemptIdentity = Object.freeze({
      scope,
      ordinal: ++this.nextOrdinal,
      backend: route.backend,
      model: route.model,
      budgetOverrideMaxTokens: hints?.budgetOverride?.maxTokens,
      maxOutputTokensOverride: hints?.maxOutputTokensOverride,
    })
    signal.throwIfAborted()
    const candidate = await prepareRequest(route, hints, attempt, signal)
    signal.throwIfAborted()
    if (candidate.attempt !== attempt) {
      throw new Error(
        `Provider request preparation returned a mismatched attempt identity for ${route.backend}/${route.model}`
      )
    }
    if (
      (route.backend === "codex" && candidate.kind !== "codex") ||
      (route.backend !== "codex" && candidate.kind !== "standard")
    ) {
      throw new Error(
        `Prepared ${candidate.kind} request does not match ${route.backend} backend (${route.model})`
      )
    }
    assertLifecycleHooks(candidate.lifecycle, attempt)
    if (candidate.receipt) {
      if (candidate.receipt.attempt !== attempt) {
        throw new Error(
          `Provider request receipt does not belong to ${route.backend}/${route.model}`
        )
      }
      if (!Object.isFrozen(candidate.receipt)) {
        throw new Error(
          `Provider request receipt must be immutable for ${route.backend}/${route.model}`
        )
      }
    }
    const lifecycle = createLifecycle(attempt, candidate.lifecycle)
    const request = cloneAndFreezeProviderRequest(
      candidate.request,
      `${attempt.backend}/${attempt.model}`
    )
    const projection = freezeProjection(candidate, request)

    if (candidate.kind === "codex") {
      return Object.freeze({
        kind: "codex" as const,
        attempt,
        request: request as Readonly<CodexNativeInputExecutionRequest>,
        projection: projection as CodexProviderAttemptProjection,
        lifecycle,
        ...(candidate.receipt ? { receipt: candidate.receipt } : {}),
      })
    }
    return Object.freeze({
      kind: "standard" as const,
      attempt,
      request: request as Readonly<CreateMessageDto>,
      projection: projection as ProviderAttemptProjection,
      lifecycle,
      ...(candidate.receipt ? { receipt: candidate.receipt } : {}),
    })
  }
}
