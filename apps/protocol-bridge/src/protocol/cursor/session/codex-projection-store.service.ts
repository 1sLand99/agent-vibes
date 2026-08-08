import { Injectable } from "@nestjs/common"
import { CodexContextEngineService } from "../../../context/codex-context-engine.service"
import {
  requireExactDurableIdentifier,
  requireOptionalExactDurableIdentifier,
} from "../../../context/durable-identifier"
import { stableCodexJsonStringify } from "../../../llm/openai/codex-incremental"
import type {
  CodexProjectionRolloutItem,
  CodexProjectionState,
  CodexRecordedResponseItem,
} from "../../../llm/openai/codex-projection-state"
import {
  commitCodexPendingRollout,
  forkCodexProjectionState,
  getCodexDurableLastRolloutId,
  getCodexDurableRolloutLength,
  getCodexPendingRollout,
  materializeCodexCompactionCommit,
} from "../../../llm/openai/codex-projection-state"
import {
  CodexRolloutStore,
  type AppendCodexRolloutItem,
  type CodexRolloutHeadInstall,
  type CodexRolloutPreparedInstall,
} from "./codex-rollout-store.service"
import {
  INITIAL_PROVIDER_PROJECTION_REVISION,
  type ProviderActiveHead,
} from "./provider-active-head.store"
import {
  assertProviderProjectionRef,
  providerProjectionStorageKey,
  type ProviderProjectionRef,
} from "./projection-owner"
import type { SessionTxn } from "./tool-call-ledger.service"

/**
 * The durable compare-and-swap point for one Codex projection.  This is
 * captured from the installed provider head, never inferred from an
 * in-process rollout array.
 */
export interface CodexProjectionBaseSnapshot {
  readonly historyVersion: number
  readonly projectionGeneration: number
  readonly activeWindowId: string
  readonly rolloutLength: number
  /** Exact ProviderActiveHeadStore revision captured before the attempt. */
  readonly durableHeadRevision: number
  readonly lastRolloutId?: string
}

/**
 * Couples one local provider projection with the one upstream Codex thread
 * that owns its native history. The upstream identity deliberately remains
 * outside ProviderProjectionRef: the ref is local ownership only.
 */
export interface CodexProjectionScope {
  readonly projection: ProviderProjectionRef
  readonly nativeThreadId: string
}

/** One raw native item and the graph fragments it rendered in this response. */
export interface CodexGraphSourceBinding {
  readonly nativeItemId: string
  readonly sourceFragmentIndexes: readonly number[]
}

export interface BeginCodexGraphResponseCommitInput {
  readonly scope: CodexProjectionScope
  readonly responseItems: readonly Record<string, unknown>[]
  readonly sourceBindings: readonly CodexGraphSourceBinding[]
  readonly responseId?: string
}

/**
 * Formal cross-domain transaction contract consumed by ContextStateService.
 * A graph append hands this object its accepted fragment ids while the
 * MessageStore transaction is still open; this object then writes the native
 * rollout and provider head in that very transaction.  There is no pending
 * join state and no later reconciliation path.
 */
export interface CodexGraphResponseCommit {
  readonly provider: "codex"
  readonly scope: CodexProjectionScope
  commitInTransaction(
    txn: SessionTxn,
    fragments: readonly { recordId: string }[]
  ): void
  installAfterCommit(): void
  abortAfterRollback(): void
}

export interface CodexProjectionDeltaCommit {
  readonly scope: CodexProjectionScope
  readonly expected: CodexProjectionBaseSnapshot
  readonly state: CodexProjectionState
  readonly responseId?: string
}

/**
 * Formal durable boundary for a Remote Compaction V2 response derived from a
 * prepared, but not yet accepted, main provider request.
 */
export interface CodexProjectionCompactionCommit {
  readonly scope: CodexProjectionScope
  readonly expected: CodexProjectionBaseSnapshot
  readonly candidateProjectionState: CodexProjectionState
  readonly compactedProjectionState: CodexProjectionState
}

/**
 * The only cache-install capability produced after an accepted rollout/head
 * transaction. The head has already been compared with the staged state, so
 * installation after the outer transaction commits is deliberately a map
 * assignment and cannot issue a second durable read.
 */
export interface CodexProjectionPreparedInstall {
  readonly cacheKey: string
  readonly state: CodexProjectionState
  readonly head: ProviderActiveHead
}

