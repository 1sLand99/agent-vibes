import { createHash } from "crypto"
import { requireExactDurableIdentifier } from "../../context/durable-identifier"
import type { CodexReplacementHistoryItem } from "../../shared/provider-content"
import { stableCodexJsonStringify } from "./codex-incremental"
import type {
  CodexConversationTool,
  CodexInputItem,
  CodexTool,
} from "./codex-native-types"
import {
  codexResponseOutputItemToInputItem,
  isCodexApiVisibleInputItem,
} from "./codex-response-items"
import {
  countCodexApproxTokens,
  truncateCodexTextByTokens,
} from "./codex-text-truncation"
import { CODEX_CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE } from "./codex-token-accounting"

/**
 * Native Codex context is an append-only rollout plus an installed model
 * history. It is intentionally not represented as `UnifiedMessage[]`:
 * Responses items, compaction boundaries and raw tool calls are provider
 * semantics, not generic transcript content.
 */
export const CODEX_PROJECTION_STATE_VERSION = 7 as const

const REMOTE_COMPACTION_V2_RETAINED_MESSAGE_TOKEN_BUDGET = 64_000

type CodexContextRole = "developer" | "user"

/**
 * One durable graph record may produce several native input items (for
 * example, a tool call and its output). The binding is the only authority for
 * source coverage; callers must not infer it from content or item position.
 */
export interface CodexProjectionInputBinding {
  bindingId: string
  sourceRecordId: string
  items: CodexInputItem[]
}

export interface CodexProjectionInputBindingInput {
  sourceRecordId: string
  items: readonly CodexInputItem[]
}

export interface CodexProjectionContextSnapshot {
  signatures: Readonly<Record<string, string>>
  roles: Readonly<Record<string, CodexContextRole>>
  /** Stable source binding for each context key. */
  sourceRecordIdsByKey: Readonly<Record<string, string>>
}

/**
 * Codex WorldState is an incremental state patch, not a transcript snapshot.
 * This record carries only the source-bound context entries changed at one
 * sampling boundary plus the resulting keyed context state.
 */
export interface CodexProjectionWorldStatePatch {
  readonly type: "context_projection_patch"
  readonly removeSourceRecordIds: readonly string[]
  readonly appendBindings: readonly CodexProjectionInputBindingInput[]
  readonly contextSnapshot: CodexProjectionContextSnapshot
}

/** An installed item and the stable rollout identity that owns it. */
export interface CodexProjectionHistoryEntry {
  itemId: string
  rolloutId: string
  /** Atomic binding boundary for rollback; distinct from the enclosing rollout. */
  bindingId: string
  item: CodexInputItem
  sourceRecordIds: string[]
}

export type CodexProjectionRolloutItem =
  | {
      kind: "input_items"
      rolloutId: string
      recordedAt: number
      bindings: CodexProjectionInputBinding[]
      contextSnapshot?: CodexProjectionContextSnapshot
    }
  | {
      kind: "response_item"
      rolloutId: string
      recordedAt: number
      item: CodexReplacementHistoryItem
      /** Undefined only when the raw response item is not model-visible. */
      itemIdentity?: string
      nativeItemId?: string
    }
  | {
      kind: "source_records_linked"
      rolloutId: string
      recordedAt: number
      targetItemId: string
      sourceRecordIds: string[]
    }
  | {
      kind: "compacted"
      rolloutId: string
      recordedAt: number
      compactionId: string
      injectionMode: "pre_turn" | "mid_turn"
      /** Digest of the installed history replaced by this checkpoint. */
      sourceHistoryHash: string
      /** Digest of the validated remote-compaction transaction. */
      requestFingerprint: string
      responseId: string
      /** Semantic replacement history installed at this boundary. */
      replacementEntries: CodexProjectionHistoryEntry[]
      compactedSourceRecordIds: string[]
      retainedSourceRecordIds: string[]
      contextSnapshot: CodexProjectionContextSnapshot
      window: CodexProjectionWindow
    }
  | {
      kind: "world_state"
      rolloutId: string
      recordedAt: number
      item: CodexProjectionWorldStatePatch
    }
  | {
      kind: "turn_context" | "event_msg" | "inter_agent"
      rolloutId: string
      recordedAt: number
      item: Record<string, unknown>
    }
  | {
      kind: "history_replaced"
      rolloutId: string
      recordedAt: number
      reason: "replace" | "rollback"
      entries: CodexProjectionHistoryEntry[]
      contextSnapshot: CodexProjectionContextSnapshot
    }

export interface CodexProjectionRolloutIdentity {
  readonly rolloutId: string
  readonly kind: CodexProjectionRolloutItem["kind"]
  /** Hash of the retry-relevant semantic payload, excluding recordedAt. */
  readonly payloadHash: string
  readonly itemIdentity?: string
  readonly nativeItemId?: string
  readonly window?: CodexProjectionWindow
}

export interface CodexProjectionRolloutCursor {
  readonly length: number
  readonly lastRolloutId?: string
  readonly lastKind?: CodexProjectionRolloutItem["kind"]
  readonly lastHeadId?: string
  /** Projection metadata installed by the durable head at this cursor. */
  readonly historyVersion: number
  readonly projectionGeneration: number
  readonly activeWindowId: string
  readonly projectedSourceRecordCount: number
  /**
   * Lightweight retry/idempotency index. Raw rollout payloads remain solely
   * in CodexRolloutStore and are never retained by the mounted hot state.
   */
  readonly activeWindowIdentities: ReadonlyMap<
    string,
    CodexProjectionRolloutIdentity
  >
  readonly activeWindowResponseItemsByNativeId: ReadonlyMap<
    string,
    CodexProjectionRolloutIdentity
  >
}

export interface CodexProjectionWindow {
  windowNumber: number
  firstWindowId: string
  previousWindowId?: string
  windowId: string
  createdAt: number
  compactionId?: string
}

export interface CodexProjectionState {
  version: typeof CODEX_PROJECTION_STATE_VERSION
  /**
   * Durable upstream Codex thread identity. Native window ids are derived
   * only from this value, never from a local projection key.
   */
  readonly nativeThreadId: string
  /** Mirrors Codex ContextManager.history_version. */
  historyVersion: number
  /** Incremented whenever the installed prompt history is replaced. */
  projectionGeneration: number
  /** Exact Responses input items installed for the active model window. */
  activeHistory: CodexInputItem[]
  /** Authoritative item identities and exact graph-source bindings. */
  activeHistoryEntries: CodexProjectionHistoryEntry[]
  /** Durable append-only position plus small idempotency indexes. */
  committedRollout: CodexProjectionRolloutCursor
  /** Candidate-owned records not yet accepted by the durable rollout CAS. */
  pendingRollout: CodexProjectionRolloutItem[]
  /** Graph records exactly represented by the currently installed history. */
  projectedSourceRecordIds: string[]
  contextSignatures: Record<string, string>
  contextRoles: Record<string, CodexContextRole>
  contextSourceRecordIds: Record<string, string>
  activeWindow: CodexProjectionWindow
}

export interface CodexProjectionManifest {
  provider: "codex"
  historyVersion: number
  projectionGeneration: number
  activeWindow: CodexProjectionWindow
  sourceItemCount: number
  sourceItemIds: string[]
  sourceRecordIds: string[]
  outputItemCount: number
  toolCatalogHash?: string
  settingsHash?: string
  reinjectedItemCount: number
}

export interface CodexPromptProjectionOptions {
  /** Items generated for the current step after the installed window. */
  reinjectedItems?: readonly CodexInputItem[]
  tools?: readonly (CodexTool | CodexConversationTool)[]
  settings?: Record<string, unknown>
}

export interface CodexPromptProjection {
  input: CodexInputItem[]
  manifest: CodexProjectionManifest
}

export interface CodexRecordInputBindingsInput {
  /** Stable identity for the input rollout record; retries must reuse it. */
  rolloutId: string
  bindings: readonly CodexProjectionInputBindingInput[]
  contextSnapshot?: CodexProjectionContextSnapshot
  recordedAt?: number
}

export interface CodexResponseRolloutRecord {
  /** Stable raw rollout identity, not a content-derived surrogate. */
  rolloutId: string
  item: CodexReplacementHistoryItem
  recordedAt?: number
}

export interface CodexRecordedResponseItem {
  rolloutId: string
  /** Use this identity when linking a graph record to this raw response item. */
  itemIdentity?: string
}

export interface CodexSourceRecordLinkInput {
  rolloutId: string
  targetItemId: string
  sourceRecordIds: readonly string[]
  recordedAt?: number
}

export interface CodexCompactionInstallInput {
  rolloutId: string
  compactionId: string
  injectionMode: "pre_turn" | "mid_turn"
  /** Compare-and-swap boundary captured before the remote request starts. */
  expectedHistoryVersion: number
  expectedProjectionGeneration: number
  expectedWindowId: string
  /** Exact native state and prompt supplied to Remote Compaction V2. */
  rawHistory: readonly CodexInputItem[]
  preTriggerInput: readonly CodexInputItem[]
  requestInput: readonly CodexInputItem[]
  wireInput: readonly CodexInputItem[]
  compactionOutput: CodexReplacementHistoryItem
  responseId: string
  usage?: Readonly<Record<string, unknown>>
  /** Upstream native thread that owns this compaction window. */
  nativeThreadId: string
  createdAt?: number
}

export interface CodexCompactionCommitInput {
  /** Length of the installed durable rollout before this provider request. */
  durableRolloutLength: number
  /** Exact prepared request state used to construct Remote Compaction V2. */
  candidateProjectionState: CodexProjectionState
  /** Derivative state after the provider returned one compaction item. */
  compactedProjectionState: CodexProjectionState
}

export interface CodexProjectionBindingReplacementInput {
  rolloutId: string
  removeSourceRecordIds: readonly string[]
  appendBindings?: readonly CodexProjectionInputBindingInput[]
  /** The full post-replacement context snapshot; no implicit stale-key carryover. */
  contextSnapshot: CodexProjectionContextSnapshot
  recordedAt?: number
}

export interface CodexRollbackInput {
  rolloutId: string
  numTurns: number
  recordedAt?: number
}

export interface CodexRollbackResult {
  removedUserTurns: number
  retainedItemCount: number
}

export function createCodexProjectionState(
  nativeThreadId: string,
  createdAt: number = Date.now()
): CodexProjectionState {
  const normalizedNativeThreadId = requireNativeThreadId(nativeThreadId)
  const firstWindowId = buildCodexProjectionWindowId(
    normalizedNativeThreadId,
    0
  )
  return {
    version: CODEX_PROJECTION_STATE_VERSION,
    nativeThreadId: normalizedNativeThreadId,
    historyVersion: 0,
    projectionGeneration: 0,
    activeHistory: [],
    activeHistoryEntries: [],
    committedRollout: {
      length: 0,
      historyVersion: 0,
      projectionGeneration: 0,
      activeWindowId: firstWindowId,
      projectedSourceRecordCount: 0,
      activeWindowIdentities: new Map(),
      activeWindowResponseItemsByNativeId: new Map(),
    },
    pendingRollout: [],
    projectedSourceRecordIds: [],
    contextSignatures: {},
    contextRoles: {},
    contextSourceRecordIds: {},
    activeWindow: {
      windowNumber: 0,
      firstWindowId,
      windowId: firstWindowId,
      createdAt,
    },
  }
}

