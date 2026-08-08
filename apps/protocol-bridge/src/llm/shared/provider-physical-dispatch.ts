import type { BackendErrorClass } from "./backend-error-class"
import { BackendApiError } from "./backend-errors"
import type { BackendType } from "./model-router.service"

const DEFAULT_PROVIDER_PHYSICAL_PRE_ACCEPTANCE_BUFFER_LIMIT = 64
/**
 * A clean close before the declared response boundary has no usable output,
 * so one fresh physical attempt is permitted. This is deliberately a shared
 * contract constant rather than a provider retry-policy dependency.
 */
export const DEFAULT_INCOMPLETE_STREAM_PHYSICAL_RETRIES = 1

/**
 * Identity owned by exactly one physical upstream dispatch.  It is deliberately
 * independent of a provider's account, worker, endpoint, or wire transport:
 * those are selected once by the provider when this identity is dispatched.
 * A retry always receives a new ordinal and therefore a new immutable request.
 */
export interface ProviderPhysicalAttemptIdentity {
  readonly scope: string
  readonly ordinal: number
  readonly backend: BackendType
  readonly model: string
  readonly budgetOverrideMaxTokens?: number
  readonly maxOutputTokensOverride?: number
}

export type ProviderPhysicalDispatchAbandonReason =
  | "reactive_retry"
  | "backend_fallback"
  | "transport_error"
  | "aborted"
  | "consumer_cancelled"

export interface ProviderPhysicalDispatchAcceptance {
  readonly responseId?: string
}

/**
 * One monotonic lifecycle shared by stateless callers and Cursor's durable
 * projection lifecycle. Provider services may dispatch only while `active`.
 */
export type ProviderPhysicalDispatchLifecycleState =
  | "pending"
  | "activating"
  | "active"
  | "activation_failed"
  | "accepting"
  | "accepted"
  | "accept_failed"
  | "abandoning"
  | "abandoned"
  | "abandon_failed"

/**
 * The physical contract owns an explicit terminal choice. A failed transport
 * attempt is abandoned; an attempt that crosses its response boundary is
 * accepted. Neither transition may be silently replaced by a resend.
 */
export interface ProviderPhysicalDispatchLifecycle {
  readonly state: ProviderPhysicalDispatchLifecycleState
  readonly acceptanceStarted: boolean
  activate(): void | Promise<void>
  accept(input: ProviderPhysicalDispatchAcceptance): void | Promise<void>
  abandon(reason: ProviderPhysicalDispatchAbandonReason): void | Promise<void>
}

/**
 * The only input a provider transport may receive for a model request.
 * The request is produced by the attempt owner, deep-frozen before dispatch,
 * and remains bound to one physical attempt identity for its whole lifetime.
 */
export interface ProviderPhysicalDispatch<TRequest extends object> {
  readonly attempt: ProviderPhysicalAttemptIdentity
  readonly request: Readonly<TRequest>
  readonly lifecycle: ProviderPhysicalDispatchLifecycle
}

/**
 * A stable logical request for a stateless caller. The runner snapshots this
 * input before the first send, then gives every physical retry a new deep
 * clone, identity, and lifecycle. Stateful turn owners such as Cursor use
 * their own coordinator because their request candidate is intentionally
 * rebuilt from the current projection on each ordinal.
 */
export interface ProviderPhysicalDispatchPlan<TRequest extends object> {
  readonly scope: string
  readonly backend: BackendType
  readonly model: string
  readonly request: TRequest
  readonly budgetOverrideMaxTokens?: number
  readonly maxOutputTokensOverride?: number
}

/**
 * One stateless outer owner for physical retry. Providers only execute the
 * dispatch passed to `execute`; they never select a second transport or send
 * the request again. A stream collector may call `dispatch.lifecycle.accept`
 * itself at its semantic response boundary. For ordinary one-shot responses,
 * `accept` is invoked after `execute` resolves.
 */
