import { Injectable, Logger } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import {
  requireExactDurableIdentifier,
  requireOptionalExactDurableIdentifier,
} from "../../../context/durable-identifier"
import { PersistenceService } from "../../../persistence"
import type { ToolResultBlock } from "../../../context/types"
import type { ConversationId, TurnId } from "../turn/turn.types"

/**
 * SessionTxn — opaque token threaded through the message-store / ledger
 * write APIs to enforce that every paired write happens inside the same
 * SQLite transaction.
 *
 * The token is materialised by `MessageStore.runInTransaction`. Holding
 * an instance proves you are inside an active BEGIN/COMMIT pair, and
 * the underlying `database` reference lets the ledger and message-store
 * services share prepared statements without re-wiring DI on every
 * call.
 *
 * The shape is intentionally minimal: no public `database` field on the
 * actual class so call sites cannot reach around the txn discipline
 * (the field is `readonly` and accessed via the package-internal
 * symbol re-export below).
 */
export interface SessionTxn {
  readonly conversationId: ConversationId
  readonly tag: typeof SESSION_TXN_TAG
}

/**
 * Tag carried on every SessionTxn so callers from outside this module
 * cannot fabricate one. Exported only as a type-level brand.
 */
export const SESSION_TXN_TAG: unique symbol = Symbol("SessionTxn")

/**
 * Internal accessor used by services in this directory to thread the
 * shared persistence handle through the txn token. Not exported from
 * the package barrel.
 */
export interface SessionTxnInternal extends SessionTxn {
  readonly persistence: PersistenceService
  /**
   * Exact normal tool-result receipts accepted by this transaction. This is
   * deliberately transaction-local proof, not a durable cache: append-only
   * projection mutations may only be triggered by one of these receipts.
   */
  readonly acceptedToolResultReceipts: Map<
    string,
    { readonly recordUuid: string; readonly seq: number }
  >
}

export type AbortReason =
  | "bidi_teardown"
  | "turn_superseded"
  | "user_cancelled"
  | "shutdown"
  | "stream_failed"

/** Runtime calls belong to a bridge turn; imported Cursor history does not. */
export type ToolCallLedgerOrigin = "runtime" | "cursor_history"

function readLedgerOrigin(value: unknown): ToolCallLedgerOrigin {
  if (value === "runtime" || value === "cursor_history") {
    return value
  }
  throw new Error(`ToolCallLedger: invalid ledger origin ${String(value)}`)
}

function requirePositiveSequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value as number
}

interface OpenLedgerArgs {
  toolUseId: string
  toolName: string
  turnId?: TurnId
  origin?: ToolCallLedgerOrigin
  /** Sequence id of the tool_use block in session_messages. */
  openMessageSeq: number
}

interface CloseLedgerArgs {
  toolUseId: string
  /** Sequence id of the tool_result block in session_messages. */
  closeMessageSeq: number
}

interface AbortAllArgs {
  turnId: TurnId
  reason: AbortReason
}

interface AbortAllResult {
  abortedToolCallIds: Array<{
    toolUseId: string
    toolName: string
    openMessageSeq: number
  }>
}

interface AbortOpenToolCallsResult {
  abortedToolCallIds: OpenEntry[]
}

interface AbortOpenToolCallsArgs {
  toolUseIds: string[]
  reason: AbortReason
  /** Defaults to runtime calls so imported Cursor history is never aborted by cleanup. */
  origin?: ToolCallLedgerOrigin
}

export interface OpenEntry {
  toolUseId: string
  toolName: string
  turnId?: TurnId
  origin: ToolCallLedgerOrigin
  openMessageSeq: number
  openedAt: number
}

export type ToolCallLedgerState = "open" | "closed" | "aborted"

/**
 * ToolCallLedger
 *
 * Single source of truth for the tool_use ↔ tool_result protocol. Every
 * entry transitions strictly:
 *
 *   open → closed   (normal tool result received)
 *   open → aborted  (cleanup coordinator drained the turn)
 *
 * `aborted` carries a structured `AbortReason`. The canonical transcript
 * remains untouched; a provider-native projector may deterministically
 * normalize the incomplete pair for one outbound request. This prevents a
 * interruption path from fabricating durable user content.
 *
 * All write paths require a `SessionTxn` so the ledger row and the
 * matching `session_messages` row land in the same SQLite transaction.
 */
@Injectable()
export class ToolCallLedger {
  private readonly logger = new Logger(ToolCallLedger.name)

