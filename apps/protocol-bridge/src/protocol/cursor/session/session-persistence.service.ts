import { Injectable, Logger } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { PersistenceService } from "../../../persistence"
import type { ConversationId } from "../turn/turn.types"
import {
  SESSION_TXN_TAG,
  type SessionTxn,
  type SessionTxnInternal,
} from "./tool-call-ledger.service"
import {
  describeSessionFileStateLimit,
  isSessionFileStateWithinLimit,
  SESSION_FILE_STATE_CONTENT_LIMIT_BYTES,
} from "./file-state-limits"

/**
 * SessionRow — the immutable / config-class fields stored in the
 * `sessions` table. Mutable runtime state (TurnRuntime, in-flight tool
 * batches, abort signals, edit-path queues) is owned by other services
 * and never lands here.
 */
export interface SessionRow {
  conversationId: ConversationId
  createdAt: number
  lastActivityAt: number
  model: string
  /**
   * Free-form JSON blob carrying configuration that does not warrant
   * its own column: project context, cursor rules / commands, custom
   * system prompt, supported tools snapshot, thinking level, isAgentic,
   * useWeb, requested model parameters, browser MCP context, additional
   * roots, etc. Domain services parse the slice they care about.
   */
  config: Record<string, unknown>
}

export const SESSION_TODO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const

export type SessionTodoStatus = (typeof SESSION_TODO_STATUSES)[number]

export interface SessionFileState {
  conversationId: ConversationId
  path: string
  beforeContent: Buffer
  afterContent: Buffer
  updatedAt: number
}

type SqliteBlob = Buffer | Uint8Array

function normalizeSqliteBlob(blob: SqliteBlob): Buffer {
  return Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
}

export interface SessionTodo {
  conversationId: ConversationId
  id: string
  content: string
  status: SessionTodoStatus
  createdAt: number
  updatedAt: number
  dependencies: string[]
}

export interface SessionMessageBlob {
  conversationId: ConversationId
  blobId: string
  addedAt: number
}

export interface SessionReadPath {
  conversationId: ConversationId
  path: string
  readAt: number
}

/**
 * The complete mutable session-owned snapshot. The durable message graph is
 * intentionally absent: MessageStore owns graph rows and supplies the shared
 * transaction token used to commit both stores together.
 */
export interface SessionPersistenceSnapshot {
  row: SessionRow
  fileStates: SessionFileState[]
  todos: SessionTodo[]
  messageBlobs: SessionMessageBlob[]
  readPaths: SessionReadPath[]
}

export interface PersistedSessionActivitySummary {
  conversationId: ConversationId
  lastActivityAt: number
  model: string
  openToolCallCount: number
  providerProjectionUpdatedAt?: number
}

/**
 * SessionPersistenceService
 *
 * Sole SQL owner of `sessions`, `session_file_states`, `session_todos`,
 * `session_message_blobs`, and `session_read_paths`. Domain services decide
 * when state changes; this repository defines the normalized persistence
 * contract and row reconstruction.
 *
 * The previous design serialised the entire session into a single
 * `cursor_sessions.state_json` blob and rewrote it on every dirty
 * flush. The split lets each domain service only touch the rows it
 * cares about. Most related tables use foreign-key cascade; the Cursor wire
 * stores are conversation-scoped and can exist before a local session, so
 * their deletion is explicit in `deleteSession`.
 */
@Injectable()
export class SessionPersistenceService {
  private readonly logger = new Logger(SessionPersistenceService.name)

  // sessions
  private stmtUpsertSession?: StatementSync
  private stmtSelectSession?: StatementSync
  private stmtListSessions?: StatementSync
  private stmtTouchSession?: StatementSync

  // related
  private stmtUpsertFileState?: StatementSync
  private stmtListFileStates?: StatementSync
  private stmtDeleteFileState?: StatementSync

  private stmtUpsertTodo?: StatementSync
  private stmtListTodos?: StatementSync
  private stmtDeleteTodosForConversation?: StatementSync

  private stmtInsertMessageBlob?: StatementSync
  private stmtListMessageBlobs?: StatementSync

  private stmtUpsertReadPath?: StatementSync
  private stmtListReadPaths?: StatementSync
  private stmtDeleteReadPathsForConversation?: StatementSync