export interface RunProviderPhysicalDispatchInput<
  TRequest extends object,
  TResult,
> {
  readonly plan: ProviderPhysicalDispatchPlan<TRequest>
  readonly signal?: AbortSignal
  readonly coordinator?: ProviderPhysicalDispatchCoordinator
  /** Hard cap including the initial physical dispatch. */
  readonly maxAttempts?: number
  readonly execute: (
    dispatch: ProviderPhysicalDispatch<TRequest>
  ) => Promise<TResult>
  readonly accept?: (
    dispatch: ProviderPhysicalDispatch<TRequest>,
    result: TResult
  ) =>
    | ProviderPhysicalDispatchAcceptance
    | Promise<ProviderPhysicalDispatchAcceptance>
  readonly onRetry?: (input: {
    readonly failedDispatch: ProviderPhysicalDispatch<TRequest>
    readonly error: ProviderAttemptRetryableError
    /** 1 for the first retry after the first physical dispatch. */
    readonly retryOrdinal: number
  }) => void | Promise<void>
}

/**
 * Streaming form of the stateless attempt owner. The caller declares the
 * semantic response boundary instead of relying on transport frame shape:
 * envelopes can remain retryable, while the first accepted value is marked
 * before it is yielded to the consumer.
 */
export interface RunProviderPhysicalDispatchStreamInput<
  TRequest extends object,
  TValue,
> {
  readonly plan: ProviderPhysicalDispatchPlan<TRequest>
  readonly signal?: AbortSignal
  readonly coordinator?: ProviderPhysicalDispatchCoordinator
  /** Hard cap including the initial physical dispatch. */
  readonly maxAttempts?: number
  /**
   * A protocol-level bound for envelopes retained before the response
   * boundary. Values are never exposed to consumers before acceptance.
   */
  readonly maxPreAcceptanceValues?: number
  readonly execute: (
    dispatch: ProviderPhysicalDispatch<TRequest>
  ) => AsyncIterable<TValue>
  readonly acceptanceForValue?: (
    dispatch: ProviderPhysicalDispatch<TRequest>,
    value: TValue
  ) =>
    | ProviderPhysicalDispatchAcceptance
    | undefined
    | Promise<ProviderPhysicalDispatchAcceptance | undefined>
  /**
   * Used only by protocols whose successful terminal frame is an acceptance
   * boundary even when no prior frame qualified. Without this callback an
   * empty stream fails closed instead of being silently accepted.
   */
  readonly acceptanceOnComplete?: (
    dispatch: ProviderPhysicalDispatch<TRequest>
  ) =>
    | ProviderPhysicalDispatchAcceptance
    | undefined
    | Promise<ProviderPhysicalDispatchAcceptance | undefined>
  readonly onRetry?: (input: {
    readonly failedDispatch: ProviderPhysicalDispatch<TRequest>
    readonly error: ProviderAttemptRetryableError
    readonly retryOrdinal: number
  }) => void | Promise<void>
}

/**
 * Stateless callers (CC Messages, remote compaction, and other one-shot
 * operations) use this coordinator instead of inventing a transport-local
 * retry loop. Each call clones and freezes the canonical request before it
 * can reach a provider; a retry calls `prepare` again and receives a new
 * monotonic identity.
 */
export class ProviderPhysicalDispatchCoordinator {
  private nextOrdinal = 0