  // Prepared statements are cached lazily on first use. We can't
  // prepare them at boot because the persistence service may not be
  // initialised yet when DI wires this provider in tests.
  private stmtInsertOpen?: StatementSync
  private stmtClose?: StatementSync
  private stmtAbort?: StatementSync
  private stmtAbortOpenToolCalls?: StatementSync
  private stmtListOpenForTurn?: StatementSync
  private stmtListOpenForConversation?: StatementSync
  private stmtIsOpen?: StatementSync
  private stmtGetState?: StatementSync

  constructor(private readonly persistence: PersistenceService) {}

  /**
   * Record a fresh tool_use. Must be called inside the same transaction
   * as the message-store append for the corresponding tool_use block.
   */
  open(txn: SessionTxn, args: OpenLedgerArgs): void {
    this.assertTxn(txn)
    const toolUseId = requireExactDurableIdentifier(
      args.toolUseId,
      "ToolCallLedger.open toolUseId"
    )
    const toolName = requireExactDurableIdentifier(
      args.toolName,
      "ToolCallLedger.open toolName"
    )
    const turnId = requireOptionalExactDurableIdentifier(
      args.turnId,
      "ToolCallLedger.open turnId"
    ) as TurnId | undefined
    if (!Number.isSafeInteger(args.openMessageSeq) || args.openMessageSeq < 1) {
      throw new Error("ToolCallLedger.open: openMessageSeq must be positive")
    }
    const origin = readLedgerOrigin(args.origin ?? "runtime")
    if (origin === "runtime" && !turnId) {
      throw new Error(
        "ToolCallLedger.open: runtime tool calls require a turnId"
      )
    }
    if (origin === "cursor_history" && turnId !== undefined) {
      throw new Error(
        "ToolCallLedger.open: imported Cursor history must not carry a runtime turnId"
      )
    }
    const stmt = (this.stmtInsertOpen ??= this.persistence.prepare(
      `INSERT INTO tool_call_ledger (
         conversation_id,
         tool_use_id,
         turn_id,
         origin,
         tool_name,
         state,
         opened_at,
         open_message_seq
       ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
    ))
    stmt.run(
      txn.conversationId,
      toolUseId,
      turnId ?? null,
      origin,
      toolName,
      Date.now(),
      args.openMessageSeq
    )
  }

  /**
   * Mark a tool_use as closed by a real tool_result. Must be called in
   * the same transaction as the message-store append for the result.
   */
  close(txn: SessionTxn, args: CloseLedgerArgs): void {
    this.assertTxn(txn)
    const toolUseId = requireExactDurableIdentifier(
      args.toolUseId,
      "ToolCallLedger.close toolUseId"
    )
    if (
      !Number.isSafeInteger(args.closeMessageSeq) ||
      args.closeMessageSeq < 1
    ) {
      throw new Error("ToolCallLedger.close: closeMessageSeq must be positive")
    }
    const stmt = (this.stmtClose ??= this.persistence.prepare(
      `UPDATE tool_call_ledger
         SET state = 'closed',
             closed_at = ?,
             close_message_seq = ?
       WHERE conversation_id = ?
         AND tool_use_id = ?
         AND state = 'open'`
    ))
    const result = stmt.run(
      Date.now(),
      args.closeMessageSeq,
      txn.conversationId,
      toolUseId
    )
    const changes = (result as { changes?: number }).changes ?? 0
    if (changes === 0) {
      // Either the tool_use was never opened (caller bug), already
      // closed (double-close), or already aborted (close raced with
      // cleanup). Each case is a contract violation worth logging
      // loudly so the test suite catches it instead of silently
      // missing a ledger update.
      throw new Error(
        `ToolCallLedger.close: no open ledger entry for ` +
          `conversation=${txn.conversationId} toolUseId=${toolUseId}`
      )
    }
  }

  /**
   * Drain every open ledger entry for the supplied turn into the
   * `aborted` state. Returns the durable identities a provider projector may
   * use when constructing its next prompt.
   *
   * Empty result is fine — it just means the turn had no in-flight
   * tools at cleanup time (e.g. it failed before any tool batch).
   */
  abortAll(txn: SessionTxn, args: AbortAllArgs): AbortAllResult {
    this.assertTxn(txn)
    const turnId = requireExactDurableIdentifier(
      args.turnId,
      "ToolCallLedger.abortAll turnId"
    )
    const list = (this.stmtListOpenForTurn ??= this.persistence.prepare(
      `SELECT tool_use_id, tool_name, open_message_seq
         FROM tool_call_ledger
        WHERE conversation_id = ?
          AND turn_id = ?
          AND origin = 'runtime'
          AND state = 'open'`
    ))
    const rows = list.all(txn.conversationId, turnId) as unknown as Array<{
      tool_use_id: string
      tool_name: string
      open_message_seq: number
    }>
    if (rows.length === 0) {
      return { abortedToolCallIds: [] }
    }

    const abort = (this.stmtAbort ??= this.persistence.prepare(
      `UPDATE tool_call_ledger
         SET state = 'aborted',
             closed_at = ?,
             abort_reason = ?
       WHERE conversation_id = ?
         AND tool_use_id = ?
         AND state = 'open'`
    ))
    const now = Date.now()
    for (const row of rows) {
      abort.run(
        now,
        args.reason,
        txn.conversationId,
        requireExactDurableIdentifier(
          row.tool_use_id,
          "ToolCallLedger stored aborted toolUseId"
        )
      )
    }

    this.logger.log(
      `Ledger aborted ${rows.length} tool call(s) for turn=${turnId} ` +
        `conversation=${txn.conversationId} reason=${args.reason}`
    )

    return {
      abortedToolCallIds: rows.map((row) => ({
        toolUseId: requireExactDurableIdentifier(
          row.tool_use_id,
          "ToolCallLedger stored aborted toolUseId"
        ),
        toolName: requireExactDurableIdentifier(
          row.tool_name,
          "ToolCallLedger stored aborted toolName"
        ),
        openMessageSeq: requirePositiveSequence(
          row.open_message_seq,
          "ToolCallLedger stored aborted openMessageSeq"
        ),
      })),
    }
  }

  abortOpenToolCalls(
    txn: SessionTxn,
    args: AbortOpenToolCallsArgs
  ): AbortOpenToolCallsResult {
    this.assertTxn(txn)
    const toolUseIds = Array.from(
      new Set(
        args.toolUseIds.map((id) =>
          requireExactDurableIdentifier(
            id,
            "ToolCallLedger.abortOpenToolCalls toolUseId"
          )
        )
      )
    )
    if (toolUseIds.length === 0) {
      return { abortedToolCallIds: [] }
    }

    const placeholders = toolUseIds.map(() => "?").join(", ")
    const origin = readLedgerOrigin(args.origin ?? "runtime")
    const rows = this.persistence
      .prepare(
        `SELECT tool_use_id, tool_name, turn_id, origin, open_message_seq, opened_at
           FROM tool_call_ledger
          WHERE conversation_id = ?
            AND state = 'open'
            AND origin = ?
            AND tool_use_id IN (${placeholders})
          ORDER BY open_message_seq ASC`
      )
      .all(txn.conversationId, origin, ...toolUseIds) as unknown as Array<{
      tool_use_id: string
      tool_name: string
      turn_id: string | null
      origin: string
      open_message_seq: number
      opened_at: number
    }>
    if (rows.length === 0) {
      return { abortedToolCallIds: [] }
    }

    const abort = (this.stmtAbortOpenToolCalls ??= this.persistence.prepare(
      `UPDATE tool_call_ledger
         SET state = 'aborted',
             closed_at = ?,
             abort_reason = ?
       WHERE conversation_id = ?
         AND tool_use_id = ?
         AND state = 'open'`
    ))
    const now = Date.now()
    for (const row of rows) {
      abort.run(
        now,
        args.reason,
        txn.conversationId,
        requireExactDurableIdentifier(
          row.tool_use_id,
          "ToolCallLedger stored selected toolUseId"
        )
      )
    }

    this.logger.warn(
      `Ledger aborted ${rows.length} selected open tool call(s) ` +
        `conversation=${txn.conversationId} reason=${args.reason}`
    )

    return {
      abortedToolCallIds: rows.map((row) => ({
        toolUseId: requireExactDurableIdentifier(
          row.tool_use_id,
          "ToolCallLedger stored selected toolUseId"
        ),
        toolName: requireExactDurableIdentifier(
          row.tool_name,
          "ToolCallLedger stored selected toolName"
        ),
        turnId: requireOptionalExactDurableIdentifier(
          row.turn_id ?? undefined,
          "ToolCallLedger stored selected turnId"
        ) as TurnId | undefined,
        origin: readLedgerOrigin(row.origin),
        openMessageSeq: requirePositiveSequence(
          row.open_message_seq,
          "ToolCallLedger stored selected openMessageSeq"
        ),
        openedAt: requirePositiveSequence(
          row.opened_at,
          "ToolCallLedger stored selected openedAt"
        ),
      })),
    }
  }

  /**
   * Read-only check used by the message-store to assert that
   * appendToolResultBlock targets a legitimately open ledger entry.
   */
  isOpen(conversationId: ConversationId, toolUseId: string): boolean {
    const exactToolUseId = requireExactDurableIdentifier(
      toolUseId,
      "ToolCallLedger.isOpen toolUseId"
    )
    const stmt = (this.stmtIsOpen ??= this.persistence.prepare(
      `SELECT 1
         FROM tool_call_ledger
        WHERE conversation_id = ?
          AND tool_use_id = ?
          AND state = 'open'
        LIMIT 1`
    ))
    return stmt.get(conversationId, exactToolUseId) !== undefined
  }

  getState(
    conversationId: ConversationId,
    toolUseId: string
  ): ToolCallLedgerState | undefined {
    const exactToolUseId = requireExactDurableIdentifier(
      toolUseId,
      "ToolCallLedger.getState toolUseId"
    )
    const stmt = (this.stmtGetState ??= this.persistence.prepare(
      `SELECT state
         FROM tool_call_ledger
        WHERE conversation_id = ?
          AND tool_use_id = ?
        LIMIT 1`
    ))
    const row = stmt.get(conversationId, exactToolUseId) as
      | { state?: string }
      | undefined
    if (!row) return undefined
    if (
      row.state === "open" ||
      row.state === "closed" ||
      row.state === "aborted"
    ) {
      return row.state
    }
    throw new Error(
      `ToolCallLedger.getState: invalid stored state ${String(row.state)}`
    )
  }

  /**
   * Snapshot of currently-open tool calls for a conversation. Used by
   * cleanup-coordinator decisions and by diagnostics.
   */
  listOpen(conversationId: ConversationId): OpenEntry[] {
    const stmt = (this.stmtListOpenForConversation ??= this.persistence.prepare(
      `SELECT tool_use_id, tool_name, turn_id, origin, open_message_seq, opened_at
           FROM tool_call_ledger
          WHERE conversation_id = ?
            AND state = 'open'
          ORDER BY open_message_seq ASC`
    ))
    const rows = stmt.all(conversationId) as unknown as Array<{
      tool_use_id: string
      tool_name: string
      turn_id: string | null
      origin: string
      open_message_seq: number
      opened_at: number
    }>
    return rows.map((row) => ({
      toolUseId: requireExactDurableIdentifier(
        row.tool_use_id,
        "ToolCallLedger stored open toolUseId"
      ),
      toolName: requireExactDurableIdentifier(
        row.tool_name,
        "ToolCallLedger stored open toolName"
      ),
      turnId: requireOptionalExactDurableIdentifier(
        row.turn_id ?? undefined,
        "ToolCallLedger stored open turnId"
      ) as TurnId | undefined,
      origin: readLedgerOrigin(row.origin),
      openMessageSeq: requirePositiveSequence(
        row.open_message_seq,
        "ToolCallLedger stored open openMessageSeq"
      ),
      openedAt: requirePositiveSequence(
        row.opened_at,
        "ToolCallLedger stored open openedAt"
      ),
    }))
  }

  /**
   * Build the structured abort tool_result block written alongside the
   * `aborted` ledger entry. Centralised here so the format is consistent
   * across every abort path (bidi teardown, supersede, user cancel,
   * deadline expiry, shutdown, stream failure).
   */
  static buildAbortToolResult(
    toolUseId: string,
    reason: AbortReason
  ): ToolResultBlock {
    const exactToolUseId = requireExactDurableIdentifier(
      toolUseId,
      "ToolCallLedger.buildAbortToolResult toolUseId"
    )
    return {
      type: "tool_result",
      tool_use_id: exactToolUseId,
      content: [{ type: "text", text: `[abort:${reason}]` }],
      is_error: true,
    }
  }

  private assertTxn(txn: SessionTxn): void {
    if (!txn || txn.tag !== SESSION_TXN_TAG) {
      throw new Error(
        "ToolCallLedger: write methods require a SessionTxn from MessageStore.runInTransaction()"
      )
    }
  }
}