/**
 * Creates a candidate-owned mutable projection without copying the durable
 * rollout ledger. The committed cursor is immutable and shared; active native
 * history and the small pending delta are copied because request staging may
 * replace or append them.
 */
export function forkCodexProjectionState(
  state: CodexProjectionState
): CodexProjectionState {
  return {
    version: state.version,
    nativeThreadId: state.nativeThreadId,
    historyVersion: state.historyVersion,
    projectionGeneration: state.projectionGeneration,
    activeHistory: state.activeHistory.map(cloneInputItem),
    activeHistoryEntries: state.activeHistoryEntries.map(cloneHistoryEntry),
    committedRollout: state.committedRollout,
    pendingRollout: [...state.pendingRollout],
    projectedSourceRecordIds: [...state.projectedSourceRecordIds],
    contextSignatures: { ...state.contextSignatures },
    contextRoles: { ...state.contextRoles },
    contextSourceRecordIds: { ...state.contextSourceRecordIds },
    activeWindow: { ...state.activeWindow },
  }
}

export function getCodexPendingRollout(
  state: CodexProjectionState
): readonly CodexProjectionRolloutItem[] {
  return state.pendingRollout
}

export function getCodexDurableRolloutLength(
  state: CodexProjectionState
): number {
  return state.committedRollout.length
}

export function getCodexDurableLastRolloutId(
  state: CodexProjectionState
): string | undefined {
  return state.committedRollout.lastRolloutId
}

/**
 * Promotes the exact candidate delta after its rollout rows and active-head
 * CAS have committed. This is intentionally the only transition that clears
 * pending records from the mounted projection.
 */
export function commitCodexPendingRollout(
  state: CodexProjectionState
): CodexProjectionState {
  if (state.pendingRollout.length === 0) {
    throw new Error("Codex projection has no pending rollout to commit")
  }
  const committedRollout = extendCommittedRollout(
    state.committedRollout,
    state.pendingRollout,
    state
  )
  return {
    ...state,
    committedRollout,
    pendingRollout: [],
  }
}

/**
 * Records an exact source-to-native-item binding. A source that has no native
 * items must be excluded by the caller rather than marked as covered.
 */
export function recordCodexInputBindings(
  state: CodexProjectionState,
  input: CodexRecordInputBindingsInput
): CodexProjectionInputBinding[] {
  const bindings = materializeInputBindings(input.rolloutId, input.bindings)
  const snapshot = input.contextSnapshot
    ? normalizeContextSnapshot(input.contextSnapshot)
    : undefined
  const expectedRecord: CodexProjectionRolloutItem = {
    kind: "input_items",
    rolloutId: requireRolloutId(input.rolloutId),
    recordedAt: input.recordedAt ?? 0,
    bindings: bindings.map(cloneInputBinding),
    ...(snapshot ? { contextSnapshot: cloneContextSnapshot(snapshot) } : {}),
  }
  const pending = findPendingRolloutItem(state, input.rolloutId)
  if (pending) {
    if (pending.kind !== "input_items") {
      throw conflictingRolloutIdentity(
        input.rolloutId,
        pending.kind,
        "input_items"
      )
    }
    assertSameInputRollout(pending, input)
    return pending.bindings.map(cloneInputBinding)
  }
  const committed = findCommittedRolloutIdentity(state, input.rolloutId)
  if (committed) {
    assertCommittedRolloutRetry(committed, expectedRecord)
    return bindings.map(cloneInputBinding)
  }

  const activeSources = new Set(state.projectedSourceRecordIds)
  for (const binding of bindings) {
    if (activeSources.has(binding.sourceRecordId)) {
      throw new Error(
        `Codex source record ${binding.sourceRecordId} is already installed; use native history replacement before rebinding it`
      )
    }
    activeSources.add(binding.sourceRecordId)
  }

  const nextEntries = [
    ...state.activeHistoryEntries.map(cloneHistoryEntry),
    ...entriesFromInputBindings(input.rolloutId, bindings),
  ]
  if (snapshot) {
    assertContextSnapshotCoverage(snapshot, nextEntries)
  }

  setActiveHistoryEntries(state, nextEntries)
  if (snapshot) applyContextSnapshot(state, snapshot)
  appendPendingRollout(state, {
    kind: "input_items",
    rolloutId: requireRolloutId(input.rolloutId),
    recordedAt: input.recordedAt ?? Date.now(),
    bindings: bindings.map(cloneInputBinding),
    ...(snapshot ? { contextSnapshot: cloneContextSnapshot(snapshot) } : {}),
  })
  return bindings.map(cloneInputBinding)
}

/**
 * Raw response records are idempotent by stable rollout identity. This makes
 * repeated delivery of the same `response.output_item.done` event harmless,
 * while a conflicting payload remains a corruption error.
 */
export function recordCodexResponseItem(
  state: CodexProjectionState,
  record: CodexResponseRolloutRecord
): CodexRecordedResponseItem {
  const rolloutId = requireRolloutId(record.rolloutId)
  const nativeItemId = extractCodexInputItemId(record.item)
  const inputItem = codexResponseOutputItemToInputItem(record.item)
  const itemIdentity = inputItem ? `${rolloutId}:item` : undefined
  const expectedRecord: CodexProjectionRolloutItem = {
    kind: "response_item",
    rolloutId,
    recordedAt: record.recordedAt ?? 0,
    item: cloneJson(record.item),
    ...(itemIdentity ? { itemIdentity } : {}),
    ...(nativeItemId ? { nativeItemId } : {}),
  }
  const pending = findPendingRolloutItem(state, record.rolloutId)
  if (pending) {
    if (pending.kind !== "response_item") {
      throw conflictingRolloutIdentity(
        record.rolloutId,
        pending.kind,
        "response_item"
      )
    }
    if (
      stableCodexJsonStringify(pending.item) !==
      stableCodexJsonStringify(record.item)
    ) {
      throw new Error(
        `Codex response rollout ${record.rolloutId} was delivered with a different payload`
      )
    }
    return {
      rolloutId: pending.rolloutId,
      ...(pending.itemIdentity ? { itemIdentity: pending.itemIdentity } : {}),
    }
  }
  const committed = findCommittedRolloutIdentity(state, record.rolloutId)
  if (committed) {
    assertCommittedRolloutRetry(committed, expectedRecord)
    return {
      rolloutId: committed.rolloutId,
      ...(committed.itemIdentity
        ? { itemIdentity: committed.itemIdentity }
        : {}),
    }
  }
  if (nativeItemId) {
    const duplicateNativeItem = findResponseRolloutByNativeItemId(
      state,
      nativeItemId
    )
    if (duplicateNativeItem) {
      if (
        duplicateNativeItem.payloadHash ===
        hashCodexRolloutSemanticPayload({
          kind: "response_item",
          rolloutId: duplicateNativeItem.rolloutId,
          recordedAt: 0,
          item: cloneJson(record.item),
          ...(duplicateNativeItem.itemIdentity
            ? { itemIdentity: duplicateNativeItem.itemIdentity }
            : {}),
          nativeItemId,
        })
      ) {
        return {
          rolloutId: duplicateNativeItem.rolloutId,
          ...(duplicateNativeItem.itemIdentity
            ? { itemIdentity: duplicateNativeItem.itemIdentity }
            : {}),
        }
      }
      throw new Error(
        `Codex native response item ${nativeItemId} conflicts with rollout ${duplicateNativeItem.rolloutId}`
      )
    }
  }

  const item = cloneJson(record.item)
  if (inputItem) {
    setActiveHistoryEntries(state, [
      ...state.activeHistoryEntries.map(cloneHistoryEntry),
      {
        itemId: itemIdentity!,
        rolloutId,
        bindingId: itemIdentity!,
        item: cloneInputItem(inputItem),
        sourceRecordIds: [],
      },
    ])
  }
  appendPendingRollout(state, {
    kind: "response_item",
    rolloutId,
    recordedAt: record.recordedAt ?? Date.now(),
    item,
    ...(itemIdentity ? { itemIdentity } : {}),
    ...(nativeItemId ? { nativeItemId } : {}),
  })
  return { rolloutId, ...(itemIdentity ? { itemIdentity } : {}) }
}

export function recordCodexResponseItems(
  state: CodexProjectionState,
  records: readonly CodexResponseRolloutRecord[]
): CodexRecordedResponseItem[] {
  return records.map((record) => recordCodexResponseItem(state, record))
}

/** Links a graph record to the exact already-installed native response item. */
export function linkCodexSourceRecords(
  state: CodexProjectionState,
  input: CodexSourceRecordLinkInput
): void {
  const sourceRecordIds = collectExactSourceRecordIds(input.sourceRecordIds)
  const targetItemId = requireCodexIdentifier(
    input.targetItemId,
    "target item id"
  )
  const expectedRecord: CodexProjectionRolloutItem = {
    kind: "source_records_linked",
    rolloutId: requireRolloutId(input.rolloutId),
    recordedAt: input.recordedAt ?? 0,
    targetItemId,
    sourceRecordIds,
  }
  const pending = findPendingRolloutItem(state, input.rolloutId)
  if (pending) {
    if (pending.kind !== "source_records_linked") {
      throw conflictingRolloutIdentity(
        input.rolloutId,
        pending.kind,
        "source_records_linked"
      )
    }
    assertSameSourceLink(pending, input)
    return
  }
  const committed = findCommittedRolloutIdentity(state, input.rolloutId)
  if (committed) {
    assertCommittedRolloutRetry(committed, expectedRecord)
    return
  }
  if (sourceRecordIds.length === 0) {
    throw new Error("Codex source link requires at least one source record id")
  }
  const targetIndex = state.activeHistoryEntries.findIndex(
    (entry) => entry.itemId === targetItemId
  )
  if (targetIndex < 0) {
    throw new Error(
      `Codex source link target ${targetItemId} is not installed in the active history`
    )
  }

  const entries = state.activeHistoryEntries.map(cloneHistoryEntry)
  const target = entries[targetIndex]!
  for (const sourceRecordId of sourceRecordIds) {
    const boundEntries = entries.filter((entry) =>
      entry.sourceRecordIds.includes(sourceRecordId)
    )
    if (
      boundEntries.some(
        (entry) =>
          entry.itemId !== targetItemId &&
          (!isCodexResponseHistoryEntry(entry) ||
            !isCodexResponseHistoryEntry(target))
      )
    ) {
      throw new Error(
        `Codex source record ${sourceRecordId} is already bound to a non-response history item`
      )
    }
    if (!target.sourceRecordIds.includes(sourceRecordId)) {
      target.sourceRecordIds.push(sourceRecordId)
    }
  }
  setActiveHistoryEntries(state, entries)
  appendPendingRollout(state, {
    kind: "source_records_linked",
    rolloutId: requireRolloutId(input.rolloutId),
    recordedAt: input.recordedAt ?? Date.now(),
    targetItemId,
    sourceRecordIds,
  })
}

