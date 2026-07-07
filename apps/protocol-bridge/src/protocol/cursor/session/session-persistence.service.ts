import { Injectable, Logger } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { PersistenceService } from "../../../persistence"
import type { ConversationId } from "../turn/turn.types"
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
  status: string
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

export interface SessionContextStateRow {
  conversationId: ConversationId
  updatedAt: number
  state: Record<string, unknown>
}

export interface PersistedSessionActivitySummary {
  conversationId: ConversationId
  lastActivityAt: number
  model: string
  openToolCallCount: number
  contextStateUpdatedAt?: number
  hasRestartRecovery: boolean
  restartRecoveryToolCallCount: number
  restartRecoveryInteractionQueryCount: number
}

/**
 * SessionPersistenceService
 *
 * Owns the `sessions`, `session_file_states`, `session_todos`,
 * `session_message_blobs`, `session_read_paths` tables. Each method is
 * a thin DB layer; semantic concerns (when to persist, how to merge a
 * partial config update, etc.) are owned by SessionLifecycleService
 * (added in step 4).
 *
 * The previous design serialised the entire session into a single
 * `cursor_sessions.state_json` blob and rewrote it on every dirty
 * flush. The split lets each domain service only touch the rows it
 * cares about, and lets SQLite enforce foreign-key cascade on
 * conversation delete.
 */
@Injectable()
export class SessionPersistenceService {
  private readonly logger = new Logger(SessionPersistenceService.name)

  // sessions
  private stmtUpsertSession?: StatementSync
  private stmtSelectSession?: StatementSync
  private stmtListSessions?: StatementSync
  private stmtTouchSession?: StatementSync
  private stmtDeleteSession?: StatementSync

  // related
  private stmtUpsertFileState?: StatementSync
  private stmtListFileStates?: StatementSync
  private stmtDeleteFileState?: StatementSync

  private stmtUpsertTodo?: StatementSync
  private stmtListTodos?: StatementSync
  private stmtDeleteTodo?: StatementSync
  private stmtDeleteTodosForConversation?: StatementSync

  private stmtInsertMessageBlob?: StatementSync
  private stmtListMessageBlobs?: StatementSync

  private stmtUpsertReadPath?: StatementSync
  private stmtListReadPaths?: StatementSync
  private stmtDeleteReadPathsForConversation?: StatementSync

  private stmtUpsertContextState?: StatementSync
  private stmtSelectContextState?: StatementSync
  private stmtListSessionActivitySummaries?: StatementSync

  private stmtDeleteFileStatesForConversation?: StatementSync
  private stmtDeleteMessageBlobsForConversation?: StatementSync

  constructor(private readonly persistence: PersistenceService) {}

  // ── sessions ─────────────────────────────────────────────────────

