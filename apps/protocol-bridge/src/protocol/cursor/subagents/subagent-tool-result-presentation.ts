import {
  fromJson,
  toJson,
  type JsonObject,
  type JsonValue,
} from "@bufbuild/protobuf"
import * as path from "node:path"

import {
  ConversationStepSchema,
  type ConversationStep,
} from "../../../gen/agent/v1_pb"

/**
 * The sole metadata namespace for a durable child-tool presentation fact.
 *
 * The graph may carry other metadata beside this fact, but there is no
 * alternate or legacy key for this contract. Callers that need a presentation
 * fact must require this exact key and fail closed when it is absent.
 */
export const SUBAGENT_TOOL_RESULT_PRESENTATION_METADATA_KEY =
  "cursorSubagentToolResultPresentation" as const

/**
 * A child model can emit a name that is absent from its immutable contract,
 * or a known capability that has no owner in the current phase. Neither case
 * has a legal Cursor ToolCall oneof, so the result must carry this explicit
 * terminal fact rather than silently disappearing from the child graph.
 */
export const SUBAGENT_TOOL_RESULT_REJECTION_METADATA_KEY =
  "cursorSubagentToolResultRejection" as const

export type SubagentToolResultPresentationPhase = "foreground" | "background"

/**
 * A workspace mutation is only a presentation pointer. The reducer that owns
 * a frozen child capability contract validates the path against its allowed
 * workspace roots before deriving any file-change fact.
 */
export interface SubagentWorkspaceMutationPresentation {
  readonly absolutePath: string
  readonly displayPath: string
}

/**
 * JSON-safe, versioned projection for one child tool result.
 *
 * `conversationStep` is canonical proto3 JSON generated directly from
 * `agent.v1.ConversationStep`; it is never a live protobuf object or a raw
 * runtime `ToolCompletionExtraData` value.
 */
export interface SubagentToolResultPresentationFact {
  readonly version: 1
  readonly capabilityId: string
  readonly phase: SubagentToolResultPresentationPhase
  readonly conversationStep: JsonObject
  readonly workspaceMutation: SubagentWorkspaceMutationPresentation | null
}

export type SubagentToolResultPresentationMetadata = Readonly<{
  readonly [SUBAGENT_TOOL_RESULT_PRESENTATION_METADATA_KEY]: SubagentToolResultPresentationFact
}>

export type SubagentToolResultRejectionCode =
  | "unknown_capability"
  | "capability_unavailable_in_phase"

/**
 * The capability id is deliberately nullable rather than omitted.  An
 * unknown model name has no frozen capability identity; a known-but-unowned
 * capability must carry the exact frozen sha256 id.  Keeping one exact field
 * shape makes the distinction durable and rejectable on replay.
 */
export interface SubagentToolResultRejectionFact {
  readonly version: 1
  readonly capabilityId: string | null
  readonly phase: SubagentToolResultPresentationPhase
  /** Exact unnormalized name emitted in the persisted child tool_use. */
  readonly modelToolName: string
  readonly code: SubagentToolResultRejectionCode
}

export type SubagentToolResultRejectionMetadata = Readonly<{
  readonly [SUBAGENT_TOOL_RESULT_REJECTION_METADATA_KEY]: SubagentToolResultRejectionFact
}>

/** A malformed fact must not be projected best-effort into a child result. */
export class SubagentToolResultPresentationFactError extends Error {
  constructor(message: string) {
    super(`Invalid sub-agent tool-result presentation fact: ${message}`)
    this.name = "SubagentToolResultPresentationFactError"
  }
}

const FACT_FIELDS = [
  "version",
  "capabilityId",
  "phase",
  "conversationStep",
  "workspaceMutation",
] as const

const REJECTION_FACT_FIELDS = [
  "version",
  "capabilityId",
  "phase",
  "modelToolName",
  "code",
] as const

const WORKSPACE_MUTATION_FIELDS = ["absolutePath", "displayPath"] as const

const SHA256_CAPABILITY_ID = /^sha256:[a-f0-9]{64}$/