export function recordCodexRolloutMetadata(
  state: CodexProjectionState,
  input: {
    rolloutId: string
    kind: Extract<
      CodexProjectionRolloutItem,
      { kind: "turn_context" | "event_msg" | "inter_agent" }
    >["kind"]
    item: Record<string, unknown>
    recordedAt?: number
  }
): void {
  assertNewRolloutId(state, input.rolloutId)
  appendPendingRollout(state, {
    kind: input.kind,
    rolloutId: requireRolloutId(input.rolloutId),
    recordedAt: input.recordedAt ?? Date.now(),
    item: cloneJson(input.item),
  })
}

/**
 * Installs a Remote Compaction V2 result using the same local replacement
 * rule as Codex core. The provider returns one opaque compaction item; the
 * retained user suffix and current-context placement are local history
 * operations, guarded by the projection/window generation captured before
 * the request.
 */
export function installCodexCompaction(
  state: CodexProjectionState,
  input: CodexCompactionInstallInput
): CodexProjectionWindow {
  const nativeThreadId = requireNativeThreadId(input.nativeThreadId)
  const compactionId = requireCodexIdentifier(
    input.compactionId,
    "compaction id"
  )
  const responseId = requireCodexIdentifier(input.responseId, "response id")
  assertProjectionNativeThread(state, nativeThreadId, "compaction install")
  assertCodexProjectionWindow(
    state.activeWindow,
    nativeThreadId,
    undefined,
    "active"
  )
  const pending = findPendingRolloutItem(state, input.rolloutId)
  if (pending) {
    if (pending.kind !== "compacted") {
      throw conflictingRolloutIdentity(
        input.rolloutId,
        pending.kind,
        "compacted"
      )
    }
    assertSameCompaction(pending, input)
    assertCodexProjectionWindow(
      pending.window,
      nativeThreadId,
      undefined,
      "stored compaction"
    )
    return { ...pending.window }
  }
  const committed = findCommittedRolloutIdentity(state, input.rolloutId)
  if (committed) {
    if (committed.kind !== "compacted") {
      throw conflictingRolloutIdentity(
        input.rolloutId,
        committed.kind,
        "compacted"
      )
    }
    if (committed.payloadHash !== hashCodexCompactionInstallInput(input)) {
      throw new Error(
        `Codex compaction rollout ${input.rolloutId} was retried with a different payload`
      )
    }
    if (!committed.window) {
      throw new Error(
        `Codex compaction rollout ${input.rolloutId} has no installed window`
      )
    }
    assertCodexProjectionWindow(
      committed.window,
      nativeThreadId,
      undefined,
      "stored compaction"
    )
    return { ...committed.window }
  }

  assertCodexCompactionGeneration(state, input)
  assertCodexRemoteCompactionV2Input(state, input)

  const createdAt = input.createdAt ?? Date.now()
  const sourceHistoryHash = hashCodexNativeItems(input.rawHistory)
  const requestFingerprint = hashCodexCompactionInstallInput(input)
  const compactionOutput = cloneJson(input.compactionOutput)
  if (compactionOutput.type !== "compaction") {
    throw new Error(
      `Codex Remote Compaction V2 requires a compaction output, received ${String(compactionOutput.type)}`
    )
  }
  const compactionInputItem =
    codexResponseOutputItemToInputItem(compactionOutput)
  if (!compactionInputItem || compactionInputItem.type !== "compaction") {
    throw new Error(
      "Codex Remote Compaction V2 output is not a model-visible compaction item"
    )
  }

  const contextSourceRecordIds = new Set(
    Object.values(state.contextSourceRecordIds)
  )
  const currentContextEntries = state.activeHistoryEntries
    .filter(
      (entry) =>
        entry.sourceRecordIds.length > 0 &&
        entry.sourceRecordIds.every((sourceRecordId) =>
          contextSourceRecordIds.has(sourceRecordId)
        )
    )
    .map(cloneHistoryEntry)

  // Mirror Codex Remote Compaction V2's two-stage retention policy.  The
  // first predicate admits user/developer/system messages; the second drops
  // rebuilt developer/system context and retains only user-message history.
  // Keeping the stages explicit prevents a future role-only shortcut from
  // accidentally preserving stale instruction/context records.
  const retainedEntries = retainCodexRemoteCompactionV2UserSuffix(
    state.activeHistoryEntries.filter(
      (entry) =>
        entry.sourceRecordIds.some(
          (sourceRecordId) => !contextSourceRecordIds.has(sourceRecordId)
        ) &&
        isCodexRemoteCompactionV2RetentionCandidate(entry.item) &&
        shouldKeepCodexRemoteCompactionV2Item(entry.item)
    )
  )
  const rolloutId = requireRolloutId(input.rolloutId)
  const retainedSourceRecordIds = collectExactSourceRecordIds(
    retainedEntries.flatMap((entry) => entry.sourceRecordIds)
  )
  const retainedSourceSet = new Set(retainedSourceRecordIds)
  const compactedSourceRecordIds = collectExactSourceRecordIds(
    state.activeHistoryEntries
      .flatMap((entry) => entry.sourceRecordIds)
      .filter(
        (sourceRecordId) =>
          !contextSourceRecordIds.has(sourceRecordId) &&
          !retainedSourceSet.has(sourceRecordId)
      )
  )

  const reownedRetainedEntries = retainedEntries.map((entry, index) => ({
    itemId: `${rolloutId}:retained:${index}`,
    rolloutId,
    bindingId: `${rolloutId}:retained:${index}`,
    item: cloneInputItem(entry.item),
    sourceRecordIds: [...entry.sourceRecordIds],
  }))
  const compactionEntry: CodexProjectionHistoryEntry = {
    itemId: `${rolloutId}:compaction`,
    rolloutId,
    bindingId: `${rolloutId}:compaction`,
    item: cloneInputItem(compactionInputItem),
    sourceRecordIds: compactedSourceRecordIds,
  }
  const contextEntries = currentContextEntries.map((entry, index) => ({
    itemId: `${rolloutId}:context:${index}`,
    rolloutId,
    bindingId: `${rolloutId}:context:${index}`,
    item: cloneInputItem(entry.item),
    sourceRecordIds: [...entry.sourceRecordIds],
  }))
  const compactedEntries = [...reownedRetainedEntries, compactionEntry]
  const installedEntries =
    input.injectionMode === "mid_turn"
      ? insertCodexContextBeforeLastRetainedUserOrCompaction(
          compactedEntries,
          contextEntries
        )
      : compactedEntries
  const currentWindow = state.activeWindow
  const windowNumber = currentWindow.windowNumber + 1
  const window: CodexProjectionWindow = {
    windowNumber,
    firstWindowId: currentWindow.firstWindowId,
    previousWindowId: currentWindow.windowId,
    windowId: buildCodexProjectionWindowId(nativeThreadId, windowNumber),
    createdAt,
    compactionId,
  }
  const contextSnapshot =
    input.injectionMode === "mid_turn"
      ? contextSnapshotFromState(state)
      : emptyContextSnapshot()

  setActiveHistoryEntries(state, installedEntries)
  applyContextSnapshot(state, contextSnapshot)
  state.historyVersion = state.historyVersion + 1
  state.projectionGeneration = state.projectionGeneration + 1
  state.activeWindow = window
  appendPendingRollout(state, {
    kind: "compacted",
    rolloutId,
    recordedAt: createdAt,
    compactionId,
    injectionMode: input.injectionMode,
    sourceHistoryHash,
    requestFingerprint,
    responseId,
    replacementEntries: installedEntries.map(cloneHistoryEntry),
    compactedSourceRecordIds,
    retainedSourceRecordIds,
    contextSnapshot,
    window: { ...window },
  })
  return window
}

/**
 * Native replacement removes exact source-bound items and optionally appends
 * replacement bindings in the same history rewrite. It never manufactures a
 * blank message to represent deletion.
 */
export function replaceCodexProjectionBindings(
  state: CodexProjectionState,
  input: CodexProjectionBindingReplacementInput
): void {
  assertNewRolloutId(state, input.rolloutId)
  const removeSourceRecordIds = collectExactSourceRecordIds(
    input.removeSourceRecordIds
  )
  if (removeSourceRecordIds.length === 0) {
    throw new Error(
      "Codex native history replacement requires source records to remove"
    )
  }
  const removed = new Set(removeSourceRecordIds)
  const targets = state.activeHistoryEntries.filter((entry) =>
    entry.sourceRecordIds.some((sourceRecordId) => removed.has(sourceRecordId))
  )
  const foundSourceIds = new Set(
    targets.flatMap((entry) =>
      entry.sourceRecordIds.filter((id) => removed.has(id))
    )
  )
  const missingSourceIds = removeSourceRecordIds.filter(
    (id) => !foundSourceIds.has(id)
  )
  if (missingSourceIds.length > 0) {
    throw new Error(
      `Codex native history replacement cannot remove inactive source records: ${missingSourceIds.join(", ")}`
    )
  }
  for (const target of targets) {
    const survivingSources = target.sourceRecordIds.filter(
      (id) => !removed.has(id)
    )
    if (survivingSources.length > 0) {
      throw new Error(
        `Codex native history replacement cannot partially remove opaque item ${target.itemId}; reconstruct the provider history from rollout instead`
      )
    }
  }

  const retainedEntries = state.activeHistoryEntries
    .filter(
      (entry) => !targets.some((target) => target.itemId === entry.itemId)
    )
    .map(cloneHistoryEntry)
  const appendBindings = input.appendBindings?.length
    ? materializeInputBindings(input.rolloutId, input.appendBindings)
    : []
  const activeSources = new Set(
    retainedEntries.flatMap((entry) => entry.sourceRecordIds)
  )
  for (const binding of appendBindings) {
    if (activeSources.has(binding.sourceRecordId)) {
      throw new Error(
        `Codex replacement attempted to append already-installed source record ${binding.sourceRecordId}`
      )
    }
    activeSources.add(binding.sourceRecordId)
  }
  const nextEntries = [
    ...retainedEntries,
    ...entriesFromInputBindings(input.rolloutId, appendBindings),
  ]
  const contextSnapshot = normalizeContextSnapshot(input.contextSnapshot)
  assertContextSnapshotCoverage(contextSnapshot, nextEntries)
  setActiveHistoryEntries(state, nextEntries)
  applyContextSnapshot(state, contextSnapshot)
  state.historyVersion = state.historyVersion + 1
  state.projectionGeneration = state.projectionGeneration + 1
  appendPendingRollout(state, {
    kind: "world_state",
    rolloutId: requireRolloutId(input.rolloutId),
    recordedAt: input.recordedAt ?? Date.now(),
    item: {
      type: "context_projection_patch",
      removeSourceRecordIds,
      appendBindings: (input.appendBindings ?? []).map((binding) => ({
        sourceRecordId: requireCodexIdentifier(
          binding.sourceRecordId,
          "world state source record id"
        ),
        items: binding.items.map(cloneInputItem),
      })),
      contextSnapshot,
    },
  })
}

