import { Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import { PersistenceService } from "../../../persistence"
import {
  assertProjectionOwner,
  projectionOwnerStorageKey,
  type ProjectionOwner,
} from "./projection-owner"
import { SubagentBranchStore } from "./subagent-branch-store.service"

/**
 * The sole provider-neutral compact head for one explicit projection owner.
 * `generation` is both the compact epoch and its compare-and-swap token: a
 * generic compact layout can only advance from the previous epoch by one.
 */
export interface ContextProjectionHead {
  owner: ProjectionOwner
  generation: number
  layoutRecordId: string
  graphWatermarkUuid: string
  activeCompactionId: string
  updatedAt: number
}

export interface InstallContextProjectionHeadInput {
  owner: ProjectionOwner
  generation: number
  layoutRecordId: string
  graphWatermarkUuid: string
  activeCompactionId: string
  updatedAt: number
}

interface StoredContextProjectionHead {
  generation: number
  layout_record_id: string
  graph_watermark_uuid: string
  active_compaction_id: string
  updated_at: number
}

/**
 * SQL owner for owner-scoped generic compact heads. Provider-native Claude
 * and Codex heads live exclusively in ProviderActiveHeadStore; they never
 * participate in generic compaction selection.
 */
@Injectable()
export class ContextProjectionHeadStore {
  private stmtGet?: StatementSync
  private stmtInsert?: StatementSync
  private stmtAdvance?: StatementSync

  constructor(
    private readonly persistence: PersistenceService,
    private readonly subagentBranches: SubagentBranchStore
  ) {}

  get(owner: ProjectionOwner): ContextProjectionHead | undefined {
    this.assertOwner(owner, "get")
    const row = (this.stmtGet ??= this.persistence.prepare(
      `SELECT generation, layout_record_id, graph_watermark_uuid,
              active_compaction_id, updated_at
         FROM session_context_projection_heads
        WHERE conversation_id = ? AND owner_key = ?
        LIMIT 1`
    )).get(owner.conversationId, owner.ownerKey) as
      | StoredContextProjectionHead
      | undefined
    return row ? this.decode(owner, row) : undefined
  }

  /**
   * Install the next immutable generic compact generation. This method is
   * called by ContextProjectionStore inside the transaction that wrote the
   * matching layout records, so failed CAS leaves no mounted head.
   */
  install(input: InstallContextProjectionHeadInput): ContextProjectionHead {
    const normalized = this.normalize(input)
    const current = this.get(normalized.owner)
    const expectedGeneration = (current?.generation ?? 0) + 1
    if (normalized.generation !== expectedGeneration) {
      throw new Error(
        `ContextProjectionHeadStore.install: compact generation for ` +
          `${projectionOwnerStorageKey(normalized.owner)} must advance from ` +
          `${expectedGeneration - 1} to ${expectedGeneration}`
      )
    }

    if (!current) {
      const outcome = (this.stmtInsert ??= this.persistence.prepare(
        `INSERT INTO session_context_projection_heads (
           conversation_id, owner_key, generation, layout_record_id,
           graph_watermark_uuid, active_compaction_id, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )).run(
        normalized.owner.conversationId,
        normalized.owner.ownerKey,
        normalized.generation,
        normalized.layoutRecordId,
        normalized.graphWatermarkUuid,
        normalized.activeCompactionId,
        normalized.updatedAt
      ) as { changes?: number }
      if ((outcome.changes ?? 0) !== 1) {
        throw new Error(
          `ContextProjectionHeadStore.install: failed to create head for ` +
            `${projectionOwnerStorageKey(normalized.owner)}`
        )
      }
    } else {
      const outcome = (this.stmtAdvance ??= this.persistence.prepare(
        `UPDATE session_context_projection_heads
            SET generation = ?, layout_record_id = ?, graph_watermark_uuid = ?,
                active_compaction_id = ?, updated_at = ?
          WHERE conversation_id = ? AND owner_key = ? AND generation = ?`
      )).run(
        normalized.generation,
        normalized.layoutRecordId,
        normalized.graphWatermarkUuid,
        normalized.activeCompactionId,
        normalized.updatedAt,
        normalized.owner.conversationId,
        normalized.owner.ownerKey,
        current.generation
      ) as { changes?: number }
      if ((outcome.changes ?? 0) !== 1) {
        throw new Error(
          `ContextProjectionHeadStore.install: head CAS failed for ` +
            `${projectionOwnerStorageKey(normalized.owner)}`
        )
      }
    }

    return {
      owner: normalized.owner,
      generation: normalized.generation,
      layoutRecordId: normalized.layoutRecordId,
      graphWatermarkUuid: normalized.graphWatermarkUuid,
      activeCompactionId: normalized.activeCompactionId,
      updatedAt: normalized.updatedAt,
    }
  }

  private normalize(
    input: InstallContextProjectionHeadInput
  ): InstallContextProjectionHeadInput {
    this.assertOwner(input.owner, "install")
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new Error(
        "ContextProjectionHeadStore.install: generation must be a positive integer"
      )
    }
    const graphWatermarkUuid = requireExactDurableIdentifier(
      input.graphWatermarkUuid,
      "ContextProjectionHeadStore graph watermark UUID"
    )
    this.subagentBranches.verifyProjectionGraphRecord(
      input.owner,
      graphWatermarkUuid
    )
    if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt <= 0) {
      throw new Error(
        "ContextProjectionHeadStore.install: updatedAt must be positive"
      )
    }
    return {
      owner: input.owner,
      generation: input.generation,
      layoutRecordId: requireExactDurableIdentifier(
        input.layoutRecordId,
        "ContextProjectionHeadStore layout record id"
      ),
      graphWatermarkUuid,
      activeCompactionId: requireExactDurableIdentifier(
        input.activeCompactionId,
        "ContextProjectionHeadStore active compaction id"
      ),
      updatedAt: input.updatedAt,
    }
  }

  private decode(
    owner: ProjectionOwner,
    row: StoredContextProjectionHead
  ): ContextProjectionHead {
    const generation = this.requirePositiveInteger(row.generation, "generation")
    const graphWatermarkUuid = requireExactDurableIdentifier(
      row.graph_watermark_uuid,
      "ContextProjectionHeadStore stored graph watermark UUID"
    )
    this.subagentBranches.verifyProjectionGraphRecord(owner, graphWatermarkUuid)
    return {
      owner,
      generation,
      layoutRecordId: requireExactDurableIdentifier(
        row.layout_record_id,
        "ContextProjectionHeadStore stored layout record id"
      ),
      graphWatermarkUuid,
      activeCompactionId: requireExactDurableIdentifier(
        row.active_compaction_id,
        "ContextProjectionHeadStore stored active compaction id"
      ),
      updatedAt: this.requirePositiveInteger(row.updated_at, "updatedAt"),
    }
  }

  private assertOwner(owner: ProjectionOwner, operation: string): void {
    assertProjectionOwner(owner, `ContextProjectionHeadStore.${operation}`)
    this.subagentBranches.verifyProjectionOwner(owner)
  }

  private requirePositiveInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new Error(
        `ContextProjectionHeadStore: ${label} must be a positive integer`
      )
    }
    return value as number
  }
}
