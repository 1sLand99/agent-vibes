import { Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import {
  assertCodexSubagentProviderIdentity,
  type CodexSubagentProviderIdentity,
} from "../../../llm/openai/codex-provider-identity"
import { PersistenceService } from "../../../persistence"
import {
  ConversationId,
  TurnId,
  type TurnId as TurnIdValue,
} from "../turn/turn.types"
import {
  SESSION_TXN_TAG,
  type SessionTxn,
  type SessionTxnInternal,
} from "./tool-call-ledger.service"
import {
  normalizeSubagentSpawnRequestBoundary,
  type SubagentSpawnRequest,
} from "./subagent-spawn-request"

export type {
  SubagentBridgeInlineOperation,
  SubagentChildContextAttachmentSnapshot,
  SubagentMcpRegistryServerScope,
  SubagentMcpRegistryTool,
  SubagentModelRequestPolicy,
  SubagentPromptContextSnapshot,
  SubagentSpawnRequest,
  SubagentTaskAttachmentSnapshot,
  SubagentToolContract,
  SubagentToolContractEntry,
  SubagentToolCapabilityIdentityInput,
  SubagentToolContractFingerprintInput,
  SubagentToolExecutionOwner,
  SubagentToolExecutionOwners,
} from "./subagent-spawn-request"

export {
  computeSubagentToolCapabilityId,
  computeSubagentToolContractFingerprint,
  computeSubagentToolInputSchemaSha256,
} from "./subagent-spawn-request"

/** The only live state. Every other value is a terminal outcome. */
export type SubagentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "interrupted"

export type TerminalSubagentRunStatus = Exclude<SubagentRunStatus, "running">

export type SubagentRunMode = "foreground" | "background"

export type SubagentRunDeliveryState = "pending" | "delivered"

export interface SubagentRunEvidence {
  toolName: string
  summary: string
}

/** Structured facts captured by the execution owner at terminalization. */
export interface SubagentRunTerminalFacts {
  turnCount?: number
  toolCallCount?: number
  modifiedFiles: string[]
  evidence: SubagentRunEvidence[]
}

/**
 * A bridge restart has no safe way to resume an in-process sub-agent body.
 * The session-graph recovery transaction must use this exact message when it
 * appends the corresponding parent task interruption and claims delivery.
 */
export const STALE_SUBAGENT_RUN_INTERRUPTION_MESSAGE =
  "Bridge restarted before the sub-agent reached a terminal state."

export const SUBAGENT_REGISTRY_KILLED_ERROR_MESSAGE = "aborted by registry"

export interface SubagentRunRecord {
  conversationId: ConversationId
  agentId: string
  parentToolCallId: string
  /** Child execution identity; never reuse the parent task turn id. */
  executionTurnId: TurnIdValue
  threadId: string
  branchId: string
  /** Immutable parent graph fork captured when this durable run is created. */
  forkSourceUuid: string
  /** Exact inherited lineage plus the fork source; never inferred from a tail row. */
  forkLineage: readonly string[]
  /** Native Codex lineage; deliberately separate from local graph identity. */
  codexIdentity: CodexSubagentProviderIdentity
  agentType: string
  model: string
  description: string
  prompt: string
  /** Immutable model request captured at the exact child spawn boundary. */
  spawnRequest: SubagentSpawnRequest
  mode: SubagentRunMode
  status: SubagentRunStatus
  createdAt: number
  startedAt: number
  terminalAt?: number
  /** Present only for a genuinely completed run. */
  finalText?: string
  /** Present only for failed, killed, or interrupted runs. */
  errorMessage?: string
  /** Present for every terminal run; never reconstructed from report text. */
  terminalFacts?: SubagentRunTerminalFacts
  deliveryState: SubagentRunDeliveryState
  deliveredAt?: number
}

export interface CreateSubagentRunInput {
  conversationId: ConversationId
  agentId: string
  parentToolCallId: string
  executionTurnId: TurnIdValue
  threadId: string
  branchId: string
  codexIdentity: CodexSubagentProviderIdentity
  agentType: string
  model: string
  description: string
  prompt: string
  spawnRequest: SubagentSpawnRequest
  mode: SubagentRunMode
  createdAt?: number
  startedAt?: number
}

export interface TerminalizeSubagentRunInput {
  status: TerminalSubagentRunStatus
  terminalAt?: number
  terminalFacts: SubagentRunTerminalFacts
  /** A non-empty final answer is required for a completed run. */
  finalText?: string
  /** A diagnostic is required for every non-completed terminal state. */
  errorMessage?: string
}

export type TerminalizeSubagentRunResult =
  | { kind: "transitioned"; run: SubagentRunRecord }
  | { kind: "already_terminal"; run: SubagentRunRecord }
  | { kind: "missing" }

export type ClaimSubagentRunDeliveryResult =
  | { kind: "claimed"; run: SubagentRunRecord }
  | { kind: "already_delivered"; run: SubagentRunRecord }
  | { kind: "not_terminal"; run: SubagentRunRecord }
  | { kind: "missing" }

export class SubagentRunOwnerConflictError extends Error {
  constructor(
    readonly existing: SubagentRunRecord,
    attemptedAgentId: string
  ) {
    super(
      `SubagentRunStore.create: parent task owner already exists for ` +
        `conversation=${existing.conversationId} parentToolCallId=${existing.parentToolCallId} ` +
        `(existingAgentId=${existing.agentId}, attemptedAgentId=${attemptedAgentId})`
    )
    this.name = "SubagentRunOwnerConflictError"
  }
}

export class SubagentRunIdentityConflictError extends Error {
  constructor(readonly existing: SubagentRunRecord) {
    super(
      `SubagentRunStore.create: agent id already exists for ` +
        `conversation=${existing.conversationId} agentId=${existing.agentId}`
    )
    this.name = "SubagentRunIdentityConflictError"
  }
}

export class SubagentRunExecutionTurnConflictError extends Error {
  constructor(readonly existing: SubagentRunRecord) {
    super(
      `SubagentRunStore.create: execution turn already belongs to ` +
        `conversation=${existing.conversationId} executionTurnId=${existing.executionTurnId} ` +
        `(existingAgentId=${existing.agentId})`
    )
    this.name = "SubagentRunExecutionTurnConflictError"
  }
}

export class SubagentRunNativeWindowReservationError extends Error {
  constructor(conversationId: ConversationId, agentId: string) {
    super(
      `SubagentRunStore.reserveNextCodexWindowNumber: no running run for ` +
        `conversation=${conversationId} agentId=${agentId}`
    )
    this.name = "SubagentRunNativeWindowReservationError"
  }
}

/**
 * A run is permitted only while its real parent `task` tool-use remains open.
 * This makes an accidental parent-turn reuse or an invented ownership link a
 * hard failure at the durable boundary rather than an in-memory convention.
 */
export class SubagentRunParentTaskContractError extends Error {
  constructor(reason: string) {
    super(`SubagentRunStore.create: invalid parent task owner: ${reason}`)
    this.name = "SubagentRunParentTaskContractError"
  }
}

interface SubagentRunRow {
  agent_id: string
  parent_tool_call_id: string
  execution_turn_id: string
  thread_id: string
  branch_id: string
  fork_source_uuid: string
  fork_lineage_json: string
  codex_session_id: string
  codex_thread_id: string
  codex_parent_thread_id: string
  codex_thread_source: string
  codex_subagent_header: string
  codex_subagent_kind: string
  agent_type: string
  model: string
  description: string
  prompt: string
  spawn_request_json: string
  mode: string
  status: string
  created_at: number
  started_at: number
  terminal_at: number | null
  final_text: string | null
  error_message: string | null
  terminal_turn_count: number | null
  terminal_tool_call_count: number | null
  terminal_modified_files_json: string | null
  terminal_evidence_json: string | null
  delivery_state: string
  delivered_at: number | null
}

interface ParentTaskOwnerRow {
  turn_id: string | null
  origin: string
  tool_name: string
  state: string
}

interface ParentTaskGraphIdentityRow {
  uuid: string
  content_json: string
  fork_lineage_json: string | null
}

export type SubagentExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "backgrounded"
  | "interrupted"

export interface SubagentRunExecutionRecord {
  conversationId: ConversationId
  agentId: string
  executionTurnId: TurnIdValue
  mode: SubagentRunMode
  status: SubagentExecutionStatus
  startedAt: number
  terminalAt?: number
  errorMessage?: string
}

interface SubagentRunExecutionRow {
  execution_turn_id: string
  mode: string
  status: string
  started_at: number
  terminal_at: number | null
  error_message: string | null
}

/**
 * Canonical durable lifecycle for one sub-agent execution.
 *
 * The table has one owner per `(conversationId, parentToolCallId)` and one
 * identity per `(conversationId, agentId)`. Runtime AbortControllers, file
 * transcripts, and UI notifications are deliberately excluded: they are
 * transient observers of this state, never alternative authorities.
 */
@Injectable()
export class SubagentRunStore {
  private stmtInsert?: StatementSync
  private stmtGet?: StatementSync
  private stmtListInConversation?: StatementSync
  private stmtGetByParentToolCall?: StatementSync
  private stmtGetByExecutionTurn?: StatementSync
  private stmtReserveNextCodexWindowNumber?: StatementSync
  private stmtGetParentTaskOwner?: StatementSync
  private stmtGetParentTaskGraphIdentity?: StatementSync
  private stmtMarkTerminalIfRunning?: StatementSync
  private stmtListRunningInConversation?: StatementSync
  private stmtListPendingTerminalDeliveries?: StatementSync
  private stmtListPendingTerminalDeliveriesInConversation?: StatementSync
  private stmtClaimTerminalDelivery?: StatementSync
  private stmtInsertExecution?: StatementSync
  private stmtGetExecution?: StatementSync
  private stmtListExecutions?: StatementSync
  private stmtFinishExecution?: StatementSync
  private stmtTransitionRunToBackground?: StatementSync

  constructor(private readonly persistence: PersistenceService) {}

  /**
   * Transactional spawn boundary for the parent task's graph/ledger write.
   * The child record and any branch-root materialization either commit
   * together or neither becomes visible.
   */
  createInTransaction(
    txn: SessionTxn,
    input: CreateSubagentRunInput
  ): SubagentRunRecord {
    this.assertTransaction(txn, "createInTransaction")
    const normalized = this.normalizeCreate(input)
    if (txn.conversationId !== normalized.conversationId) {
      throw new Error(
        `SubagentRunStore.createInTransaction: conversation mismatch ` +
          `txn=${txn.conversationId} input=${normalized.conversationId}`
      )
    }
    return this.createNormalized(normalized)
  }

  private createNormalized(
    normalized: Required<CreateSubagentRunInput>
  ): SubagentRunRecord {
    this.throwCreationConflictIfPresent(normalized)
    this.assertParentTaskOwner(
      normalized.conversationId,
      normalized.parentToolCallId,
      normalized.executionTurnId
    )
    const branchIdentity = this.resolveParentTaskGraphIdentity(
      normalized.conversationId,
      normalized.parentToolCallId
    )

    try {
      const result = (this.stmtInsert ??= this.persistence.prepare(
        `INSERT INTO session_subagent_runs (
           conversation_id, agent_id, parent_tool_call_id, execution_turn_id,
           thread_id, branch_id,
           fork_source_uuid, fork_lineage_json,
           codex_session_id, codex_thread_id, codex_parent_thread_id,
           codex_thread_source, codex_subagent_header, codex_subagent_kind,
           agent_type, model, description, prompt, spawn_request_json,
           mode, status,
           created_at, started_at, terminal_at, final_text, error_message,
           terminal_turn_count, terminal_tool_call_count,
           terminal_modified_files_json, terminal_evidence_json,
           delivery_state, delivered_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?,
                NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'pending', NULL
           FROM tool_call_ledger AS ledger
           JOIN session_messages AS source
             ON source.conversation_id = ledger.conversation_id
            AND source.seq = ledger.open_message_seq
          WHERE ledger.conversation_id = ?
            AND ledger.tool_use_id = ?
            AND ledger.origin = 'runtime'
            AND ledger.tool_name = 'task'
            AND ledger.state = 'open'
            AND ledger.turn_id IS NOT NULL
            AND ledger.turn_id <> ?
            AND source.uuid = ?`
      )).run(
        normalized.conversationId,
        normalized.agentId,
        normalized.parentToolCallId,
        normalized.executionTurnId,
        normalized.threadId,
        normalized.branchId,
        branchIdentity.forkSourceUuid,
        JSON.stringify(branchIdentity.forkLineage),
        normalized.codexIdentity.sessionId,
        normalized.codexIdentity.threadId,
        normalized.codexIdentity.parentThreadId,
        normalized.codexIdentity.threadSource,
        normalized.codexIdentity.subagentHeader,
        normalized.codexIdentity.subagentKind,
        normalized.agentType,
        normalized.model,
        normalized.description,
        normalized.prompt,
        JSON.stringify(normalized.spawnRequest),
        normalized.mode,
        normalized.createdAt,
        normalized.startedAt,
        normalized.conversationId,
        normalized.parentToolCallId,
        normalized.executionTurnId,
        branchIdentity.forkSourceUuid
      ) as { changes?: number }

      if ((result.changes ?? 0) !== 1) {
        // The parent owner changed after validation. Re-read it below for a
        // domain error; never insert a detached child record.
        this.throwCreationConflictIfPresent(normalized)
        this.assertParentTaskOwner(
          normalized.conversationId,
          normalized.parentToolCallId,
          normalized.executionTurnId
        )
        throw new Error(
          `SubagentRunStore.create: parent task owner changed during insert ` +
            `conversation=${normalized.conversationId} parentToolCallId=${normalized.parentToolCallId}`
        )
      }
      this.insertExecution({
        conversationId: normalized.conversationId,
        agentId: normalized.agentId,
        executionTurnId: normalized.executionTurnId,
        mode: normalized.mode,
        startedAt: normalized.startedAt,
      })
    } catch (error) {
      // A concurrent creator can win after the pre-read. Re-read under the
      // canonical keys rather than parsing SQLite's implementation-specific
      // unique-constraint text.
      this.throwCreationConflictIfPresent(normalized)
      throw error
    }

    return this.require(normalized.conversationId, normalized.agentId, "create")
  }

  private throwCreationConflictIfPresent(
    normalized: Required<CreateSubagentRunInput>
  ): void {
    const existingOwner = this.getByParentToolCallId(
      normalized.conversationId,
      normalized.parentToolCallId
    )
    if (existingOwner) {
      throw new SubagentRunOwnerConflictError(existingOwner, normalized.agentId)
    }
    const existingIdentity = this.get(
      normalized.conversationId,
      normalized.agentId
    )
    if (existingIdentity) {
      throw new SubagentRunIdentityConflictError(existingIdentity)
    }
    const existingExecution = this.getByExecutionTurnId(
      normalized.conversationId,
      normalized.executionTurnId
    )
    if (existingExecution) {
      throw new SubagentRunExecutionTurnConflictError(existingExecution)
    }
  }

  /** Scoped lookup; an agent id is never global across conversations. */
  get(
    conversationId: ConversationId,
    agentId: string
  ): SubagentRunRecord | undefined {
    const normalizedAgentId = this.requireCanonicalIdentifier(
      agentId,
      "agentId"
    )
    const row = (this.stmtGet ??= this.persistence.prepare(
      `SELECT agent_id, parent_tool_call_id, execution_turn_id, thread_id,
              branch_id, fork_source_uuid, fork_lineage_json,
              codex_session_id, codex_thread_id,
              codex_parent_thread_id, codex_thread_source,
              codex_subagent_header, codex_subagent_kind,
              agent_type, model, description, prompt, spawn_request_json,
              mode, status, created_at,
              started_at, terminal_at, final_text, error_message,
              terminal_turn_count, terminal_tool_call_count,
              terminal_modified_files_json, terminal_evidence_json,
              delivery_state, delivered_at
         FROM session_subagent_runs
        WHERE conversation_id = ? AND agent_id = ?
        LIMIT 1`
    )).get(conversationId, normalizedAgentId) as SubagentRunRow | undefined
    return row ? this.decodeRow(conversationId, row) : undefined
  }

  /**
   * List every durable logical child run for cold projection mounting. The
   * caller must still derive each projection owner through
   * SubagentBranchStore; a run list is discovery data, never projection
   * authority by itself.
   */
  listInConversation(conversationId: ConversationId): SubagentRunRecord[] {
    const rows = (this.stmtListInConversation ??= this.persistence.prepare(
      `SELECT agent_id, parent_tool_call_id, execution_turn_id, thread_id,
              branch_id, fork_source_uuid, fork_lineage_json,
              codex_session_id, codex_thread_id,
              codex_parent_thread_id, codex_thread_source,
              codex_subagent_header, codex_subagent_kind,
              agent_type, model, description, prompt, spawn_request_json,
              mode, status, created_at,
              started_at, terminal_at, final_text, error_message,
              terminal_turn_count, terminal_tool_call_count,
              terminal_modified_files_json, terminal_evidence_json,
              delivery_state, delivered_at
         FROM session_subagent_runs
        WHERE conversation_id = ?
        ORDER BY created_at ASC, agent_id ASC`
    )).all(conversationId) as unknown as SubagentRunRow[]
    return rows.map((row) => this.decodeRow(conversationId, row))
  }

  /**
   * Atomically reserve one upstream Codex window number for this child run.
   * The sequence belongs to the native child thread, not a local projection
   * phase: child requests and Remote Compact V2 all draw from this single
   * durable counter.
   */
  reserveNextCodexWindowNumber(
    conversationId: ConversationId,
    agentId: string
  ): number {
    const normalizedAgentId = this.requireCanonicalIdentifier(
      agentId,
      "agentId"
    )
    const row = this.persistence.runInTransaction(
      () =>
        (this.stmtReserveNextCodexWindowNumber ??= this.persistence.prepare(
          `UPDATE session_subagent_runs
            SET codex_next_window_number = codex_next_window_number + 1
          WHERE conversation_id = ?
            AND agent_id = ?
            AND status = 'running'
          RETURNING codex_next_window_number - 1 AS window_number`
        )).get(conversationId, normalizedAgentId) as
          | { window_number: unknown }
          | undefined
    )
    if (!row) {
      throw new SubagentRunNativeWindowReservationError(
        conversationId,
        normalizedAgentId
      )
    }
    return this.requireNonNegativeSafeInteger(
      row.window_number,
      "reserved codex_next_window_number"
    )
  }

  /** The parent task tool call is the unique durable owner of a run. */
  getByParentToolCallId(
    conversationId: ConversationId,
    parentToolCallId: string
  ): SubagentRunRecord | undefined {
    const normalizedParentToolCallId = this.requireCanonicalIdentifier(
      parentToolCallId,
      "parentToolCallId"
    )
    const row = (this.stmtGetByParentToolCall ??= this.persistence.prepare(
      `SELECT agent_id, parent_tool_call_id, execution_turn_id, thread_id,
              branch_id, fork_source_uuid, fork_lineage_json,
              codex_session_id, codex_thread_id,
              codex_parent_thread_id, codex_thread_source,
              codex_subagent_header, codex_subagent_kind,
              agent_type, model, description, prompt, spawn_request_json,
              mode, status, created_at,
              started_at, terminal_at, final_text, error_message,
              terminal_turn_count, terminal_tool_call_count,
              terminal_modified_files_json, terminal_evidence_json,
              delivery_state, delivered_at
         FROM session_subagent_runs
        WHERE conversation_id = ? AND parent_tool_call_id = ?
        LIMIT 1`
    )).get(conversationId, normalizedParentToolCallId) as
      | SubagentRunRow
      | undefined
    return row ? this.decodeRow(conversationId, row) : undefined
  }

  /**
   * Any current or historical child execution turn resolves to its one
   * durable logical run within the conversation.
   */
  getByExecutionTurnId(
    conversationId: ConversationId,
    executionTurnId: TurnIdValue
  ): SubagentRunRecord | undefined {
    const normalizedExecutionTurnId = this.requireCanonicalIdentifier(
      executionTurnId,
      "executionTurnId"
    )
    const row = (this.stmtGetByExecutionTurn ??= this.persistence.prepare(
      `SELECT run.agent_id, run.parent_tool_call_id, run.execution_turn_id, run.thread_id,
              run.branch_id, run.fork_source_uuid, run.fork_lineage_json,
              run.codex_session_id, run.codex_thread_id,
              run.codex_parent_thread_id, run.codex_thread_source,
              run.codex_subagent_header, run.codex_subagent_kind,
              run.agent_type, run.model, run.description, run.prompt,
              run.spawn_request_json,
              run.mode, run.status, run.created_at, run.started_at, run.terminal_at,
              run.final_text, run.error_message, run.terminal_turn_count,
              run.terminal_tool_call_count, run.terminal_modified_files_json,
              run.terminal_evidence_json, run.delivery_state, run.delivered_at
         FROM session_subagent_run_executions AS execution
         JOIN session_subagent_runs AS run
           ON run.conversation_id = execution.conversation_id
          AND run.agent_id = execution.agent_id
        WHERE execution.conversation_id = ?
          AND execution.execution_turn_id = ?
        LIMIT 1`
    )).get(conversationId, normalizedExecutionTurnId) as
      | SubagentRunRow
      | undefined
    return row ? this.decodeRow(conversationId, row) : undefined
  }

  listExecutions(
    conversationId: ConversationId,
    agentId: string
  ): SubagentRunExecutionRecord[] {
    const normalizedAgentId = this.requireCanonicalIdentifier(
      agentId,
      "agentId"
    )
    const rows = (this.stmtListExecutions ??= this.persistence.prepare(
      `SELECT execution_turn_id, mode, status, started_at, terminal_at,
              error_message
         FROM session_subagent_run_executions
        WHERE conversation_id = ? AND agent_id = ?
        ORDER BY started_at ASC, execution_turn_id ASC`
    )).all(
      conversationId,
      normalizedAgentId
    ) as unknown as SubagentRunExecutionRow[]
    return rows.map((row) =>
      this.decodeExecution(conversationId, normalizedAgentId, row)
    )
  }

  ownsExecutionTurn(
    conversationId: ConversationId,
    agentId: string,
    executionTurnId: TurnIdValue
  ): boolean {
    return (
      this.getExecution(conversationId, agentId, executionTurnId) !== undefined
    )
  }

  /**
   * Official foreground-to-background handoff. The foreground TurnHandle is
   * closed as `backgrounded`, a distinct background execution is installed,
   * and the logical run remains running. No two execution turns may own the
   * sidechain concurrently.
   */
  transitionToBackground(
    conversationId: ConversationId,
    agentId: string,
    expectedForegroundTurnId: TurnIdValue,
    backgroundTurnId: TurnIdValue,
    transitionedAt: number = Date.now()
  ): SubagentRunRecord {
    this.assertTimestamp(
      transitionedAt,
      "transitionToBackground",
      "transitionedAt"
    )
    const normalizedAgentId = this.requireCanonicalIdentifier(
      agentId,
      "agentId"
    )
    const normalizedExpectedForegroundTurnId = TurnId.of(
      this.requireCanonicalIdentifier(
        expectedForegroundTurnId,
        "expectedForegroundTurnId"
      )
    )
    const normalizedBackgroundTurnId = TurnId.of(
      this.requireCanonicalIdentifier(backgroundTurnId, "backgroundTurnId")
    )
    if (normalizedExpectedForegroundTurnId === normalizedBackgroundTurnId) {
      throw new Error(
        "SubagentRunStore.transitionToBackground: background turn must be distinct"
      )
    }

    return this.persistence.runInTransaction(() => {
      const run = this.require(
        conversationId,
        normalizedAgentId,
        "transitionToBackground"
      )
      if (
        run.status !== "running" ||
        run.mode !== "foreground" ||
        run.executionTurnId !== normalizedExpectedForegroundTurnId
      ) {
        throw new Error(
          `SubagentRunStore.transitionToBackground: foreground owner mismatch ` +
            `conversation=${conversationId} agentId=${normalizedAgentId}`
        )
      }
      this.assertParentTaskOwner(
        conversationId,
        run.parentToolCallId,
        normalizedBackgroundTurnId
      )
      this.finishExecution(
        conversationId,
        normalizedAgentId,
        normalizedExpectedForegroundTurnId,
        "backgrounded",
        transitionedAt
      )
      const updated = (this.stmtTransitionRunToBackground ??=
        this.persistence.prepare(
          `UPDATE session_subagent_runs
              SET execution_turn_id = ?, mode = 'background'
            WHERE conversation_id = ?
              AND agent_id = ?
              AND status = 'running'
              AND mode = 'foreground'
              AND execution_turn_id = ?`
        )).run(
        normalizedBackgroundTurnId,
        conversationId,
        normalizedAgentId,
        normalizedExpectedForegroundTurnId
      ) as { changes?: number }
      if ((updated.changes ?? 0) !== 1) {
        throw new Error(
          "SubagentRunStore.transitionToBackground: run owner changed during handoff"
        )
      }
      this.insertExecution({
        conversationId,
        agentId: normalizedAgentId,
        executionTurnId: normalizedBackgroundTurnId,
        mode: "background",
        startedAt: transitionedAt,
      })
      return this.require(
        conversationId,
        normalizedAgentId,
        "transitionToBackground"
      )
    })
  }

  /**
   * Terminalize a detached background execution after its parent task ack is
   * already durable. Foreground outcomes must use the transaction-bound API
   * beside their exact parent task result.
   */
  terminalizeBackgroundOutboxRun(
    conversationId: ConversationId,
    agentId: string,
    input: TerminalizeSubagentRunInput
  ): TerminalizeSubagentRunResult {
    return this.persistence.runInTransaction(() => {
      const run = this.get(conversationId, agentId)
      if (!run) return { kind: "missing" as const }
      if (run.mode !== "background") {
        throw new Error(
          `SubagentRunStore.terminalizeBackgroundOutboxRun: run is not background ` +
            `conversation=${conversationId} agentId=${agentId}`
        )
      }
      const owner = (this.stmtGetParentTaskOwner ??= this.persistence.prepare(
        `SELECT turn_id, origin, tool_name, state
           FROM tool_call_ledger
          WHERE conversation_id = ? AND tool_use_id = ?
          LIMIT 1`
      )).get(conversationId, run.parentToolCallId) as
        | ParentTaskOwnerRow
        | undefined
      if (
        !owner ||
        owner.origin !== "runtime" ||
        owner.tool_name !== "task" ||
        owner.state !== "closed"
      ) {
        throw new Error(
          `SubagentRunStore.terminalizeBackgroundOutboxRun: parent task ack is not durable ` +
            `conversation=${conversationId} agentId=${agentId}`
        )
      }
      return this.markTerminalIfRunningUnchecked(conversationId, agentId, input)
    })
  }

  /**
   * Transactional terminalization for a child completion that also commits a
   * durable parent tool_result. This is the normal completion path.
   */
  markTerminalIfRunningInTransaction(
    txn: SessionTxn,
    agentId: string,
    input: TerminalizeSubagentRunInput
  ): TerminalizeSubagentRunResult {
    this.assertTransaction(txn, "markTerminalIfRunningInTransaction")
    return this.markTerminalIfRunningUnchecked(
      txn.conversationId,
      agentId,
      input
    )
  }

  private markTerminalIfRunningUnchecked(
    conversationId: ConversationId,
    agentId: string,
    input: TerminalizeSubagentRunInput
  ): TerminalizeSubagentRunResult {
    const normalizedAgentId = this.requireCanonicalIdentifier(
      agentId,
      "agentId"
    )
    const terminal = this.normalizeTerminalInput(input)
    const beforeTransition = this.get(conversationId, normalizedAgentId)
    if (
      beforeTransition?.status === "running" &&
      terminal.terminalAt < beforeTransition.startedAt
    ) {
      throw new Error(
        "SubagentRunStore.markTerminalIfRunning: terminalAt cannot precede startedAt"
      )
    }
    const transition = (this.stmtMarkTerminalIfRunning ??=
      this.persistence.prepare(
        `UPDATE session_subagent_runs
            SET status = ?,
                terminal_at = ?,
                final_text = ?,
                error_message = ?,
                terminal_turn_count = ?,
                terminal_tool_call_count = ?,
                terminal_modified_files_json = ?,
                terminal_evidence_json = ?
          WHERE conversation_id = ?
            AND agent_id = ?
            AND status = 'running'`
      )).run(
      terminal.status,
      terminal.terminalAt,
      terminal.finalText ?? null,
      terminal.errorMessage ?? null,
      terminal.terminalFacts.turnCount ?? null,
      terminal.terminalFacts.toolCallCount ?? null,
      JSON.stringify(terminal.terminalFacts.modifiedFiles),
      JSON.stringify(terminal.terminalFacts.evidence),
      conversationId,
      normalizedAgentId
    ) as { changes?: number }

    if ((transition.changes ?? 0) === 1) {
      this.finishExecution(
        conversationId,
        normalizedAgentId,
        beforeTransition!.executionTurnId,
        terminal.status === "killed" ? "cancelled" : terminal.status,
        terminal.terminalAt,
        terminal.errorMessage
      )
      return {
        kind: "transitioned",
        run: this.require(
          conversationId,
          normalizedAgentId,
          "markTerminalIfRunning"
        ),
      }
    }

    const existing = this.get(conversationId, normalizedAgentId)
    if (!existing) return { kind: "missing" }
    if (existing.status === "running") {
      throw new Error(
        `SubagentRunStore.markTerminalIfRunning: running row could not transition for ` +
          `conversation=${conversationId} agentId=${normalizedAgentId}`
      )
    }
    return { kind: "already_terminal", run: existing }
  }

  /**
   * Read restart-recovery candidates only inside the caller's active session
   * graph transaction. The store deliberately has no bootstrap side effect:
   * a run interruption, parent task tool_result, and terminal-delivery claim
   * must either commit together or all remain pending for recovery.
   */
  listRunningInTransaction(txn: SessionTxn): SubagentRunRecord[] {
    this.assertTransaction(txn, "listRunningInTransaction")
    const rows = (this.stmtListRunningInConversation ??=
      this.persistence.prepare(
        `SELECT agent_id, parent_tool_call_id, execution_turn_id,
                thread_id, branch_id, fork_source_uuid, fork_lineage_json,
                codex_session_id, codex_thread_id,
                codex_parent_thread_id, codex_thread_source,
                codex_subagent_header, codex_subagent_kind,
                agent_type, model, description, prompt, spawn_request_json,
                mode, status, created_at, started_at, terminal_at, final_text,
                error_message, terminal_turn_count, terminal_tool_call_count,
                terminal_modified_files_json, terminal_evidence_json,
                delivery_state, delivered_at
           FROM session_subagent_runs
          WHERE conversation_id = ?
            AND status = 'running'
          ORDER BY agent_id ASC`
      )).all(txn.conversationId) as unknown as SubagentRunRow[]
    return rows.map((row) => this.decodeRow(txn.conversationId, row))
  }

  /**
   * Read terminal runs whose parent delivery did not commit before a process
   * stop. Like `listRunningInTransaction`, this is transaction-only: the
   * recovery coordinator must either append the exact parent result, memory
   * event and delivery claim together, or leave the row visible for a later
   * retry. This deliberately does not reuse the cross-conversation background
   * notification query.
   */
  listPendingTerminalDeliveriesInTransaction(
    txn: SessionTxn
  ): SubagentRunRecord[] {
    this.assertTransaction(txn, "listPendingTerminalDeliveriesInTransaction")
    const rows = (this.stmtListPendingTerminalDeliveriesInConversation ??=
      this.persistence.prepare(
        `SELECT agent_id, parent_tool_call_id, execution_turn_id,
                thread_id, branch_id, fork_source_uuid, fork_lineage_json,
                codex_session_id, codex_thread_id,
                codex_parent_thread_id, codex_thread_source,
                codex_subagent_header, codex_subagent_kind,
                agent_type, model, description, prompt, spawn_request_json,
                mode, status, created_at, started_at, terminal_at, final_text,
                error_message, terminal_turn_count, terminal_tool_call_count,
                terminal_modified_files_json, terminal_evidence_json,
                delivery_state, delivered_at
           FROM session_subagent_runs
          WHERE conversation_id = ?
            AND status <> 'running'
            AND delivery_state = 'pending'
          ORDER BY terminal_at ASC, agent_id ASC`
      )).all(txn.conversationId) as unknown as SubagentRunRow[]
    return rows.map((row) => this.decodeRow(txn.conversationId, row))
  }

  /**
   * Restart reconciliation primitive. It is intentionally transaction-only;
   * the session graph recovery owner must append the exact interrupted parent
   * task result and call `claimTerminalDeliveryInTransaction` before commit.
   */
  reconcileInterruptedInTransaction(
    txn: SessionTxn,
    agentId: string,
    options: {
      interruptedAt?: number
      errorMessage?: string
    } = {}
  ): TerminalizeSubagentRunResult {
    this.assertTransaction(txn, "reconcileInterruptedInTransaction")
    const interruptedAt = options.interruptedAt ?? Date.now()
    this.assertTimestamp(
      interruptedAt,
      "reconcileInterruptedInTransaction",
      "interruptedAt"
    )
    return this.markTerminalIfRunningUnchecked(txn.conversationId, agentId, {
      status: "interrupted",
      terminalAt: interruptedAt,
      errorMessage:
        options.errorMessage ?? STALE_SUBAGENT_RUN_INTERRUPTION_MESSAGE,
      terminalFacts: { modifiedFiles: [], evidence: [] },
    })
  }

  /**
   * Recovery/reconciliation input for terminal outcomes whose parent result
   * has not committed yet. This deliberately reads durable state only; a
   * transcript file or a lost in-memory worker never manufactures a result.
   */
  listPendingTerminalDeliveries(): SubagentRunRecord[] {
    const rows = (this.stmtListPendingTerminalDeliveries ??=
      this.persistence.prepare(
        `SELECT conversation_id, agent_id, parent_tool_call_id, execution_turn_id,
                thread_id, branch_id, fork_source_uuid, fork_lineage_json,
                codex_session_id, codex_thread_id,
                codex_parent_thread_id, codex_thread_source,
                codex_subagent_header, codex_subagent_kind,
                agent_type, model, description, prompt, spawn_request_json,
                mode, status,
                created_at, started_at, terminal_at, final_text, error_message,
                terminal_turn_count, terminal_tool_call_count,
                terminal_modified_files_json, terminal_evidence_json,
                delivery_state, delivered_at
           FROM session_subagent_runs
          WHERE status <> 'running'
            AND delivery_state = 'pending'
          ORDER BY terminal_at ASC, conversation_id ASC, agent_id ASC`
      )).all() as unknown as Array<SubagentRunRow & { conversation_id: string }>
    return rows.map((row) =>
      this.decodeRow(ConversationId.of(row.conversation_id), row)
    )
  }

  /**
   * Atomically claims the one terminal delivery slot inside the same
   * MessageStore transaction that appends the parent's tool_result and closes
   * its ledger entry. `delivered` means that durable projection committed; it
   * is deliberately not an optimistic network-write marker. If the enclosing
   * transaction rolls back, the claim rolls back too and recovery may retry.
   */
  claimTerminalDeliveryInTransaction(
    txn: SessionTxn,
    agentId: string,
    deliveredAt: number = Date.now()
  ): ClaimSubagentRunDeliveryResult {
    this.assertTransaction(txn, "claimTerminalDeliveryInTransaction")
    const conversationId = txn.conversationId
    const normalizedAgentId = this.requireCanonicalIdentifier(
      agentId,
      "agentId"
    )
    this.assertTimestamp(
      deliveredAt,
      "claimTerminalDeliveryInTransaction",
      "deliveredAt"
    )
    const beforeClaim = this.get(conversationId, normalizedAgentId)
    if (
      beforeClaim?.terminalAt !== undefined &&
      deliveredAt < beforeClaim.terminalAt
    ) {
      throw new Error(
        "SubagentRunStore.claimTerminalDeliveryInTransaction: deliveredAt cannot precede terminalAt"
      )
    }
    const result = (this.stmtClaimTerminalDelivery ??= this.persistence.prepare(
      `UPDATE session_subagent_runs
            SET delivery_state = 'delivered', delivered_at = ?
          WHERE conversation_id = ?
            AND agent_id = ?
            AND status <> 'running'
            AND delivery_state = 'pending'`
    )).run(deliveredAt, conversationId, normalizedAgentId) as {
      changes?: number
    }

    if ((result.changes ?? 0) === 1) {
      return {
        kind: "claimed",
        run: this.require(
          conversationId,
          normalizedAgentId,
          "claimTerminalDeliveryInTransaction"
        ),
      }
    }

    const existing = this.get(conversationId, normalizedAgentId)
    if (!existing) return { kind: "missing" }
    if (existing.status === "running") {
      return { kind: "not_terminal", run: existing }
    }
    if (existing.deliveryState === "delivered") {
      return { kind: "already_delivered", run: existing }
    }
    throw new Error(
      `SubagentRunStore.claimTerminalDeliveryInTransaction: terminal delivery CAS failed for ` +
        `conversation=${conversationId} agentId=${normalizedAgentId}`
    )
  }

  private insertExecution(input: {
    conversationId: ConversationId
    agentId: string
    executionTurnId: TurnIdValue
    mode: SubagentRunMode
    startedAt: number
  }): void {
    ;(this.stmtInsertExecution ??= this.persistence.prepare(
      `INSERT INTO session_subagent_run_executions (
         conversation_id, agent_id, execution_turn_id, mode, status,
         started_at, terminal_at, error_message
       ) VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL)`
    )).run(
      input.conversationId,
      input.agentId,
      input.executionTurnId,
      input.mode,
      input.startedAt
    )
  }

  private getExecution(
    conversationId: ConversationId,
    agentId: string,
    executionTurnId: TurnIdValue
  ): SubagentRunExecutionRecord | undefined {
    const normalizedAgentId = this.requireCanonicalIdentifier(
      agentId,
      "agentId"
    )
    const normalizedExecutionTurnId = TurnId.of(
      this.requireCanonicalIdentifier(executionTurnId, "executionTurnId")
    )
    const row = (this.stmtGetExecution ??= this.persistence.prepare(
      `SELECT execution_turn_id, mode, status, started_at, terminal_at,
              error_message
         FROM session_subagent_run_executions
        WHERE conversation_id = ?
          AND agent_id = ?
          AND execution_turn_id = ?
        LIMIT 1`
    )).get(conversationId, normalizedAgentId, normalizedExecutionTurnId) as
      | SubagentRunExecutionRow
      | undefined
    return row
      ? this.decodeExecution(conversationId, normalizedAgentId, row)
      : undefined
  }

  private finishExecution(
    conversationId: ConversationId,
    agentId: string,
    executionTurnId: TurnIdValue,
    status: Exclude<SubagentExecutionStatus, "running">,
    terminalAt: number,
    errorMessage?: string
  ): void {
    const normalizedAgentId = this.requireCanonicalIdentifier(
      agentId,
      "agentId"
    )
    const normalizedExecutionTurnId = TurnId.of(
      this.requireCanonicalIdentifier(executionTurnId, "executionTurnId")
    )
    const needsError =
      status === "failed" || status === "cancelled" || status === "interrupted"
    const normalizedError = needsError
      ? this.requireText(errorMessage, "execution errorMessage")
      : undefined
    const result = (this.stmtFinishExecution ??= this.persistence.prepare(
      `UPDATE session_subagent_run_executions
          SET status = ?, terminal_at = ?, error_message = ?
        WHERE conversation_id = ?
          AND agent_id = ?
          AND execution_turn_id = ?
          AND status = 'running'`
    )).run(
      status,
      terminalAt,
      normalizedError ?? null,
      conversationId,
      normalizedAgentId,
      normalizedExecutionTurnId
    ) as { changes?: number }
    if ((result.changes ?? 0) !== 1) {
      throw new Error(
        `SubagentRunStore: execution terminal transition failed ` +
          `conversation=${conversationId} agentId=${normalizedAgentId} turn=${normalizedExecutionTurnId}`
      )
    }
  }

  private decodeExecution(
    conversationId: ConversationId,
    agentId: string,
    row: SubagentRunExecutionRow
  ): SubagentRunExecutionRecord {
    const mode = this.decodeMode(row.mode)
    const allowed: readonly SubagentExecutionStatus[] = [
      "running",
      "completed",
      "failed",
      "cancelled",
      "backgrounded",
      "interrupted",
    ]
    if (!allowed.includes(row.status as SubagentExecutionStatus)) {
      throw new Error(
        `SubagentRunStore: invalid stored execution status ${JSON.stringify(row.status)}`
      )
    }
    this.assertTimestamp(row.started_at, "decodeExecution", "started_at")
    if (row.terminal_at !== null) {
      this.assertTimestamp(row.terminal_at, "decodeExecution", "terminal_at")
    }
    const status = row.status as SubagentExecutionStatus
    const errorMessage =
      row.error_message === null
        ? undefined
        : this.requireText(row.error_message, "stored execution error_message")
    if (status === "running") {
      if (row.terminal_at !== null || errorMessage !== undefined) {
        throw new Error(
          "SubagentRunStore: running execution has terminal outcome data"
        )
      }
    } else if (status === "completed" || status === "backgrounded") {
      if (row.terminal_at === null || errorMessage !== undefined) {
        throw new Error(
          "SubagentRunStore: successful execution has invalid terminal outcome data"
        )
      }
    } else if (row.terminal_at === null || errorMessage === undefined) {
      throw new Error(
        "SubagentRunStore: unsuccessful execution has invalid terminal outcome data"
      )
    }
    return {
      conversationId,
      agentId,
      executionTurnId: TurnId.of(
        this.requireCanonicalIdentifier(
          row.execution_turn_id,
          "stored execution_turn_id"
        )
      ),
      mode,
      status,
      startedAt: row.started_at,
      ...(row.terminal_at !== null ? { terminalAt: row.terminal_at } : {}),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    }
  }

  private require(
    conversationId: ConversationId,
    agentId: string,
    operation: string
  ): SubagentRunRecord {
    const run = this.get(conversationId, agentId)
    if (!run) {
      throw new Error(
        `SubagentRunStore.${operation}: record disappeared for ` +
          `conversation=${conversationId} agentId=${agentId}`
      )
    }
    return run
  }

  private assertParentTaskOwner(
    conversationId: ConversationId,
    parentToolCallId: string,
    executionTurnId: TurnIdValue
  ): void {
    const row = (this.stmtGetParentTaskOwner ??= this.persistence.prepare(
      `SELECT turn_id, origin, tool_name, state
         FROM tool_call_ledger
        WHERE conversation_id = ? AND tool_use_id = ?
        LIMIT 1`
    )).get(conversationId, parentToolCallId) as ParentTaskOwnerRow | undefined
    if (!row) {
      throw new SubagentRunParentTaskContractError(
        `missing ledger row for conversation=${conversationId} toolUseId=${parentToolCallId}`
      )
    }
    if (row.origin !== "runtime" || row.tool_name !== "task") {
      throw new SubagentRunParentTaskContractError(
        `expected runtime task tool_use for conversation=${conversationId} toolUseId=${parentToolCallId}`
      )
    }
    if (row.state !== "open") {
      throw new SubagentRunParentTaskContractError(
        `parent task is not open for conversation=${conversationId} toolUseId=${parentToolCallId}`
      )
    }
    if (row.turn_id === null) {
      throw new SubagentRunParentTaskContractError(
        `parent task has no runtime turn for conversation=${conversationId} toolUseId=${parentToolCallId}`
      )
    }
    let parentTurnId: string
    try {
      parentTurnId = this.requireCanonicalIdentifier(
        row.turn_id,
        "parent task turn_id"
      )
    } catch (error) {
      throw new SubagentRunParentTaskContractError(
        `parent task has an invalid runtime turn for conversation=${conversationId} toolUseId=${parentToolCallId}: ${(error as Error).message}`
      )
    }
    if (parentTurnId === executionTurnId) {
      throw new SubagentRunParentTaskContractError(
        `executionTurnId must differ from parent turn for conversation=${conversationId} toolUseId=${parentToolCallId}`
      )
    }
  }

  /**
   * The parent ledger alone is not enough to identify a child branch. Bind
   * the run to the exact immutable assistant graph fragment that opened its
   * `task` edge, then persist the resulting fork lineage on the run itself.
   */
  private resolveParentTaskGraphIdentity(
    conversationId: ConversationId,
    parentToolCallId: string
  ): { forkSourceUuid: string; forkLineage: string[] } {
    const row = (this.stmtGetParentTaskGraphIdentity ??=
      this.persistence.prepare(
        `SELECT message.uuid, message.content_json, message.fork_lineage_json
           FROM tool_call_ledger AS ledger
           JOIN session_messages AS message
             ON message.conversation_id = ledger.conversation_id
            AND message.seq = ledger.open_message_seq
          WHERE ledger.conversation_id = ?
            AND ledger.tool_use_id = ?
            AND ledger.origin = 'runtime'
            AND ledger.tool_name = 'task'
          LIMIT 1`
      )).get(conversationId, parentToolCallId) as
      | ParentTaskGraphIdentityRow
      | undefined
    if (!row) {
      throw new SubagentRunParentTaskContractError(
        `parent task has no exact graph source for conversation=${conversationId} toolUseId=${parentToolCallId}`
      )
    }

    let content: unknown
    try {
      content = JSON.parse(row.content_json)
    } catch (error) {
      throw new SubagentRunParentTaskContractError(
        `parent task graph source has invalid content for conversation=${conversationId} toolUseId=${parentToolCallId}: ${(error as Error).message}`
      )
    }
    const ownsExactTask =
      Array.isArray(content) &&
      content.some(
        (block) =>
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "tool_use" &&
          (block as { id?: unknown }).id === parentToolCallId &&
          (block as { name?: unknown }).name === "task"
      )
    if (!ownsExactTask) {
      throw new SubagentRunParentTaskContractError(
        `parent task graph source does not own its exact task tool_use for conversation=${conversationId} toolUseId=${parentToolCallId}`
      )
    }

    const inherited = this.parseOptionalForkLineage(
      row.fork_lineage_json,
      `parent task fork lineage conversation=${conversationId} toolUseId=${parentToolCallId}`
    )
    const forkSourceUuid = this.requireCanonicalIdentifier(
      row.uuid,
      "parent task graph uuid"
    )
    if (inherited.includes(forkSourceUuid)) {
      throw new SubagentRunParentTaskContractError(
        `parent task fork lineage already contains its own source for conversation=${conversationId} toolUseId=${parentToolCallId}`
      )
    }
    return {
      forkSourceUuid,
      forkLineage: [...inherited, forkSourceUuid],
    }
  }

  private normalizeCreate(
    input: CreateSubagentRunInput
  ): Required<CreateSubagentRunInput> {
    const createdAt = input.createdAt ?? Date.now()
    const startedAt = input.startedAt ?? createdAt
    this.assertTimestamp(createdAt, "create", "createdAt")
    this.assertTimestamp(startedAt, "create", "startedAt")
    if (startedAt < createdAt) {
      throw new Error(
        "SubagentRunStore.create: startedAt cannot precede createdAt"
      )
    }
    if (input.mode !== "foreground" && input.mode !== "background") {
      throw new Error(
        "SubagentRunStore.create: mode must be foreground or background"
      )
    }
    const agentId = this.requireCanonicalIdentifier(input.agentId, "agentId")
    const threadId = this.requireCanonicalIdentifier(input.threadId, "threadId")
    const branchId = this.requireCanonicalIdentifier(input.branchId, "branchId")
    const expectedLocalBranchId = `subagent:${agentId}`
    if (
      threadId !== expectedLocalBranchId ||
      branchId !== expectedLocalBranchId
    ) {
      throw new Error(
        `SubagentRunStore.create: threadId and branchId must equal ${expectedLocalBranchId}`
      )
    }
    assertCodexSubagentProviderIdentity(input.codexIdentity)
    return {
      conversationId: input.conversationId,
      agentId,
      parentToolCallId: this.requireCanonicalIdentifier(
        input.parentToolCallId,
        "parentToolCallId"
      ),
      executionTurnId: TurnId.of(
        this.requireCanonicalIdentifier(
          input.executionTurnId,
          "executionTurnId"
        )
      ),
      threadId,
      branchId,
      codexIdentity: { ...input.codexIdentity },
      agentType: this.requireCanonicalIdentifier(input.agentType, "agentType"),
      model: this.requireCanonicalIdentifier(input.model, "model"),
      description: this.requireText(input.description, "description"),
      prompt: this.requireText(input.prompt, "prompt"),
      spawnRequest: normalizeSubagentSpawnRequestBoundary(input.spawnRequest)
        .request,
      mode: input.mode,
      createdAt,
      startedAt,
    }
  }

  private normalizeTerminalInput(input: TerminalizeSubagentRunInput): Required<
    Pick<TerminalizeSubagentRunInput, "status" | "terminalAt">
  > &
    Pick<TerminalizeSubagentRunInput, "finalText" | "errorMessage"> & {
      terminalFacts: SubagentRunTerminalFacts
    } {
    const terminalAt = input.terminalAt ?? Date.now()
    this.assertTimestamp(terminalAt, "markTerminalIfRunning", "terminalAt")
    const terminalFacts = this.normalizeTerminalFacts(input.terminalFacts)
    if (input.status === "completed") {
      if (input.errorMessage !== undefined) {
        throw new Error(
          "SubagentRunStore.markTerminalIfRunning: completed runs cannot carry errorMessage"
        )
      }
      if (
        typeof input.finalText !== "string" ||
        !input.finalText.trim() ||
        input.finalText.includes("\u0000")
      ) {
        throw new Error(
          "SubagentRunStore.markTerminalIfRunning: completed runs require non-empty finalText"
        )
      }
      const finalText = this.requireText(input.finalText, "finalText")
      return {
        status: input.status,
        terminalAt,
        finalText,
        terminalFacts,
      }
    }
    if (
      input.status !== "failed" &&
      input.status !== "killed" &&
      input.status !== "interrupted"
    ) {
      throw new Error(
        "SubagentRunStore.markTerminalIfRunning: status must be terminal"
      )
    }
    if (input.finalText !== undefined) {
      throw new Error(
        "SubagentRunStore.markTerminalIfRunning: non-completed runs cannot carry finalText"
      )
    }
    return {
      status: input.status,
      terminalAt,
      errorMessage: this.requireText(input.errorMessage, "errorMessage"),
      terminalFacts,
    }
  }

  private normalizeTerminalFacts(value: unknown): SubagentRunTerminalFacts {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        "SubagentRunStore.markTerminalIfRunning: terminalFacts are required"
      )
    }
    this.assertExactFields(
      value,
      ["turnCount", "toolCallCount", "modifiedFiles", "evidence"],
      "terminalFacts"
    )
    const facts = value as Partial<SubagentRunTerminalFacts>
    const turnCount =
      facts.turnCount === undefined
        ? undefined
        : this.requireNonNegativeSafeInteger(
            facts.turnCount,
            "terminalFacts.turnCount"
          )
    const toolCallCount =
      facts.toolCallCount === undefined
        ? undefined
        : this.requireNonNegativeSafeInteger(
            facts.toolCallCount,
            "terminalFacts.toolCallCount"
          )
    if (!Array.isArray(facts.modifiedFiles)) {
      throw new Error(
        "SubagentRunStore.markTerminalIfRunning: terminalFacts.modifiedFiles must be an array"
      )
    }
    if (facts.modifiedFiles.length > 1024) {
      throw new Error(
        "SubagentRunStore.markTerminalIfRunning: terminalFacts.modifiedFiles exceeds 1024 entries"
      )
    }
    const modifiedFiles = facts.modifiedFiles.map((file) =>
      this.requireBoundedFilePathText(file, "terminalFacts.modifiedFiles", 8192)
    )
    if (!Array.isArray(facts.evidence)) {
      throw new Error(
        "SubagentRunStore.markTerminalIfRunning: terminalFacts.evidence must be an array"
      )
    }
    if (facts.evidence.length > 64) {
      throw new Error(
        "SubagentRunStore.markTerminalIfRunning: terminalFacts.evidence exceeds 64 entries"
      )
    }
    const evidence = facts.evidence.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(
          "SubagentRunStore.markTerminalIfRunning: terminalFacts.evidence entries must be objects"
        )
      }
      this.assertExactFields(
        item,
        ["toolName", "summary"],
        "terminalFacts.evidence item"
      )
      return {
        toolName: this.requireCanonicalIdentifier(
          (item as Partial<SubagentRunEvidence>).toolName,
          "terminalFacts.evidence.toolName"
        ),
        summary: this.requireBoundedText(
          (item as Partial<SubagentRunEvidence>).summary,
          "terminalFacts.evidence.summary",
          4096
        ),
      }
    })
    return {
      ...(turnCount !== undefined ? { turnCount } : {}),
      ...(toolCallCount !== undefined ? { toolCallCount } : {}),
      modifiedFiles,
      evidence,
    }
  }

  private assertExactFields(
    value: object,
    allowedFields: readonly string[],
    field: string
  ): void {
    const allowed = new Set(allowedFields)
    const unsupported = Object.keys(value).filter((key) => !allowed.has(key))
    if (unsupported.length > 0) {
      throw new Error(
        `SubagentRunStore.markTerminalIfRunning: ${field} contains unsupported field(s): ${unsupported.join(", ")}`
      )
    }
  }

  private decodeTerminalFacts(row: SubagentRunRow): SubagentRunTerminalFacts {
    let modifiedFiles: unknown
    let evidence: unknown
    try {
      modifiedFiles = JSON.parse(row.terminal_modified_files_json!)
      evidence = JSON.parse(row.terminal_evidence_json!)
    } catch (error) {
      throw new Error(
        `SubagentRunStore: invalid terminal facts JSON: ${(error as Error).message}`
      )
    }
    return this.normalizeTerminalFacts({
      turnCount: row.terminal_turn_count ?? undefined,
      toolCallCount: row.terminal_tool_call_count ?? undefined,
      modifiedFiles,
      evidence,
    })
  }

  private decodeRow(
    conversationId: ConversationId,
    row: SubagentRunRow
  ): SubagentRunRecord {
    const status = this.decodeStatus(row.status)
    const mode = this.decodeMode(row.mode)
    const deliveryState = this.decodeDeliveryState(row.delivery_state)
    this.assertTimestamp(row.created_at, "decodeRow", "created_at")
    this.assertTimestamp(row.started_at, "decodeRow", "started_at")
    if (row.terminal_at !== null) {
      this.assertTimestamp(row.terminal_at, "decodeRow", "terminal_at")
    }
    if (row.delivered_at !== null) {
      this.assertTimestamp(row.delivered_at, "decodeRow", "delivered_at")
    }
    if (row.started_at < row.created_at) {
      throw new Error("SubagentRunStore: started_at precedes created_at")
    }
    if (row.terminal_at !== null && row.terminal_at < row.started_at) {
      throw new Error("SubagentRunStore: terminal_at precedes started_at")
    }
    if (
      row.delivered_at !== null &&
      (row.terminal_at === null || row.delivered_at < row.terminal_at)
    ) {
      throw new Error("SubagentRunStore: delivered_at precedes terminal_at")
    }
    this.assertRowSemantics(row, status, deliveryState)
    const terminalFacts =
      status === "running" ? undefined : this.decodeTerminalFacts(row)
    const spawnRequest = this.decodeSpawnRequest(row.spawn_request_json)
    const codexIdentity = {
      sessionId: this.requireCanonicalIdentifier(
        row.codex_session_id,
        "stored codex_session_id"
      ),
      threadId: this.requireCanonicalIdentifier(
        row.codex_thread_id,
        "stored codex_thread_id"
      ),
      parentThreadId: this.requireCanonicalIdentifier(
        row.codex_parent_thread_id,
        "stored codex_parent_thread_id"
      ),
      threadSource: this.requireCanonicalIdentifier(
        row.codex_thread_source,
        "stored codex_thread_source"
      ),
      subagentHeader: this.requireCanonicalIdentifier(
        row.codex_subagent_header,
        "stored codex_subagent_header"
      ),
      subagentKind: this.requireCanonicalIdentifier(
        row.codex_subagent_kind,
        "stored codex_subagent_kind"
      ),
    }
    assertCodexSubagentProviderIdentity(codexIdentity)
    const forkSourceUuid = this.requireCanonicalIdentifier(
      row.fork_source_uuid,
      "stored fork_source_uuid"
    )
    const forkLineage = this.parseRequiredForkLineage(
      row.fork_lineage_json,
      `stored fork lineage conversation=${conversationId} agentId=${row.agent_id}`
    )
    if (
      forkLineage.length === 0 ||
      forkLineage.at(-1) !== forkSourceUuid ||
      new Set(forkLineage).size !== forkLineage.length
    ) {
      throw new Error(
        "SubagentRunStore: stored fork lineage does not end at its unique fork source"
      )
    }
    const agentId = this.requireCanonicalIdentifier(
      row.agent_id,
      "stored agent_id"
    )
    const threadId = this.requireCanonicalIdentifier(
      row.thread_id,
      "stored thread_id"
    )
    const branchId = this.requireCanonicalIdentifier(
      row.branch_id,
      "stored branch_id"
    )
    const expectedLocalBranchId = `subagent:${agentId}`
    if (
      threadId !== expectedLocalBranchId ||
      branchId !== expectedLocalBranchId
    ) {
      throw new Error(
        "SubagentRunStore: stored thread/branch identity is not canonical"
      )
    }
    const finalText =
      row.final_text === null
        ? undefined
        : this.requireText(row.final_text, "stored final_text")
    const errorMessage =
      row.error_message === null
        ? undefined
        : this.requireText(row.error_message, "stored error_message")
    return {
      conversationId,
      agentId,
      parentToolCallId: this.requireCanonicalIdentifier(
        row.parent_tool_call_id,
        "stored parent_tool_call_id"
      ),
      executionTurnId: TurnId.of(
        this.requireCanonicalIdentifier(
          row.execution_turn_id,
          "stored execution_turn_id"
        )
      ),
      threadId,
      branchId,
      forkSourceUuid,
      forkLineage,
      codexIdentity,
      agentType: this.requireCanonicalIdentifier(
        row.agent_type,
        "stored agent_type"
      ),
      model: this.requireCanonicalIdentifier(row.model, "stored model"),
      description: this.requireText(row.description, "stored description"),
      prompt: this.requireText(row.prompt, "stored prompt"),
      spawnRequest,
      mode,
      status,
      createdAt: row.created_at,
      startedAt: row.started_at,
      ...(row.terminal_at !== null ? { terminalAt: row.terminal_at } : {}),
      ...(finalText === undefined ? {} : { finalText }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
      ...(terminalFacts ? { terminalFacts } : {}),
      deliveryState,
      ...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
    }
  }

  private decodeSpawnRequest(value: unknown): SubagentSpawnRequest {
    if (typeof value !== "string") {
      throw new Error(
        "SubagentRunStore: stored spawn_request_json must be text"
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      throw new Error(
        `SubagentRunStore: invalid stored spawn_request_json: ${(error as Error).message}`
      )
    }
    try {
      return normalizeSubagentSpawnRequestBoundary(parsed).request
    } catch (error) {
      throw new Error(
        `SubagentRunStore: invalid stored spawn_request_json: ${(error as Error).message}`
      )
    }
  }

  private assertRowSemantics(
    row: SubagentRunRow,
    status: SubagentRunStatus,
    deliveryState: SubagentRunDeliveryState
  ): void {
    if (status === "running") {
      if (
        row.terminal_at !== null ||
        row.final_text !== null ||
        row.error_message !== null ||
        row.terminal_turn_count !== null ||
        row.terminal_tool_call_count !== null ||
        row.terminal_modified_files_json !== null ||
        row.terminal_evidence_json !== null ||
        deliveryState !== "pending" ||
        row.delivered_at !== null
      ) {
        throw new Error("SubagentRunStore: invalid running row semantics")
      }
      return
    }
    if (row.terminal_at === null) {
      throw new Error("SubagentRunStore: terminal run missing terminal_at")
    }
    if (
      row.terminal_modified_files_json === null ||
      row.terminal_evidence_json === null
    ) {
      throw new Error("SubagentRunStore: terminal run missing terminal facts")
    }
    if (status === "completed") {
      if (
        row.error_message !== null ||
        row.final_text === null ||
        !row.final_text.trim()
      ) {
        throw new Error(
          "SubagentRunStore: completed run has invalid final_text"
        )
      }
    } else if (
      row.final_text !== null ||
      !row.error_message ||
      !row.error_message.trim()
    ) {
      throw new Error(
        "SubagentRunStore: unsuccessful terminal run has invalid outcome payload"
      )
    }
    if (deliveryState === "pending" && row.delivered_at !== null) {
      throw new Error("SubagentRunStore: pending delivery has delivered_at")
    }
    if (deliveryState === "delivered" && row.delivered_at === null) {
      throw new Error("SubagentRunStore: delivered run missing delivered_at")
    }
  }

  private decodeStatus(value: string): SubagentRunStatus {
    if (
      value === "running" ||
      value === "completed" ||
      value === "failed" ||
      value === "killed" ||
      value === "interrupted"
    ) {
      return value
    }
    throw new Error(
      `SubagentRunStore: invalid stored status ${JSON.stringify(value)}`
    )
  }

  private decodeMode(value: string): SubagentRunMode {
    if (value === "foreground" || value === "background") return value
    throw new Error(
      `SubagentRunStore: invalid stored mode ${JSON.stringify(value)}`
    )
  }

  private decodeDeliveryState(value: string): SubagentRunDeliveryState {
    if (value === "pending" || value === "delivered") return value
    throw new Error(
      `SubagentRunStore: invalid stored delivery state ${JSON.stringify(value)}`
    )
  }

  private parseOptionalForkLineage(
    value: string | null,
    label: string
  ): string[] {
    if (value === null) return []
    return this.parseForkLineageJson(value, label)
  }

  private parseRequiredForkLineage(value: unknown, label: string): string[] {
    if (typeof value !== "string") {
      throw new Error(`SubagentRunStore: invalid ${label}: expected JSON text`)
    }
    return this.parseForkLineageJson(value, label)
  }

  private parseForkLineageJson(value: string, label: string): string[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      throw new Error(
        `SubagentRunStore: invalid ${label}: ${(error as Error).message}`
      )
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`SubagentRunStore: invalid ${label}: expected array`)
    }
    const lineage = parsed.map((entry, index) =>
      this.requireCanonicalIdentifier(entry, `${label}[${index}]`)
    )
    if (new Set(lineage).size !== lineage.length) {
      throw new Error(
        `SubagentRunStore: invalid ${label}: contains duplicate identities`
      )
    }
    return lineage
  }

  /**
   * Opaque graph and execution identities are already canonical at their
   * producer. A durable read must reject, rather than trim, any corruption.
   */
  private requireCanonicalIdentifier(value: unknown, label: string): string {
    if (typeof value !== "string") {
      throw new Error(`SubagentRunStore: ${label} must be a string`)
    }
    if (
      !value ||
      value.trim() !== value ||
      value.includes("\u0000") ||
      value.length > 1024
    ) {
      throw new Error(
        `SubagentRunStore: ${label} must be a canonical non-empty identifier`
      )
    }
    return value
  }

  /** Preserve non-identifier content exactly while enforcing text semantics. */
  private requireText(value: unknown, label: string): string {
    if (typeof value !== "string") {
      throw new Error(`SubagentRunStore: ${label} must be a string`)
    }
    if (!value.trim() || value.includes("\u0000")) {
      throw new Error(`SubagentRunStore: ${label} must be non-empty text`)
    }
    return value
  }

  private requireBoundedText(
    value: unknown,
    label: string,
    maxLength: number
  ): string {
    if (typeof value !== "string") {
      throw new Error(`SubagentRunStore: ${label} must be a string`)
    }
    if (!value.trim() || value.includes("\u0000") || value.length > maxLength) {
      throw new Error(
        `SubagentRunStore: ${label} must be non-empty and at most ${maxLength} characters`
      )
    }
    return value
  }

  /**
   * File paths are durable opaque facts, not presentation text. Do not trim:
   * leading and trailing whitespace are valid POSIX filename bytes.
   */
  private requireBoundedFilePathText(
    value: unknown,
    label: string,
    maxLength: number
  ): string {
    if (typeof value !== "string") {
      throw new Error(`SubagentRunStore: ${label} must be a string`)
    }
    if (
      value.length === 0 ||
      value.includes("\u0000") ||
      value.length > maxLength
    ) {
      throw new Error(
        `SubagentRunStore: ${label} must be non-empty and at most ${maxLength} characters`
      )
    }
    return value
  }

  private requireNonNegativeSafeInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(
        `SubagentRunStore.markTerminalIfRunning: ${label} must be a non-negative safe integer`
      )
    }
    return value as number
  }

  private assertTimestamp(
    value: unknown,
    operation: string,
    label: string
  ): void {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new Error(
        `SubagentRunStore.${operation}: ${label} must be a positive safe integer`
      )
    }
  }

  private assertTransaction(
    txn: SessionTxn,
    operation: string
  ): asserts txn is SessionTxnInternal {
    const internal = txn as SessionTxnInternal | undefined
    if (
      !internal ||
      internal.tag !== SESSION_TXN_TAG ||
      internal.persistence !== this.persistence
    ) {
      throw new Error(
        `SubagentRunStore.${operation}: requires the active MessageStore transaction`
      )
    }
  }
}