/**
 * Replays a persisted rollout into the same active history as the original
 * session. The stored binding identities, not message content or array
 * offsets, decide coverage after compaction and rollback.
 */
export function replayCodexRollout(
  rollout: readonly CodexProjectionRolloutItem[],
  nativeThreadId: string
): CodexProjectionState {
  let state = createCodexProjectionState(nativeThreadId)
  for (const item of rollout) {
    switch (item.kind) {
      case "input_items":
        recordCodexInputBindings(state, {
          rolloutId: item.rolloutId,
          bindings: item.bindings,
          ...(item.contextSnapshot
            ? { contextSnapshot: item.contextSnapshot }
            : {}),
          recordedAt: item.recordedAt,
        })
        break
      case "response_item":
        recordCodexResponseItem(state, {
          rolloutId: item.rolloutId,
          item: item.item,
          recordedAt: item.recordedAt,
        })
        break
      case "source_records_linked":
        linkCodexSourceRecords(state, {
          rolloutId: item.rolloutId,
          targetItemId: item.targetItemId,
          sourceRecordIds: item.sourceRecordIds,
          recordedAt: item.recordedAt,
        })
        break
      case "compacted":
        replayCodexCompactionRecord(state, item)
        break
      case "world_state":
        assertCodexWorldStatePatch(item.item)
        replaceCodexProjectionBindings(state, {
          rolloutId: item.rolloutId,
          removeSourceRecordIds: item.item.removeSourceRecordIds,
          appendBindings: item.item.appendBindings,
          contextSnapshot: item.item.contextSnapshot,
          recordedAt: item.recordedAt,
        })
        break
      case "history_replaced":
        assertNewRolloutId(state, item.rolloutId)
        installCodexHistoryReplacement(state, {
          rolloutId: item.rolloutId,
          reason: item.reason,
          entries: item.entries,
          contextSnapshot: item.contextSnapshot,
          recordedAt: item.recordedAt,
        })
        break
      case "turn_context":
      case "event_msg":
      case "inter_agent":
        recordCodexRolloutMetadata(state, {
          rolloutId: item.rolloutId,
          kind: item.kind,
          item: item.item,
          recordedAt: item.recordedAt,
        })
        break
    }
    const replayed = state.pendingRollout
    if (
      replayed.length !== 1 ||
      stableCodexJsonStringify(replayed[0]) !== stableCodexJsonStringify(item)
    ) {
      throw new Error(
        `Codex replay did not reproduce durable rollout ${item.rolloutId}`
      )
    }
    state = commitCodexReplayedRollout(state)
  }
  return state
}

/**
 * Materializes the only durable transition produced by Remote Compaction V2.
 *
 * A prepared request may stage context replacement and input bindings so the
 * provider receives an exact source-mapped candidate. Those records do not
 * describe an accepted provider request and therefore cannot enter the
 * append-only rollout. The compaction record is self-contained: it owns the
 * installed entries, source coverage, context snapshot and next native
 * window. Replaying the durable prefix plus that one record must reproduce
 * the effective projection returned by the compaction working state.
 */
export function materializeCodexCompactionCommit(
  input: CodexCompactionCommitInput
): CodexProjectionState {
  const candidate = input.candidateProjectionState
  const compacted = input.compactedProjectionState
  const durableRolloutLength = input.durableRolloutLength
  if (
    !Number.isSafeInteger(durableRolloutLength) ||
    durableRolloutLength < 0 ||
    durableRolloutLength !== candidate.committedRollout.length
  ) {
    throw new Error("Codex compaction has an invalid durable rollout boundary")
  }
  assertProjectionNativeThread(
    compacted,
    candidate.nativeThreadId,
    "compaction derivative"
  )
  assertSameCommittedRollout(
    candidate.committedRollout,
    compacted.committedRollout,
    "compaction derivative"
  )
  if (compacted.pendingRollout.length !== candidate.pendingRollout.length + 1) {
    throw new Error(
      "Codex compaction transaction must add exactly one rollout record to its prepared candidate"
    )
  }
  if (
    stableCodexJsonStringify(
      compacted.pendingRollout.slice(0, candidate.pendingRollout.length)
    ) !== stableCodexJsonStringify(candidate.pendingRollout)
  ) {
    throw new Error(
      "Codex compaction transaction does not derive from its prepared candidate"
    )
  }

  const compaction = compacted.pendingRollout.at(-1)!
  if (compaction.kind !== "compacted") {
    throw new Error(
      "Codex compaction transaction must terminate in one compacted response item"
    )
  }
  if (
    compaction.sourceHistoryHash !==
    hashCodexNativeItems(candidate.activeHistory)
  ) {
    throw new Error(
      "Codex compaction transaction was built from a different prepared native history"
    )
  }

  const installed = forkCodexProjectionState(compacted)
  installed.committedRollout = candidate.committedRollout
  installed.pendingRollout = [cloneRolloutItem(compaction)]
  // Candidate-only context/input staging was never accepted as an
  // independent provider transition. The durable compaction is one native
  // history replacement from the mounted base, so its generation advances
  // exactly once and cold replay can reproduce the active head.
  installed.historyVersion = candidate.committedRollout.historyVersion + 1
  installed.projectionGeneration =
    candidate.committedRollout.projectionGeneration + 1
  if (
    stableCodexJsonStringify(compactionProjectionSurface(installed)) !==
    stableCodexJsonStringify(compactionProjectionSurface(compacted))
  ) {
    throw new Error(
      "Codex compacted response cannot reproduce its installed native projection"
    )
  }
  return installed
}

/**
 * Mirrors Codex's user-turn rollback boundary. The selected user turn is cut
 * at its owning source/response rollout identity, so every source record in
 * the removed native item disappears from coverage as well.
 */
export function rollbackCodexProjectionUserTurns(
  state: CodexProjectionState,
  input: CodexRollbackInput
): CodexRollbackResult {
  const requested = Math.max(0, Math.floor(input.numTurns))
  if (requested === 0) {
    return {
      removedUserTurns: 0,
      retainedItemCount: state.activeHistory.length,
    }
  }
  assertNewRolloutId(state, input.rolloutId)

  const userIndexes: number[] = []
  for (let index = 0; index < state.activeHistoryEntries.length; index++) {
    if (isCodexUserTurnBoundary(state.activeHistoryEntries[index]?.item)) {
      userIndexes.push(index)
    }
  }
  if (userIndexes.length === 0) {
    return {
      removedUserTurns: 0,
      retainedItemCount: state.activeHistory.length,
    }
  }

  const firstRemovedTurn = Math.max(0, userIndexes.length - requested)
  const selectedEntry =
    state.activeHistoryEntries[userIndexes[firstRemovedTurn]!]!
  const cutoff = state.activeHistoryEntries.findIndex(
    (entry) => entry.bindingId === selectedEntry.bindingId
  )
  if (cutoff < 0) {
    throw new Error(
      `Codex rollback could not resolve binding identity ${selectedEntry.bindingId}`
    )
  }
  const retainedEntries = state.activeHistoryEntries
    .slice(0, cutoff)
    .map(cloneHistoryEntry)
  const contextSnapshot = deriveContextSnapshotForEntries(
    state,
    retainedEntries
  )
  installCodexHistoryReplacement(state, {
    rolloutId: input.rolloutId,
    reason: "rollback",
    entries: retainedEntries,
    contextSnapshot,
    recordedAt: input.recordedAt ?? Date.now(),
  })
  return {
    removedUserTurns: userIndexes.length - firstRemovedTurn,
    retainedItemCount: state.activeHistory.length,
  }
}

/**
 * Builds a model prompt without modifying active history. The installed
 * rollout is canonical, so a malformed tool pair fails before it can reach
 * the provider; this projection never fabricates or removes native items.
 */
export function projectCodexPrompt(
  state: CodexProjectionState,
  options: CodexPromptProjectionOptions = {}
): CodexPromptProjection {
  const source = [
    ...state.activeHistory.map(cloneInputItem),
    ...(options.reinjectedItems ?? []).map(cloneInputItem),
  ]
  // API-invisible rollout metadata is not prompt input. This is a provider
  // visibility boundary, distinct from tool-pair validation: no visible item
  // is fabricated, removed, or otherwise repaired below.
  const input = source.filter(isCodexApiVisibleInputItem)
  assertCodexPromptToolPairs(input)
  const sourceItemIds = source
    .map(extractCodexInputItemId)
    .filter((id): id is string => !!id)
  const toolCatalogHash = options.tools
    ? hashCodexToolCatalog(options.tools)
    : undefined
  const settingsHash = options.settings
    ? hashCodexProjectionSettings(options.settings)
    : undefined

  return {
    input,
    manifest: {
      provider: "codex",
      historyVersion: state.historyVersion,
      projectionGeneration: state.projectionGeneration,
      activeWindow: { ...state.activeWindow },
      sourceItemCount: source.length,
      sourceItemIds,
      sourceRecordIds: [...state.projectedSourceRecordIds],
      outputItemCount: input.length,
      toolCatalogHash,
      settingsHash,
      reinjectedItemCount: options.reinjectedItems?.length ?? 0,
    },
  }
}

/**
 * Builds the exact provider-native pre-trigger window for Remote Compaction
 * V2. Codex normalizes its history before compaction so the wire request never
 * contains an unmatched client call. The bridge retains the stricter durable
 * invariant: real graph outputs must be synchronized at the compaction
 * boundary rather than fabricating an "aborted" output at send time.
 */
export function projectCodexRemoteCompactionV2Input(
  state: CodexProjectionState
): CodexInputItem[] {
  const input = state.activeHistory
    .filter(isCodexApiVisibleInputItem)
    .map(cloneInputItem)
  assertCodexPromptToolPairs(input)
  return input
}

/**
 * Native rollout data has one source of truth. A missing or orphaned tool
 * output is therefore a write-path integrity fault, not a prompt-time repair
 * opportunity. This deliberately uses the strict branch of the upstream
 * Codex invariant rather than its release-mode synthetic-output fallback.
 */
