import { Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import {
  requireExactDurableIdentifier,
  requireOptionalExactDurableIdentifier,
} from "../../../context/durable-identifier"
import { PersistenceService } from "../../../persistence"
import type { SessionTxn } from "./tool-call-ledger.service"
import {
  ProviderActiveHeadStore,
  type ProviderActiveHead,
} from "./provider-active-head.store"
import {
  assertProviderProjectionRef,
  providerProjectionStorageKey,
  type ProviderProjectionRef,
} from "./projection-owner"

export interface CodexRolloutItem {
  readonly projection: ProviderProjectionRef
  /** Durable upstream identity for the native rollout/window. */
  readonly nativeThreadId: string
  readonly seq: number
  readonly itemId?: string
  readonly itemKind: string
  /** Native window metadata, not the provider projection revision. */
  readonly windowId?: string
  readonly responseId?: string
  readonly parentResponseId?: string
  /** Exact native RolloutItem bytes. */
  readonly payload: Buffer
  readonly createdAt: number
}

export interface AppendCodexRolloutItem {
  /** Explicit durable owner/provider/local namespace; no implicit root key. */
  readonly projection: ProviderProjectionRef
  /** Required upstream identity; never inferred from local projection data. */
  readonly nativeThreadId: string
  readonly itemId?: string
  readonly itemKind: string
  /** Native window metadata, not the provider projection revision. */
  readonly windowId?: string
  readonly responseId?: string
  readonly parentResponseId?: string
  readonly payload: Buffer
  readonly createdAt?: number
}

/**
 * A Codex projection advances its provider revision exactly once for every
 * durable rollout install. `expectedRevision` is captured from the installed
 * ProviderActiveHeadStore row, never inferred from an in-process array.
 */
export interface CodexRolloutHeadInstall extends Omit<
  ProviderActiveHead,
  "ref"
> {
  readonly expectedRevision: number
}

/**
 * A successful append/CAS has already validated this exact native head and
 * its rollout rows. Callers that are inside a larger graph transaction must
 * retain it until that transaction commits, then install only their mounted
 * projection state; they must not re-read the active head to validate work
 * that was just committed.
 */
export interface CodexRolloutPreparedInstall {
  readonly projection: ProviderProjectionRef
  readonly items: readonly CodexRolloutItem[]
  readonly head: ProviderActiveHead
}

/**
 * Append-only Codex native rollout log. The store accepts exact raw
 * RolloutItem bytes rather than translating response items or compactions
 * into the generic transcript model. Every API is scoped by the complete
 * ProviderProjectionRef so a child run cannot collide with the root or a
 * sibling merely because a local key happens to match.
 */
@Injectable()
export class CodexRolloutStore {
  private stmtNextSeq?: StatementSync
  private stmtInsert?: StatementSync
  private stmtList?: StatementSync

  constructor(
    private readonly persistence: PersistenceService,
    private readonly activeHeads: ProviderActiveHeadStore
  ) {}

  appendAndInstall(
    item: AppendCodexRolloutItem,
    head: CodexRolloutHeadInstall
  ): CodexRolloutPreparedInstall {
    return this.appendBatchAndInstall([item], head)
  }

  /**
   * Atomically persist one native response/compaction batch and advance its
   * provider revision. A failed revision CAS rolls back every rollout row,
   * so a stale projector can never leave an alternate history behind.
   */
  appendBatchAndInstall(
    items: readonly AppendCodexRolloutItem[],
    head: CodexRolloutHeadInstall
  ): CodexRolloutPreparedInstall {
    this.assertBatch(items, head, "appendBatchAndInstall")
    return this.persistence.runInTransaction(() =>
      this.appendBatchAndInstallInTransactionUnchecked(items, head)
    )
  }

  /**
   * Append a native rollout delta under ContextStateService's already-open
   * graph transaction. Raw response items, graph-source links and the exact
   * provider revision either commit together or all roll back.
   */
  appendBatchAndInstallInTransaction(
    txn: SessionTxn,
    items: readonly AppendCodexRolloutItem[],
    head: CodexRolloutHeadInstall
  ): CodexRolloutPreparedInstall {
    this.assertBatch(items, head, "appendBatchAndInstallInTransaction")
    const projection = items[0]!.projection
    if (txn.conversationId !== projection.owner.conversationId) {
      throw new Error(
        "CodexRolloutStore.appendBatchAndInstallInTransaction: transaction conversation does not match rollout projection"
      )
    }
    return this.appendBatchAndInstallInTransactionUnchecked(items, head)
  }

  list(projection: ProviderProjectionRef): CodexRolloutItem[] {
    this.assertCodexProjection(projection, "list")
    const stmt = (this.stmtList ??= this.persistence.prepare(
      `SELECT seq, native_thread_id, item_id, item_kind, window_id, response_id,
              parent_response_id, payload, created_at
         FROM session_codex_rollout_items
        WHERE conversation_id = ? AND owner_key = ? AND local_key = ?
        ORDER BY seq ASC`
    ))
    const rows = stmt.all(
      projection.owner.conversationId,
      projection.owner.ownerKey,
      projection.localKey
    ) as unknown as Array<{
      seq: number
      native_thread_id: string
      item_id: string | null
      item_kind: string
      window_id: string | null
      response_id: string | null
      parent_response_id: string | null
      payload: Buffer | Uint8Array
      created_at: number
    }>
    return rows.map((row) => ({
      projection,
      seq: this.requirePositiveSequence(row.seq, `stored seq`),
      nativeThreadId: this.requireNativeThreadId(
        row.native_thread_id,
        `stored native_thread_id at seq ${row.seq}`
      ),
      itemId: requireOptionalExactDurableIdentifier(
        row.item_id ?? undefined,
        `CodexRolloutStore stored item_id at seq ${row.seq}`
      ),
      itemKind: requireExactDurableIdentifier(
        row.item_kind,
        `CodexRolloutStore stored item_kind at seq ${row.seq}`
      ),
      windowId: requireOptionalExactDurableIdentifier(
        row.window_id ?? undefined,
        `CodexRolloutStore stored window_id at seq ${row.seq}`
      ),
      responseId: requireOptionalExactDurableIdentifier(
        row.response_id ?? undefined,
        `CodexRolloutStore stored response_id at seq ${row.seq}`
      ),
      parentResponseId: requireOptionalExactDurableIdentifier(
        row.parent_response_id ?? undefined,
        `CodexRolloutStore stored parent_response_id at seq ${row.seq}`
      ),
      payload: this.requirePayload(row.payload, row.seq),
      createdAt: this.requirePositiveTimestamp(
        row.created_at,
        `stored created_at at seq ${row.seq}`
      ),
    }))
  }

  getActiveHead(
    projection: ProviderProjectionRef
  ): ProviderActiveHead | undefined {
    this.assertCodexProjection(projection, "getActiveHead")
    return this.activeHeads.get(projection)
  }

  private appendBatchAndInstallInTransactionUnchecked(
    items: readonly AppendCodexRolloutItem[],
    head: CodexRolloutHeadInstall
  ): CodexRolloutPreparedInstall {
    const projection = items[0]!.projection
    const installedHead: ProviderActiveHead = {
      ref: projection,
      revision: head.revision,
      headKind: head.headKind,
      headId: head.headId,
      ...(head.metadata ? { metadata: structuredClone(head.metadata) } : {}),
      updatedAt: head.updatedAt,
    }
    this.activeHeads.installIfRevision(installedHead, head.expectedRevision)

    let nextSeq = this.nextSeq(projection)
    const appendedItems = items.map((item) => {
      const appended = this.appendInTransaction(item, nextSeq)
      nextSeq += 1
      return appended
    })
    return {
      projection,
      items: appendedItems,
      head: installedHead,
    }
  }

  private assertBatch(
    items: readonly AppendCodexRolloutItem[],
    head: CodexRolloutHeadInstall,
    operation: string
  ): void {
    if (items.length === 0) {
      throw new Error(
        `CodexRolloutStore.${operation}: at least one rollout item is required`
      )
    }

    const projection = items[0]!.projection
    const nativeThreadId = items[0]!.nativeThreadId
    this.assertHeadNativeThread(head, nativeThreadId, operation)
    this.assertCodexProjection(projection, operation)
    const projectionStorageKey = providerProjectionStorageKey(projection)
    for (const item of items) {
      this.assertAppendItem(item, operation)
      if (
        providerProjectionStorageKey(item.projection) !== projectionStorageKey
      ) {
        throw new Error(
          `CodexRolloutStore.${operation}: all items must belong to one provider projection`
        )
      }
      if (item.nativeThreadId !== nativeThreadId) {
        throw new Error(
          `CodexRolloutStore.${operation}: all items must belong to one native thread`
        )
      }
    }
  }

  private nextSeq(projection: ProviderProjectionRef): number {
    const row = (this.stmtNextSeq ??= this.persistence.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM session_codex_rollout_items
        WHERE conversation_id = ? AND owner_key = ? AND local_key = ?`
    )).get(
      projection.owner.conversationId,
      projection.owner.ownerKey,
      projection.localKey
    ) as { next_seq: number } | undefined
    return row?.next_seq ?? 1
  }

  private appendInTransaction(
    item: AppendCodexRolloutItem,
    seq: number
  ): CodexRolloutItem {
    const projection = item.projection
    const createdAt = item.createdAt ?? Date.now()
    ;(this.stmtInsert ??= this.persistence.prepare(
      `INSERT INTO session_codex_rollout_items (
         conversation_id, owner_key, local_key, seq, native_thread_id, item_id, item_kind,
         window_id, response_id, parent_response_id, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )).run(
      projection.owner.conversationId,
      projection.owner.ownerKey,
      projection.localKey,
      seq,
      item.nativeThreadId,
      item.itemId ?? null,
      item.itemKind,
      item.windowId ?? null,
      item.responseId ?? null,
      item.parentResponseId ?? null,
      Buffer.from(item.payload),
      createdAt
    )
    return {
      projection,
      seq,
      nativeThreadId: item.nativeThreadId,
      itemId: item.itemId,
      itemKind: item.itemKind,
      windowId: item.windowId,
      responseId: item.responseId,
      parentResponseId: item.parentResponseId,
      payload: Buffer.from(item.payload),
      createdAt,
    }
  }

  private assertAppendItem(
    item: AppendCodexRolloutItem,
    operation: string
  ): void {
    this.assertCodexProjection(item.projection, operation)
    requireExactDurableIdentifier(
      item.itemKind,
      `CodexRolloutStore.${operation}: itemKind`
    )
    this.requireNativeThreadId(
      item.nativeThreadId,
      `CodexRolloutStore.${operation}: nativeThreadId`
    )
    requireOptionalExactDurableIdentifier(
      item.itemId,
      `CodexRolloutStore.${operation}: itemId`
    )
    requireOptionalExactDurableIdentifier(
      item.windowId,
      `CodexRolloutStore.${operation}: windowId`
    )
    requireOptionalExactDurableIdentifier(
      item.responseId,
      `CodexRolloutStore.${operation}: responseId`
    )
    requireOptionalExactDurableIdentifier(
      item.parentResponseId,
      `CodexRolloutStore.${operation}: parentResponseId`
    )
    if (
      item.createdAt !== undefined &&
      (!Number.isSafeInteger(item.createdAt) || item.createdAt <= 0)
    ) {
      throw new Error(
        `CodexRolloutStore.${operation}: createdAt must be a positive integer`
      )
    }
    const payload: unknown = item.payload
    if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
      throw new Error(`CodexRolloutStore.${operation}: payload must be bytes`)
    }
  }

  private assertHeadNativeThread(
    head: CodexRolloutHeadInstall,
    nativeThreadId: string,
    operation: string
  ): void {
    const headNativeThreadId = requireExactDurableIdentifier(
      head.metadata?.nativeThreadId,
      `CodexRolloutStore.${operation}: head metadata nativeThreadId`
    )
    if (headNativeThreadId !== nativeThreadId) {
      throw new Error(
        `CodexRolloutStore.${operation}: head metadata nativeThreadId must match rollout items`
      )
    }
  }

  private requireNativeThreadId(value: unknown, label: string): string {
    return requireExactDurableIdentifier(value, label)
  }

  private requirePositiveSequence(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new Error(`CodexRolloutStore ${label} must be a positive integer`)
    }
    return value as number
  }

  private requirePositiveTimestamp(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new Error(`CodexRolloutStore ${label} must be a positive integer`)
    }
    return value as number
  }

  private requirePayload(value: unknown, seq: number): Buffer {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw new Error(
        `CodexRolloutStore stored payload at seq ${seq} must be bytes`
      )
    }
    return Buffer.from(value)
  }

  private assertCodexProjection(
    projection: ProviderProjectionRef,
    operation: string
  ): void {
    assertProviderProjectionRef(projection, `CodexRolloutStore.${operation}`)
    if (projection.provider !== "codex") {
      throw new Error(
        `CodexRolloutStore.${operation}: projection provider must be codex`
      )
    }
  }
}