  private stmtListSessionActivitySummaries?: StatementSync

  private stmtDeleteFileStatesForConversation?: StatementSync
  private stmtDeleteMessageBlobsForConversation?: StatementSync

  constructor(private readonly persistence: PersistenceService) {}

  // ── sessions ─────────────────────────────────────────────────────

  /**
   * Persist every session-owned normalized table inside a transaction created
   * by MessageStore. Mounted snapshot saves use this complete command;
   * bootstrap uses the explicit parent-row and domain-state commands below to
   * place its durable graph between them without opening a nested transaction.
   */
  persistSnapshotInTransaction(
    txn: SessionTxn,
    snapshot: SessionPersistenceSnapshot
  ): void {
    this.upsertSessionInTransaction(txn, snapshot.row)
    this.replaceDomainStateInTransaction(txn, snapshot)
  }

  /**
   * Write the parent row before a graph owner appends child records in the
   * same transaction. Kept public only for the lifecycle bootstrap boundary;
   * regular mounted writes use persistSnapshotInTransaction above.
   */
  upsertSessionInTransaction(txn: SessionTxn, row: SessionRow): void {
    this.assertTransactionForConversation(txn, row.conversationId)
    this.upsertSessionUnsafe(row)
  }

  /**
   * Replace the mutable normalized session state after the graph owner has
   * accepted its records under the same transaction token.
   */
  replaceDomainStateInTransaction(
    txn: SessionTxn,
    snapshot: SessionPersistenceSnapshot
  ): void {
    this.assertTransactionForConversation(txn, snapshot.row.conversationId)
    this.assertSnapshotConversation(snapshot)
    this.replaceFileStatesUnsafe(
      snapshot.row.conversationId,
      snapshot.fileStates
    )
    this.replaceReadPathsUnsafe(snapshot.row.conversationId, snapshot.readPaths)
    this.replaceMessageBlobsUnsafe(
      snapshot.row.conversationId,
      snapshot.messageBlobs
    )
    this.replaceTodosUnsafe(snapshot.row.conversationId, snapshot.todos)
  }

  private upsertSessionUnsafe(row: SessionRow): void {
    const stmt = (this.stmtUpsertSession ??= this.persistence.prepare(
      `INSERT INTO sessions (
         conversation_id, created_at, last_activity_at, model, config_json
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         last_activity_at = excluded.last_activity_at,
         model = excluded.model,
         config_json = excluded.config_json`
    ))
    stmt.run(
      row.conversationId,
      row.createdAt,
      row.lastActivityAt,
      row.model,
      JSON.stringify(row.config ?? {})
    )
  }

  loadSession(conversationId: ConversationId): SessionRow | undefined {
    const stmt = (this.stmtSelectSession ??= this.persistence.prepare(
      `SELECT created_at, last_activity_at, model, config_json
         FROM sessions
        WHERE conversation_id = ?`
    ))
    const row = stmt.get(conversationId) as
      | {
          created_at: number
          last_activity_at: number
          model: string
          config_json: string
        }
      | undefined
    if (!row) return undefined
    let configValue: unknown
    try {
      configValue = JSON.parse(row.config_json)
    } catch (err) {
      throw new Error(
        `loadSession(${conversationId}): invalid config_json: ${(err as Error).message}`
      )
    }
    if (
      !configValue ||
      typeof configValue !== "object" ||
      Array.isArray(configValue)
    ) {
      throw new Error(
        `loadSession(${conversationId}): invalid config_json: expected object`
      )
    }
    return {
      conversationId,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      model: row.model,
      config: configValue as Record<string, unknown>,
    }
  }

  listSessions(): Array<{
    conversationId: ConversationId
    lastActivityAt: number
    model: string
  }> {
    const stmt = (this.stmtListSessions ??= this.persistence.prepare(
      `SELECT conversation_id, last_activity_at, model
         FROM sessions
        ORDER BY last_activity_at DESC`
    ))
    const rows = stmt.all() as unknown as Array<{
      conversation_id: string
      last_activity_at: number
      model: string
    }>
    return rows.map((row) => ({
      conversationId: row.conversation_id as ConversationId,
      lastActivityAt: row.last_activity_at,
      model: row.model,
    }))
  }