/**
 * Normalize untrusted input into the one durable representation. This is the
 * only construction path: it rejects unknown fields and non-JSON values, then
 * round-trips the official ConversationStep through protobuf JSON decoding and
 * encoding so persisted data cannot depend on an in-memory shape.
 */
export function normalizeSubagentToolResultPresentationFact(
  value: unknown
): SubagentToolResultPresentationFact {
  const fact = requireJsonObject(value, "fact")
  requireExactFields(fact, FACT_FIELDS, "fact")

  const version = fact.version
  if (version !== 1) {
    fail("fact.version must equal 1")
  }

  const capabilityId = requireNonEmptyString(
    fact.capabilityId,
    "fact.capabilityId"
  )
  if (!SHA256_CAPABILITY_ID.test(capabilityId)) {
    fail("fact.capabilityId must be a lowercase sha256:<64 hex> identifier")
  }

  const phase = fact.phase
  if (phase !== "foreground" && phase !== "background") {
    fail('fact.phase must be "foreground" or "background"')
  }

  const conversationStep = canonicalizeToolCallConversationStep(
    fact.conversationStep
  )
  const workspaceMutation = normalizeWorkspaceMutation(fact.workspaceMutation)

  return Object.freeze({
    version: 1,
    capabilityId,
    phase,
    conversationStep: freezeJsonObject(conversationStep),
    workspaceMutation: workspaceMutation
      ? Object.freeze(workspaceMutation)
      : null,
  })
}

/**
 * Put a normalized presentation fact under its only durable metadata key.
 * This intentionally does not merge arbitrary metadata; the graph owner does
 * that explicitly, so no caller can silently choose another representation.
 */
export function buildSubagentToolResultPresentationMetadata(
  value: unknown
): SubagentToolResultPresentationMetadata {
  return Object.freeze({
    [SUBAGENT_TOOL_RESULT_PRESENTATION_METADATA_KEY]:
      normalizeSubagentToolResultPresentationFact(value),
  })
}

/** Build the only durable representation for a child capability rejection. */
export function buildSubagentToolResultRejectionMetadata(
  value: unknown
): SubagentToolResultRejectionMetadata {
  return Object.freeze({
    [SUBAGENT_TOOL_RESULT_REJECTION_METADATA_KEY]:
      normalizeSubagentToolResultRejectionFact(value),
  })
}

/**
 * Read and revalidate the fixed-key fact from a graph metadata object.
 * Unrelated graph metadata is deliberately left to its owning contract.
 */
export function readSubagentToolResultPresentationFact(
  metadata: unknown
): SubagentToolResultPresentationFact | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("metadata must be a JSON object")
  }
  if (
    Object.getPrototypeOf(metadata) !== Object.prototype &&
    Object.getPrototypeOf(metadata) !== null
  ) {
    fail("metadata must be a plain JSON object")
  }
  if (Object.getOwnPropertySymbols(metadata).length > 0) {
    fail("metadata contains a symbol property")
  }
  if (
    !Object.prototype.hasOwnProperty.call(
      metadata,
      SUBAGENT_TOOL_RESULT_PRESENTATION_METADATA_KEY
    )
  ) {
    return undefined
  }

  const descriptor = Object.getOwnPropertyDescriptor(
    metadata,
    SUBAGENT_TOOL_RESULT_PRESENTATION_METADATA_KEY
  )
  if (
    !descriptor ||
    !Object.prototype.hasOwnProperty.call(descriptor, "value")
  ) {
    fail(
      `metadata.${SUBAGENT_TOOL_RESULT_PRESENTATION_METADATA_KEY} must be a data property`
    )
  }
  return normalizeSubagentToolResultPresentationFact(descriptor.value)
}

