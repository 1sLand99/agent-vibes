import { Injectable } from "@nestjs/common"
import { createHash } from "node:crypto"
import type { StatementSync } from "node:sqlite"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import type { ContextTranscriptRecord } from "../../../context/types"
import {
  isCompactBoundaryRecord,
  isCompactSummaryRecord,
  isMessageRecord,
  isSnipBoundaryRecord,
} from "../../../context/context-transcript-events"
import { PersistenceService } from "../../../persistence"
import {
  ContextProjectionHeadStore,
  type ContextProjectionHead,
} from "./context-projection-active-head.store"
import {
  assertProjectionOwner,
  assertSameProjectionOwner,
  projectionOwnerStorageKey,
  type ProjectionOwner,
} from "./projection-owner"
import { SubagentBranchStore } from "./subagent-branch-store.service"

export interface ContextProjectionLayout {
  recordId: string
  orderedRecordIds: string[]
}

export interface RestoredContextProjection {
  head: ContextProjectionHead
  layout: ContextProjectionLayout
  syntheticRecords: ContextTranscriptRecord[]
}

export interface InstallContextProjectionInput {
  owner: ProjectionOwner
  /** Monotonic compact epoch. The first installed generation is exactly 1. */
  generation: number
  /** Exact post-compact projection order, including graph and Snip ids. */
  orderedRecords: readonly ContextTranscriptRecord[]
  /** Last durable main-graph fragment seen by the candidate at install time. */
  graphWatermarkUuid: string
  activeCompactionId: string
  updatedAt?: number
}

interface StoredProjectionRecord {
  generation: number
  seq: number
  record_id: string
  record_kind: string
  payload: Buffer
  created_at: number
}

type ContextProjectionPayload =
  | { kind: "projection_layout"; orderedRecordIds: string[] }
  | { kind: "synthetic_record"; record: ContextTranscriptRecord }

/**
 * Durable provider-neutral compact projection.
 *
 * Graph messages and Snip boundaries remain owned by their dedicated
 * append-only stores. This store owns only the ordered layout and the
 * provider-independent synthetic records which cannot be reconstructed from
 * the graph (compact boundary/summary, frozen attachments and hook output).
 * Every installation is a new immutable generation; the head is a CAS-style
 * pointer to one complete generation rather than a mutable context snapshot.
 */
@Injectable()
export class ContextProjectionStore {
  private stmtNextSeq?: StatementSync
  private stmtInsert?: StatementSync
  private stmtGetRecords?: StatementSync
  private stmtHasGraphRecord?: StatementSync
  private stmtHasSnipBoundary?: StatementSync

  constructor(
    private readonly persistence: PersistenceService,
    private readonly activeHeads: ContextProjectionHeadStore,
    private readonly subagentBranches: SubagentBranchStore
  ) {}

  install(input: InstallContextProjectionInput): ContextProjectionHead {
    const normalized = this.normalizeInstall(input)
    const layoutPayload: ContextProjectionPayload = {
      kind: "projection_layout",
      orderedRecordIds: normalized.orderedRecords.map((record) => record.id),
    }
    const layoutBytes = this.encodePayload(layoutPayload)
    const layoutRecordId = `layout:${createHash("sha256")
      .update(layoutBytes)
      .digest("hex")}`

    return this.persistence.runInTransaction(() => {
      this.assertDurableLayoutSources(
        normalized.owner,
        normalized.orderedRecords
      )
      this.assertDurableGraphRecord(
        normalized.owner,
        normalized.graphWatermarkUuid,
        "graph watermark"
      )
      for (const record of normalized.orderedRecords) {
        if (isMessageRecord(record) || isSnipBoundaryRecord(record)) continue
        this.appendImmutable({
          owner: normalized.owner,
          generation: normalized.generation,
          recordId: `synthetic:${record.id}`,
          recordKind: "synthetic_record",
          payload: this.encodePayload({ kind: "synthetic_record", record }),
          createdAt: record.createdAt,
        })
      }
      this.appendImmutable({
        owner: normalized.owner,
        generation: normalized.generation,
        recordId: layoutRecordId,
        recordKind: "projection_layout",
        payload: layoutBytes,
        createdAt: normalized.updatedAt,
      })

      return this.activeHeads.install({
        owner: normalized.owner,
        generation: normalized.generation,
        layoutRecordId,
        graphWatermarkUuid: normalized.graphWatermarkUuid,
        activeCompactionId: normalized.activeCompactionId,
        updatedAt: normalized.updatedAt,
      })
    })
  }