export function assertCodexPromptToolPairs(
  items: readonly CodexInputItem[]
): void {
  const calls = new Map<string, CodexPromptCall>()
  const outputs = new Set<string>()

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    const type = getCodexItemType(item)
    if (!isCodexApiVisibleInputItem(item)) {
      throw new CodexPromptToolPairIntegrityError(
        `item ${index} (${type}) is not API-visible`
      )
    }

    const callType = getCodexPromptCallType(item)
    if (callType) {
      const callId = getCodexPromptCallId(item)
      if (!callId) {
        throw new CodexPromptToolPairIntegrityError(
          `item ${index} (${callType}) has no call_id`
        )
      }
      const previous = calls.get(callId)
      if (previous) {
        throw new CodexPromptToolPairIntegrityError(
          `item ${index} (${callType}) duplicates call_id ${callId} from item ${previous.index} (${previous.type})`
        )
      }
      calls.set(callId, { index, type: callType })
      continue
    }

    const outputType = getCodexPromptOutputType(item)
    if (!outputType) continue
    const callId = getCodexPromptCallId(item)
    if (!callId) {
      throw new CodexPromptToolPairIntegrityError(
        `item ${index} (${outputType}) has no call_id`
      )
    }
    const call = calls.get(callId)
    if (!call) {
      throw new CodexPromptToolPairIntegrityError(
        `item ${index} (${outputType}) is orphaned for call_id ${callId}`
      )
    }
    if (!isCodexPromptOutputCompatible(call.type, outputType)) {
      throw new CodexPromptToolPairIntegrityError(
        `item ${index} (${outputType}) does not match ${call.type} for call_id ${callId}`
      )
    }
    if (outputs.has(callId)) {
      throw new CodexPromptToolPairIntegrityError(
        `item ${index} (${outputType}) duplicates output for call_id ${callId}`
      )
    }
    outputs.add(callId)
  }

  const missing = [...calls.entries()]
    .filter(([callId]) => !outputs.has(callId))
    .map(([callId, call]) => `${callId} (item ${call.index}, ${call.type})`)
  if (missing.length > 0) {
    throw new CodexPromptToolPairIntegrityError(
      `calls without committed outputs: ${missing.join(", ")}`
    )
  }
}

export function hashCodexToolCatalog(
  tools: readonly (CodexTool | CodexConversationTool)[]
): string {
  const normalized = tools
    .map((tool) => cloneJson(tool))
    .sort((left, right) =>
      stableCodexJsonStringify(left).localeCompare(
        stableCodexJsonStringify(right)
      )
    )
  return hashCodexProjectionValue(normalized)
}

export function hashCodexProjectionSettings(
  settings: Record<string, unknown>
): string {
  return hashCodexProjectionValue(settings)
}

function installCodexHistoryReplacement(
  state: CodexProjectionState,
  input: {
    rolloutId: string
    reason: "replace" | "rollback"
    entries: readonly CodexProjectionHistoryEntry[]
    contextSnapshot: CodexProjectionContextSnapshot
    recordedAt: number
  }
): void {
  const rolloutId = requireRolloutId(input.rolloutId)
  assertStoredHistoryEntries(rolloutId, input.entries)
  const contextSnapshot = normalizeContextSnapshot(input.contextSnapshot)
  assertContextSnapshotCoverage(contextSnapshot, input.entries)
  setActiveHistoryEntries(state, input.entries)
  applyContextSnapshot(state, contextSnapshot)
  state.historyVersion = state.historyVersion + 1
  state.projectionGeneration = state.projectionGeneration + 1
  appendPendingRollout(state, {
    kind: "history_replaced",
    rolloutId,
    recordedAt: input.recordedAt,
    reason: input.reason,
    entries: input.entries.map(cloneHistoryEntry),
    contextSnapshot,
  })
}

function setActiveHistoryEntries(
  state: CodexProjectionState,
  entries: readonly CodexProjectionHistoryEntry[]
): void {
  state.activeHistoryEntries = entries.map(cloneHistoryEntry)
  state.activeHistory = state.activeHistoryEntries.map((entry) =>
    cloneInputItem(entry.item)
  )
  state.projectedSourceRecordIds = collectExactSourceRecordIds(
    state.activeHistoryEntries.flatMap((entry) => entry.sourceRecordIds)
  )
}

/** Response output can map to several graph fragments from one rendered turn. */
function isCodexResponseHistoryEntry(
  entry: CodexProjectionHistoryEntry
): boolean {
  return entry.itemId === entry.bindingId
}

function materializeInputBindings(
  rolloutIdValue: string,
  inputs: readonly CodexProjectionInputBindingInput[]
): CodexProjectionInputBinding[] {
  const rolloutId = requireRolloutId(rolloutIdValue)
  if (inputs.length === 0) {
    throw new Error(
      "Codex input rollout requires at least one exact source binding"
    )
  }
  const seenSourceIds = new Set<string>()
  return inputs.map((input, index) => {
    const sourceRecordId = requireCodexIdentifier(
      input.sourceRecordId,
      "source record id"
    )
    if (seenSourceIds.has(sourceRecordId)) {
      throw new Error(
        `Codex input rollout ${rolloutId} contains duplicate source record ${sourceRecordId}`
      )
    }
    seenSourceIds.add(sourceRecordId)
    if (input.items.length === 0) {
      throw new Error(
        `Codex source record ${sourceRecordId} produced no native input items`
      )
    }
    return {
      bindingId: `${rolloutId}:binding:${index}`,
      sourceRecordId,
      items: input.items.map(cloneInputItem),
    }
  })
}

function entriesFromInputBindings(
  rolloutIdValue: string,
  bindings: readonly CodexProjectionInputBinding[]
): CodexProjectionHistoryEntry[] {
  const rolloutId = requireRolloutId(rolloutIdValue)
  return bindings.flatMap((binding) =>
    binding.items.map((item, index) => ({
      itemId: `${binding.bindingId}:item:${index}`,
      rolloutId,
      bindingId: binding.bindingId,
      item: cloneInputItem(item),
      sourceRecordIds: [binding.sourceRecordId],
    }))
  )
}

function assertStoredHistoryEntries(
  rolloutId: string,
  entries: readonly CodexProjectionHistoryEntry[]
): void {
  const itemIds = new Set<string>()
  for (const entry of entries) {
    const itemId = requireCodexIdentifier(entry.itemId, "history item id")
    const entryRolloutId = requireRolloutId(entry.rolloutId)
    const bindingId = requireCodexIdentifier(
      entry.bindingId,
      "history binding id"
    )
    if (itemIds.has(itemId)) {
      throw new Error(
        `Codex history replacement ${rolloutId} has duplicate item ${itemId}`
      )
    }
    if (!entryRolloutId) {
      throw new Error(
        `Codex history replacement ${rolloutId} has an empty item rollout id`
      )
    }
    if (!bindingId) {
      throw new Error(
        `Codex history replacement ${rolloutId} has an empty binding id`
      )
    }
    itemIds.add(itemId)
  }
}

function normalizeContextSnapshot(
  snapshot: CodexProjectionContextSnapshot
): CodexProjectionContextSnapshot {
  const signatures = { ...snapshot.signatures }
  const roles = { ...snapshot.roles }
  const sourceRecordIdsByKey = { ...snapshot.sourceRecordIdsByKey }
  const keys = new Set([
    ...Object.keys(signatures),
    ...Object.keys(roles),
    ...Object.keys(sourceRecordIdsByKey),
  ])
  for (const key of keys) {
    const contextKey = requireCodexIdentifier(key, "context snapshot key")
    if (
      typeof signatures[key] !== "string" ||
      (roles[key] !== "developer" && roles[key] !== "user") ||
      typeof sourceRecordIdsByKey[key] !== "string"
    ) {
      throw new Error(
        `Codex context snapshot key ${contextKey} requires signature, role, and source record id`
      )
    }
    requireCodexIdentifier(
      signatures[key],
      `context snapshot signature for ${contextKey}`
    )
    sourceRecordIdsByKey[key] = requireCodexIdentifier(
      sourceRecordIdsByKey[key],
      `context snapshot source record id for ${contextKey}`
    )
  }
  return { signatures, roles, sourceRecordIdsByKey }
}

function assertCodexWorldStatePatch(
  item: CodexProjectionWorldStatePatch
): asserts item is CodexProjectionWorldStatePatch {
  if (
    !item ||
    typeof item !== "object" ||
    item.type !== "context_projection_patch" ||
    !Array.isArray(item.removeSourceRecordIds) ||
    !Array.isArray(item.appendBindings) ||
    !item.contextSnapshot ||
    typeof item.contextSnapshot !== "object"
  ) {
    throw new Error(
      "Codex world_state record is not a context projection patch"
    )
  }
}

function assertContextSnapshotCoverage(
  snapshot: CodexProjectionContextSnapshot,
  entries: readonly CodexProjectionHistoryEntry[]
): void {
  const normalized = normalizeContextSnapshot(snapshot)
  const covered = new Set(entries.flatMap((entry) => entry.sourceRecordIds))
  for (const [key, sourceRecordId] of Object.entries(
    normalized.sourceRecordIdsByKey
  )) {
    if (!covered.has(sourceRecordId)) {
      throw new Error(
        `Codex context key ${key} references inactive source binding ${sourceRecordId}`
      )
    }
  }
}

function applyContextSnapshot(
  state: CodexProjectionState,
  snapshot: CodexProjectionContextSnapshot
): void {
  const normalized = normalizeContextSnapshot(snapshot)
  state.contextSignatures = { ...normalized.signatures }
  state.contextRoles = { ...normalized.roles }
  state.contextSourceRecordIds = { ...normalized.sourceRecordIdsByKey }
}

function contextSnapshotFromState(
  state: CodexProjectionState
): CodexProjectionContextSnapshot {
  return {
    signatures: { ...state.contextSignatures },
    roles: { ...state.contextRoles },
    sourceRecordIdsByKey: { ...state.contextSourceRecordIds },
  }
}

function emptyContextSnapshot(): CodexProjectionContextSnapshot {
  return {
    signatures: {},
    roles: {},
    sourceRecordIdsByKey: {},
  }
}

function assertCodexCompactionGeneration(
  state: CodexProjectionState,
  input: CodexCompactionInstallInput
): void {
  const expectedWindowId = requireCodexIdentifier(
    input.expectedWindowId,
    "expected compaction window id"
  )
  if (
    state.historyVersion !== input.expectedHistoryVersion ||
    state.projectionGeneration !== input.expectedProjectionGeneration ||
    state.activeWindow.windowId !== expectedWindowId
  ) {
    throw new Error(
      "Codex Remote Compaction V2 result is stale: " +
        `expected history=${input.expectedHistoryVersion} generation=${input.expectedProjectionGeneration} window=${expectedWindowId}, ` +
        `current history=${state.historyVersion} generation=${state.projectionGeneration} window=${state.activeWindow.windowId}`
    )
  }
}

function assertCodexRemoteCompactionV2Input(
  state: CodexProjectionState,
  input: CodexCompactionInstallInput
): void {
  if (
    stableCodexJsonStringify(input.rawHistory) !==
    stableCodexJsonStringify(state.activeHistory)
  ) {
    throw new Error(
      "Codex Remote Compaction V2 raw history does not match the installed native history"
    )
  }

  const expectedPreTriggerInput = projectCodexRemoteCompactionV2Input(state)
  assertCodexCompactionInputDerivesFromInstalledHistory(
    expectedPreTriggerInput,
    input.preTriggerInput
  )
  assertCodexRemoteCompactionV2AuditInput(input)
}