  prepare<TRequest extends object>(input: {
    readonly scope: string
    readonly backend: BackendType
    readonly model: string
    readonly request: TRequest
    readonly budgetOverrideMaxTokens?: number
    readonly maxOutputTokensOverride?: number
  }): ProviderPhysicalDispatch<TRequest> {
    const scope = input.scope
    const model = input.model
    if (
      !isExactNonEmptyIdentifier(scope) ||
      !isExactNonEmptyIdentifier(model)
    ) {
      throw new Error(
        "Physical provider dispatch requires a non-empty scope and model"
      )
    }
    const attempt = Object.freeze({
      scope,
      ordinal: ++this.nextOrdinal,
      backend: input.backend,
      model,
      ...(input.budgetOverrideMaxTokens === undefined
        ? {}
        : { budgetOverrideMaxTokens: input.budgetOverrideMaxTokens }),
      ...(input.maxOutputTokensOverride === undefined
        ? {}
        : { maxOutputTokensOverride: input.maxOutputTokensOverride }),
    })
    const request = cloneAndFreezePhysicalRequest(
      input.request,
      `${input.backend}/${model}`
    )
    return Object.freeze({
      attempt,
      request,
      lifecycle: createPhysicalDispatchLifecycle(attempt),
    })
  }
}

/**
 * Drives stateless callers through the one permitted retry sequence. It is
 * intentionally outside provider services: `execute` receives exactly one
 * dispatch and can only report that a new one is needed. Once acceptance has
 * started, every error is terminal for this logical operation.
 */
export async function runProviderPhysicalDispatch<
  TRequest extends object,
  TResult,
>(
  input: RunProviderPhysicalDispatchInput<TRequest, TResult>
): Promise<TResult> {
  const coordinator =
    input.coordinator ?? new ProviderPhysicalDispatchCoordinator()
  const canonicalRequest = cloneAndFreezePhysicalRequest(
    input.plan.request,
    `${input.plan.backend}/${input.plan.model}`
  )
  const maxAttempts = normalizeMaxAttempts(input.maxAttempts)
  let attemptCount = 0
  let retryCount = 0

  for (;;) {
    input.signal?.throwIfAborted()
    attemptCount += 1
    const dispatch = coordinator.prepare({
      scope: input.plan.scope,
      backend: input.plan.backend,
      model: input.plan.model,
      request: canonicalRequest,
      budgetOverrideMaxTokens: input.plan.budgetOverrideMaxTokens,
      maxOutputTokensOverride: input.plan.maxOutputTokensOverride,
    })
    await dispatch.lifecycle.activate()

    try {
      const result = await input.execute(dispatch)
      if (!dispatch.lifecycle.acceptanceStarted) {
        const acceptance = input.accept
          ? await input.accept(dispatch, result)
          : {}
        await dispatch.lifecycle.accept(acceptance)
      }
      return result
    } catch (error) {
      if (dispatch.lifecycle.acceptanceStarted) {
        throw error
      }

      const abandonReason = input.signal?.aborted
        ? "aborted"
        : "transport_error"
      await dispatch.lifecycle.abandon(abandonReason)
      if (
        !isProviderAttemptRetryableError(error) ||
        input.signal?.aborted ||
        (maxAttempts !== undefined && attemptCount >= maxAttempts) ||
        retryCount >= error.maxRetries
      ) {
        throw error
      }

      retryCount += 1
      await input.onRetry?.({
        failedDispatch: dispatch,
        error,
        retryOrdinal: retryCount,
      })
      await waitForProviderPhysicalRetry(error.retryAfterMs, input.signal)
    }
  }
}

/**
 * Relay a stateless provider stream with a bounded pre-acceptance envelope
 * buffer. Each retry starts with a new dispatch and can happen only before
 * `acceptanceForValue` (or the explicitly declared terminal boundary) crosses
 * the lifecycle barrier; consumers never observe an abandoned envelope.
 */
export async function* runProviderPhysicalDispatchStream<
  TRequest extends object,
  TValue,
