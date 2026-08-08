import type {
  ContextStoredToolResultReference,
  ContextToolResultReplacementMutation,
  ContextToolResultReplacementRecord,
  ContextToolResultReplacementState,
} from "./types"
import { requireExactDurableIdentifier } from "./durable-identifier"

/**
 * Build and apply immutable provider-projection mutations for tool results.
 *
 * Graph writers carry these small semantic facts until the graph commit has
 * succeeded.  The ContextPipeline owner then applies them to the current
 * mounted state, so independently committed tool results cannot overwrite
 * one another with stale whole-state snapshots.
 */
export function createToolResultSeenMutation(
  toolUseId: string
): ContextToolResultReplacementMutation {
  return {
    kind: "seen",
    toolUseId: requireToolUseId(toolUseId),
  }
}

export function createToolResultReplacementMutation(input: {
  toolUseId: string
  replacement: string
  reason: ContextToolResultReplacementRecord["reason"]
  createdAt?: number
  projectionVersion?: number
  provider?: "claude"
  documentId?: string
  storedReference?: ContextStoredToolResultReference
}): ContextToolResultReplacementMutation {
  const toolUseId = requireToolUseId(input.toolUseId)
  if (typeof input.replacement !== "string") {
    throw new Error("Tool-result replacement must be a string")
  }
  const createdAt = input.createdAt ?? Date.now()
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new Error(
      "Tool-result replacement createdAt must be a positive integer"
    )
  }
  if (
    input.projectionVersion !== undefined &&
    (!Number.isSafeInteger(input.projectionVersion) ||
      input.projectionVersion <= 0)
  ) {
    throw new Error(
      "Tool-result replacement projectionVersion must be positive"
    )
  }
  if (input.storedReference) {
    requireStoredReferenceIdentifiers(input.storedReference)
  }
  if (input.storedReference && input.storedReference.toolUseId !== toolUseId) {
    throw new Error(
      `Stored tool-result reference belongs to ${input.storedReference.toolUseId}, not ${toolUseId}`
    )
  }

  return {
    kind: "replacement",
    toolUseId,
    replacement: input.replacement,
    record: {
      kind: "tool-result",
      toolUseId,
      replacement: input.replacement,
      ...(input.projectionVersion
        ? { projectionVersion: input.projectionVersion }
        : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.documentId ? { documentId: input.documentId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt,
    },
    ...(input.storedReference
      ? { storedReference: cloneStoredReference(input.storedReference) }
      : {}),
  }
}

/**
 * Apply a sequence of immutable mutations to a mounted replacement state.
 * Returns the original object on a semantic no-op so candidate identity
 * checks remain a precise revision boundary.
 */
export function applyToolResultReplacementMutations(
  current: ContextToolResultReplacementState | undefined,
  mutations: readonly ContextToolResultReplacementMutation[]
): {
  state: ContextToolResultReplacementState | undefined
  changed: boolean
} {
  if (mutations.length === 0) {
    return { state: current, changed: false }
  }

  const next = cloneReplacementState(current)
  let changed = current === undefined

  for (const mutation of mutations) {
    const toolUseId = requireToolUseId(mutation.toolUseId)
    const seen = new Set(next.seenToolUseIds)
    if (!seen.has(toolUseId)) {
      seen.add(toolUseId)
      next.seenToolUseIds = [...seen]
      changed = true
    }
    if (mutation.kind === "seen") continue

    assertReplacementMutation(mutation, toolUseId)
    if (next.replacementByToolUseId[toolUseId] !== mutation.replacement) {
      next.replacementByToolUseId = {
        ...next.replacementByToolUseId,
        [toolUseId]: mutation.replacement,
      }
      changed = true
    }

    if (
      mutation.storedReference &&
      !sameStoredReference(
        next.storedByToolUseId?.[toolUseId],
        mutation.storedReference
      )
    ) {
      next.storedByToolUseId = {
        ...(next.storedByToolUseId || {}),
        [toolUseId]: cloneStoredReference(mutation.storedReference),
      }
      changed = true
    }

    const records = next.records || []
    if (
      !records.some(
        (record) =>
          record.kind === "tool-result" &&
          record.toolUseId === toolUseId &&
          record.replacement === mutation.replacement
      )
    ) {
      next.records = [...records, { ...mutation.record }]
      changed = true
    }
  }

  return changed
    ? { state: next, changed: true }
    : { state: current, changed: false }
}

function cloneReplacementState(
  state: ContextToolResultReplacementState | undefined
): ContextToolResultReplacementState {
  for (const toolUseId of state?.seenToolUseIds || []) {
    requireToolUseId(toolUseId)
  }
  for (const [toolUseId, replacement] of Object.entries(
    state?.replacementByToolUseId || {}
  )) {
    requireToolUseId(toolUseId)
    if (typeof replacement !== "string") {
      throw new Error(`Tool-result replacement for ${toolUseId} must be text`)
    }
  }
  for (const [toolUseId, reference] of Object.entries(
    state?.storedByToolUseId || {}
  )) {
    requireToolUseId(toolUseId)
    requireStoredReferenceIdentifiers(reference)
    if (reference.toolUseId !== toolUseId) {
      throw new Error(
        `Stored tool-result reference key does not match ${reference.toolUseId}`
      )
    }
  }
  for (const record of state?.records || []) {
    requireReplacementRecordIdentifiers(record)
  }
  return {
    seenToolUseIds: [...(state?.seenToolUseIds || [])],
    replacementByToolUseId: { ...(state?.replacementByToolUseId || {}) },
    storedByToolUseId: state?.storedByToolUseId
      ? Object.fromEntries(
          Object.entries(state.storedByToolUseId).map(
            ([toolUseId, reference]) => [
              toolUseId,
              cloneStoredReference(reference),
            ]
          )
        )
      : undefined,
    records: state?.records
      ? state.records.map((record) => ({ ...record }))
      : [],
  }
}

function requireToolUseId(toolUseId: string): string {
  try {
    return requireExactDurableIdentifier(
      toolUseId,
      "Tool-result replacement tool_use id"
    )
  } catch {
    throw new Error("Tool-result replacement requires a tool_use id")
  }
}

function assertReplacementMutation(
  mutation: Extract<
    ContextToolResultReplacementMutation,
    { kind: "replacement" }
  >,
  toolUseId: string
): void {
  if (
    mutation.record.kind !== "tool-result" ||
    mutation.record.toolUseId !== toolUseId ||
    mutation.record.replacement !== mutation.replacement
  ) {
    throw new Error(
      `Tool-result replacement mutation is inconsistent for ${toolUseId}`
    )
  }
  requireReplacementRecordIdentifiers(mutation.record)
  if (
    mutation.storedReference &&
    mutation.storedReference.toolUseId !== toolUseId
  ) {
    throw new Error(
      `Tool-result replacement stored reference is inconsistent for ${toolUseId}`
    )
  }
  if (mutation.storedReference) {
    requireStoredReferenceIdentifiers(mutation.storedReference)
  }
}

function cloneStoredReference(
  reference: ContextStoredToolResultReference
): ContextStoredToolResultReference {
  requireStoredReferenceIdentifiers(reference)
  return { ...reference }
}

function requireReplacementRecordIdentifiers(
  record: ContextToolResultReplacementRecord
): void {
  if (!record || record.kind !== "tool-result") {
    throw new Error("Tool-result replacement record has an invalid kind")
  }
  requireToolUseId(record.toolUseId)
  if (record.documentId !== undefined) {
    requireExactDurableIdentifier(
      record.documentId,
      "Tool-result replacement document id"
    )
  }
}

function requireStoredReferenceIdentifiers(
  reference: ContextStoredToolResultReference
): void {
  if (!reference || typeof reference !== "object") {
    throw new Error("Stored tool-result reference must be an object")
  }
  requireToolUseId(reference.toolUseId)
  requireExactDurableIdentifier(
    reference.documentId,
    "Stored tool-result reference document id"
  )
}

function sameStoredReference(
  left: ContextStoredToolResultReference | undefined,
  right: ContextStoredToolResultReference
): boolean {
  if (!left) return false
  return (
    left.toolUseId === right.toolUseId &&
    left.documentId === right.documentId &&
    left.relativePath === right.relativePath &&
    left.toolName === right.toolName &&
    left.originalSizeChars === right.originalSizeChars &&
    left.originalLineCount === right.originalLineCount &&
    left.previewChars === right.previewChars &&
    left.chunkSize === right.chunkSize &&
    left.chunkCount === right.chunkCount &&
    left.contentType === right.contentType &&
    left.sha256 === right.sha256 &&
    left.createdAt === right.createdAt
  )
}