function assertCodexCompactionInputDerivesFromInstalledHistory(
  installed: readonly CodexInputItem[],
  prepared: readonly CodexInputItem[]
): void {
  if (installed.length !== prepared.length) {
    throw new Error(
      "Codex Remote Compaction V2 pre-trigger input changed the installed item count"
    )
  }
  let firstRewrite = -1
  for (let index = 0; index < installed.length; index++) {
    if (
      stableCodexJsonStringify(installed[index]) !==
      stableCodexJsonStringify(prepared[index])
    ) {
      firstRewrite = index
      break
    }
  }
  if (firstRewrite < 0) return

  for (let index = firstRewrite; index < installed.length; index++) {
    const original = installed[index]!
    const actual = prepared[index]!
    const expected = codexCompactionOverflowRewrite(original)
    if (
      !expected ||
      stableCodexJsonStringify(actual) !== stableCodexJsonStringify(expected)
    ) {
      throw new Error(
        `Codex Remote Compaction V2 pre-trigger input changed native item ${index} outside the trailing tool-output overflow rewrite`
      )
    }
  }
}

function codexCompactionOverflowRewrite(
  item: CodexInputItem
): CodexInputItem | undefined {
  if (
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  ) {
    const rewritten = structuredClone(item)
    rewritten.output = CODEX_CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE
    return rewritten
  }
  if (item.type === "tool_search_output") {
    const rewritten = structuredClone(item)
    rewritten.tools = []
    return rewritten
  }
  return undefined
}

function assertCodexRemoteCompactionV2AuditInput(input: {
  preTriggerInput: readonly CodexInputItem[]
  requestInput: readonly CodexInputItem[]
  wireInput: readonly CodexInputItem[]
}): void {
  if (
    input.preTriggerInput.some((item) => item.type === "compaction_trigger")
  ) {
    throw new Error(
      "Codex Remote Compaction V2 pre-trigger input already contains a compaction trigger"
    )
  }

  const expectedRequestInput: CodexInputItem[] = [
    ...input.preTriggerInput.map(cloneInputItem),
    { type: "compaction_trigger" },
  ]
  if (
    stableCodexJsonStringify(input.requestInput) !==
    stableCodexJsonStringify(expectedRequestInput)
  ) {
    throw new Error(
      "Codex Remote Compaction V2 request input must equal the pre-trigger input plus one final compaction trigger"
    )
  }
  const wireTriggerIndexes = input.wireInput.flatMap((item, index) =>
    item.type === "compaction_trigger" ? [index] : []
  )
  if (
    wireTriggerIndexes.length !== 1 ||
    wireTriggerIndexes[0] !== input.wireInput.length - 1
  ) {
    throw new Error(
      "Codex Remote Compaction V2 transport input must end with exactly one compaction trigger"
    )
  }
}

/**
 * Replays the accepted compaction event rather than re-running its discarded
 * request candidate. Candidate-only context replacement and current-turn
 * bindings are audit inputs of the compacted event; they are not independent
 * durable rollout rows.
 */
function replayCodexCompactionRecord(
  state: CodexProjectionState,
  item: Extract<CodexProjectionRolloutItem, { kind: "compacted" }>
): void {
  assertNewRolloutId(state, item.rolloutId)
  if (!/^[a-f0-9]{64}$/.test(item.sourceHistoryHash)) {
    throw new Error(
      `Codex replay compaction ${item.rolloutId} has an invalid source-history digest`
    )
  }
  if (!/^[a-f0-9]{64}$/.test(item.requestFingerprint)) {
    throw new Error(
      `Codex replay compaction ${item.rolloutId} has an invalid request fingerprint`
    )
  }
  assertStoredHistoryEntries(item.rolloutId, item.replacementEntries)
  if (
    item.replacementEntries.some((entry) => entry.rolloutId !== item.rolloutId)
  ) {
    throw new Error(
      `Codex replay compaction ${item.rolloutId} contains entries owned by another rollout`
    )
  }
  assertContextSnapshotCoverage(item.contextSnapshot, item.replacementEntries)

  const installedCompactions = item.replacementEntries.filter(
    (entry) => entry.item.type === "compaction"
  )
  if (installedCompactions.length !== 1) {
    throw new Error(
      `Codex replay compaction ${item.rolloutId} does not install one compaction item`
    )
  }

  const previousWindow = state.activeWindow
  assertCodexProjectionWindow(
    item.window,
    state.nativeThreadId,
    undefined,
    "replayed compaction"
  )
  if (
    item.window.windowNumber !== previousWindow.windowNumber + 1 ||
    item.window.firstWindowId !== previousWindow.firstWindowId ||
    item.window.previousWindowId !== previousWindow.windowId ||
    item.window.compactionId !== item.compactionId
  ) {
    throw new Error(
      `Codex replay compaction ${item.rolloutId} breaks native window lineage`
    )
  }

  const installedSourceIds = collectExactSourceRecordIds(
    item.replacementEntries.flatMap((entry) => entry.sourceRecordIds)
  ).sort()
  const compactedSourceIds = new Set(item.compactedSourceRecordIds)
  const retainedSourceIds = new Set(item.retainedSourceRecordIds)
  const contextSourceIds = new Set(
    Object.values(item.contextSnapshot.sourceRecordIdsByKey)
  )
  if (
    [...compactedSourceIds].some(
      (sourceRecordId) =>
        retainedSourceIds.has(sourceRecordId) ||
        contextSourceIds.has(sourceRecordId)
    ) ||
    [...retainedSourceIds].some((sourceRecordId) =>
      contextSourceIds.has(sourceRecordId)
    )
  ) {
    throw new Error(
      `Codex replay compaction ${item.rolloutId} classifies one source more than once`
    )
  }
  const classifiedSourceIds = collectExactSourceRecordIds([
    ...item.compactedSourceRecordIds,
    ...item.retainedSourceRecordIds,
    ...Object.values(item.contextSnapshot.sourceRecordIdsByKey),
  ]).sort()
  if (
    stableCodexJsonStringify(installedSourceIds) !==
    stableCodexJsonStringify(classifiedSourceIds)
  ) {
    throw new Error(
      `Codex replay compaction ${item.rolloutId} has inconsistent source coverage`
    )
  }

  setActiveHistoryEntries(state, item.replacementEntries)
  applyContextSnapshot(state, item.contextSnapshot)
  state.historyVersion += 1
  state.projectionGeneration += 1
  state.activeWindow = { ...item.window }
  appendPendingRollout(state, cloneRolloutItem(item))
}

function retainCodexRemoteCompactionV2UserSuffix(
  entries: readonly CodexProjectionHistoryEntry[]
): CodexProjectionHistoryEntry[] {
  let remaining = REMOTE_COMPACTION_V2_RETAINED_MESSAGE_TOKEN_BUDGET
  const retainedReversed: CodexProjectionHistoryEntry[] = []
  for (let index = entries.length - 1; index >= 0; index--) {
    if (remaining === 0) continue
    const entry = entries[index]!
    const tokenCount = Math.max(1, countCodexMessageTextTokens(entry.item))
    if (tokenCount <= remaining) {
      retainedReversed.push(cloneHistoryEntry(entry))
      remaining = Math.max(0, remaining - tokenCount)
      continue
    }
    const truncated = truncateCodexMessageToTokenBudget(entry, remaining)
    if (truncated) retainedReversed.push(truncated)
    remaining = 0
  }
  retainedReversed.reverse()
  return retainedReversed
}

/**
 * First Remote Compaction V2 retention stage from Codex core: only message
 * items with a user/developer/system role are candidates.
 */
function isCodexRemoteCompactionV2RetentionCandidate(
  item: CodexInputItem
): boolean {
  const record = item as Record<string, unknown>
  return (
    item.type === "message" &&
    (record.role === "user" ||
      record.role === "developer" ||
      record.role === "system") &&
    Array.isArray(record.content)
  )
}

/**
 * Second Remote Compaction V2 retention stage.  Codex rebuilds canonical
 * developer/system context after compaction, so those items are intentionally
 * excluded from the retained history.  Native context bindings are excluded
 * before this function; the remaining user messages are the durable turn
 * inputs represented by this bridge's typed projection state.
 */
function shouldKeepCodexRemoteCompactionV2Item(item: CodexInputItem): boolean {
  const record = item as Record<string, unknown>
  return (
    item.type === "message" &&
    record.role === "user" &&
    Array.isArray(record.content)
  )
}

function isCodexRetainedUserMessage(item: CodexInputItem): boolean {
  return shouldKeepCodexRemoteCompactionV2Item(item)
}

function countCodexMessageTextTokens(item: CodexInputItem): number {
  if (!isCodexRetainedUserMessage(item)) return 0
  const content = (item as { content: unknown[] }).content
  return content.reduce<number>((total, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return total
    }
    const block = value as Record<string, unknown>
    return (block.type === "input_text" || block.type === "output_text") &&
      typeof block.text === "string"
      ? total + countCodexApproxTokens(block.text)
      : total
  }, 0)
}

function truncateCodexMessageToTokenBudget(
  entry: CodexProjectionHistoryEntry,
  maxTokens: number
): CodexProjectionHistoryEntry | undefined {
  if (!isCodexRetainedUserMessage(entry.item)) {
    return cloneHistoryEntry(entry)
  }
  const item = cloneInputItem(entry.item) as CodexInputItem & {
    content: Array<Record<string, unknown>>
  }
  let remaining = Math.max(0, Math.floor(maxTokens))
  const content: Array<Record<string, unknown>> = []
  for (const original of item.content) {
    const block = cloneJson(original)
    if (
      (block.type === "input_text" || block.type === "output_text") &&
      typeof block.text === "string"
    ) {
      if (remaining === 0) continue
      const originalText = block.text
      const tokenCount = countCodexApproxTokens(originalText)
      if (tokenCount <= remaining) {
        remaining = Math.max(0, remaining - tokenCount)
      } else {
        block.text = truncateCodexTextByTokens(originalText, remaining)
        remaining = 0
      }
      if (typeof block.text === "string" && block.text.length > 0) {
        content.push(block)
      }
      continue
    }
    // Images do not consume the retained text budget in Codex core.
    if (block.type === "input_image") content.push(block)
  }
  if (content.length === 0) return undefined
  item.content = content
  return {
    ...cloneHistoryEntry(entry),
    item,
  }
}

function insertCodexContextBeforeLastRetainedUserOrCompaction(
  compactedEntries: readonly CodexProjectionHistoryEntry[],
  contextEntries: readonly CodexProjectionHistoryEntry[]
): CodexProjectionHistoryEntry[] {
  const result = compactedEntries.map(cloneHistoryEntry)
  if (contextEntries.length === 0) return result
  let insertionIndex = -1
  for (let index = result.length - 1; index >= 0; index--) {
    if (isCodexRetainedUserMessage(result[index]!.item)) {
      insertionIndex = index
      break
    }
  }
  if (insertionIndex < 0) {
    for (let index = result.length - 1; index >= 0; index--) {
      if (result[index]!.item.type === "compaction") {
        insertionIndex = index
        break
      }
    }
  }
  if (insertionIndex < 0) insertionIndex = result.length
  result.splice(insertionIndex, 0, ...contextEntries.map(cloneHistoryEntry))
  return result
}