>(
  input: RunProviderPhysicalDispatchStreamInput<TRequest, TValue>
): AsyncGenerator<TValue, void, unknown> {
  const coordinator =
    input.coordinator ?? new ProviderPhysicalDispatchCoordinator()
  const canonicalRequest = cloneAndFreezePhysicalRequest(
    input.plan.request,
    `${input.plan.backend}/${input.plan.model}`
  )
  const maxAttempts = normalizeMaxAttempts(input.maxAttempts)
  const maxPreAcceptanceValues = normalizePreAcceptanceBufferLimit(
    input.maxPreAcceptanceValues
  )
  let attemptCount = 0
  let retryCount = 0

  for (;;) {
    input.signal?.throwIfAborted()
    attemptCount += 1
    const dispatch = coordinator.prepare({
      scope: input.plan.scope,
      backend: input.plan.backend,
      model: input.plan.model,
      request: canonicalRequest,
      budgetOverrideMaxTokens: input.plan.budgetOverrideMaxTokens,
      maxOutputTokensOverride: input.plan.maxOutputTokensOverride,
    })
    let terminal = false
    let abandoned = false
    let preAcceptanceValues: TValue[] = []
    await dispatch.lifecycle.activate()

    try {
      for await (const value of input.execute(dispatch)) {
        if (!dispatch.lifecycle.acceptanceStarted && input.acceptanceForValue) {
          const acceptance = await input.acceptanceForValue(dispatch, value)
          if (acceptance !== undefined) {
            // Do this before `yield`: a consumer can close the iterator while
            // it is suspended at that yield, and must never reopen fallback.
            await dispatch.lifecycle.accept(acceptance)
            for (const bufferedValue of preAcceptanceValues) {
              yield bufferedValue
            }
            preAcceptanceValues = []
          } else {
            if (preAcceptanceValues.length >= maxPreAcceptanceValues) {
              throw new Error(
                `Provider stream exceeded the pre-acceptance envelope limit (${maxPreAcceptanceValues}) for ${dispatch.attempt.backend}/${dispatch.attempt.model}`
              )
            }
            preAcceptanceValues.push(value)
            continue
          }
        }
        yield value
      }

      if (!dispatch.lifecycle.acceptanceStarted && input.acceptanceOnComplete) {
        const acceptance = await input.acceptanceOnComplete(dispatch)
        if (acceptance !== undefined) {
          await dispatch.lifecycle.accept(acceptance)
          for (const bufferedValue of preAcceptanceValues) {
            yield bufferedValue
          }
          preAcceptanceValues = []
        }
      }
      if (!dispatch.lifecycle.acceptanceStarted) {
        throw new ProviderAttemptRetryableError(
          `Provider stream completed before its response boundary (${dispatch.attempt.backend}/${dispatch.attempt.model})`,
          {
            backend: dispatch.attempt.backend,
            errorClass: "transient_network",
            maxRetries: DEFAULT_INCOMPLETE_STREAM_PHYSICAL_RETRIES,
          }
        )
      }
      terminal = true
      return
    } catch (error) {
      if (dispatch.lifecycle.acceptanceStarted) {
        throw error
      }

      const abandonReason = input.signal?.aborted
        ? "aborted"
        : "transport_error"
      preAcceptanceValues = []
      await dispatch.lifecycle.abandon(abandonReason)
      abandoned = true
      if (
        !isProviderAttemptRetryableError(error) ||
        input.signal?.aborted ||
        (maxAttempts !== undefined && attemptCount >= maxAttempts) ||
        retryCount >= error.maxRetries
      ) {
        throw error
      }

      retryCount += 1
      await input.onRetry?.({
        failedDispatch: dispatch,
        error,
        retryOrdinal: retryCount,
      })
      await waitForProviderPhysicalRetry(error.retryAfterMs, input.signal)
    } finally {
      if (!terminal && !abandoned && !dispatch.lifecycle.acceptanceStarted) {
        await dispatch.lifecycle.abandon(
          input.signal?.aborted ? "aborted" : "consumer_cancelled"
        )
      }
    }
  }
}

/**
 * Provider-owned retry result for an already-failed physical dispatch.
 *
 * This is not a transport loop. It records that the service has finished one
 * account/worker/endpoint/transport selection and that its caller may create
 * a new attempt. The caller must abandon the current lifecycle and rebuild a
 * candidate before sending again.
 */
export class ProviderAttemptRetryableError extends BackendApiError {
  readonly retryAfterMs?: number
  readonly maxRetries: number
  readonly nextTransport?: "http"