/** Read the fixed-key child rejection fact without any fallback. */
export function readSubagentToolResultRejectionFact(
  metadata: unknown
): SubagentToolResultRejectionFact | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("metadata must be a JSON object")
  }
  if (
    Object.getPrototypeOf(metadata) !== Object.prototype &&
    Object.getPrototypeOf(metadata) !== null
  ) {
    fail("metadata must be a plain JSON object")
  }
  if (Object.getOwnPropertySymbols(metadata).length > 0) {
    fail("metadata contains a symbol property")
  }
  if (
    !Object.prototype.hasOwnProperty.call(
      metadata,
      SUBAGENT_TOOL_RESULT_REJECTION_METADATA_KEY
    )
  ) {
    return undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    metadata,
    SUBAGENT_TOOL_RESULT_REJECTION_METADATA_KEY
  )
  if (
    !descriptor ||
    !Object.prototype.hasOwnProperty.call(descriptor, "value")
  ) {
    fail(
      `metadata.${SUBAGENT_TOOL_RESULT_REJECTION_METADATA_KEY} must be a data property`
    )
  }
  return normalizeSubagentToolResultRejectionFact(descriptor.value)
}

export function requireSubagentToolResultRejectionFact(
  metadata: unknown
): SubagentToolResultRejectionFact {
  const fact = readSubagentToolResultRejectionFact(metadata)
  if (!fact) {
    fail(`metadata is missing ${SUBAGENT_TOOL_RESULT_REJECTION_METADATA_KEY}`)
  }
  return fact
}

export function normalizeSubagentToolResultRejectionFact(
  value: unknown
): SubagentToolResultRejectionFact {
  const fact = requireJsonObject(value, "rejection fact")
  requireExactFields(fact, REJECTION_FACT_FIELDS, "rejection fact")
  if (fact.version !== 1) fail("rejection fact.version must equal 1")
  if (fact.phase !== "foreground" && fact.phase !== "background") {
    fail('rejection fact.phase must be "foreground" or "background"')
  }
  const modelToolName = requireNonEmptyString(
    fact.modelToolName,
    "rejection fact.modelToolName"
  )
  if (
    fact.code !== "unknown_capability" &&
    fact.code !== "capability_unavailable_in_phase"
  ) {
    fail("rejection fact.code is not a supported frozen capability rejection")
  }
  const code = fact.code
  if (code === "unknown_capability") {
    if (fact.capabilityId !== null) {
      fail(
        "unknown_capability rejection fact.capabilityId must be explicit null"
      )
    }
    return Object.freeze({
      version: 1,
      capabilityId: null,
      phase: fact.phase,
      modelToolName,
      code,
    })
  }
  const capabilityId = requireNonEmptyString(
    fact.capabilityId,
    "rejection fact.capabilityId"
  )
  if (!SHA256_CAPABILITY_ID.test(capabilityId)) {
    fail(
      "rejection fact.capabilityId must be a lowercase sha256:<64 hex> identifier"
    )
  }
  return Object.freeze({
    version: 1,
    capabilityId,
    phase: fact.phase,
    modelToolName,
    code,
  })
}

/**
 * Reducers use this form so a missing, renamed, or malformed fact fails
 * closed instead of falling back to runtime-only child-tool state.
 */
export function requireSubagentToolResultPresentationFact(
  metadata: unknown
): SubagentToolResultPresentationFact {
  const fact = readSubagentToolResultPresentationFact(metadata)
  if (!fact) {
    fail(
      `metadata is missing ${SUBAGENT_TOOL_RESULT_PRESENTATION_METADATA_KEY}`
    )
  }
  return fact
}

function canonicalizeToolCallConversationStep(value: unknown): JsonObject {
  const json = requireJsonObject(value, "fact.conversationStep")

  let step: ConversationStep
  try {
    step = fromJson(ConversationStepSchema, json, {
      ignoreUnknownFields: false,
    })
  } catch {
    fail(
      "fact.conversationStep must be valid official agent.v1.ConversationStep JSON"
    )
  }

  if (step.message.case !== "toolCall") {
    fail("fact.conversationStep must contain a toolCall message")
  }
  if (!step.message.value.toolCallId) {
    fail("fact.conversationStep toolCall must contain a toolCallId")
  }
  if (step.message.value.tool.case === undefined) {
    fail("fact.conversationStep toolCall must contain an official tool case")
  }

  const canonical = toJson(ConversationStepSchema, step)
  return requireJsonObject(canonical, "canonical ConversationStep")
}