function deriveContextSnapshotForEntries(
  state: CodexProjectionState,
  entries: readonly CodexProjectionHistoryEntry[]
): CodexProjectionContextSnapshot {
  const activeSources = new Set(
    entries.flatMap((entry) => entry.sourceRecordIds)
  )
  const signatures: Record<string, string> = {}
  const roles: Record<string, CodexContextRole> = {}
  const sourceRecordIdsByKey: Record<string, string> = {}
  for (const [key, sourceRecordId] of Object.entries(
    state.contextSourceRecordIds
  )) {
    if (!activeSources.has(sourceRecordId)) continue
    const signature = state.contextSignatures[key]
    const role = state.contextRoles[key]
    if (!signature || !role) continue
    signatures[key] = signature
    roles[key] = role
    sourceRecordIdsByKey[key] = sourceRecordId
  }
  return { signatures, roles, sourceRecordIdsByKey }
}

function assertSameInputRollout(
  existing: Extract<CodexProjectionRolloutItem, { kind: "input_items" }>,
  input: CodexRecordInputBindingsInput
): void {
  const expected = input.bindings.map((binding) => ({
    sourceRecordId: requireCodexIdentifier(
      binding.sourceRecordId,
      "source record id"
    ),
    items: binding.items,
  }))
  const actual = existing.bindings.map((binding) => ({
    sourceRecordId: binding.sourceRecordId,
    items: binding.items,
  }))
  if (stableCodexJsonStringify(actual) !== stableCodexJsonStringify(expected)) {
    throw new Error(
      `Codex input rollout ${input.rolloutId} was retried with different source bindings`
    )
  }
  const expectedSnapshot = input.contextSnapshot
    ? normalizeContextSnapshot(input.contextSnapshot)
    : undefined
  if (
    stableCodexJsonStringify(existing.contextSnapshot) !==
    stableCodexJsonStringify(expectedSnapshot)
  ) {
    throw new Error(
      `Codex input rollout ${input.rolloutId} was retried with a different context snapshot`
    )
  }
}

function assertSameSourceLink(
  existing: Extract<
    CodexProjectionRolloutItem,
    { kind: "source_records_linked" }
  >,
  input: CodexSourceRecordLinkInput
): void {
  if (
    existing.targetItemId !== input.targetItemId ||
    stableCodexJsonStringify(existing.sourceRecordIds) !==
      stableCodexJsonStringify(
        collectExactSourceRecordIds(input.sourceRecordIds)
      )
  ) {
    throw new Error(
      `Codex source link rollout ${input.rolloutId} was retried with different binding data`
    )
  }
}

function assertSameCompaction(
  existing: Extract<CodexProjectionRolloutItem, { kind: "compacted" }>,
  input: CodexCompactionInstallInput
): void {
  if (
    existing.compactionId !==
      requireCodexIdentifier(input.compactionId, "compaction id") ||
    existing.injectionMode !== input.injectionMode ||
    existing.sourceHistoryHash !== hashCodexNativeItems(input.rawHistory) ||
    existing.requestFingerprint !== hashCodexCompactionInstallInput(input) ||
    existing.responseId !==
      requireCodexIdentifier(input.responseId, "response id")
  ) {
    throw new Error(
      `Codex compaction rollout ${input.rolloutId} was retried with a different payload`
    )
  }
}

function appendPendingRollout(
  state: CodexProjectionState,
  item: CodexProjectionRolloutItem
): void {
  if (
    findPendingRolloutItem(state, item.rolloutId) ||
    findCommittedRolloutIdentity(state, item.rolloutId)
  ) {
    throw new Error(
      `Codex rollout identity ${item.rolloutId} already exists before append`
    )
  }
  state.pendingRollout.push(item)
}

/**
 * Cold replay owns an unshared cursor until the final mounted state is
 * returned. Reuse its local indexes while advancing rows so reconstructing a
 * long durable ledger stays O(n), rather than copying the entire identity map
 * once per historical row.
 */
function commitCodexReplayedRollout(
  state: CodexProjectionState
): CodexProjectionState {
  if (state.pendingRollout.length !== 1) {
    throw new Error(
      "Codex cold replay must commit exactly one durable rollout row at a time"
    )
  }
  return {
    ...state,
    committedRollout: extendCommittedRollout(
      state.committedRollout,
      state.pendingRollout,
      state,
      false
    ),
    pendingRollout: [],
  }
}

function findPendingRolloutItem(
  state: CodexProjectionState,
  rolloutId: string
): CodexProjectionRolloutItem | undefined {
  const normalized = requireRolloutId(rolloutId)
  return state.pendingRollout.find((item) => item.rolloutId === normalized)
}

function findCommittedRolloutIdentity(
  state: CodexProjectionState,
  rolloutId: string
): CodexProjectionRolloutIdentity | undefined {
  return state.committedRollout.activeWindowIdentities.get(
    requireRolloutId(rolloutId)
  )
}

function findResponseRolloutByNativeItemId(
  state: CodexProjectionState,
  nativeItemId: string
): CodexProjectionRolloutIdentity | undefined {
  const pending = state.pendingRollout.find(
    (
      item
    ): item is Extract<CodexProjectionRolloutItem, { kind: "response_item" }> =>
      item.kind === "response_item" && item.nativeItemId === nativeItemId
  )
  return pending
    ? buildCodexRolloutIdentity(pending)
    : state.committedRollout.activeWindowResponseItemsByNativeId.get(
        nativeItemId
      )
}

function assertNewRolloutId(
  state: CodexProjectionState,
  rolloutId: string
): void {
  const existing =
    findPendingRolloutItem(state, rolloutId) ||
    findCommittedRolloutIdentity(state, rolloutId)
  if (existing) {
    throw new Error(
      `Codex rollout identity ${requireRolloutId(rolloutId)} already exists as ${existing.kind}`
    )
  }
}

function extendCommittedRollout(
  base: CodexProjectionRolloutCursor,
  items: readonly CodexProjectionRolloutItem[],
  state: CodexProjectionState,
  copyIndexes: boolean = true
): CodexProjectionRolloutCursor {
  let replacementIndex = -1
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.kind === "compacted" || item.kind === "history_replaced") {
      replacementIndex = index
      break
    }
  }
  const activeItems =
    replacementIndex >= 0 ? items.slice(replacementIndex) : items
  const identities =
    replacementIndex >= 0
      ? new Map<string, CodexProjectionRolloutIdentity>()
      : copyIndexes
        ? new Map(base.activeWindowIdentities)
        : (base.activeWindowIdentities as Map<
            string,
            CodexProjectionRolloutIdentity
          >)
  const responseItemsByNativeId =
    replacementIndex >= 0
      ? new Map<string, CodexProjectionRolloutIdentity>()
      : copyIndexes
        ? new Map(base.activeWindowResponseItemsByNativeId)
        : (base.activeWindowResponseItemsByNativeId as Map<
            string,
            CodexProjectionRolloutIdentity
          >)
  let lastIdentity: CodexProjectionRolloutIdentity | undefined
  for (const item of activeItems) {
    const identity = buildCodexRolloutIdentity(item)
    if (identities.has(identity.rolloutId)) {
      throw new Error(
        `Codex committed rollout repeats identity ${identity.rolloutId}`
      )
    }
    identities.set(identity.rolloutId, identity)
    if (identity.nativeItemId) {
      const existing = responseItemsByNativeId.get(identity.nativeItemId)
      if (
        existing &&
        (existing.payloadHash !== identity.payloadHash ||
          existing.rolloutId !== identity.rolloutId)
      ) {
        throw new Error(
          `Codex committed rollout repeats native response item ${identity.nativeItemId}`
        )
      }
      responseItemsByNativeId.set(identity.nativeItemId, identity)
    }
    lastIdentity = identity
  }
  if (!lastIdentity) return base
  const lastItem = items.at(-1)!
  return {
    length: base.length + items.length,
    lastRolloutId: lastIdentity.rolloutId,
    lastKind: lastIdentity.kind,
    lastHeadId: getCodexRolloutHeadId(lastItem),
    historyVersion: state.historyVersion,
    projectionGeneration: state.projectionGeneration,
    activeWindowId: state.activeWindow.windowId,
    projectedSourceRecordCount: state.projectedSourceRecordIds.length,
    activeWindowIdentities: identities,
    activeWindowResponseItemsByNativeId: responseItemsByNativeId,
  }
}

function buildCodexRolloutIdentity(
  item: CodexProjectionRolloutItem
): CodexProjectionRolloutIdentity {
  return {
    rolloutId: requireRolloutId(item.rolloutId),
    kind: item.kind,
    payloadHash: hashCodexRolloutSemanticPayload(item),
    ...(item.kind === "response_item" && item.itemIdentity
      ? { itemIdentity: item.itemIdentity }
      : {}),
    ...(item.kind === "response_item" && item.nativeItemId
      ? { nativeItemId: item.nativeItemId }
      : {}),
    ...(item.kind === "compacted" ? { window: { ...item.window } } : {}),
  }
}

function hashCodexRolloutSemanticPayload(
  item: CodexProjectionRolloutItem
): string {
  if (item.kind === "compacted") {
    return item.requestFingerprint
  }
  const payload = (() => {
    switch (item.kind) {
      case "input_items":
        return {
          kind: item.kind,
          bindings: item.bindings,
          contextSnapshot: item.contextSnapshot,
        }
      case "response_item":
        return {
          kind: item.kind,
          item: item.item,
          itemIdentity: item.itemIdentity,
          nativeItemId: item.nativeItemId,
        }
      case "source_records_linked":
        return {
          kind: item.kind,
          targetItemId: item.targetItemId,
          sourceRecordIds: item.sourceRecordIds,
        }
      case "history_replaced":
        return {
          kind: item.kind,
          reason: item.reason,
          entries: item.entries,
          contextSnapshot: item.contextSnapshot,
        }
      default:
        return { kind: item.kind, item: item.item }
    }
  })()
  return createHash("sha256")
    .update(stableCodexJsonStringify(payload))
    .digest("hex")
}

function hashCodexCompactionInstallInput(
  input: CodexCompactionInstallInput
): string {
  return createHash("sha256")
    .update(
      stableCodexJsonStringify({
        compactionId: requireCodexIdentifier(
          input.compactionId,
          "compaction id"
        ),
        injectionMode: input.injectionMode,
        rawHistory: input.rawHistory,
        preTriggerInput: input.preTriggerInput,
        requestInput: input.requestInput,
        wireInput: input.wireInput,
        compactionOutput: input.compactionOutput,
        responseId: requireCodexIdentifier(input.responseId, "response id"),
      })
    )
    .digest("hex")
}

function hashCodexNativeItems(items: readonly CodexInputItem[]): string {
  return createHash("sha256")
    .update(stableCodexJsonStringify(items))
    .digest("hex")
}

function assertCommittedRolloutRetry(
  existing: CodexProjectionRolloutIdentity,
  expected: CodexProjectionRolloutItem
): void {
  if (
    existing.kind !== expected.kind ||
    existing.payloadHash !== hashCodexRolloutSemanticPayload(expected)
  ) {
    throw new Error(
      `Codex ${expected.kind} rollout ${expected.rolloutId} was retried with a different payload`
    )
  }
}

