import { Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import { PersistenceService } from "../../../persistence"
import {
  assertProviderProjectionRef,
  providerProjectionStorageKey,
  type ProviderProjectionRef,
} from "./projection-owner"
import { SubagentBranchStore } from "./subagent-branch-store.service"

/** A missing provider head is the explicit initial CAS revision. */
export const INITIAL_PROVIDER_PROJECTION_REVISION = 0

export interface ProviderActiveHead {
  ref: ProviderProjectionRef
  /** Independent provider-layout revision, never a generic compact epoch. */
  revision: number
  headKind: string
  headId: string
  metadata?: Record<string, unknown>
  updatedAt: number
}

/** A stale provider projector must rebuild its layout from the durable head. */
export class ProviderProjectionHeadRevisionConflictError extends Error {
  constructor(ref: ProviderProjectionRef, expectedRevision: number) {
    super(
      `ProviderActiveHeadStore: stale provider projection head for ` +
        `${providerProjectionStorageKey(ref)}; expected revision ${expectedRevision}`
    )
    this.name = "ProviderProjectionHeadRevisionConflictError"
  }
}

/**
 * Provider-native active heads, keyed only by explicit owner/provider/local
 * reference. Claude and Codex use the same revision-CAS contract; neither
 * provider has an unconditional upsert path.
 */
@Injectable()
export class ProviderActiveHeadStore {
  private stmtInsertInitial?: StatementSync
  private stmtAdvance?: StatementSync
  private stmtGet?: StatementSync

  constructor(
    private readonly persistence: PersistenceService,
    private readonly subagentBranches: SubagentBranchStore
  ) {}

  installIfRevision(head: ProviderActiveHead, expectedRevision: number): void {
    this.assertHead(head, "installIfRevision")
    this.assertExpectedRevision(expectedRevision)
    if (head.revision !== expectedRevision + 1) {
      throw new Error(
        "ProviderActiveHeadStore.installIfRevision: revision must advance " +
          `from ${expectedRevision} to ${expectedRevision + 1}`
      )
    }

    const metadataJson = head.metadata ? JSON.stringify(head.metadata) : null
    const result =
      expectedRevision === INITIAL_PROVIDER_PROJECTION_REVISION
        ? (this.stmtInsertInitial ??= this.persistence.prepare(
            `INSERT INTO session_provider_active_heads (
               conversation_id, owner_key, provider, local_key, revision,
               head_kind, head_id, metadata_json, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(conversation_id, owner_key, provider, local_key)
             DO NOTHING`
          )).run(
            head.ref.owner.conversationId,
            head.ref.owner.ownerKey,
            head.ref.provider,
            head.ref.localKey,
            head.revision,
            head.headKind,
            head.headId,
            metadataJson,
            head.updatedAt
          )
        : (this.stmtAdvance ??= this.persistence.prepare(
            `UPDATE session_provider_active_heads
                SET revision = ?,
                    head_kind = ?,
                    head_id = ?,
                    metadata_json = ?,
                    updated_at = ?
              WHERE conversation_id = ?
                AND owner_key = ?
                AND provider = ?
                AND local_key = ?
                AND revision = ?`
          )).run(
            head.revision,
            head.headKind,
            head.headId,
            metadataJson,
            head.updatedAt,
            head.ref.owner.conversationId,
            head.ref.owner.ownerKey,
            head.ref.provider,
            head.ref.localKey,
            expectedRevision
          )

    if ((result.changes ?? 0) !== 1) {
      throw new ProviderProjectionHeadRevisionConflictError(
        head.ref,
        expectedRevision
      )
    }
  }

  get(ref: ProviderProjectionRef): ProviderActiveHead | undefined {
    this.assertRef(ref, "get")
    const row = (this.stmtGet ??= this.persistence.prepare(
      `SELECT revision, head_kind, head_id, metadata_json, updated_at
         FROM session_provider_active_heads
        WHERE conversation_id = ?
          AND owner_key = ?
          AND provider = ?
          AND local_key = ?
        LIMIT 1`
    )).get(
      ref.owner.conversationId,
      ref.owner.ownerKey,
      ref.provider,
      ref.localKey
    ) as
      | {
          revision: number
          head_kind: string
          head_id: string
          metadata_json: string | null
          updated_at: number
        }
      | undefined
    if (!row) return undefined
    return {
      ref,
      revision: this.requirePositiveInteger(row.revision, "stored revision"),
      headKind: requireExactDurableIdentifier(
        row.head_kind,
        "ProviderActiveHeadStore stored head kind"
      ),
      headId: requireExactDurableIdentifier(
        row.head_id,
        "ProviderActiveHeadStore stored head id"
      ),
      metadata: row.metadata_json
        ? this.parseMetadata(ref, row.metadata_json)
        : undefined,
      updatedAt: this.requirePositiveInteger(
        row.updated_at,
        "stored updatedAt"
      ),
    }
  }

  private assertHead(head: ProviderActiveHead, operation: string): void {
    this.assertRef(head.ref, operation)
    if (!Number.isInteger(head.revision) || head.revision < 1) {
      throw new Error(
        `ProviderActiveHeadStore.${operation}: revision must be a positive integer`
      )
    }
    requireExactDurableIdentifier(
      head.headKind,
      "ProviderActiveHeadStore headKind"
    )
    requireExactDurableIdentifier(head.headId, "ProviderActiveHeadStore headId")
    if (!Number.isSafeInteger(head.updatedAt) || head.updatedAt <= 0) {
      throw new Error(
        `ProviderActiveHeadStore.${operation}: updatedAt must be positive`
      )
    }
  }

  private assertRef(ref: ProviderProjectionRef, operation: string): void {
    assertProviderProjectionRef(ref, `ProviderActiveHeadStore.${operation}`)
    this.subagentBranches.verifyProjectionOwner(ref.owner)
  }

  private assertExpectedRevision(expectedRevision: number): void {
    if (
      !Number.isInteger(expectedRevision) ||
      expectedRevision < INITIAL_PROVIDER_PROJECTION_REVISION
    ) {
      throw new Error(
        "ProviderActiveHeadStore.installIfRevision: expectedRevision must be " +
          "a non-negative integer"
      )
    }
  }

  private parseMetadata(
    ref: ProviderProjectionRef,
    value: string
  ): Record<string, unknown> {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      throw new Error(
        `ProviderActiveHeadStore: invalid metadata for ` +
          `${providerProjectionStorageKey(ref)}: ${(error as Error).message}`
      )
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `ProviderActiveHeadStore: invalid metadata for ` +
          `${providerProjectionStorageKey(ref)}`
      )
    }
    return parsed as Record<string, unknown>
  }

  private requirePositiveInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new Error(`ProviderActiveHeadStore: ${label} must be positive`)
    }
    return value as number
  }
}