/**
 * Owns the hot read cache for durable Codex projection state and the only
 * write protocol that advances a Codex active head.  The cache is a mounted
 * read model only: every install follows a successful rollout/head CAS and a
 * failed transaction evicts the projected state rather than retaining a
 * speculative branch.
 */
@Injectable()
export class CodexProjectionStore {
  private readonly states = new Map<string, CodexProjectionState>()

  constructor(
    private readonly codexContextEngine: CodexContextEngineService,
    private readonly rolloutStore: CodexRolloutStore
  ) {}

  get(scope: CodexProjectionScope): CodexProjectionState {
    const { projection, nativeThreadId } = this.assertScope(scope, "get")
    const cacheKey = providerProjectionStorageKey(projection)
    const cached = this.states.get(cacheKey)
    if (cached) {
      this.assertStateNativeThread(cached, nativeThreadId, "cached projection")
      this.assertDurableHeadMatchesState(scope, cached)
      return cached
    }

    const rollout = this.rolloutStore.list(projection).map((row) => {
      if (row.nativeThreadId !== nativeThreadId) {
        throw new Error(
          `Codex rollout row ${row.seq} native thread mismatch for ${this.describeProjection(projection)}: expected ${nativeThreadId}, received ${row.nativeThreadId}`
        )
      }
      return this.decodeRolloutItem(row.payload, row.seq)
    })
    const state = this.codexContextEngine.replayProjectionState(
      rollout,
      nativeThreadId
    )
    this.assertStateNativeThread(state, nativeThreadId, "cold replay")
    this.assertDurableHeadMatchesState(scope, state)
    this.states.set(cacheKey, state)
    return state
  }

  getActiveSourceRecordIds(scope: CodexProjectionScope): string[] {
    const sourceRecordIds = new Set<string>()
    for (const entry of this.get(scope).activeHistoryEntries) {
      for (const sourceRecordId of entry.sourceRecordIds) {
        sourceRecordIds.add(
          requireExactDurableIdentifier(
            sourceRecordId,
            "Codex active source record id"
          )
        )
      }
    }
    return [...sourceRecordIds].sort()
  }

  captureBase(
    scope: CodexProjectionScope,
    state: CodexProjectionState = this.get(scope)
  ): CodexProjectionBaseSnapshot {
    const { projection, nativeThreadId } = this.assertScope(
      scope,
      "captureBase"
    )
    this.assertStateNativeThread(state, nativeThreadId, "captured projection")
    this.assertDurableHeadMatchesState(scope, state)
    const head = this.rolloutStore.getActiveHead(projection)
    const cursor = state.committedRollout
    return {
      historyVersion: cursor.historyVersion,
      projectionGeneration: cursor.projectionGeneration,
      activeWindowId: cursor.activeWindowId,
      rolloutLength: getCodexDurableRolloutLength(state),
      durableHeadRevision:
        head?.revision ?? INITIAL_PROVIDER_PROJECTION_REVISION,
      ...(getCodexDurableLastRolloutId(state)
        ? { lastRolloutId: getCodexDurableLastRolloutId(state) }
        : {}),
    }
  }

  assertBase(
    scope: CodexProjectionScope,
    expected: CodexProjectionBaseSnapshot
  ): CodexProjectionState {
    const { projection, nativeThreadId } = this.assertScope(scope, "assertBase")
    const state = this.get(scope)
    this.assertStateNativeThread(state, nativeThreadId, "installed projection")
    this.assertStateMatchesBase(state, expected, "installed projection")
    this.assertDurableHeadMatchesState(scope, state)
    const head = this.rolloutStore.getActiveHead(projection)
    const actualRevision =
      head?.revision ?? INITIAL_PROVIDER_PROJECTION_REVISION
    if (actualRevision !== expected.durableHeadRevision) {
      throw new Error(
        `Codex projection has a stale durable head for ${this.describeProjection(projection)}: ` +
          `expected revision ${expected.durableHeadRevision}, received ${actualRevision}`
      )
    }
    return state
  }

