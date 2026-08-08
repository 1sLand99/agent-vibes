import { Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { applyToolResultReplacementMutations } from "../../../context/tool-result-replacement-state"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import type {
  ContextStoredToolResultReference,
  ContextToolResultReplacementMutation,
  ContextToolResultReplacementRecord,
  ContextToolResultReplacementState,
} from "../../../context/types"
import { PersistenceService } from "../../../persistence"
import {
  assertProviderProjectionRef,
  createClaudeProjectionRefFromGraphProvider,
  providerProjectionStorageKey,
  type ProviderProjectionRef,
} from "./projection-owner"
import { MessageStore, type PersistedMessage } from "./message-store.service"
import { SubagentBranchStore } from "./subagent-branch-store.service"
import { SESSION_TXN_TAG, type SessionTxn } from "./tool-call-ledger.service"

/**
 * A provider-native projection change caused by one accepted tool_result.
 *
 * These are deliberately semantic mutations, not a mutable replacement-state
 * snapshot. They can therefore be appended with the graph result and replayed
 * exactly after a crash without selecting a provider from current session
 * fields.
 */
export type ClaudeProjectionMutation = ContextToolResultReplacementMutation

export type PersistedClaudeProjectionMutation = ClaudeProjectionMutation & {
  readonly ref: ProviderProjectionRef
  /** Monotonic append order within one explicit Claude projection owner. */
  readonly seq: number
  /** Stable ordinal when one trigger receipt owns more than one mutation. */
  readonly sourceOrdinal: number
  /** Exact graph receipt that triggered this semantic mutation batch. */
  readonly sourceGraphUuid: string
  /** Exact triggering tool_result/tool_use identity carried by that receipt. */
  readonly sourceToolUseId: string
  readonly createdAt: number
}

export interface AppendClaudeProjectionMutationsInput {
  /** Must be the exact accepted Claude projection that issued this tool_use. */
  readonly ref: ProviderProjectionRef
  /**
   * `MessageStore.appendToolResultBlock` receipt that triggered this batch,
   * never a latest-row lookup. It is not necessarily the target result.
   */
  readonly sourceGraphUuid: string
  /** Tool-use id closed by `sourceGraphUuid`; this is the trigger identity. */
  readonly sourceToolUseId: string
  /**
   * Mutations may target any already accepted tool result in the same Claude
   * projection. `mutation.toolUseId` is the target identity, not the source.
   */
  readonly mutations: readonly ClaudeProjectionMutation[]
  /** Event acceptance timestamp; replacement payload timestamps remain intact. */
  readonly createdAt?: number
}

/**
 * Immutable tail receipt consumed by the provider-head commit. A newer graph
 * append may add records after `targetMutationWatermarkSeq`; those records
 * remain a later tail instead of changing this already prepared receipt.
 */
export interface PreparedClaudeProjectionMutationTail {
  readonly ref: ProviderProjectionRef
  readonly baseMutationWatermarkSeq: number
  readonly targetMutationWatermarkSeq: number
  readonly mutations: readonly PersistedClaudeProjectionMutation[]
}

interface StoredMutationRow {
  seq: number
  trigger_graph_uuid: string
  trigger_tool_use_id: string
  target_tool_use_id: string
  source_ordinal: number
  mutation_kind: string
  payload_json: string
  created_at: number
}

/**
 * Owner-scoped append-only mutation log for Claude's tool-result projection.
 *
 * The only write API accepts a `SessionTxn`, which forces a mutation to commit
 * beside the graph receipt and its ledger close. Provider-head watermarking is
 * intentionally separate: until an accepted head consumes this immutable tail,
 * cold recovery can replay it from the exact source result.
 */
@Injectable()
export class ClaudeProjectionMutationLog {
  private stmtNextSeq?: StatementSync
  private stmtInsert?: StatementSync
  private stmtList?: StatementSync

  constructor(
    private readonly persistence: PersistenceService,
    private readonly messageStore: MessageStore,
    private readonly subagentBranches: SubagentBranchStore
  ) {}

  appendForToolResultInTransaction(
    txn: SessionTxn,
    input: AppendClaudeProjectionMutationsInput
  ): PersistedClaudeProjectionMutation[] {
    this.assertTxn(txn)
    const normalized = this.normalizeAppendInput(txn, input)
    this.assertAcceptedToolResultTrigger(txn, normalized)

    const persisted: PersistedClaudeProjectionMutation[] = []
    for (const [sourceOrdinal, mutation] of normalized.mutations.entries()) {
      this.assertAcceptedMutationTarget(normalized.ref, mutation)
      const seq = this.nextSeq(normalized.ref)
      const kind = this.storageKindForMutation(mutation)
      ;(this.stmtInsert ??= this.persistence.prepare(
        `INSERT INTO session_claude_projection_mutations (
           conversation_id, owner_key, local_key, seq, trigger_graph_uuid,
           trigger_tool_use_id, target_tool_use_id, source_ordinal,
           mutation_kind, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )).run(
        normalized.ref.owner.conversationId,
        normalized.ref.owner.ownerKey,
        normalized.ref.localKey,
        seq,
        normalized.sourceGraphUuid,
        normalized.sourceToolUseId,
        mutation.toolUseId,
        sourceOrdinal,
        kind,
        JSON.stringify(mutation),
        normalized.createdAt
      )
      persisted.push(
        this.freezePersisted({
          ...mutation,
          ref: normalized.ref,
          seq,
          sourceOrdinal,
          sourceGraphUuid: normalized.sourceGraphUuid,
          sourceToolUseId: normalized.sourceToolUseId,
          createdAt: normalized.createdAt,
        })
      )
    }
    return persisted
  }

  /** Entire owner log, validated as one contiguous immutable sequence. */
  list(ref: ProviderProjectionRef): PersistedClaudeProjectionMutation[] {
    this.assertClaudeRef(ref, "list")
    const rows = (this.stmtList ??= this.persistence.prepare(
      `SELECT seq, trigger_graph_uuid, trigger_tool_use_id,
              target_tool_use_id, source_ordinal, mutation_kind, payload_json,
              created_at
         FROM session_claude_projection_mutations
        WHERE conversation_id = ? AND owner_key = ? AND local_key = ?
        ORDER BY seq ASC`
    )).all(
      ref.owner.conversationId,
      ref.owner.ownerKey,
      ref.localKey
    ) as unknown as StoredMutationRow[]
    const mutations = rows.map((row) => this.decodeRow(ref, row))
    this.assertContiguous(ref, mutations)
    return mutations
  }

  /** Reconstruct the mutation state accepted by an active head watermark. */
  materializeThrough(
    ref: ProviderProjectionRef,
    watermarkSeq: number
  ): ContextToolResultReplacementState | undefined {
    const through = this.listThrough(ref, watermarkSeq)
    const applied = applyToolResultReplacementMutations(
      undefined,
      through.map((mutation) => this.toContextMutation(mutation))
    )
    return applied.state ? structuredClone(applied.state) : undefined
  }

  listThrough(
    ref: ProviderProjectionRef,
    watermarkSeq: number
  ): PersistedClaudeProjectionMutation[] {
    this.assertWatermark(watermarkSeq, "listThrough")
    const all = this.list(ref)
    const latest = all.at(-1)?.seq ?? 0
    if (watermarkSeq > latest) {
      throw new Error(
        `ClaudeProjectionMutationLog.listThrough: watermark ${watermarkSeq} exceeds durable tail ${latest} for ${providerProjectionStorageKey(ref)}`
      )
    }
    return all
      .filter((mutation) => mutation.seq <= watermarkSeq)
      .map((mutation) => this.clonePersisted(mutation))
  }

  listAfter(
    ref: ProviderProjectionRef,
    watermarkSeq: number
  ): PersistedClaudeProjectionMutation[] {
    this.assertWatermark(watermarkSeq, "listAfter")
    const all = this.list(ref)
    const latest = all.at(-1)?.seq ?? 0
    if (watermarkSeq > latest) {
      throw new Error(
        `ClaudeProjectionMutationLog.listAfter: watermark ${watermarkSeq} exceeds durable tail ${latest} for ${providerProjectionStorageKey(ref)}`
      )
    }
    return all
      .filter((mutation) => mutation.seq > watermarkSeq)
      .map((mutation) => this.clonePersisted(mutation))
  }

  prepareTail(
    ref: ProviderProjectionRef,
    baseMutationWatermarkSeq: number
  ): PreparedClaudeProjectionMutationTail {
    this.assertClaudeRef(ref, "prepareTail")
    this.assertWatermark(baseMutationWatermarkSeq, "prepareTail")
    const mutations = this.listAfter(ref, baseMutationWatermarkSeq)
    const targetMutationWatermarkSeq =
      mutations.at(-1)?.seq ?? baseMutationWatermarkSeq
    return this.freezeTail({
      ref,
      baseMutationWatermarkSeq,
      targetMutationWatermarkSeq,
      mutations,
    })
  }

  /**
   * Re-read a prepared tail while the caller owns a transaction. The receipt
   * is immutable and the prefix must still be byte-for-byte identical before
   * an active head advances its watermark.
   */
  assertPreparedTailCurrentInTransaction(
    txn: SessionTxn,
    tail: PreparedClaudeProjectionMutationTail
  ): void {
    this.assertTxn(txn)
    if (tail.ref.owner.conversationId !== txn.conversationId) {
      throw new Error(
        "ClaudeProjectionMutationLog: prepared tail conversation does not match transaction"
      )
    }
    this.assertPreparedTailCurrent(tail)
  }

  /**
   * Validate an immutable tail receipt while another owner transaction holds
   * the SQLite writer lock. Head installation is not a graph write, so it
   * deliberately does not fabricate a `SessionTxn`; the caller is still
   * required to perform this check and the CAS in one database transaction.
   */
  assertPreparedTailCurrent(tail: PreparedClaudeProjectionMutationTail): void {
    this.assertClaudeRef(tail.ref, "assertPreparedTailCurrent")
    this.assertWatermark(
      tail.baseMutationWatermarkSeq,
      "assertPreparedTailCurrent base"
    )
    this.assertWatermark(
      tail.targetMutationWatermarkSeq,
      "assertPreparedTailCurrent target"
    )
    if (tail.targetMutationWatermarkSeq < tail.baseMutationWatermarkSeq) {
      throw new Error(
        "ClaudeProjectionMutationLog: prepared tail target precedes its base watermark"
      )
    }
    const durable = this.prepareTail(tail.ref, tail.baseMutationWatermarkSeq)
    const expected = tail.mutations
    const actualPrefix = durable.mutations.filter(
      (mutation) => mutation.seq <= tail.targetMutationWatermarkSeq
    )
    if (
      durable.targetMutationWatermarkSeq < tail.targetMutationWatermarkSeq ||
      actualPrefix.length !== expected.length ||
      !this.sameTailBase(durable, tail)
    ) {
      throw new Error(
        `ClaudeProjectionMutationLog: prepared tail is stale for ${providerProjectionStorageKey(tail.ref)}`
      )
    }
    for (let index = 0; index < expected.length; index += 1) {
      if (!this.samePersistedMutation(actualPrefix[index]!, expected[index]!)) {
        throw new Error(
          `ClaudeProjectionMutationLog: prepared tail changed at index ${index} for ${providerProjectionStorageKey(tail.ref)}`
        )
      }
    }
    if (
      tail.targetMutationWatermarkSeq === tail.baseMutationWatermarkSeq &&
      expected.length !== 0
    ) {
      throw new Error(
        "ClaudeProjectionMutationLog: empty prepared tail cannot carry mutations"
      )
    }
    if (
      tail.targetMutationWatermarkSeq > tail.baseMutationWatermarkSeq &&
      expected.length !==
        tail.targetMutationWatermarkSeq - tail.baseMutationWatermarkSeq
    ) {
      throw new Error(
        "ClaudeProjectionMutationLog: prepared tail has a sequence gap"
      )
    }
  }

  private normalizeAppendInput(
    txn: SessionTxn,
    input: AppendClaudeProjectionMutationsInput
  ): {
    ref: ProviderProjectionRef
    sourceGraphUuid: string
    sourceToolUseId: string
    mutations: ClaudeProjectionMutation[]
    createdAt: number
  } {
    this.assertClaudeRef(input.ref, "appendForToolResultInTransaction")
    if (input.ref.owner.conversationId !== txn.conversationId) {
      throw new Error(
        "ClaudeProjectionMutationLog: projection owner does not belong to transaction conversation"
      )
    }
    const sourceGraphUuid = requireExactDurableIdentifier(
      input.sourceGraphUuid,
      "ClaudeProjectionMutationLog source graph UUID"
    )
    const sourceToolUseId = requireExactDurableIdentifier(
      input.sourceToolUseId,
      "ClaudeProjectionMutationLog source tool_use id"
    )
    if (!Array.isArray(input.mutations) || input.mutations.length === 0) {
      throw new Error(
        "ClaudeProjectionMutationLog: a source tool_result requires at least one mutation"
      )
    }
    const mutations = input.mutations.map((mutation, index) =>
      this.normalizeMutation(mutation, `mutations[${index}]`)
    )
    const createdAt = input.createdAt ?? Date.now()
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
      throw new Error(
        "ClaudeProjectionMutationLog: createdAt must be a positive safe integer"
      )
    }
    return {
      ref: input.ref,
      sourceGraphUuid,
      sourceToolUseId,
      mutations,
      createdAt,
    }
  }

  /**
   * The source fields name the current graph receipt that caused this batch.
   * It must be the exact closed ledger result, but its tool-use id is not the
   * mutation target: commands such as snip_messages legitimately rewrite
   * earlier closed tool results.
   */
  private assertAcceptedToolResultTrigger(
    txn: SessionTxn,
    input: {
      ref: ProviderProjectionRef
      sourceGraphUuid: string
      sourceToolUseId: string
    }
  ): void {
    this.messageStore.assertAcceptedToolResultReceiptInTransaction(txn, {
      toolUseId: input.sourceToolUseId,
      recordUuid: input.sourceGraphUuid,
    })
    this.assertClosedToolResultForProjection({
      ref: input.ref,
      toolUseId: input.sourceToolUseId,
      expectedGraphUuid: input.sourceGraphUuid,
      label: "trigger",
    })
  }

  /**
   * Each mutation target is independently provenance-checked. A valid
   * trigger cannot smuggle a cross-owner, non-Claude, open, or fabricated
   * historic target into a Claude replacement projection.
   */
  private assertAcceptedMutationTarget(
    ref: ProviderProjectionRef,
    mutation: ClaudeProjectionMutation
  ): void {
    this.assertClosedToolResultForProjection({
      ref,
      toolUseId: mutation.toolUseId,
      label: "mutation target",
    })
  }

  private assertClosedToolResultForProjection(input: {
    ref: ProviderProjectionRef
    toolUseId: string
    expectedGraphUuid?: string
    label: string
  }): PersistedMessage {
    const closed = this.messageStore.getToolResultMessage(
      input.ref.owner.conversationId,
      input.toolUseId
    )
    if (!closed) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${input.label} tool_result ${input.toolUseId} is not a closed ledger receipt`
      )
    }
    if (
      input.expectedGraphUuid !== undefined &&
      closed.uuid !== input.expectedGraphUuid
    ) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${input.label} graph receipt ${input.expectedGraphUuid} is not the closed result for ${input.toolUseId}`
      )
    }
    this.subagentBranches.verifyProjectionGraphRecords(input.ref.owner, [
      closed,
    ])
    if (
      closed.role !== "user" ||
      !closed.content.some(
        (block) =>
          block.type === "tool_result" && block.tool_use_id === input.toolUseId
      )
    ) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${input.label} graph receipt ${closed.uuid} does not own tool_result ${input.toolUseId}`
      )
    }
    const sourceToolAssistantUuid = requireExactDurableIdentifier(
      closed.sourceToolAssistantUuid,
      `ClaudeProjectionMutationLog ${input.label} tool assistant UUID`
    )
    const assistant = this.subagentBranches.verifyProjectionGraphRecord(
      input.ref.owner,
      sourceToolAssistantUuid
    )
    if (
      assistant.role !== "assistant" ||
      !assistant.content.some(
        (block) => block.type === "tool_use" && block.id === input.toolUseId
      )
    ) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${input.label} tool_result ${input.toolUseId} does not point to its assistant tool_use source`
      )
    }
    const projection = createClaudeProjectionRefFromGraphProvider(
      input.ref.owner,
      assistant.provider
    )
    if (
      providerProjectionStorageKey(projection) !==
      providerProjectionStorageKey(input.ref)
    ) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${input.label} tool_use projection does not match captured Claude ref for ${input.toolUseId}`
      )
    }
    return closed
  }

  private nextSeq(ref: ProviderProjectionRef): number {
    const row = (this.stmtNextSeq ??= this.persistence.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM session_claude_projection_mutations
        WHERE conversation_id = ? AND owner_key = ? AND local_key = ?`
    )).get(ref.owner.conversationId, ref.owner.ownerKey, ref.localKey) as
      | { next_seq?: number }
      | undefined
    const next = row?.next_seq
    if (!Number.isSafeInteger(next) || !next || next < 1) {
      throw new Error(
        `ClaudeProjectionMutationLog: cannot allocate mutation sequence for ${providerProjectionStorageKey(ref)}`
      )
    }
    return next
  }

  private decodeRow(
    ref: ProviderProjectionRef,
    row: StoredMutationRow
  ): PersistedClaudeProjectionMutation {
    if (!Number.isSafeInteger(row.seq) || row.seq < 1) {
      throw new Error(
        `ClaudeProjectionMutationLog: invalid stored sequence for ${providerProjectionStorageKey(ref)}`
      )
    }
    if (!Number.isSafeInteger(row.source_ordinal) || row.source_ordinal < 0) {
      throw new Error(
        `ClaudeProjectionMutationLog: invalid source ordinal for ${providerProjectionStorageKey(ref)}`
      )
    }
    if (!Number.isSafeInteger(row.created_at) || row.created_at <= 0) {
      throw new Error(
        `ClaudeProjectionMutationLog: invalid createdAt for ${providerProjectionStorageKey(ref)}`
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(row.payload_json)
    } catch (error) {
      throw new Error(
        `ClaudeProjectionMutationLog: invalid JSON payload for ${providerProjectionStorageKey(ref)}/${row.seq}: ${(error as Error).message}`
      )
    }
    const mutation = this.normalizeMutation(
      payload,
      `stored mutation ${row.seq}`
    )
    if (this.storageKindForMutation(mutation) !== row.mutation_kind) {
      throw new Error(
        `ClaudeProjectionMutationLog: stored mutation kind does not match payload for ${providerProjectionStorageKey(ref)}/${row.seq}`
      )
    }
    const sourceGraphUuid = requireExactDurableIdentifier(
      row.trigger_graph_uuid,
      "ClaudeProjectionMutationLog stored trigger graph UUID"
    )
    const sourceToolUseId = requireExactDurableIdentifier(
      row.trigger_tool_use_id,
      "ClaudeProjectionMutationLog stored trigger tool_use id"
    )
    const targetToolUseId = requireExactDurableIdentifier(
      row.target_tool_use_id,
      "ClaudeProjectionMutationLog stored target tool_use id"
    )
    if (mutation.toolUseId !== targetToolUseId) {
      throw new Error(
        `ClaudeProjectionMutationLog: stored mutation target mismatch for ${providerProjectionStorageKey(ref)}/${row.seq}`
      )
    }
    this.assertClosedToolResultForProjection({
      ref,
      toolUseId: sourceToolUseId,
      expectedGraphUuid: sourceGraphUuid,
      label: "stored trigger",
    })
    this.assertAcceptedMutationTarget(ref, mutation)
    return this.freezePersisted({
      ...mutation,
      ref,
      seq: row.seq,
      sourceOrdinal: row.source_ordinal,
      sourceGraphUuid,
      sourceToolUseId,
      createdAt: row.created_at,
    })
  }

  private normalizeMutation(
    value: unknown,
    label: string
  ): ClaudeProjectionMutation {
    this.assertObject(value, label)
    const kind = value.kind
    if (kind === "seen") {
      this.assertExactFields(value, ["kind", "toolUseId"], label)
      return {
        kind: "seen",
        toolUseId: requireExactDurableIdentifier(
          value.toolUseId,
          `ClaudeProjectionMutationLog ${label}.toolUseId`
        ),
      }
    }
    if (kind !== "replacement") {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label}.kind must be seen or replacement`
      )
    }
    this.assertExactFields(
      value,
      ["kind", "toolUseId", "replacement", "record", "storedReference"],
      label
    )
    const toolUseId = requireExactDurableIdentifier(
      value.toolUseId,
      `ClaudeProjectionMutationLog ${label}.toolUseId`
    )
    if (typeof value.replacement !== "string") {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label}.replacement must be a string`
      )
    }
    const record = this.normalizeReplacementRecord(
      value.record,
      toolUseId,
      `${label}.record`
    )
    if (record.replacement !== value.replacement) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label}.record replacement does not match mutation`
      )
    }
    const storedReference =
      value.storedReference === undefined
        ? undefined
        : this.normalizeStoredReference(
            value.storedReference,
            toolUseId,
            `${label}.storedReference`
          )
    if (
      storedReference &&
      record.documentId !== undefined &&
      record.documentId !== storedReference.documentId
    ) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label}.record document id does not match stored reference`
      )
    }
    return {
      kind: "replacement",
      toolUseId,
      replacement: value.replacement,
      record,
      ...(storedReference ? { storedReference } : {}),
    }
  }

  private normalizeReplacementRecord(
    value: unknown,
    toolUseId: string,
    label: string
  ): ContextToolResultReplacementRecord {
    this.assertObject(value, label)
    this.assertExactFields(
      value,
      [
        "kind",
        "toolUseId",
        "replacement",
        "projectionVersion",
        "provider",
        "documentId",
        "reason",
        "createdAt",
      ],
      label
    )
    if (value.kind !== "tool-result") {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label}.kind must be tool-result`
      )
    }
    if (
      requireExactDurableIdentifier(
        value.toolUseId,
        `ClaudeProjectionMutationLog ${label}.toolUseId`
      ) !== toolUseId
    ) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label}.toolUseId does not match mutation`
      )
    }
    if (typeof value.replacement !== "string") {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label}.replacement must be a string`
      )
    }
    const createdAt = this.requirePositiveSafeInteger(
      value.createdAt,
      `${label}.createdAt`
    )
    const projectionVersion =
      value.projectionVersion === undefined
        ? undefined
        : this.requirePositiveSafeInteger(
            value.projectionVersion,
            `${label}.projectionVersion`
          )
    if (value.provider !== undefined && value.provider !== "claude") {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label}.provider must be claude when present`
      )
    }
    const documentId =
      value.documentId === undefined
        ? undefined
        : requireExactDurableIdentifier(
            value.documentId,
            `ClaudeProjectionMutationLog ${label}.documentId`
          )
    if (
      value.reason !== undefined &&
      value.reason !== "per_tool" &&
      value.reason !== "aggregate" &&
      value.reason !== "empty" &&
      value.reason !== "microcompact" &&
      value.reason !== "snip"
    ) {
      throw new Error(`ClaudeProjectionMutationLog: ${label}.reason is invalid`)
    }
    return {
      kind: "tool-result",
      toolUseId,
      replacement: value.replacement,
      ...(projectionVersion !== undefined ? { projectionVersion } : {}),
      ...(value.provider === "claude" ? { provider: "claude" as const } : {}),
      ...(documentId ? { documentId } : {}),
      ...(value.reason !== undefined ? { reason: value.reason } : {}),
      createdAt,
    }
  }

  private normalizeStoredReference(
    value: unknown,
    toolUseId: string,
    label: string
  ): ContextStoredToolResultReference {
    this.assertObject(value, label)
    this.assertExactFields(
      value,
      [
        "toolUseId",
        "documentId",
        "relativePath",
        "toolName",
        "originalSizeChars",
        "originalLineCount",
        "previewChars",
        "chunkSize",
        "chunkCount",
        "contentType",
        "sha256",
        "createdAt",
      ],
      label
    )
    if (
      requireExactDurableIdentifier(
        value.toolUseId,
        `ClaudeProjectionMutationLog ${label}.toolUseId`
      ) !== toolUseId
    ) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label}.toolUseId does not match mutation`
      )
    }
    const originalSizeChars = this.requireNonNegativeSafeInteger(
      value.originalSizeChars,
      `${label}.originalSizeChars`
    )
    const originalLineCount = this.requireNonNegativeSafeInteger(
      value.originalLineCount,
      `${label}.originalLineCount`
    )
    const previewChars = this.requireNonNegativeSafeInteger(
      value.previewChars,
      `${label}.previewChars`
    )
    if (previewChars > originalSizeChars) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label}.previewChars exceeds original size`
      )
    }
    const chunkSize = this.requirePositiveSafeInteger(
      value.chunkSize,
      `${label}.chunkSize`
    )
    const chunkCount = this.requirePositiveSafeInteger(
      value.chunkCount,
      `${label}.chunkCount`
    )
    const sha256 = requireExactDurableIdentifier(
      value.sha256,
      `ClaudeProjectionMutationLog ${label}.sha256`
    )
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label}.sha256 must be canonical lowercase SHA-256`
      )
    }
    if (value.contentType !== "text" && value.contentType !== "json") {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label}.contentType must be text or json`
      )
    }
    return {
      toolUseId,
      documentId: requireExactDurableIdentifier(
        value.documentId,
        `ClaudeProjectionMutationLog ${label}.documentId`
      ),
      relativePath: requireExactDurableIdentifier(
        value.relativePath,
        `ClaudeProjectionMutationLog ${label}.relativePath`
      ),
      toolName: requireExactDurableIdentifier(
        value.toolName,
        `ClaudeProjectionMutationLog ${label}.toolName`
      ),
      originalSizeChars,
      originalLineCount,
      previewChars,
      chunkSize,
      chunkCount,
      contentType: value.contentType,
      sha256,
      createdAt: this.requirePositiveSafeInteger(
        value.createdAt,
        `${label}.createdAt`
      ),
    }
  }

  private storageKindForMutation(mutation: ClaudeProjectionMutation): string {
    return mutation.kind === "seen"
      ? "tool_result_seen"
      : "tool_result_replacement"
  }

  private toContextMutation(
    mutation: PersistedClaudeProjectionMutation
  ): ContextToolResultReplacementMutation {
    if (mutation.kind === "seen") {
      return { kind: "seen", toolUseId: mutation.toolUseId }
    }
    return {
      kind: "replacement",
      toolUseId: mutation.toolUseId,
      replacement: mutation.replacement,
      record: { ...mutation.record },
      ...(mutation.storedReference
        ? { storedReference: { ...mutation.storedReference } }
        : {}),
    }
  }

  private assertContiguous(
    ref: ProviderProjectionRef,
    mutations: readonly PersistedClaudeProjectionMutation[]
  ): void {
    let expected = 1
    for (const mutation of mutations) {
      if (mutation.seq !== expected) {
        throw new Error(
          `ClaudeProjectionMutationLog: non-contiguous sequence for ${providerProjectionStorageKey(ref)} expected=${expected} actual=${mutation.seq}`
        )
      }
      expected += 1
    }
  }

  private assertWatermark(value: number, operation: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `ClaudeProjectionMutationLog.${operation}: watermark must be a non-negative safe integer`
      )
    }
  }

  private assertClaudeRef(ref: ProviderProjectionRef, operation: string): void {
    assertProviderProjectionRef(ref, `ClaudeProjectionMutationLog.${operation}`)
    if (ref.provider !== "claude") {
      throw new Error(
        `ClaudeProjectionMutationLog.${operation}: projection provider must be claude`
      )
    }
    this.subagentBranches.verifyProjectionOwner(ref.owner)
  }

  private assertTxn(txn: SessionTxn): void {
    if (!txn || txn.tag !== SESSION_TXN_TAG) {
      throw new Error(
        "ClaudeProjectionMutationLog: append requires a MessageStore transaction"
      )
    }
  }

  private assertObject(
    value: unknown,
    label: string
  ): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`ClaudeProjectionMutationLog: ${label} must be an object`)
    }
  }

  private assertExactFields(
    value: Record<string, unknown>,
    allowedFields: readonly string[],
    label: string
  ): void {
    const allowed = new Set(allowedFields)
    const unsupported = Object.keys(value).filter((key) => !allowed.has(key))
    if (unsupported.length > 0) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label} contains unsupported field(s): ${unsupported.join(", ")}`
      )
    }
  }

  private requireNonNegativeSafeInteger(value: unknown, label: string): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label} must be a non-negative safe integer`
      )
    }
    return value
  }

  private requirePositiveSafeInteger(value: unknown, label: string): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      throw new Error(
        `ClaudeProjectionMutationLog: ${label} must be a positive safe integer`
      )
    }
    return value
  }

  private freezeTail(
    tail: PreparedClaudeProjectionMutationTail
  ): PreparedClaudeProjectionMutationTail {
    return Object.freeze({
      ref: this.freezeRef(tail.ref),
      baseMutationWatermarkSeq: tail.baseMutationWatermarkSeq,
      targetMutationWatermarkSeq: tail.targetMutationWatermarkSeq,
      mutations: Object.freeze(
        tail.mutations.map((mutation) => this.clonePersisted(mutation))
      ),
    })
  }

  private freezePersisted(
    mutation: PersistedClaudeProjectionMutation
  ): PersistedClaudeProjectionMutation {
    const clone = this.clonePersisted(mutation, false)
    if (clone.kind === "replacement") {
      Object.freeze(clone.record)
      if (clone.storedReference) Object.freeze(clone.storedReference)
    }
    return Object.freeze(clone)
  }

  private clonePersisted(
    mutation: PersistedClaudeProjectionMutation,
    freeze = true
  ): PersistedClaudeProjectionMutation {
    const ref = this.freezeRef(mutation.ref)
    const clone: PersistedClaudeProjectionMutation =
      mutation.kind === "seen"
        ? {
            kind: "seen",
            toolUseId: mutation.toolUseId,
            ref,
            seq: mutation.seq,
            sourceOrdinal: mutation.sourceOrdinal,
            sourceGraphUuid: mutation.sourceGraphUuid,
            sourceToolUseId: mutation.sourceToolUseId,
            createdAt: mutation.createdAt,
          }
        : {
            kind: "replacement",
            toolUseId: mutation.toolUseId,
            replacement: mutation.replacement,
            record: { ...mutation.record },
            ...(mutation.storedReference
              ? { storedReference: { ...mutation.storedReference } }
              : {}),
            ref,
            seq: mutation.seq,
            sourceOrdinal: mutation.sourceOrdinal,
            sourceGraphUuid: mutation.sourceGraphUuid,
            sourceToolUseId: mutation.sourceToolUseId,
            createdAt: mutation.createdAt,
          }
    return freeze ? this.freezePersisted(clone) : clone
  }

  private freezeRef(ref: ProviderProjectionRef): ProviderProjectionRef {
    const owner =
      ref.owner.kind === "main"
        ? Object.freeze({ ...ref.owner })
        : Object.freeze({
            ...ref.owner,
            forkLineage: Object.freeze([...ref.owner.forkLineage]),
          })
    return Object.freeze({ ...ref, owner })
  }

  private sameTailBase(
    left: PreparedClaudeProjectionMutationTail,
    right: PreparedClaudeProjectionMutationTail
  ): boolean {
    return (
      left.baseMutationWatermarkSeq === right.baseMutationWatermarkSeq &&
      providerProjectionStorageKey(left.ref) ===
        providerProjectionStorageKey(right.ref)
    )
  }

  private samePersistedMutation(
    left: PersistedClaudeProjectionMutation,
    right: PersistedClaudeProjectionMutation
  ): boolean {
    return (
      left.kind === right.kind &&
      left.toolUseId === right.toolUseId &&
      left.seq === right.seq &&
      left.sourceOrdinal === right.sourceOrdinal &&
      left.sourceGraphUuid === right.sourceGraphUuid &&
      left.sourceToolUseId === right.sourceToolUseId &&
      left.createdAt === right.createdAt &&
      JSON.stringify(this.toContextMutation(left)) ===
        JSON.stringify(this.toContextMutation(right))
    )
  }
}