  touchSession(conversationId: ConversationId, at: number): void {
    const stmt = (this.stmtTouchSession ??= this.persistence.prepare(
      `UPDATE sessions
          SET last_activity_at = ?
        WHERE conversation_id = ?`
    ))
    stmt.run(at, conversationId)
  }

  deleteSession(conversationId: ConversationId): void {
    // Exact Cursor frames and blob uploads can precede the local session row,
    // so their tables intentionally have no sessions FK. Delete conversation-
    // owned stores explicitly; never rely on CASCADE through ON DELETE RESTRICT
    // edges (background commands, projection heads, subagent provenance, …).
    this.persistence.runInTransaction(() => {
      // Sidechain messages ↔ subagent runs/executions form a RESTRICT cycle.
      // Defer checks until COMMIT so the ordered deletes can clear the cycle.
      this.persistence.exec("PRAGMA defer_foreign_keys = ON")
      this.deleteConversationOwnedRows(conversationId)
    })
  }

  /**
   * Wipe every conversation-owned row in the current session graph schema. Cache clear is an
   * operator-level reset, so it truncates every session-owned domain
   * table explicitly instead of relying on parent-table cascade.
   *
   * Returns the count of `sessions` rows that were deleted so the
   * caller can report a progress number to the UI.
   */
  deleteAllSessions(): number {
    // Re-assert FK handling on this connection. The cache-clear command is
    // an operator action, so clear every conversation-owned domain table explicitly instead
    // of depending on cascade side effects to catch all persisted state.
    this.persistence.exec("PRAGMA foreign_keys = ON")
    const before = this.persistence
      .prepare(`SELECT COUNT(*) AS n FROM sessions`)
      .get() as { n: number } | undefined
    this.persistence.runInTransaction(() => {
      this.persistence.exec("PRAGMA defer_foreign_keys = ON")
      this.deleteConversationOwnedRows(undefined)
    })
    return before?.n ?? 0
  }

  /**
   * Ordered delete of session-graph tables for one conversation, or every
   * conversation when `conversationId` is omitted.
   *
   * Order matters: several children use ON DELETE RESTRICT against
   * `session_messages` / `tool_call_ledger`, so a bare `DELETE FROM sessions`
   * (CASCADE) fails with FOREIGN KEY constraint failed. Callers must enable
   * `PRAGMA defer_foreign_keys = ON` for the surrounding transaction because
   * sidechain messages and subagent run/execution rows form a RESTRICT cycle
   * that no single delete order can break under immediate FK checks.
   */
  private deleteConversationOwnedRows(
    conversationId: ConversationId | undefined
  ): void {
    // Children that RESTRICT parents, then dependents, then the session row.
    // `session_subagent_run_executions` is listed explicitly (not only via
    // CASCADE from runs) so deferred cleanup does not leave historical leases
    // behind if a run row is already gone.
    const tables = [
      "session_context_projection_heads",
      "session_context_summary_deliveries",
      "session_context_runtime_events",
      "session_context_runtime_operations",
      "session_async_user_interactions",
      "session_background_commands",
      "session_claude_projection_mutations",
      "session_subagent_branch_heads",
      "session_memory_events",
      "session_snip_boundaries",
      "session_message_revisions",
      "session_subagent_run_executions",
      "session_subagent_runs",
      "session_context_projection_records",
      "session_exec_dispatches",
      "turn_events",
      "tool_call_ledger",
      "session_claude_projection_records",
      "session_codex_rollout_items",
      "session_provider_active_heads",
      "session_cursor_wire_frames",
      "session_cursor_wire_blobs",
      "session_messages",
      "session_file_states",
      "session_todos",
      "session_message_blobs",
      "session_read_paths",
      "sessions",
    ] as const

    for (const table of tables) {
      if (!this.conversationOwnedTableExists(table)) continue
      if (conversationId === undefined) {
        this.persistence.prepare(`DELETE FROM ${table}`).run()
      } else {
        this.persistence
          .prepare(`DELETE FROM ${table} WHERE conversation_id = ?`)
          .run(conversationId)
      }
    }
  }