  /**
   * Commit a staged native transition outside a graph transaction, such as
   * input binding acceptance or remote compaction.  The caller must supply
   * the exact base captured before the upstream attempt began.
   */
  commitDelta(input: CodexProjectionDeltaCommit): CodexProjectionState {
    this.assertBase(input.scope, input.expected)
    const prepared = this.appendDelta(input, (items, head) =>
      this.rolloutStore.appendBatchAndInstall(items, head)
    )
    this.installPrepared(prepared)
    return prepared.state
  }

  /**
   * Publishes Remote Compaction V2 as one independent provider transaction.
   * Candidate-only input/context staging is consumed for exact source mapping
   * but is never appended as though the discarded main request was accepted.
   */
  commitCompaction(
    input: CodexProjectionCompactionCommit
  ): CodexProjectionState {
    const state = materializeCodexCompactionCommit({
      durableRolloutLength: input.expected.rolloutLength,
      candidateProjectionState: input.candidateProjectionState,
      compactedProjectionState: input.compactedProjectionState,
    })
    return this.commitDelta({
      scope: input.scope,
      expected: input.expected,
      state,
    })
  }

  /**
   * Same transition under ContextStateService's already-open graph
   * transaction.  No nested transaction is created, so graph fragments,
   * ledger rows, raw response records, source links and the active head share
   * a single commit boundary.
   */
  commitDeltaInTransaction(
    txn: SessionTxn,
    input: CodexProjectionDeltaCommit
  ): CodexProjectionPreparedInstall {
    const { projection } = this.assertScope(
      input.scope,
      "commitDeltaInTransaction"
    )
    if (txn.conversationId !== projection.owner.conversationId) {
      throw new Error(
        `Codex projection transaction belongs to ${txn.conversationId}, not ${projection.owner.conversationId}`
      )
    }
    this.assertBase(input.scope, input.expected)
    return this.appendDelta(input, (items, head) =>
      this.rolloutStore.appendBatchAndInstallInTransaction(txn, items, head)
    )
  }

  beginGraphResponseCommit(
    input: BeginCodexGraphResponseCommitInput
  ): CodexGraphResponseCommit {
    this.assertScope(input.scope, "beginGraphResponseCommit")
    const live = this.get(input.scope)
    const expected = this.captureBase(input.scope, live)
    return new CodexGraphResponseCommitImpl(this, {
      scope: input.scope,
      expected,
      baseState: live,
      responseItems: input.responseItems,
      sourceBindings: input.sourceBindings,
      responseId: input.responseId,
    })
  }

  clearConversation(conversationId: string): void {
    const prefix = `${requireExactDurableIdentifier(
      conversationId,
      "Codex projection conversation id"
    )}\u0000`
    for (const key of this.states.keys()) {
      if (key.startsWith(prefix)) this.states.delete(key)
    }
  }

  install(scope: CodexProjectionScope, state: CodexProjectionState): void {
    const { projection, nativeThreadId } = this.assertScope(scope, "install")
    this.assertStateNativeThread(state, nativeThreadId, "installed projection")
    this.assertDurableHeadMatchesState(scope, state)
    this.states.set(providerProjectionStorageKey(projection), state)
  }

  /**
   * Install a receipt prepared by the successful append/head CAS. This runs
   * only after the enclosing transaction commits and intentionally performs
   * no validation, replay, or durable lookup.
   */
  installPrepared(receipt: CodexProjectionPreparedInstall): void {
    this.states.set(receipt.cacheKey, receipt.state)
  }

  evict(scope: CodexProjectionScope): void {
    const { projection } = this.assertScope(scope, "evict")
    this.states.delete(providerProjectionStorageKey(projection))
  }

  recordResponseItems(
    state: CodexProjectionState,
    items: Parameters<
      CodexContextEngineService["recordProviderResponseItems"]
    >[1]
  ): CodexRecordedResponseItem[] {
    return this.codexContextEngine.recordProviderResponseItems(state, items)
  }

  linkSourceRecord(
    state: CodexProjectionState,
    input: Parameters<CodexContextEngineService["linkProviderSourceRecord"]>[1]
  ): void {
    this.codexContextEngine.linkProviderSourceRecord(state, input)
  }