  restore(
    owner: ProjectionOwner,
    expectedHead?: ContextProjectionHead
  ): RestoredContextProjection | undefined {
    this.assertOwner(owner, "restore")
    const head = expectedHead ?? this.activeHeads.get(owner)
    if (!head) return undefined
    assertSameProjectionOwner(
      owner,
      head.owner,
      "ContextProjectionStore.restore"
    )
    const syntheticById = new Map<string, ContextTranscriptRecord>()
    let layout: ContextProjectionLayout | undefined

    for (const stored of this.listGeneration(owner, head.generation)) {
      const payload = this.decodePayload(owner, stored)
      if (payload.kind === "synthetic_record") {
        const record = this.normalizeSyntheticRecord(payload.record)
        if (syntheticById.has(record.id)) {
          throw new Error(
            `ContextProjectionStore.restore: duplicate synthetic record ${record.id} for ${projectionOwnerStorageKey(owner)}`
          )
        }
        syntheticById.set(record.id, record)
        continue
      }
      if (payload.kind === "projection_layout") {
        if (stored.record_id !== head.layoutRecordId) {
          throw new Error(
            `ContextProjectionStore.restore: active generation contains an unselected layout ${stored.record_id} for ${projectionOwnerStorageKey(owner)}`
          )
        }
        if (layout) {
          throw new Error(
            `ContextProjectionStore.restore: duplicate active layout ${head.layoutRecordId} for ${projectionOwnerStorageKey(owner)}`
          )
        }
        layout = {
          recordId: stored.record_id,
          orderedRecordIds: this.requireOrderedRecordIds(
            payload.orderedRecordIds
          ),
        }
      }
    }

    if (!layout) {
      throw new Error(
        `ContextProjectionStore.restore: active layout ${head.layoutRecordId} is missing for ${projectionOwnerStorageKey(owner)}`
      )
    }
    const layoutIds = new Set(layout.orderedRecordIds)
    for (const syntheticId of syntheticById.keys()) {
      if (!layoutIds.has(syntheticId)) {
        throw new Error(
          `ContextProjectionStore.restore: synthetic record ${syntheticId} is absent from active layout for ${projectionOwnerStorageKey(owner)}`
        )
      }
    }
    for (const recordId of layout.orderedRecordIds) {
      const synthetic = syntheticById.has(recordId)
      const graph = this.hasOwnedGraphRecord(owner, recordId)
      const snip = this.hasOwnedSnipBoundary(owner, recordId)
      if (Number(synthetic) + Number(graph) + Number(snip) !== 1) {
        throw new Error(
          `ContextProjectionStore.restore: layout source ${recordId} is not uniquely durable for ${projectionOwnerStorageKey(owner)}`
        )
      }
    }

    return {
      head,
      layout,
      syntheticRecords: [...syntheticById.values()].map((record) =>
        structuredClone(record)
      ),
    }
  }

  private listGeneration(
    owner: ProjectionOwner,
    generation: number
  ): StoredProjectionRecord[] {
    const rows = (this.stmtGetRecords ??= this.persistence.prepare(
      `SELECT generation, seq, record_id, record_kind, payload, created_at
         FROM session_context_projection_records
        WHERE conversation_id = ? AND owner_key = ? AND generation = ?
        ORDER BY seq ASC`
    )).all(
      owner.conversationId,
      owner.ownerKey,
      generation
    ) as unknown as StoredProjectionRecord[]
    let previousSeq = 0
    for (const row of rows) {
      if (
        !Number.isInteger(row.generation) ||
        row.generation !== generation ||
        !Number.isInteger(row.seq) ||
        row.seq <= previousSeq ||
        !Number.isSafeInteger(row.created_at) ||
        row.created_at <= 0 ||
        typeof row.record_id !== "string" ||
        (row.record_kind !== "projection_layout" &&
          row.record_kind !== "synthetic_record")
      ) {
        throw new Error(
          `ContextProjectionStore.restore: invalid record sequence for ${projectionOwnerStorageKey(owner)} generation=${generation}`
        )
      }
      requireExactDurableIdentifier(
        row.record_id,
        "ContextProjectionStore stored record id"
      )
      previousSeq = row.seq
    }
    return rows
  }