function normalizeWorkspaceMutation(
  value: JsonValue | undefined
): SubagentWorkspaceMutationPresentation | null {
  if (value === null) return null

  const mutation = requireJsonObject(value, "fact.workspaceMutation")
  requireExactFields(
    mutation,
    WORKSPACE_MUTATION_FIELDS,
    "fact.workspaceMutation"
  )
  const absolutePath = requireNonEmptyString(
    mutation.absolutePath,
    "fact.workspaceMutation.absolutePath"
  )
  if (!path.isAbsolute(absolutePath)) {
    fail("fact.workspaceMutation.absolutePath must be absolute")
  }

  return {
    absolutePath,
    displayPath: requireNonEmptyString(
      mutation.displayPath,
      "fact.workspaceMutation.displayPath"
    ),
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`)
  }
  return value
}

function requireExactFields(
  value: JsonObject,
  fields: readonly string[],
  label: string
): void {
  const actual = Object.keys(value)
  if (actual.length !== fields.length) {
    fail(`${label} must contain exactly ${fields.join(", ")}`)
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      fail(`${label} is missing ${field}`)
    }
  }
  for (const field of actual) {
    if (!fields.includes(field)) {
      fail(`${label} contains unsupported field ${field}`)
    }
  }
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  const cloned = cloneJsonValue(value, label, new Set<object>())
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
    fail(`${label} must be a JSON object`)
  }
  return cloned
}

function cloneJsonValue(
  value: unknown,
  label: string,
  ancestors: Set<object>
): JsonValue {
  if (value === null) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(`${label} contains a non-finite number`)
    }
    return value
  }
  if (typeof value === "bigint") {
    fail(`${label} contains a bigint`)
  }
  if (typeof value !== "object") {
    fail(`${label} contains a non-JSON value`)
  }
  if (value instanceof Uint8Array) {
    fail(`${label} contains a Uint8Array`)
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    fail(`${label} contains binary data`)
  }
  if (ancestors.has(value)) {
    fail(`${label} contains a cycle`)
  }

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail(`${label} must be a plain JSON array`)
    }
    assertPlainJsonArray(value, label)
    ancestors.add(value)
    const cloned = value.map((entry, index) =>
      cloneJsonValue(entry, `${label}[${index}]`, ancestors)
    )
    ancestors.delete(value)
    return cloned
  }

  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    fail(`${label} must be a plain JSON object`)
  }
  assertPlainJsonObject(value, label)
  ancestors.add(value)
  const cloned: JsonObject = {}
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      !descriptor ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail(`${label}.${key} must be a JSON data property`)
    }
    Object.defineProperty(cloned, key, {
      value: cloneJsonValue(descriptor.value, `${label}.${key}`, ancestors),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  ancestors.delete(value)
  return cloned
}

function assertPlainJsonObject(value: object, label: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(`${label} contains a symbol property`)
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail(`${label}.${key} must be an enumerable JSON data property`)
    }
  }
}

function assertPlainJsonArray(value: unknown[], label: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(`${label} contains a symbol property`)
  }
  const names = Object.getOwnPropertyNames(value)
  for (const key of names) {
    if (key === "length") continue
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || String(index) !== key) {
      fail(`${label} contains a non-JSON array property ${key}`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail(`${label}[${key}] must be an enumerable JSON data property`)
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      fail(`${label} contains a sparse array`)
    }
  }
}

function freezeJsonObject(value: JsonObject): JsonObject {
  for (const nested of Object.values(value)) {
    freezeJsonValue(nested)
  }
  return Object.freeze(value)
}

function freezeJsonValue(value: JsonValue): void {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const nested of value) freezeJsonValue(nested)
    Object.freeze(value)
    return
  }
  for (const nested of Object.values(value)) freezeJsonValue(nested)
  Object.freeze(value)
}

function fail(message: string): never {
  throw new SubagentToolResultPresentationFactError(message)
}
