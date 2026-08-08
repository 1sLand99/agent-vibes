import Ajv, { type ValidateFunction } from "ajv"
import {
  computeSubagentToolContractFingerprint,
  type SubagentSpawnJsonValue,
  type SubagentToolContract,
  type SubagentToolContractEntry,
  type SubagentToolExecutionOwner,
} from "../session/subagent-spawn-request"

/** The two executable child capability surfaces. */
export type FrozenCapabilityInvocationPhase = "foreground" | "background"

export interface ResolveFrozenCapabilityInvocationInput {
  /** Immutable contract read from the durable child spawn request. */
  readonly toolContract: SubagentToolContract
  readonly phase: FrozenCapabilityInvocationPhase
  /** Exact model-visible function name emitted by the provider. */
  readonly modelToolName: string
  /** Already parsed provider JSON. This boundary never parses or repairs it. */
  readonly parsedJson: unknown
}

export type FrozenCapabilityToolErrorCode =
  | "invalid_phase"
  | "invalid_frozen_contract"
  | "unknown_capability"
  | "capability_unavailable_in_phase"
  | "input_is_not_json"
  | "invalid_frozen_schema"
  | "input_schema_violation"

/**
 * Stable local rejection payload for a model tool call. It is intentionally
 * data-only: the resolver does not dispatch, repair, alias, or retry.
 */
export interface FrozenCapabilityToolError {
  readonly kind: "tool_error"
  readonly code: FrozenCapabilityToolErrorCode
  readonly phase: string
  readonly modelToolName: string
  readonly message: string
}

/**
 * Identity that remains safe to present after an exact frozen capability has
 * been located.  It is deliberately separate from dispatch authorization:
 * a schema-rejected call still needs the same durable ToolCall fact as a
 * successful call, but it must never reach the capability executor.
 */
export interface FrozenCapabilityPresentationInvocation {
  readonly capabilityId: string
  readonly contractFingerprint: string
  readonly entry: SubagentToolContractEntry
  readonly phase: FrozenCapabilityInvocationPhase
  /** Exact owner selected by the frozen phase field, never by input args. */
  readonly phaseOwner: SubagentToolExecutionOwner
}

/** A fully authorized invocation ready for the owning runtime to dispatch. */
export interface ResolvedFrozenCapabilityInvocation extends FrozenCapabilityPresentationInvocation {
  readonly kind: "resolved"
  /** The same parsed JSON value that passed the frozen input schema. */
  readonly validatedInput: SubagentSpawnJsonValue
}

/**
 * A model call whose name and phase owner were frozen and recognized, but
 * whose input was refused before dispatch.  Keep its immutable owner so the
 * paired tool_result can be projected and terminal graph reduction remains
 * complete.  `unvalidatedInput` is diagnostic/presentation-only and must
 * never be passed to an executor.
 */
export interface RejectedFrozenCapabilityInvocation extends FrozenCapabilityPresentationInvocation {
  readonly kind: "rejected"
  readonly code: Extract<
    FrozenCapabilityToolErrorCode,
    "invalid_frozen_schema" | "input_schema_violation"
  >
  readonly modelToolName: string
  readonly message: string
  readonly unvalidatedInput: SubagentSpawnJsonValue
}

/**
 * The exact capability exists in the durable contract but has no owner for
 * this phase. It is a terminal rejection, not an executable invocation and
 * not a guessed Cursor ToolCall. Consumers must persist its dedicated
 * rejection fact alongside the error tool_result.
 */
export interface UnownedFrozenCapabilityInvocation {
  readonly kind: "unowned"
  readonly code: "capability_unavailable_in_phase"
  readonly capabilityId: string
  readonly contractFingerprint: string
  readonly entry: SubagentToolContractEntry
  readonly phase: FrozenCapabilityInvocationPhase
  readonly modelToolName: string
  readonly message: string
}

export type FrozenCapabilityInvocationResult =
  | ResolvedFrozenCapabilityInvocation
  | RejectedFrozenCapabilityInvocation
  | UnownedFrozenCapabilityInvocation
  | FrozenCapabilityToolError

type CachedValidator =
  | { readonly kind: "compiled"; readonly validate: ValidateFunction }
  | { readonly kind: "invalid_schema" }

/**
 * Build the only valid schema-validator cache key. All three durable
 * identities are required: a capability can never reuse a validator across a
 * contract revision or a schema revision.
 */
export function frozenCapabilityValidatorCacheKey(
  contractFingerprint: string,
  capabilityId: string,
  schemaSha256: string
): string {
  return `${contractFingerprint}\u0000${capabilityId}\u0000${schemaSha256}`
}

/**
 * Resolve one model-emitted tool call exclusively against a durable child
 * contract. This class owns no transport or live registry dependency, so a
 * recovery path cannot accidentally rediscover a different capability.
 */
export class FrozenCapabilityInvocationResolver {
  private readonly ajv = new Ajv({
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    strict: true,
    useDefaults: false,
  })

  private readonly validators = new Map<string, CachedValidator>()