  private appendDelta(
    input: CodexProjectionDeltaCommit,
    append: (
      items: readonly AppendCodexRolloutItem[],
      head: CodexRolloutHeadInstall
    ) => CodexRolloutPreparedInstall
  ): CodexProjectionPreparedInstall {
    const { projection, nativeThreadId } = this.assertScope(
      input.scope,
      "commitDelta"
    )
    const { expected, state } = input
    this.assertStateNativeThread(state, nativeThreadId, "staged projection")
    this.assertStateMatchesBase(state, expected, "staged projection base")
    const pending = getCodexPendingRollout(state)
    if (pending.length === 0) {
      throw new Error(
        `Codex projection transition has no new rollout records for ${this.describeProjection(projection)}`
      )
    }

    const last = pending.at(-1)!
    const items = pending.map((item) =>
      this.toAppendItem(input.scope, state, item, input.responseId)
    )
    const head: CodexRolloutHeadInstall = {
      expectedRevision: expected.durableHeadRevision,
      revision: expected.durableHeadRevision + 1,
      headKind: last.kind,
      headId: this.getRolloutHeadId(last),
      metadata: {
        nativeThreadId,
        rolloutLength: expected.rolloutLength + pending.length,
        lastRolloutId: last.rolloutId,
        historyVersion: state.historyVersion,
        projectionGeneration: state.projectionGeneration,
        activeWindowId: state.activeWindow.windowId,
        projectedSourceRecordCount: state.projectedSourceRecordIds.length,
      },
      updatedAt: last.recordedAt,
    }
    const rolloutInstall = append(items, head)
    const committedState = commitCodexPendingRollout(state)
    return this.prepareInstall(input.scope, committedState, rolloutInstall)
  }

  private toAppendItem(
    scope: CodexProjectionScope,
    state: CodexProjectionState,
    item: CodexProjectionRolloutItem,
    responseId: string | undefined
  ): AppendCodexRolloutItem {
    return {
      projection: scope.projection,
      nativeThreadId: scope.nativeThreadId,
      itemId: this.getRolloutHeadId(item),
      itemKind: item.kind,
      windowId: state.activeWindow.windowId,
      responseId: item.kind === "compacted" ? item.responseId : responseId,
      payload: Buffer.from(JSON.stringify(item), "utf8"),
      createdAt: item.recordedAt,
    }
  }

  private assertDurableHeadMatchesState(
    scope: CodexProjectionScope,
    state: CodexProjectionState
  ): void {
    const { projection, nativeThreadId } = this.assertScope(
      scope,
      "assertDurableHeadMatchesState"
    )
    this.assertStateNativeThread(state, nativeThreadId, "durable projection")
    const head = this.rolloutStore.getActiveHead(projection)
    this.assertHeadMatchesState(projection, state, nativeThreadId, head)
  }

  private prepareInstall(
    scope: CodexProjectionScope,
    state: CodexProjectionState,
    rolloutInstall: CodexRolloutPreparedInstall
  ): CodexProjectionPreparedInstall {
    const { projection, nativeThreadId } = this.assertScope(
      scope,
      "prepareInstall"
    )
    this.assertStateNativeThread(state, nativeThreadId, "staged projection")
    if (
      providerProjectionStorageKey(rolloutInstall.projection) !==
      providerProjectionStorageKey(projection)
    ) {
      throw new Error(
        "Codex rollout prepared install belongs to a different provider projection"
      )
    }
    this.assertHeadMatchesState(
      projection,
      state,
      nativeThreadId,
      rolloutInstall.head
    )
    return {
      cacheKey: providerProjectionStorageKey(projection),
      state,
      head: rolloutInstall.head,
    }
  }