  constructor(
    message: string,
    options: {
      backend: BackendType
      errorClass: BackendErrorClass
      statusCode?: number
      retryAfterMs?: number
      maxRetries: number
      nextTransport?: "http"
      actualTokens?: number
      maxTokens?: number
    }
  ) {
    const retryAfterMs = normalizeRetryAfterMs(options.retryAfterMs)
    super(message, {
      backend: options.backend,
      statusCode: options.statusCode,
      retryAfterSeconds:
        retryAfterMs === undefined ? undefined : Math.ceil(retryAfterMs / 1000),
      errorClass: options.errorClass,
      actualTokens: options.actualTokens,
      maxTokens: options.maxTokens,
    })
    this.name = "ProviderAttemptRetryableError"
    this.retryAfterMs = retryAfterMs
    this.maxRetries = normalizeMaxRetries(options.maxRetries)
    this.nextTransport = options.nextTransport
  }
}

export function isProviderAttemptRetryableError(
  error: unknown
): error is ProviderAttemptRetryableError {
  return error instanceof ProviderAttemptRetryableError
}

/** Runtime boundary shared by Cursor, CC Messages, and one-shot runners. */
export function assertProviderPhysicalDispatch<TRequest extends object>(input: {
  readonly dispatch: ProviderPhysicalDispatch<TRequest>
  readonly backend: BackendType
  readonly label: string
}): void {
  const { attempt, request, lifecycle } = input.dispatch
  if (!attempt || typeof attempt !== "object") {
    throw new Error(`${input.label} requires a physical provider attempt`)
  }
  if (!Object.isFrozen(attempt)) {
    throw new Error(
      `${input.label} physical provider attempt must be immutable`
    )
  }
  if (
    !isExactNonEmptyIdentifier(attempt.scope) ||
    !Number.isSafeInteger(attempt.ordinal) ||
    attempt.ordinal < 1 ||
    attempt.backend !== input.backend ||
    !isExactNonEmptyIdentifier(attempt.model)
  ) {
    throw new Error(`${input.label} has an invalid physical provider attempt`)
  }
  if (
    !request ||
    typeof request !== "object" ||
    !isDeepFrozenPlainRequest(request, new WeakSet())
  ) {
    throw new Error(`${input.label} requires an immutable provider request`)
  }
  if (
    !lifecycle ||
    !Object.isFrozen(lifecycle) ||
    !isProviderPhysicalDispatchLifecycleState(lifecycle.state) ||
    typeof lifecycle.activate !== "function" ||
    typeof lifecycle.accept !== "function" ||
    typeof lifecycle.abandon !== "function" ||
    typeof lifecycle.acceptanceStarted !== "boolean"
  ) {
    throw new Error(`${input.label} requires a physical dispatch lifecycle`)
  }
  if (lifecycle.state !== "active") {
    throw new Error(`${input.label} requires an activated physical dispatch`)
  }
}