  private appendImmutable(input: {
    owner: ProjectionOwner
    generation: number
    recordId: string
    recordKind: "projection_layout" | "synthetic_record"
    payload: Buffer
    createdAt: number
  }): void {
    const existing = this.persistence
      .prepare(
        `SELECT record_kind, payload
          FROM session_context_projection_records
          WHERE conversation_id = ?
            AND owner_key = ?
            AND generation = ?
            AND record_id = ?
          LIMIT 1`
      )
      .get(
        input.owner.conversationId,
        input.owner.ownerKey,
        input.generation,
        input.recordId
      ) as { record_kind: string; payload: Buffer } | undefined
    if (existing) {
      if (
        existing.record_kind !== input.recordKind ||
        !Buffer.from(existing.payload).equals(Buffer.from(input.payload))
      ) {
        throw new Error(
          `ContextProjectionStore.install: immutable record collision ${projectionOwnerStorageKey(input.owner)}/${input.recordId}`
        )
      }
      return
    }
    const seq = this.nextSeq(input.owner, input.generation)
    ;(this.stmtInsert ??= this.persistence.prepare(
      `INSERT INTO session_context_projection_records (
         conversation_id, owner_key, generation, seq, record_id, record_kind,
         payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )).run(
      input.owner.conversationId,
      input.owner.ownerKey,
      input.generation,
      seq,
      input.recordId,
      input.recordKind,
      Buffer.from(input.payload),
      input.createdAt
    )
  }

  private nextSeq(owner: ProjectionOwner, generation: number): number {
    const row = (this.stmtNextSeq ??= this.persistence.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM session_context_projection_records
        WHERE conversation_id = ? AND owner_key = ? AND generation = ?`
    )).get(owner.conversationId, owner.ownerKey, generation) as
      | {
          next_seq?: number
        }
      | undefined
    if (
      !Number.isInteger(row?.next_seq) ||
      !row?.next_seq ||
      row.next_seq < 1
    ) {
      throw new Error(
        `ContextProjectionStore.install: cannot allocate sequence for ${projectionOwnerStorageKey(owner)}`
      )
    }
    return row.next_seq
  }