function assertSameCommittedRollout(
  left: CodexProjectionRolloutCursor,
  right: CodexProjectionRolloutCursor,
  label: string
): void {
  if (
    left !== right ||
    left.length !== right.length ||
    left.lastRolloutId !== right.lastRolloutId ||
    left.lastKind !== right.lastKind ||
    left.lastHeadId !== right.lastHeadId ||
    left.historyVersion !== right.historyVersion ||
    left.projectionGeneration !== right.projectionGeneration ||
    left.activeWindowId !== right.activeWindowId ||
    left.projectedSourceRecordCount !== right.projectedSourceRecordCount
  ) {
    throw new Error(`Codex ${label} changed its committed rollout base`)
  }
}

function getCodexRolloutHeadId(item: CodexProjectionRolloutItem): string {
  if (item.kind === "response_item") {
    const itemId = extractCodexInputItemId(item.item)
    if (itemId) return itemId
  }
  if (item.kind === "compacted") {
    return requireCodexIdentifier(item.compactionId, "compaction head id")
  }
  return requireRolloutId(item.rolloutId)
}

function conflictingRolloutIdentity(
  rolloutId: string,
  actual: string,
  expected: string
): Error {
  return new Error(
    `Codex rollout identity ${requireRolloutId(rolloutId)} is ${actual}, not ${expected}`
  )
}

export class CodexPromptToolPairIntegrityError extends Error {
  constructor(readonly detail: string) {
    super(`Invalid Codex tool projection: ${detail}`)
    this.name = "CodexPromptToolPairIntegrityError"
  }
}

function getCodexPromptCallType(
  item: CodexInputItem
): CodexPromptCallType | undefined {
  const type = getCodexItemType(item)
  switch (type) {
    case "function_call":
    case "custom_tool_call":
      return type
    case "local_shell_call":
      // Local shell rows without a Responses call_id are provider-native
      // history items, not client continuations awaiting a function output.
      return getCodexPromptCallId(item) ? type : undefined
    case "tool_search_call":
      // Only client-executed tool search participates in the call/output
      // protocol. Server-native search rows and rows without an id are
      // standalone model-visible history.
      return isCodexClientToolSearchItem(item) && getCodexPromptCallId(item)
        ? type
        : undefined
    default:
      return undefined
  }
}

function getCodexPromptOutputType(
  item: CodexInputItem
): CodexPromptOutputType | undefined {
  const type = getCodexItemType(item)
  switch (type) {
    case "function_call_output":
    case "custom_tool_call_output":
      return type
    case "tool_search_output":
      // Codex preserves server-side search outputs without a matching client
      // call. The same holds for native rows that carry no call_id.
      return isCodexClientToolSearchItem(item) && getCodexPromptCallId(item)
        ? type
        : undefined
    default:
      return undefined
  }
}

function getCodexPromptCallId(item: CodexInputItem): string | undefined {
  const callId = (item as Record<string, unknown>).call_id
  return callId === undefined
    ? undefined
    : requireCodexIdentifier(callId, "prompt call id")
}

function isCodexClientToolSearchItem(item: CodexInputItem): boolean {
  return (item as Record<string, unknown>).execution === "client"
}

function isCodexPromptOutputCompatible(
  callType: CodexPromptCallType,
  outputType: CodexPromptOutputType
): boolean {
  if (outputType === "function_call_output") {
    return callType === "function_call" || callType === "local_shell_call"
  }
  if (outputType === "custom_tool_call_output") {
    return callType === "custom_tool_call"
  }
  return callType === "tool_search_call"
}

type CodexPromptCallType =
  | "function_call"
  | "local_shell_call"
  | "tool_search_call"
  | "custom_tool_call"

type CodexPromptOutputType =
  | "function_call_output"
  | "custom_tool_call_output"
  | "tool_search_output"

type CodexPromptCall = {
  index: number
  type: CodexPromptCallType
}

function isCodexUserTurnBoundary(item: CodexInputItem | undefined): boolean {
  if (getCodexItemType(item) !== "message") return false
  return (item as Record<string, unknown> | undefined)?.role === "user"
}

function extractCodexInputItemId(item: unknown): string | undefined {
  const id =
    item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>).id
      : undefined
  return id === undefined
    ? undefined
    : requireCodexIdentifier(id, "native response item id")
}

function getCodexItemType(item: unknown): string {
  const type =
    item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>).type
      : undefined
  return typeof type === "string" && type.length > 0 ? type : "unknown"
}

function buildCodexProjectionWindowId(
  nativeThreadId: string,
  windowNumber: number
): string {
  const normalizedNativeThreadId = requireNativeThreadId(nativeThreadId)
  if (!Number.isSafeInteger(windowNumber) || windowNumber < 0) {
    throw new Error(
      "Codex projection window number must be a non-negative integer"
    )
  }
  return `${normalizedNativeThreadId}:${windowNumber}`
}

function assertProjectionNativeThread(
  state: CodexProjectionState,
  nativeThreadId: string,
  operation: string
): void {
  const stateNativeThreadId = requireNativeThreadId(state.nativeThreadId)
  if (stateNativeThreadId !== nativeThreadId) {
    throw new Error(
      `Codex ${operation} thread mismatch: state=${stateNativeThreadId}, input=${nativeThreadId}`
    )
  }
}

function assertCodexProjectionWindow(
  window: CodexProjectionWindow,
  nativeThreadId: string,
  previousWindow: CodexProjectionWindow | undefined,
  label: string
): void {
  const normalizedNativeThreadId = requireNativeThreadId(nativeThreadId)
  const firstWindowId = requireCodexIdentifier(
    window.firstWindowId,
    `${label} first window id`
  )
  const windowId = requireCodexIdentifier(window.windowId, `${label} window id`)
  const previousWindowId =
    window.previousWindowId === undefined
      ? undefined
      : requireCodexIdentifier(
          window.previousWindowId,
          `${label} previous window id`
        )
  if (window.compactionId !== undefined) {
    requireCodexIdentifier(window.compactionId, `${label} compaction id`)
  }
  if (!Number.isSafeInteger(window.windowNumber) || window.windowNumber < 0) {
    throw new Error(`Codex ${label} window has an invalid window number`)
  }
  const expectedFirstWindowId = buildCodexProjectionWindowId(
    normalizedNativeThreadId,
    0
  )
  if (firstWindowId !== expectedFirstWindowId) {
    throw new Error(
      `Codex ${label} window belongs to a different native thread: expected ${expectedFirstWindowId}, received ${window.firstWindowId}`
    )
  }
  const expectedWindowId = buildCodexProjectionWindowId(
    normalizedNativeThreadId,
    window.windowNumber
  )
  if (windowId !== expectedWindowId) {
    throw new Error(
      `Codex ${label} window id mismatch: expected ${expectedWindowId}, received ${window.windowId}`
    )
  }
  if (previousWindow) {
    if (window.windowNumber !== previousWindow.windowNumber + 1) {
      throw new Error(
        `Codex ${label} window number does not continue the previous native window`
      )
    }
    if (previousWindowId !== previousWindow.windowId) {
      throw new Error(
        `Codex ${label} window previous id does not continue the previous native window`
      )
    }
    return
  }
  if (window.windowNumber === 0) {
    if (previousWindowId !== undefined) {
      throw new Error("Codex initial native window must not have a previous id")
    }
    return
  }
  const expectedPreviousWindowId = buildCodexProjectionWindowId(
    normalizedNativeThreadId,
    window.windowNumber - 1
  )
  if (previousWindowId !== expectedPreviousWindowId) {
    throw new Error(
      `Codex ${label} window previous id mismatch: expected ${expectedPreviousWindowId}, received ${String(window.previousWindowId)}`
    )
  }
}

function hashCodexProjectionValue(value: unknown): string {
  return createHash("sha256")
    .update(stableCodexJsonStringify(value))
    .digest("hex")
    .slice(0, 24)
}

function cloneInputItem(item: CodexInputItem): CodexInputItem {
  assertCodexInputItemIdentityFields(item)
  return cloneJson(item)
}

/**
 * Native items may carry upstream response ids and tool call ids even though
 * the union keeps most provider extensions open-ended. Preserve absence, but
 * never reinterpret a supplied opaque key while staging or replaying it.
 */
function assertCodexInputItemIdentityFields(item: CodexInputItem): void {
  const record = item as Record<string, unknown>
  if (record.id !== undefined) {
    requireCodexIdentifier(record.id, "native input item id")
  }
  if (record.call_id !== undefined) {
    requireCodexIdentifier(record.call_id, "native input call id")
  }
  if (record.sourceUuid !== undefined) {
    requireCodexIdentifier(record.sourceUuid, "native input source UUID")
  }
  if (record.messageId !== undefined) {
    requireCodexIdentifier(record.messageId, "native input message id")
  }
}

function cloneInputBinding(
  binding: CodexProjectionInputBinding
): CodexProjectionInputBinding {
  return {
    bindingId: binding.bindingId,
    sourceRecordId: binding.sourceRecordId,
    items: binding.items.map(cloneInputItem),
  }
}

function cloneHistoryEntry(
  entry: CodexProjectionHistoryEntry
): CodexProjectionHistoryEntry {
  return {
    itemId: entry.itemId,
    rolloutId: entry.rolloutId,
    bindingId: entry.bindingId,
    item: cloneInputItem(entry.item),
    sourceRecordIds: [...entry.sourceRecordIds],
  }
}

function cloneContextSnapshot(
  snapshot: CodexProjectionContextSnapshot
): CodexProjectionContextSnapshot {
  const normalized = normalizeContextSnapshot(snapshot)
  return {
    signatures: { ...normalized.signatures },
    roles: { ...normalized.roles },
    sourceRecordIdsByKey: { ...normalized.sourceRecordIdsByKey },
  }
}

function compactionProjectionSurface(state: CodexProjectionState): unknown {
  return {
    version: state.version,
    nativeThreadId: state.nativeThreadId,
    activeHistory: state.activeHistory,
    activeHistoryEntries: state.activeHistoryEntries,
    projectedSourceRecordIds: state.projectedSourceRecordIds,
    contextSignatures: state.contextSignatures,
    contextRoles: state.contextRoles,
    contextSourceRecordIds: state.contextSourceRecordIds,
    activeWindow: state.activeWindow,
  }
}

function collectExactSourceRecordIds(ids: readonly string[]): string[] {
  return [
    ...new Set(ids.map((id) => requireCodexIdentifier(id, "source record id"))),
  ]
}

function requireRolloutId(value: unknown): string {
  return requireCodexIdentifier(value, "rollout id")
}

function requireCodexIdentifier(value: unknown, label: string): string {
  try {
    return requireExactDurableIdentifier(value, `Codex ${label}`)
  } catch (error) {
    throw new Error(
      `Codex ${label} must be an exact durable identifier: ${(error as Error).message}`
    )
  }
}

function requireNativeThreadId(value: unknown): string {
  return requireCodexIdentifier(value, "native thread id")
}

function cloneRolloutItem(
  item: CodexProjectionRolloutItem
): CodexProjectionRolloutItem {
  return cloneJson(item)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