  resolve(
    input: ResolveFrozenCapabilityInvocationInput
  ): FrozenCapabilityInvocationResult {
    if (input.phase !== "foreground" && input.phase !== "background") {
      return toolError(
        "invalid_phase",
        input.phase,
        input.modelToolName,
        "Child capability phase must be foreground or background."
      )
    }

    if (!hasCanonicalFrozenContract(input.toolContract)) {
      return toolError(
        "invalid_frozen_contract",
        input.phase,
        input.modelToolName,
        "Child capability contract failed its durable integrity check."
      )
    }

    // Deliberately compare raw strings. Do not trim, case-fold, normalize, or
    // map aliases: the name must be exactly what the frozen request emitted.
    const entry = input.toolContract.tools.find(
      (candidate) => candidate.name === input.modelToolName
    )
    if (!entry) {
      return toolError(
        "unknown_capability",
        input.phase,
        input.modelToolName,
        "Child capability name is not present in the frozen contract."
      )
    }

    const phaseOwner = entry.executionOwners[input.phase]
    if (phaseOwner === null) {
      return {
        kind: "unowned",
        code: "capability_unavailable_in_phase",
        capabilityId: entry.capabilityId,
        contractFingerprint: input.toolContract.fingerprint,
        entry,
        phase: input.phase,
        modelToolName: input.modelToolName,
        message: "Child capability is not available in this execution phase.",
      }
    }

    if (!isParsedJsonValue(input.parsedJson)) {
      return toolError(
        "input_is_not_json",
        input.phase,
        input.modelToolName,
        "Child capability input must be a parsed JSON value."
      )
    }

    const validator = this.resolveValidator(input.toolContract, entry)
    if (validator.kind === "invalid_schema") {
      return rejectedInvocation(
        "invalid_frozen_schema",
        input.toolContract,
        entry,
        input.phase,
        phaseOwner,
        input.modelToolName,
        "Child capability has an invalid frozen input schema.",
        input.parsedJson
      )
    }

    if (!validator.validate(input.parsedJson)) {
      return rejectedInvocation(
        "input_schema_violation",
        input.toolContract,
        entry,
        input.phase,
        phaseOwner,
        input.modelToolName,
        "Child capability input does not satisfy its frozen schema.",
        input.parsedJson
      )
    }

    return {
      kind: "resolved",
      capabilityId: entry.capabilityId,
      contractFingerprint: input.toolContract.fingerprint,
      entry,
      phase: input.phase,
      phaseOwner,
      validatedInput: input.parsedJson,
    }
  }

  private resolveValidator(
    contract: SubagentToolContract,
    entry: SubagentToolContractEntry
  ): CachedValidator {
    const key = frozenCapabilityValidatorCacheKey(
      contract.fingerprint,
      entry.capabilityId,
      entry.schemaSha256
    )
    const cached = this.validators.get(key)
    if (cached) return cached

    let compiled: CachedValidator
    try {
      compiled = {
        kind: "compiled",
        validate: this.ajv.compile(entry.inputSchema),
      }
    } catch {
      compiled = { kind: "invalid_schema" }
    }
    this.validators.set(key, compiled)
    return compiled
  }
}

const defaultFrozenCapabilityInvocationResolver =
  new FrozenCapabilityInvocationResolver()

/** Convenience API backed by one process-local, identity-keyed validator cache. */
export function resolveFrozenCapabilityInvocation(
  input: ResolveFrozenCapabilityInvocationInput
): FrozenCapabilityInvocationResult {
  return defaultFrozenCapabilityInvocationResolver.resolve(input)
}

function hasCanonicalFrozenContract(
  value: unknown
): value is SubagentToolContract {
  if (!value || typeof value !== "object") return false
  const contract = value as SubagentToolContract
  try {
    return (
      computeSubagentToolContractFingerprint({
        version: contract.version,
        tools: contract.tools,
        mcpRegistry: contract.mcpRegistry,
      }) === contract.fingerprint
    )
  } catch {
    return false
  }
}

function toolError(
  code: FrozenCapabilityToolErrorCode,
  phase: string,
  modelToolName: unknown,
  message: string
): FrozenCapabilityToolError {
  return {
    kind: "tool_error",
    code,
    phase,
    modelToolName: typeof modelToolName === "string" ? modelToolName : "",
    message,
  }
}

function rejectedInvocation(
  code: RejectedFrozenCapabilityInvocation["code"],
  contract: SubagentToolContract,
  entry: SubagentToolContractEntry,
  phase: FrozenCapabilityInvocationPhase,
  phaseOwner: SubagentToolExecutionOwner,
  modelToolName: string,
  message: string,
  unvalidatedInput: SubagentSpawnJsonValue
): RejectedFrozenCapabilityInvocation {
  return {
    kind: "rejected",
    code,
    capabilityId: entry.capabilityId,
    contractFingerprint: contract.fingerprint,
    entry,
    phase,
    phaseOwner,
    modelToolName,
    message,
    unvalidatedInput,
  }
}

function isParsedJsonValue(value: unknown): value is SubagentSpawnJsonValue {
  return isParsedJsonValueInner(value, new Set<object>())
}

function isParsedJsonValueInner(
  value: unknown,
  ancestors: Set<object>
): value is SubagentSpawnJsonValue {
  if (value === null) return true
  if (typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object") return false
  if (ancestors.has(value)) return false

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
        return false
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return false
    }
    ancestors.add(value)
    try {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return false
        if (!isParsedJsonValueInner(value[index], ancestors)) return false
      }
      return true
    } finally {
      ancestors.delete(value)
    }
  }

  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  ancestors.add(value)
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return false
      if (!isParsedJsonValueInner(descriptor.value, ancestors)) return false
    }
    return true
  } finally {
    ancestors.delete(value)
  }
}