  upsertSession(row: SessionRow): void {
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
    let config: Record<string, unknown>
    try {
      config = JSON.parse(row.config_json) as Record<string, unknown>
    } catch (err) {
      this.logger.warn(
        `loadSession(${conversationId}): bad config_json: ${(err as Error).message}`
      )
      config = {}
    }
    return {
      conversationId,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      model: row.model,
      config,
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
    // Cascade FKs handle the related tables.
    const stmt = (this.stmtDeleteSession ??= this.persistence.prepare(
      `DELETE FROM sessions WHERE conversation_id = ?`
    ))
    stmt.run(conversationId)
  }

  /**
   * Wipe every row in the v2 session schema. Cache clear is an
   * operator-level reset, so it truncates every session-owned domain
   * table explicitly instead of relying on parent-table cascade.
   *
   * Returns the count of `sessions` rows that were deleted so the
   * caller can report a progress number to the UI.
   */
  deleteAllSessions(): number {
    // Re-assert FK handling on this connection. The cache-clear command is
    // an operator action, so clear every v2 domain table explicitly instead
    // of depending on cascade side effects to catch all persisted state.
    this.persistence.exec("PRAGMA foreign_keys = ON")
    const before = this.persistence
      .prepare(`SELECT COUNT(*) AS n FROM sessions`)
      .get() as { n: number } | undefined
    this.persistence.runInTransaction(() => {
      this.persistence.exec(`DELETE FROM tool_call_ledger`)
      this.persistence.exec(`DELETE FROM session_messages`)
      this.persistence.exec(`DELETE FROM turn_events`)
      this.persistence.exec(`DELETE FROM session_file_states`)
      this.persistence.exec(`DELETE FROM session_todos`)
      this.persistence.exec(`DELETE FROM session_message_blobs`)
      this.persistence.exec(`DELETE FROM session_read_paths`)
      this.persistence.exec(`DELETE FROM session_context_state`)
      this.persistence.exec(`DELETE FROM sessions`)
    })
    return before?.n ?? 0
  }

  listSessionActivitySummaries(): PersistedSessionActivitySummary[] {
    const stmt = (this.stmtListSessionActivitySummaries ??=
      this.persistence.prepare(
        `SELECT s.conversation_id,
                s.last_activity_at,
                s.model,
                COALESCE(open_ledger.open_tool_call_count, 0) AS open_tool_call_count,
                state.updated_at AS context_state_updated_at,
                state.state_json AS context_state_json
           FROM sessions s
           LEFT JOIN (
             SELECT conversation_id, COUNT(*) AS open_tool_call_count
               FROM tool_call_ledger
              WHERE state = 'open'
              GROUP BY conversation_id
           ) open_ledger ON open_ledger.conversation_id = s.conversation_id
           LEFT JOIN session_context_state state
             ON state.conversation_id = s.conversation_id
          ORDER BY s.last_activity_at DESC`
      ))
    const rows = stmt.all() as unknown as Array<{
      conversation_id: string
      last_activity_at: number
      model: string
      open_tool_call_count: number
      context_state_updated_at: number | null
      context_state_json: string | null
    }>

    return rows.map((row) => {
      const recovery = this.parseRestartRecoveryActivity(
        row.conversation_id,
        row.context_state_json
      )
      return {
        conversationId: row.conversation_id as ConversationId,
        lastActivityAt: row.last_activity_at,
        model: row.model,
        openToolCallCount: row.open_tool_call_count || 0,
        contextStateUpdatedAt: row.context_state_updated_at ?? undefined,
        ...recovery,
      }
    })
  }

  // ── file states ──────────────────────────────────────────────────

  upsertFileState(state: SessionFileState): void {
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

  deleteFileState(conversationId: ConversationId, path: string): void {
    const stmt = (this.stmtDeleteFileState ??= this.persistence.prepare(
      `DELETE FROM session_file_states
        WHERE conversation_id = ?
          AND path = ?`
    ))
    stmt.run(conversationId, path)
  }

  replaceFileStates(
    conversationId: ConversationId,
    states: SessionFileState[]
  ): void {
    this.persistence.runInTransaction(() => {
      const deleteStmt = (this.stmtDeleteFileStatesForConversation ??=
        this.persistence.prepare(
          `DELETE FROM session_file_states
            WHERE conversation_id = ?`
        ))
      deleteStmt.run(conversationId)
      for (const state of states) {
        this.upsertFileState(state)
      }
    })
  }

  // ── todos ────────────────────────────────────────────────────────

  upsertTodo(todo: SessionTodo): void {
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
      let dependencies: string[]
      try {
        dependencies = JSON.parse(row.dependencies_json) as string[]
      } catch {
        dependencies = []
      }
      return {
        conversationId,
        id: row.id,
        content: row.content,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        dependencies,
      }
    })
  }

  deleteTodo(conversationId: ConversationId, id: string): void {
    const stmt = (this.stmtDeleteTodo ??= this.persistence.prepare(
      `DELETE FROM session_todos
        WHERE conversation_id = ?
          AND id = ?`
    ))
    stmt.run(conversationId, id)
  }

  replaceTodos(conversationId: ConversationId, todos: SessionTodo[]): void {
    this.persistence.runInTransaction(() => {
      const deleteStmt = (this.stmtDeleteTodosForConversation ??=
        this.persistence.prepare(
          `DELETE FROM session_todos
            WHERE conversation_id = ?`
        ))
      deleteStmt.run(conversationId)
      for (const todo of todos) {
        this.upsertTodo(todo)
      }
    })
  }

  // ── message blobs ────────────────────────────────────────────────

