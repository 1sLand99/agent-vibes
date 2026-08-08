import { Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import { PersistenceService } from "../../../persistence"
import type { ConversationId } from "../turn/turn.types"

export interface SessionSnipBoundaryEvent {
  conversationId: ConversationId
  /** Monotonic per-conversation event sequence assigned by the store. */
  seq: number
  id: string
  /** The graph record immediately before this projection event. */
  afterGraphUuid: string
  /** Durable graph message UUIDs hidden from every provider projection. */
  removedRecordIds: string[]
  trigger: "user" | "model"
  reason?: string
  createdAt: number
}

export interface AppendSessionSnipBoundary {
  conversationId: ConversationId
  id: string
  afterGraphUuid: string
  removedRecordIds: readonly string[]
  trigger: "user" | "model"
  reason?: string
  createdAt: number
}

interface StoredSnipBoundaryRow {
  seq: number
  boundary_id: string
  after_graph_uuid: string
  removed_record_ids_json: string
  trigger: string
  reason: string | null
  created_at: number
}

/**
 * Provider-neutral append-only store for Snip projection boundaries.
 *
 * This table deliberately has no snapshot reader and no provider-specific
 * payload: the immutable graph plus these events are sufficient to rebuild a
 * projection exactly after a cold restart.
 */
@Injectable()
export class SnipBoundaryStore {
  private stmtNextSeq?: StatementSync
  private stmtInsert?: StatementSync
  private stmtFindById?: StatementSync
  private stmtGraphRecord?: StatementSync

  constructor(private readonly persistence: PersistenceService) {}

  /**
   * Appends one immutable event. It is transaction-neutral so an owner can
   * compose it atomically with a provider-head installation.
   */
  appendImmutable(input: AppendSessionSnipBoundary): SessionSnipBoundaryEvent {
    const normalized = this.normalizeAppend(input)
    this.assertDurableMainGraphSources(normalized)
    const existing = (this.stmtFindById ??= this.persistence.prepare(
      `SELECT seq, boundary_id, after_graph_uuid, removed_record_ids_json,
              trigger, reason, created_at
         FROM session_snip_boundaries
        WHERE conversation_id = ? AND boundary_id = ?
        LIMIT 1`
    )).get(normalized.conversationId, normalized.id) as
      | StoredSnipBoundaryRow
      | undefined
    if (existing) {
      const restored = this.decodeRow(normalized.conversationId, existing)
      if (!this.isSameEvent(restored, normalized)) {
        throw new Error(
          `SnipBoundaryStore: immutable boundary collision ${normalized.conversationId}/${normalized.id}`
        )
      }
      return restored
    }

    const seq = this.nextSeq(normalized.conversationId)
    ;(this.stmtInsert ??= this.persistence.prepare(
      `INSERT INTO session_snip_boundaries (
         conversation_id, seq, boundary_id, after_graph_uuid,
         removed_record_ids_json, trigger, reason, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )).run(
      normalized.conversationId,
      seq,
      normalized.id,
      normalized.afterGraphUuid,
      JSON.stringify(normalized.removedRecordIds),
      normalized.trigger,
      normalized.reason ?? null,
      normalized.createdAt
    )
    return { ...normalized, seq }
  }

  list(conversationId: ConversationId): SessionSnipBoundaryEvent[] {
    const rows = this.persistence
      .prepare(
        `SELECT seq, boundary_id, after_graph_uuid, removed_record_ids_json,
                trigger, reason, created_at
           FROM session_snip_boundaries
          WHERE conversation_id = ?
          ORDER BY seq ASC`
      )
      .all(conversationId) as unknown as StoredSnipBoundaryRow[]
    let previousSeq = 0
    return rows.map((row) => {
      if (!Number.isInteger(row.seq) || row.seq <= previousSeq) {
        throw new Error(
          `SnipBoundaryStore: invalid sequence for ${conversationId}`
        )
      }
      previousSeq = row.seq
      return this.decodeRow(conversationId, row)
    })
  }

  private nextSeq(conversationId: ConversationId): number {
    const row = (this.stmtNextSeq ??= this.persistence.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM session_snip_boundaries
        WHERE conversation_id = ?`
    )).get(conversationId) as { next_seq?: number } | undefined
    const next = row?.next_seq
    if (!Number.isInteger(next) || !next || next < 1) {
      throw new Error(
        `SnipBoundaryStore: cannot allocate sequence for ${conversationId}`
      )
    }
    return next
  }

  private normalizeAppend(
    input: AppendSessionSnipBoundary
  ): Omit<SessionSnipBoundaryEvent, "seq"> {
    const id = requireExactDurableIdentifier(
      input.id,
      "SnipBoundaryStore boundary id"
    )
    const afterGraphUuid = requireExactDurableIdentifier(
      input.afterGraphUuid,
      "SnipBoundaryStore after_graph_uuid"
    )
    const removedRecordIds = input.removedRecordIds.map((recordId) =>
      requireExactDurableIdentifier(
        recordId,
        "SnipBoundaryStore removed record id"
      )
    )
    if (removedRecordIds.length === 0) {
      throw new Error("SnipBoundaryStore: removed record ids are required")
    }
    if (new Set(removedRecordIds).size !== removedRecordIds.length) {
      throw new Error("SnipBoundaryStore: removed record ids must be unique")
    }
    if (input.trigger !== "user" && input.trigger !== "model") {
      throw new Error("SnipBoundaryStore: invalid trigger")
    }
    if (!Number.isSafeInteger(input.createdAt) || input.createdAt <= 0) {
      throw new Error("SnipBoundaryStore: createdAt must be a positive integer")
    }
    const reason = input.reason?.trim()
    if (reason && reason.length > 240) {
      throw new Error("SnipBoundaryStore: reason exceeds 240 characters")
    }
    return {
      conversationId: input.conversationId,
      id,
      afterGraphUuid,
      removedRecordIds,
      trigger: input.trigger,
      ...(reason ? { reason } : {}),
      createdAt: input.createdAt,
    }
  }

  /**
   * A Snip is a durable graph transform, never a free-standing UI marker.
   * Validate its anchor and every removed source against the same
   * conversation before it can become visible to any projection. The JSON
   * array cannot be expressed as a SQLite foreign key, so this is the write
   * boundary that keeps malformed events out of durable state.
   */
  private assertDurableMainGraphSources(
    input: Omit<SessionSnipBoundaryEvent, "seq">
  ): void {
    const anchor = this.getMainGraphRecord(
      input.conversationId,
      input.afterGraphUuid,
      "anchor"
    )
    for (const recordId of input.removedRecordIds) {
      const removed = this.getMainGraphRecord(
        input.conversationId,
        recordId,
        "removed record"
      )
      if (removed.seq > anchor.seq) {
        throw new Error(
          `SnipBoundaryStore: removed record ${recordId} is after anchor ${input.afterGraphUuid}`
        )
      }
    }
  }

  private getMainGraphRecord(
    conversationId: ConversationId,
    recordId: string,
    label: string
  ): { seq: number } {
    const row = (this.stmtGraphRecord ??= this.persistence.prepare(
      `SELECT seq, is_sidechain
         FROM session_messages
        WHERE conversation_id = ? AND uuid = ?
        LIMIT 1`
    )).get(conversationId, recordId) as
      | { seq: number; is_sidechain: number }
      | undefined
    if (!row || !Number.isInteger(row.seq) || row.seq < 1) {
      throw new Error(
        `SnipBoundaryStore: ${label} ${recordId} is absent from the durable graph for ${conversationId}`
      )
    }
    if (row.is_sidechain !== 0) {
      throw new Error(
        `SnipBoundaryStore: ${label} ${recordId} is not a main-graph message for ${conversationId}`
      )
    }
    return { seq: row.seq }
  }

  private decodeRow(
    conversationId: ConversationId,
    row: StoredSnipBoundaryRow
  ): SessionSnipBoundaryEvent {
    let removedRecordIds: unknown
    try {
      removedRecordIds = JSON.parse(row.removed_record_ids_json)
    } catch (error) {
      throw new Error(
        `SnipBoundaryStore: invalid removed record ids for ${conversationId}/${row.boundary_id}: ${(error as Error).message}`
      )
    }
    if (!Array.isArray(removedRecordIds)) {
      throw new Error(
        `SnipBoundaryStore: removed record ids are not an array for ${conversationId}/${row.boundary_id}`
      )
    }
    return {
      ...this.normalizeAppend({
        conversationId,
        id: row.boundary_id,
        afterGraphUuid: row.after_graph_uuid,
        removedRecordIds: removedRecordIds as string[],
        trigger: row.trigger as "user" | "model",
        reason: row.reason ?? undefined,
        createdAt: row.created_at,
      }),
      seq: row.seq,
    }
  }

  private isSameEvent(
    existing: SessionSnipBoundaryEvent,
    input: Omit<SessionSnipBoundaryEvent, "seq">
  ): boolean {
    return (
      existing.afterGraphUuid === input.afterGraphUuid &&
      existing.trigger === input.trigger &&
      existing.reason === input.reason &&
      existing.createdAt === input.createdAt &&
      existing.removedRecordIds.length === input.removedRecordIds.length &&
      existing.removedRecordIds.every(
        (recordId, index) => recordId === input.removedRecordIds[index]
      )
    )
  }
}