  private assertHeadMatchesState(
    projection: ProviderProjectionRef,
    state: CodexProjectionState,
    nativeThreadId: string,
    head: ProviderActiveHead | undefined
  ): void {
    if (state.pendingRollout.length > 0) {
      throw new Error(
        `Codex mounted projection contains ${state.pendingRollout.length} uncommitted rollout records for ${this.describeProjection(projection)}`
      )
    }
    const cursor = state.committedRollout
    if (
      state.historyVersion !== cursor.historyVersion ||
      state.projectionGeneration !== cursor.projectionGeneration ||
      state.activeWindow.windowId !== cursor.activeWindowId ||
      state.projectedSourceRecordIds.length !==
        cursor.projectedSourceRecordCount
    ) {
      throw new Error(
        `Codex mounted projection surface does not match its durable cursor for ${this.describeProjection(projection)}`
      )
    }
    if (getCodexDurableRolloutLength(state) === 0) {
      if (head) {
        throw new Error(
          `Codex active head exists without rollout for ${this.describeProjection(projection)}`
        )
      }
      return
    }
    if (!head) {
      throw new Error(
        `Codex rollout exists without active head for ${this.describeProjection(projection)}`
      )
    }
    const metadata = head.metadata
    const headNativeThreadId = requireExactDurableIdentifier(
      metadata?.nativeThreadId,
      "Codex active head metadata nativeThreadId"
    )
    const headLastRolloutId = requireExactDurableIdentifier(
      metadata?.lastRolloutId,
      "Codex active head metadata lastRolloutId"
    )
    const headActiveWindowId = requireExactDurableIdentifier(
      metadata?.activeWindowId,
      "Codex active head metadata activeWindowId"
    )
    if (
      head.headKind !== state.committedRollout.lastKind ||
      head.headId !== state.committedRollout.lastHeadId ||
      metadata?.rolloutLength !== getCodexDurableRolloutLength(state) ||
      headNativeThreadId !== nativeThreadId ||
      headLastRolloutId !== getCodexDurableLastRolloutId(state) ||
      metadata?.historyVersion !== cursor.historyVersion ||
      metadata?.projectionGeneration !== cursor.projectionGeneration ||
      headActiveWindowId !== cursor.activeWindowId ||
      metadata?.projectedSourceRecordCount !== cursor.projectedSourceRecordCount
    ) {
      throw new Error(
        `Codex active head metadata does not match cold replay for ${this.describeProjection(projection)}`
      )
    }
  }

  private assertStateMatchesBase(
    state: CodexProjectionState,
    expected: CodexProjectionBaseSnapshot,
    label: string
  ): void {
    const cursor = state.committedRollout
    if (
      cursor.historyVersion !== expected.historyVersion ||
      cursor.projectionGeneration !== expected.projectionGeneration ||
      cursor.activeWindowId !== expected.activeWindowId ||
      cursor.length !== expected.rolloutLength ||
      cursor.lastRolloutId !== expected.lastRolloutId
    ) {
      throw new Error(
        `Codex ${label} does not match the expected native-history base`
      )
    }
  }