  private conversationOwnedTableExists(table: string): boolean {
    const row = this.persistence
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`
      )
      .get(table) as { ok: number } | undefined
    return row?.ok === 1
  }

  listSessionActivitySummaries(): PersistedSessionActivitySummary[] {
    const stmt = (this.stmtListSessionActivitySummaries ??=
      this.persistence.prepare(
        `SELECT s.conversation_id,
                s.last_activity_at,
                s.model,
                COALESCE(open_ledger.open_tool_call_count, 0) AS open_tool_call_count,
                projection.updated_at AS provider_projection_updated_at
           FROM sessions s
           LEFT JOIN (
             SELECT conversation_id, COUNT(*) AS open_tool_call_count
               FROM tool_call_ledger
              WHERE state = 'open'
              GROUP BY conversation_id
           ) open_ledger ON open_ledger.conversation_id = s.conversation_id
           LEFT JOIN (
             SELECT conversation_id, MAX(updated_at) AS updated_at
               FROM session_provider_active_heads
              GROUP BY conversation_id
           ) projection ON projection.conversation_id = s.conversation_id
          ORDER BY s.last_activity_at DESC`
      ))
    const rows = stmt.all() as unknown as Array<{
      conversation_id: string
      last_activity_at: number
      model: string
      open_tool_call_count: number
      provider_projection_updated_at: number | null
    }>

    return rows.map((row) => {
      return {
        conversationId: row.conversation_id as ConversationId,
        lastActivityAt: row.last_activity_at,
        model: row.model,
        openToolCallCount: row.open_tool_call_count || 0,
        providerProjectionUpdatedAt:
          row.provider_projection_updated_at ?? undefined,
      }
    })
  }

  // ── file states ──────────────────────────────────────────────────

  private upsertFileState(state: SessionFileState): void {
    if (
      !isSessionFileStateWithinLimit(state.beforeContent, state.afterContent)
    ) {
      const beforeBytes = state.beforeContent.byteLength
      const afterBytes = state.afterContent.byteLength
      this.logger.warn(
        `Skipping oversized file state for ${state.conversationId} ${state.path}: ` +
          describeSessionFileStateLimit(beforeBytes, afterBytes)
      )
      this.deleteFileState(state.conversationId, state.path)
      return
    }

    const stmt = (this.stmtUpsertFileState ??= this.persistence.prepare(
      `INSERT INTO session_file_states (
         conversation_id, path, before_content, after_content, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, path) DO UPDATE SET
         before_content = excluded.before_content,
         after_content = excluded.after_content,
         updated_at = excluded.updated_at`
    ))
    stmt.run(
      state.conversationId,
      state.path,
      state.beforeContent,
      state.afterContent,
      state.updatedAt
    )
  }

  listFileStates(conversationId: ConversationId): SessionFileState[] {
    const stmt = (this.stmtListFileStates ??= this.persistence.prepare(
      `SELECT path, before_content, after_content, updated_at
         FROM session_file_states
        WHERE conversation_id = ?
          AND length(before_content) <= ?
          AND length(after_content) <= ?
        ORDER BY path ASC`
    ))
    const rows = stmt.all(
      conversationId,
      SESSION_FILE_STATE_CONTENT_LIMIT_BYTES,
      SESSION_FILE_STATE_CONTENT_LIMIT_BYTES
    ) as unknown as Array<{
      path: string
      before_content: SqliteBlob
      after_content: SqliteBlob
      updated_at: number
    }>
    return rows.map((row) => ({
      conversationId,
      path: row.path,
      beforeContent: normalizeSqliteBlob(row.before_content),
      afterContent: normalizeSqliteBlob(row.after_content),
      updatedAt: row.updated_at,
    }))
  }

  private deleteFileState(conversationId: ConversationId, path: string): void {
    const stmt = (this.stmtDeleteFileState ??= this.persistence.prepare(
      `DELETE FROM session_file_states
        WHERE conversation_id = ?
          AND path = ?`
    ))
    stmt.run(conversationId, path)
  }

  private replaceFileStatesUnsafe(
    conversationId: ConversationId,
    states: SessionFileState[]
  ): void {
    const deleteStmt = (this.stmtDeleteFileStatesForConversation ??=
      this.persistence.prepare(
        `DELETE FROM session_file_states
          WHERE conversation_id = ?`
      ))
    deleteStmt.run(conversationId)
    for (const state of states) {
      this.upsertFileState(state)
    }
  }

  // ── todos ────────────────────────────────────────────────────────

  private upsertTodo(todo: SessionTodo): void {
    const stmt = (this.stmtUpsertTodo ??= this.persistence.prepare(
      `INSERT INTO session_todos (
         conversation_id, id, content, status,
         created_at, updated_at, dependencies_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, id) DO UPDATE SET
         content = excluded.content,
         status = excluded.status,
         updated_at = excluded.updated_at,
         dependencies_json = excluded.dependencies_json`
    ))
    stmt.run(
      todo.conversationId,
      todo.id,
      todo.content,
      todo.status,
      todo.createdAt,
      todo.updatedAt,
      JSON.stringify(todo.dependencies)
    )
  }

  listTodos(conversationId: ConversationId): SessionTodo[] {
    const stmt = (this.stmtListTodos ??= this.persistence.prepare(
      `SELECT id, content, status, created_at, updated_at, dependencies_json
         FROM session_todos
        WHERE conversation_id = ?
        ORDER BY created_at ASC`
    ))
    const rows = stmt.all(conversationId) as unknown as Array<{
      id: string
      content: string
      status: string
      created_at: number
      updated_at: number
      dependencies_json: string
    }>
    return rows.map((row) => {
      assertPersistedTodoText(row.id, `listTodos(${conversationId}): id`)
      assertPersistedTodoText(
        row.content,
        `listTodos(${conversationId}): content for ${row.id}`
      )
      const status = parsePersistedTodoStatus(
        row.status,
        `listTodos(${conversationId}): status for ${row.id}`
      )
      assertPersistedTodoTimestamp(
        row.created_at,
        `listTodos(${conversationId}): created_at for ${row.id}`
      )
      assertPersistedTodoTimestamp(
        row.updated_at,
        `listTodos(${conversationId}): updated_at for ${row.id}`
      )
      if (row.updated_at < row.created_at) {
        throw new Error(
          `listTodos(${conversationId}): updated_at precedes created_at for ${row.id}`
        )
      }
      let dependenciesValue: unknown
      try {
        dependenciesValue = JSON.parse(row.dependencies_json)
      } catch (err) {
        throw new Error(
          `listTodos(${conversationId}): invalid dependencies_json for ${row.id}: ${(err as Error).message}`
        )
      }
      if (
        !Array.isArray(dependenciesValue) ||
        dependenciesValue.some(
          (dependency) =>
            typeof dependency !== "string" || dependency.trim().length === 0
        )
      ) {
        throw new Error(
          `listTodos(${conversationId}): invalid dependencies_json for ${row.id}`
        )
      }
      const dependencies = dependenciesValue as string[]
      return {
        conversationId,
        id: row.id,
        content: row.content,
        status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        dependencies,
      }
    })
  }

  replaceTodos(conversationId: ConversationId, todos: SessionTodo[]): void {
    this.persistence.runInTransaction(() => {
      this.replaceTodosUnsafe(conversationId, todos)
    })
  }

  private replaceTodosUnsafe(
    conversationId: ConversationId,
    todos: SessionTodo[]
  ): void {
    const deleteStmt = (this.stmtDeleteTodosForConversation ??=
      this.persistence.prepare(
        `DELETE FROM session_todos
          WHERE conversation_id = ?`
      ))
    deleteStmt.run(conversationId)
    for (const todo of todos) {
      this.upsertTodo(todo)
    }
  }

  // ── message blobs ────────────────────────────────────────────────

  private insertMessageBlob(blob: SessionMessageBlob): void {
    const stmt = (this.stmtInsertMessageBlob ??= this.persistence.prepare(
      `INSERT INTO session_message_blobs (
         conversation_id, blob_id, added_at
       ) VALUES (?, ?, ?)
       ON CONFLICT(conversation_id, blob_id) DO NOTHING`
    ))
    stmt.run(blob.conversationId, blob.blobId, blob.addedAt)
  }

  listMessageBlobs(conversationId: ConversationId): SessionMessageBlob[] {
    const stmt = (this.stmtListMessageBlobs ??= this.persistence.prepare(
      `SELECT blob_id, added_at
         FROM session_message_blobs
        WHERE conversation_id = ?
        ORDER BY added_at ASC`
    ))
    const rows = stmt.all(conversationId) as unknown as Array<{
      blob_id: string
      added_at: number
    }>
    return rows.map((row) => ({
      conversationId,
      blobId: row.blob_id,
      addedAt: row.added_at,
    }))
  }

  private replaceMessageBlobsUnsafe(
    conversationId: ConversationId,
    blobs: SessionMessageBlob[]
  ): void {
    const deleteStmt = (this.stmtDeleteMessageBlobsForConversation ??=
      this.persistence.prepare(
        `DELETE FROM session_message_blobs
          WHERE conversation_id = ?`
      ))
    deleteStmt.run(conversationId)
    for (const blob of blobs) {
      this.insertMessageBlob(blob)
    }
  }

  // ── read paths ───────────────────────────────────────────────────

  private upsertReadPath(record: SessionReadPath): void {
    const stmt = (this.stmtUpsertReadPath ??= this.persistence.prepare(
      `INSERT INTO session_read_paths (
         conversation_id, path, read_at
       ) VALUES (?, ?, ?)
       ON CONFLICT(conversation_id, path) DO UPDATE SET
         read_at = excluded.read_at`
    ))
    stmt.run(record.conversationId, record.path, record.readAt)
  }

  listReadPaths(conversationId: ConversationId): SessionReadPath[] {
    const stmt = (this.stmtListReadPaths ??= this.persistence.prepare(
      `SELECT path, read_at
         FROM session_read_paths
        WHERE conversation_id = ?
        ORDER BY read_at DESC`
    ))
    const rows = stmt.all(conversationId) as unknown as Array<{
      path: string
      read_at: number
    }>
    return rows.map((row) => ({
      conversationId,
      path: row.path,
      readAt: row.read_at,
    }))
  }

  private replaceReadPathsUnsafe(
    conversationId: ConversationId,
    records: SessionReadPath[]
  ): void {
    const deleteStmt = (this.stmtDeleteReadPathsForConversation ??=
      this.persistence.prepare(
        `DELETE FROM session_read_paths
          WHERE conversation_id = ?`
      ))
    deleteStmt.run(conversationId)
    for (const record of records) {
      this.upsertReadPath(record)
    }
  }

  private assertTransactionForConversation(
    txn: SessionTxn,
    conversationId: ConversationId
  ): void {
    if (!txn || txn.tag !== SESSION_TXN_TAG) {
      throw new Error(
        "SessionPersistenceService: snapshot writes require a SessionTxn from MessageStore.runInTransaction()"
      )
    }
    if ((txn as SessionTxnInternal).persistence !== this.persistence) {
      throw new Error(
        "SessionPersistenceService: snapshot transaction belongs to another persistence connection"
      )
    }
    if (txn.conversationId !== conversationId) {
      throw new Error(
        `SessionPersistenceService: transaction conversation mismatch: txn=${txn.conversationId} row=${conversationId}`
      )
    }
  }

  private assertSnapshotConversation(
    snapshot: SessionPersistenceSnapshot
  ): void {
    const conversationId = snapshot.row.conversationId
    const entries = [
      ...snapshot.fileStates,
      ...snapshot.todos,
      ...snapshot.messageBlobs,
      ...snapshot.readPaths,
    ]
    if (entries.some((entry) => entry.conversationId !== conversationId)) {
      throw new Error(
        `SessionPersistenceService: snapshot contains a row for another conversation than ${conversationId}`
      )
    }
  }
}

function parsePersistedTodoStatus(
  value: unknown,
  label: string
): SessionTodoStatus {
  if (
    typeof value === "string" &&
    (SESSION_TODO_STATUSES as readonly string[]).includes(value)
  ) {
    return value as SessionTodoStatus
  }
  throw new Error(`${label} is invalid`)
}

function assertPersistedTodoText(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

function assertPersistedTodoTimestamp(
  value: unknown,
  label: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
}