async function waitForProviderPhysicalRetry(
  delayMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!delayMs) {
    signal?.throwIfAborted()
    return
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      clearTimeout(timeout)
      callback()
    }
    const onAbort = (): void =>
      finish(() => {
        const reason = signal?.reason as unknown
        reject(
          reason instanceof Error
            ? reason
            : new Error("Provider retry aborted", { cause: reason })
        )
      })
    const timeout = setTimeout(() => finish(resolve), delayMs)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function createPhysicalDispatchLifecycle(
  attempt: ProviderPhysicalAttemptIdentity
): ProviderPhysicalDispatchLifecycle {
  let state: ProviderPhysicalDispatchLifecycleState = "pending"
  const transitionError = (action: string): Error =>
    new Error(
      `Cannot ${action} physical provider attempt ${attempt.scope}#${attempt.ordinal} while ${state}`
    )
  return Object.freeze({
    get state(): ProviderPhysicalDispatchLifecycleState {
      return state
    },
    get acceptanceStarted(): boolean {
      return (
        state === "accepting" ||
        state === "accepted" ||
        state === "accept_failed"
      )
    },
    activate(): void {
      if (state === "pending") {
        state = "activating"
        state = "active"
        return
      }
      if (state === "active") return
      throw transitionError("activate")
    },
    accept(input: ProviderPhysicalDispatchAcceptance): void {
      if (state !== "active") throw transitionError("accept")
      // The barrier is set before validation so malformed/failed acceptance
      // cannot be reclassified as a transport error and replayed.
      state = "accepting"
      try {
        if (
          input.responseId !== undefined &&
          !isExactNonEmptyIdentifier(input.responseId)
        ) {
          throw new Error(
            "Physical provider acceptance responseId must be non-empty"
          )
        }
        state = "accepted"
      } catch (error) {
        state = "accept_failed"
        throw error
      }
    },
    abandon(_reason: ProviderPhysicalDispatchAbandonReason): void {
      if (state !== "pending" && state !== "active") {
        throw transitionError("abandon")
      }
      state = "abandoned"
    },
  })
}

function isProviderPhysicalDispatchLifecycleState(
  value: unknown
): value is ProviderPhysicalDispatchLifecycleState {
  return (
    value === "pending" ||
    value === "activating" ||
    value === "active" ||
    value === "activation_failed" ||
    value === "accepting" ||
    value === "accepted" ||
    value === "accept_failed" ||
    value === "abandoning" ||
    value === "abandoned" ||
    value === "abandon_failed"
  )
}

function isExactNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim()
}

function isDeepFrozenPlainRequest(
  value: unknown,
  ancestors: WeakSet<object>
): boolean {
  if (value === null || typeof value !== "object") return true
  if (ancestors.has(value)) return false
  if (!Object.isFrozen(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  if (
    prototype !== Object.prototype &&
    prototype !== Array.prototype &&
    prototype !== null
  ) {
    return false
  }
  ancestors.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (!isDeepFrozenPlainRequest(child, ancestors)) {
      return false
    }
  }
  ancestors.delete(value)
  return true
}

function normalizeRetryAfterMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Provider retry delay must be a non-negative safe integer")
  }
  return value
}

function cloneAndFreezePhysicalRequest<TRequest extends object>(
  request: TRequest,
  label: string
): Readonly<TRequest> {
  let clone: TRequest
  try {
    clone = structuredClone(request)
  } catch (error) {
    throw new Error(`Physical provider request is not cloneable (${label})`, {
      cause: error,
    })
  }
  return freezePhysicalRequestValue(clone, label, new WeakSet())
}

function freezePhysicalRequestValue<TRequest>(
  value: TRequest,
  label: string,
  ancestors: WeakSet<object>
): TRequest {
  if (value === null || typeof value !== "object") return value
  if (ancestors.has(value)) {
    throw new Error(
      `Physical provider request must not contain cycles (${label})`
    )
  }
  const prototype = Object.getPrototypeOf(value) as object | null
  if (
    prototype !== Object.prototype &&
    prototype !== Array.prototype &&
    prototype !== null
  ) {
    throw new Error(
      `Physical provider request must contain plain JSON containers (${label})`
    )
  }
  ancestors.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezePhysicalRequestValue(child, label, ancestors)
  }
  ancestors.delete(value)
  return Object.freeze(value)
}

function normalizeMaxRetries(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Provider retry budget must be a non-negative safe integer")
  }
  return value
}

function normalizeMaxAttempts(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Provider attempt cap must be a positive safe integer")
  }
  return value
}

function normalizePreAcceptanceBufferLimit(value: number | undefined): number {
  const resolved =
    value ?? DEFAULT_PROVIDER_PHYSICAL_PRE_ACCEPTANCE_BUFFER_LIMIT
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(
      "Provider pre-acceptance envelope limit must be a positive safe integer"
    )
  }
  return resolved
}