  private normalizeInstall(input: InstallContextProjectionInput): {
    owner: ProjectionOwner
    generation: number
    orderedRecords: ContextTranscriptRecord[]
    graphWatermarkUuid: string
    activeCompactionId: string
    updatedAt: number
  } {
    this.assertOwner(input.owner, "install")
    if (!Number.isInteger(input.generation) || input.generation < 1) {
      throw new Error(
        "ContextProjectionStore.install: generation must be positive"
      )
    }
    const orderedRecords = input.orderedRecords.map((record) =>
      structuredClone(record)
    )
    if (orderedRecords.length === 0) {
      throw new Error("ContextProjectionStore.install: layout cannot be empty")
    }
    const ids = this.requireOrderedRecordIds(
      orderedRecords.map((record) => record.id)
    )
    if (ids.length !== orderedRecords.length) {
      throw new Error(
        "ContextProjectionStore.install: layout identifiers are invalid"
      )
    }
    const graphWatermarkUuid = requireExactDurableIdentifier(
      input.graphWatermarkUuid,
      "ContextProjectionStore graph watermark UUID"
    )
    const activeCompactionId = requireExactDurableIdentifier(
      input.activeCompactionId,
      "ContextProjectionStore active compaction id"
    )
    // A full compaction intentionally has no retained graph message in its
    // mounted layout. The watermark still names the exact durable graph head
    // at installation, and recovery uses it to append only later graph rows.
    // Its durable ownership is verified inside the write transaction rather
    // than inferred from the layout membership.
    const activeBoundary = orderedRecords.find(
      (record) =>
        isCompactBoundaryRecord(record) &&
        record.compactMetadata?.commit?.id === activeCompactionId
    )
    if (!activeBoundary) {
      throw new Error(
        `ContextProjectionStore.install: active compaction ${activeCompactionId} has no boundary record`
      )
    }
    const activeSummary = orderedRecords.find(
      (record) =>
        isCompactSummaryRecord(record) &&
        record.compactMetadata?.commit?.id === activeCompactionId
    )
    if (!activeSummary) {
      throw new Error(
        `ContextProjectionStore.install: active compaction ${activeCompactionId} has no summary record`
      )
    }
    const boundaryEpoch = activeBoundary.compactMetadata?.commit?.epoch
    const summaryEpoch = activeSummary.compactMetadata?.commit?.epoch
    if (
      boundaryEpoch !== input.generation ||
      summaryEpoch !== input.generation
    ) {
      throw new Error(
        `ContextProjectionStore.install: active compaction ${activeCompactionId} does not match generation ${input.generation}`
      )
    }
    const updatedAt = input.updatedAt ?? Date.now()
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) {
      throw new Error(
        "ContextProjectionStore.install: updatedAt must be positive"
      )
    }
    return {
      owner: input.owner,
      generation: input.generation,
      orderedRecords,
      graphWatermarkUuid,
      activeCompactionId,
      updatedAt,
    }
  }

  private normalizeSyntheticRecord(
    record: ContextTranscriptRecord
  ): ContextTranscriptRecord {
    const normalized = structuredClone(record)
    if (
      !normalized.id ||
      isMessageRecord(normalized) ||
      isSnipBoundaryRecord(normalized)
    ) {
      throw new Error(
        "ContextProjectionStore.restore: synthetic record has an invalid kind"
      )
    }
    requireExactDurableIdentifier(
      normalized.id,
      "ContextProjectionStore synthetic record id"
    )
    return normalized
  }

  /**
   * A projection layout can reference exactly one source for every id: a
   * durable graph row, a durable Snip event, or an immutable synthetic row
   * owned by this layout. Do this before appending any records so a malformed
   * hot layout cannot become a cold-recovery failure later.
   */
  private assertDurableLayoutSources(
    owner: ProjectionOwner,
    records: readonly ContextTranscriptRecord[]
  ): void {
    for (const record of records) {
      const recordId = requireExactDurableIdentifier(
        record.id,
        "ContextProjectionStore layout id"
      )
      const synthetic =
        !isMessageRecord(record) && !isSnipBoundaryRecord(record)
      const graph = this.hasOwnedGraphRecord(owner, recordId)
      const snip = this.hasOwnedSnipBoundary(owner, recordId)
      const sourceCount = Number(synthetic) + Number(graph) + Number(snip)
      if (sourceCount !== 1) {
        throw new Error(
          `ContextProjectionStore.install: layout source ${recordId} is not uniquely durable for ${projectionOwnerStorageKey(owner)}`
        )
      }
    }
  }

  private assertDurableGraphRecord(
    owner: ProjectionOwner,
    recordId: string,
    label: string
  ): void {
    if (!this.hasOwnedGraphRecord(owner, recordId)) {
      throw new Error(
        `ContextProjectionStore.install: ${label} ${recordId} is absent from the durable graph for ${projectionOwnerStorageKey(owner)}`
      )
    }
  }

  private hasOwnedGraphRecord(
    owner: ProjectionOwner,
    recordId: string
  ): boolean {
    const exists = Boolean(
      (this.stmtHasGraphRecord ??= this.persistence.prepare(
        `SELECT 1
           FROM session_messages
          WHERE conversation_id = ? AND uuid = ?
          LIMIT 1`
      )).get(owner.conversationId, recordId)
    )
    if (!exists) return false
    this.subagentBranches.verifyProjectionGraphRecord(owner, recordId)
    return true
  }

  private hasOwnedSnipBoundary(
    owner: ProjectionOwner,
    recordId: string
  ): boolean {
    const exists = Boolean(
      (this.stmtHasSnipBoundary ??= this.persistence.prepare(
        `SELECT 1
           FROM session_snip_boundaries
          WHERE conversation_id = ? AND boundary_id = ?
          LIMIT 1`
      )).get(owner.conversationId, recordId)
    )
    if (exists && owner.kind !== "main") {
      throw new Error(
        `ContextProjectionStore: child projection cannot consume main-owned Snip boundary ${recordId}`
      )
    }
    return exists
  }

  private requireOrderedRecordIds(ids: readonly string[]): string[] {
    if (ids.length === 0) {
      throw new Error("ContextProjectionStore: layout identifiers are required")
    }
    const exactIds = ids.map((id) =>
      requireExactDurableIdentifier(id, "ContextProjectionStore layout id")
    )
    if (new Set(exactIds).size !== exactIds.length) {
      throw new Error("ContextProjectionStore: layout ids must be unique")
    }
    return exactIds
  }

  private decodePayload(
    owner: ProjectionOwner,
    record: StoredProjectionRecord
  ): ContextProjectionPayload {
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(record.payload).toString("utf8"))
    } catch (error) {
      throw new Error(
        `ContextProjectionStore.restore: invalid payload ${record.record_id} for ${projectionOwnerStorageKey(owner)}: ${(error as Error).message}`
      )
    }
    if (!payload || typeof payload !== "object") {
      throw new Error(
        `ContextProjectionStore.restore: invalid payload shape ${record.record_id} for ${projectionOwnerStorageKey(owner)}`
      )
    }
    const kind = (payload as { kind?: unknown }).kind
    if (kind === "projection_layout") {
      if (record.record_kind !== "projection_layout") {
        throw new Error(
          `ContextProjectionStore.restore: record kind mismatch for ${record.record_id}`
        )
      }
      const orderedRecordIds = (payload as { orderedRecordIds?: unknown })
        .orderedRecordIds
      if (!Array.isArray(orderedRecordIds)) {
        throw new Error(
          `ContextProjectionStore.restore: invalid layout payload ${record.record_id}`
        )
      }
      const exactIds = this.requireOrderedRecordIds(
        orderedRecordIds as string[]
      )
      const expectedRecordId = `layout:${createHash("sha256")
        .update(
          this.encodePayload({
            kind: "projection_layout",
            orderedRecordIds: exactIds,
          })
        )
        .digest("hex")}`
      if (record.record_id !== expectedRecordId) {
        throw new Error(
          `ContextProjectionStore.restore: layout record id does not match its payload for ${projectionOwnerStorageKey(owner)}`
        )
      }
      return {
        kind,
        orderedRecordIds: exactIds,
      }
    }
    if (kind === "synthetic_record") {
      if (record.record_kind !== "synthetic_record") {
        throw new Error(
          `ContextProjectionStore.restore: record kind mismatch for ${record.record_id}`
        )
      }
      const synthetic = (payload as { record?: unknown }).record
      if (!synthetic || typeof synthetic !== "object") {
        throw new Error(
          `ContextProjectionStore.restore: invalid synthetic payload ${record.record_id}`
        )
      }
      const normalized = this.normalizeSyntheticRecord(
        synthetic as ContextTranscriptRecord
      )
      if (record.record_id !== `synthetic:${normalized.id}`) {
        throw new Error(
          `ContextProjectionStore.restore: synthetic record id does not match its payload for ${projectionOwnerStorageKey(owner)}`
        )
      }
      return {
        kind,
        record: normalized,
      }
    }
    throw new Error(
      `ContextProjectionStore.restore: unknown payload kind ${String(kind)} for ${record.record_id}`
    )
  }

  private encodePayload(payload: ContextProjectionPayload): Buffer {
    return Buffer.from(JSON.stringify(payload), "utf8")
  }

  private assertOwner(owner: ProjectionOwner, operation: string): void {
    assertProjectionOwner(owner, `ContextProjectionStore.${operation}`)
    this.subagentBranches.verifyProjectionOwner(owner)
  }
}