  private decodeRolloutItem(
    payload: Buffer,
    seq: number
  ): CodexProjectionRolloutItem {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload.toString("utf8"))
    } catch (error) {
      throw new Error(
        `Invalid Codex rollout payload at seq ${seq}: ${(error as Error).message}`
      )
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid Codex rollout item at seq ${seq}`)
    }
    const kind = (parsed as { kind?: unknown }).kind
    if (
      kind !== "input_items" &&
      kind !== "response_item" &&
      kind !== "compacted" &&
      kind !== "turn_context" &&
      kind !== "world_state" &&
      kind !== "event_msg" &&
      kind !== "inter_agent" &&
      kind !== "history_replaced" &&
      kind !== "source_records_linked"
    ) {
      throw new Error(
        `Unsupported Codex rollout kind at seq ${seq}: ${String(kind)}`
      )
    }
    return parsed as CodexProjectionRolloutItem
  }

  private getRolloutHeadId(item: CodexProjectionRolloutItem): string {
    const record = item as unknown as Record<string, unknown>
    const nestedItem =
      item.kind === "response_item"
        ? (item.item as Record<string, unknown>)
        : undefined
    if (nestedItem?.id !== undefined) {
      return requireExactDurableIdentifier(
        nestedItem.id,
        "Codex response-item head id"
      )
    }
    if (record.compactionId !== undefined) {
      return requireExactDurableIdentifier(
        record.compactionId,
        "Codex compaction head id"
      )
    }
    return requireExactDurableIdentifier(
      item.rolloutId,
      "Codex rollout head id"
    )
  }

  private assertCodexProjection(
    projection: ProviderProjectionRef,
    operation: string
  ): void {
    assertProviderProjectionRef(projection, `CodexProjectionStore.${operation}`)
    if (projection.provider !== "codex") {
      throw new Error(
        `CodexProjectionStore.${operation}: provider must be codex`
      )
    }
  }

  private assertScope(
    scope: CodexProjectionScope,
    operation: string
  ): { projection: ProviderProjectionRef; nativeThreadId: string } {
    this.assertCodexProjection(scope.projection, operation)
    return {
      projection: scope.projection,
      nativeThreadId: requireExactDurableIdentifier(
        scope.nativeThreadId,
        `CodexProjectionStore.${operation}: nativeThreadId`
      ),
    }
  }

  private assertStateNativeThread(
    state: CodexProjectionState,
    nativeThreadId: string,
    label: string
  ): void {
    const exactStateNativeThreadId = requireExactDurableIdentifier(
      state.nativeThreadId,
      `Codex ${label} native thread id`
    )
    if (exactStateNativeThreadId !== nativeThreadId) {
      throw new Error(
        `Codex ${label} native thread mismatch: expected ${nativeThreadId}, received ${exactStateNativeThreadId}`
      )
    }
  }

  private describeProjection(projection: ProviderProjectionRef): string {
    return `${projection.owner.conversationId}/${projection.owner.ownerKey}/${projection.localKey}`
  }
}

interface CodexGraphResponseCommitState {
  scope: CodexProjectionScope
  expected: CodexProjectionBaseSnapshot
  baseState: CodexProjectionState
  responseItems: readonly Record<string, unknown>[]
  sourceBindings: readonly CodexGraphSourceBinding[]
  responseId?: string
}

class CodexGraphResponseCommitImpl implements CodexGraphResponseCommit {
  readonly provider = "codex" as const
  readonly scope: CodexProjectionScope
  private readonly expected: CodexProjectionBaseSnapshot
  private readonly responseItems: readonly Record<string, unknown>[]
  private readonly sourceBindings: readonly CodexGraphSourceBinding[]
  private readonly responseId: string | undefined
  private readonly stagedState: CodexProjectionState
  private preparedInstall: CodexProjectionPreparedInstall | undefined
  private committed = false
  private installed = false

  constructor(
    private readonly store: CodexProjectionStore,
    input: CodexGraphResponseCommitState
  ) {
    this.scope = input.scope
    this.expected = input.expected
    this.responseItems = input.responseItems.map((item) =>
      structuredClone(item)
    )
    this.sourceBindings = input.sourceBindings.map((binding) => ({
      nativeItemId: binding.nativeItemId,
      sourceFragmentIndexes: [...binding.sourceFragmentIndexes],
    }))
    this.responseId = requireOptionalExactDurableIdentifier(
      input.responseId,
      "Codex graph response id"
    )
    this.stagedState = forkCodexProjectionState(input.baseState)
    this.recordRawResponseItems()
  }

  commitInTransaction(
    txn: SessionTxn,
    fragments: readonly { recordId: string }[]
  ): void {
    if (this.committed) {
      throw new Error("Codex graph response commit was applied more than once")
    }
    const sourceRecordIds = fragments.map((fragment, index) => {
      return requireExactDurableIdentifier(
        fragment.recordId,
        `Codex graph response fragment id at index ${index}`
      )
    })
    if (new Set(sourceRecordIds).size !== sourceRecordIds.length) {
      throw new Error(
        "Codex graph response commit received duplicate graph fragment ids"
      )
    }

    const sourceIdsByNativeItem = this.resolveSourceBindings(sourceRecordIds)
    for (const [nativeItemId, sourceIds] of sourceIdsByNativeItem) {
      const recorded = this.recordedByNativeItemId.get(nativeItemId)
      if (!recorded?.itemIdentity) {
        throw new Error(
          `Codex graph source records target non-visible native response item ${nativeItemId}`
        )
      }
      for (const sourceRecordId of sourceIds) {
        this.store.linkSourceRecord(this.stagedState, {
          rolloutId: `source-link:${recorded.itemIdentity}:${sourceRecordId}`,
          targetItemId: recorded.itemIdentity,
          sourceRecordIds: [sourceRecordId],
        })
      }
    }

    this.preparedInstall = this.store.commitDeltaInTransaction(txn, {
      scope: this.scope,
      expected: this.expected,
      state: this.stagedState,
      ...(this.responseId ? { responseId: this.responseId } : {}),
    })
    this.committed = true
  }

  installAfterCommit(): void {
    if (!this.committed) {
      throw new Error(
        "Codex graph response commit cannot install before its durable transaction succeeds"
      )
    }
    if (this.installed) return
    if (!this.preparedInstall) {
      throw new Error(
        "Codex graph response commit has no prepared projection install"
      )
    }
    this.store.installPrepared(this.preparedInstall)
    this.installed = true
  }

  abortAfterRollback(): void {
    if (!this.committed) {
      this.store.evict(this.scope)
      return
    }
    // A failure after the native write attempt means the enclosing graph
    // transaction rolled back. Drop the mounted projection so the next read
    // reconstructs only the committed database state.
    this.store.evict(this.scope)
  }

  private readonly recordedByNativeItemId = new Map<
    string,
    CodexRecordedResponseItem
  >()

  private recordRawResponseItems(): void {
    const seenPayloadByNativeItemId = new Map<string, string>()
    for (const item of this.responseItems) {
      const nativeItemId = this.requireNativeItemId(item)
      const serialized = stableCodexJsonStringify(item)
      const previous = seenPayloadByNativeItemId.get(nativeItemId)
      if (previous !== undefined) {
        if (previous !== serialized) {
          throw new Error(
            `Codex response contains conflicting payloads for native item ${nativeItemId}`
          )
        }
        continue
      }
      seenPayloadByNativeItemId.set(nativeItemId, serialized)
      const [recorded] = this.store.recordResponseItems(this.stagedState, [
        {
          rolloutId: `response-item:${nativeItemId}`,
          item,
        },
      ])
      if (!recorded) {
        throw new Error(
          `Codex native response item ${nativeItemId} did not produce a durable record`
        )
      }
      if (recorded.rolloutId === undefined) {
        throw new Error(
          `Codex native response item ${nativeItemId} has no rollout identity`
        )
      }
      this.recordedByNativeItemId.set(nativeItemId, recorded)
    }
    if (
      this.sourceBindings.length > 0 &&
      this.recordedByNativeItemId.size === 0
    ) {
      throw new Error(
        "Codex graph response has source fragments but no raw response items"
      )
    }
  }

  private resolveSourceBindings(
    sourceRecordIds: readonly string[]
  ): Map<string, string[]> {
    const sourceIdsByNativeItem = new Map<string, string[]>()
    const coveredFragmentIndexes = new Set<number>()
    for (const binding of this.sourceBindings) {
      const nativeItemId = this.requireCanonicalId(
        binding.nativeItemId,
        "native response item id"
      )
      if (sourceIdsByNativeItem.has(nativeItemId)) {
        throw new Error(
          `Codex graph response has duplicate source bindings for native item ${nativeItemId}`
        )
      }
      const recorded = this.recordedByNativeItemId.get(nativeItemId)
      if (!recorded) {
        throw new Error(
          `Codex graph response binds graph fragments to absent raw native item ${nativeItemId}`
        )
      }
      const newlyRecorded = getCodexPendingRollout(this.stagedState).some(
        (item) =>
          item.kind === "response_item" && item.rolloutId === recorded.rolloutId
      )
      if (!newlyRecorded) {
        throw new Error(
          `Codex graph response refuses delayed source binding for native item ${nativeItemId}`
        )
      }
      const sourceIds: string[] = []
      const localIndexes = new Set<number>()
      for (const index of binding.sourceFragmentIndexes) {
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= sourceRecordIds.length
        ) {
          throw new Error(
            `Codex graph response source binding has invalid fragment index ${String(index)} for native item ${nativeItemId}`
          )
        }
        if (localIndexes.has(index)) {
          throw new Error(
            `Codex graph response repeats fragment index ${index} for native item ${nativeItemId}`
          )
        }
        localIndexes.add(index)
        coveredFragmentIndexes.add(index)
        sourceIds.push(sourceRecordIds[index]!)
      }
      if (sourceIds.length === 0) {
        throw new Error(
          `Codex graph response native item ${nativeItemId} has no graph source fragments`
        )
      }
      sourceIdsByNativeItem.set(nativeItemId, sourceIds)
    }
    if (coveredFragmentIndexes.size !== sourceRecordIds.length) {
      throw new Error(
        `Codex graph response source coverage is incomplete: graph=${sourceRecordIds.length} bound=${coveredFragmentIndexes.size}`
      )
    }
    return sourceIdsByNativeItem
  }

  private requireNativeItemId(item: Record<string, unknown>): string {
    return this.requireCanonicalId(item.id, "raw response item id")
  }

  private requireCanonicalId(value: unknown, label: string): string {
    return requireExactDurableIdentifier(value, `Codex ${label}`)
  }
}