  insertMessageBlob(blob: SessionMessageBlob): void {
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

  replaceMessageBlobs(
    conversationId: ConversationId,
    blobs: SessionMessageBlob[]
  ): void {
    this.persistence.runInTransaction(() => {
      const deleteStmt = (this.stmtDeleteMessageBlobsForConversation ??=
        this.persistence.prepare(
          `DELETE FROM session_message_blobs
            WHERE conversation_id = ?`
        ))
      deleteStmt.run(conversationId)
      for (const blob of blobs) {
        this.insertMessageBlob(blob)
      }
    })
  }

  // ── read paths ───────────────────────────────────────────────────

  upsertReadPath(record: SessionReadPath): void {
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

  replaceReadPaths(
    conversationId: ConversationId,
    records: SessionReadPath[]
  ): void {
    this.persistence.runInTransaction(() => {
      const deleteStmt = (this.stmtDeleteReadPathsForConversation ??=
        this.persistence.prepare(
          `DELETE FROM session_read_paths
            WHERE conversation_id = ?`
        ))
      deleteStmt.run(conversationId)
      for (const record of records) {
        this.upsertReadPath(record)
      }
    })
  }

  // ── context state ────────────────────────────────────────────────

  upsertContextState(row: SessionContextStateRow): void {
    const stmt = (this.stmtUpsertContextState ??= this.persistence.prepare(
      `INSERT INTO session_context_state (
         conversation_id, updated_at, state_json
       ) VALUES (?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         state_json = excluded.state_json`
    ))
    stmt.run(row.conversationId, row.updatedAt, JSON.stringify(row.state))
  }

  loadContextState(
    conversationId: ConversationId
  ): SessionContextStateRow | undefined {
    const stmt = (this.stmtSelectContextState ??= this.persistence.prepare(
      `SELECT updated_at, state_json
         FROM session_context_state
        WHERE conversation_id = ?`
    ))
    const row = stmt.get(conversationId) as
      | { updated_at: number; state_json: string }
      | undefined
    if (!row) return undefined
    let state: Record<string, unknown>
    try {
      state = JSON.parse(row.state_json) as Record<string, unknown>
    } catch (err) {
      this.logger.warn(
        `loadContextState(${conversationId}): bad state_json: ${(err as Error).message}`
      )
      state = {}
    }
    return {
      conversationId,
      updatedAt: row.updated_at,
      state,
    }
  }

  private parseRestartRecoveryActivity(
    conversationId: string,
    stateJson: string | null
  ): Pick<
    PersistedSessionActivitySummary,
    | "hasRestartRecovery"
    | "restartRecoveryToolCallCount"
    | "restartRecoveryInteractionQueryCount"
  > {
    if (!stateJson) {
      return {
        hasRestartRecovery: false,
        restartRecoveryToolCallCount: 0,
        restartRecoveryInteractionQueryCount: 0,
      }
    }

    let state: Record<string, unknown>
    try {
      state = JSON.parse(stateJson) as Record<string, unknown>
    } catch (err) {
      this.logger.warn(
        `listSessionActivitySummaries(${conversationId}): bad state_json: ${(err as Error).message}`
      )
      return {
        hasRestartRecovery: false,
        restartRecoveryToolCallCount: 0,
        restartRecoveryInteractionQueryCount: 0,
      }
    }

    const restartRecovery = state.restartRecovery
    if (!restartRecovery || typeof restartRecovery !== "object") {
      return {
        hasRestartRecovery: false,
        restartRecoveryToolCallCount: 0,
        restartRecoveryInteractionQueryCount: 0,
      }
    }

    const recovery = restartRecovery as {
      interruptedToolCalls?: unknown
      interruptedInteractionQueryCount?: unknown
    }
    return {
      hasRestartRecovery: true,
      restartRecoveryToolCallCount: Array.isArray(recovery.interruptedToolCalls)
        ? recovery.interruptedToolCalls.length
        : 0,
      restartRecoveryInteractionQueryCount:
        typeof recovery.interruptedInteractionQueryCount === "number" &&
        Number.isFinite(recovery.interruptedInteractionQueryCount)
          ? Math.max(0, Math.floor(recovery.interruptedInteractionQueryCount))
          : 0,
    }
  }
}
