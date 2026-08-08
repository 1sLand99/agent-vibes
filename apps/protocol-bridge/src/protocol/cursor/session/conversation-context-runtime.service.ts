import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { PersistenceService } from "../../../persistence"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import {
  assertProjectionOwner,
  createMainProjectionOwner,
  type ProjectionOwner,
} from "./projection-owner"
import { ConversationId } from "../turn/turn.types"

export type CursorTurnPhase =
  | "received"
  | "context_preparing"
  | "compacting"
  | "context_rebuilding"
  | "context_ready"
  | "request_streaming"
  | "waiting_for_tools"
  | "continuing_after_tool"
  | "retrying"
  | "finalizing"
  | "completed"
  | "failed"
  | "aborted"

export type CursorTurnOrigin =
  | "chat"
  | "control"
  | "tool_result"
  | "shell_result"
  | "recovery"

export type CursorTurnTransitionReason =
  | "new_chat_turn"
  | "control_continuation"
  | "context_preparation_started"
  | "context_compaction_started"
  | "context_compaction_applied"
  | "context_rebuild_started"
  | "context_prepared"
  | "backend_stream_started"
  | "reactive_context_retry"
  | "provider_physical_retry"
  | "backend_switch"
  | "assistant_tool_batch"
  | "tool_result_continuation"
  | "shell_result_continuation"
  | "empty_stream_retry"
  | "thinking_only_recovery"
  | "transport_stream_recovery"
  | "max_output_tokens_escalate"
  | "max_output_tokens_recovery"
  | "max_output_tokens_exhausted"
  | "partial_stream_finalized"
  | "assistant_final"
  | "async_user_interaction_pending"
  | "friendly_final"
  | "superseded_stream"
  | "stream_aborted"
  | "stream_error"

export type CursorTurnDetailValue = string | number | boolean | null
export type CursorTurnDetails = Record<string, CursorTurnDetailValue>

export interface CursorTurnTransition {
  reason: CursorTurnTransitionReason
  phase: CursorTurnPhase
  at: number
  attempt: number
  backend?: string
  model?: string
  details?: CursorTurnDetails
}

export interface CursorTurnState {
  id: string
  conversationId: string
  ownerKey: string
  topLevelTurnId: string
  origin: CursorTurnOrigin
  phase: CursorTurnPhase
  startedAt: number
  updatedAt: number
  attempt: number
  revision: number
  streamId?: string
  backend?: string
  model?: string
  backendModel?: string
  lastTransition: CursorTurnTransition
  transitions: CursorTurnTransition[]
}

export interface StartCursorTurnInput {
  origin: CursorTurnOrigin
  topLevelTurnId: string
  initialReason?: CursorTurnTransitionReason
  streamId?: string
  backend?: string
  model?: string
  backendModel?: string
  details?: CursorTurnDetails
}

export interface CursorTurnTransitionInput {
  phase: CursorTurnPhase
  reason: CursorTurnTransitionReason
  streamId?: string
  backend?: string
  model?: string
  backendModel?: string
  incrementAttempt?: boolean
  details?: CursorTurnDetails
}

export interface CursorSummaryDelivery {
  deliveryId: string
  conversationId: string
  ownerKey: string
  compactionId: string
  epoch: number
  summary: string
  state: "pending" | "dispatching" | "delivered" | "interrupted"
  createdAt: number
  updatedAt: number
}

const TERMINAL_PHASES = new Set<CursorTurnPhase>([
  "completed",
  "failed",
  "aborted",
])

export function isCursorTurnTerminalPhase(phase: CursorTurnPhase): boolean {
  return TERMINAL_PHASES.has(phase)
}

const TURN_PHASES = new Set<CursorTurnPhase>([
  "received",
  "context_preparing",
  "compacting",
  "context_rebuilding",
  "context_ready",
  "request_streaming",
  "waiting_for_tools",
  "continuing_after_tool",
  "retrying",
  "finalizing",
  "completed",
  "failed",
  "aborted",
])

const TURN_ORIGINS = new Set<CursorTurnOrigin>([
  "chat",
  "control",
  "tool_result",
  "shell_result",
  "recovery",
])

const TURN_REASONS = new Set<CursorTurnTransitionReason>([
  "new_chat_turn",
  "control_continuation",
  "context_preparation_started",
  "context_compaction_started",
  "context_compaction_applied",
  "context_rebuild_started",
  "context_prepared",
  "backend_stream_started",
  "reactive_context_retry",
  "provider_physical_retry",
  "backend_switch",
  "assistant_tool_batch",
  "tool_result_continuation",
  "shell_result_continuation",
  "empty_stream_retry",
  "thinking_only_recovery",
  "transport_stream_recovery",
  "max_output_tokens_escalate",
  "max_output_tokens_recovery",
  "max_output_tokens_exhausted",
  "partial_stream_finalized",
  "assistant_final",
  "async_user_interaction_pending",
  "friendly_final",
  "superseded_stream",
  "stream_aborted",
  "stream_error",
])

interface RuntimeOperationRow {
  operation_id: string
  top_level_turn_id: string
  origin: string
  phase: string
  started_at: number
  updated_at: number
  attempt: number
  revision: number
  stream_id: string | null
  backend: string | null
  model: string | null
  backend_model: string | null
}

interface RuntimeTransitionRow {
  phase: string
  reason: string
  occurred_at: number
  attempt: number
  backend: string | null
  model: string | null
  details_json: string | null
}

interface SummaryDeliveryRow {
  delivery_id: string
  compaction_id: string
  epoch: number
  summary: string
  state: CursorSummaryDelivery["state"]
  created_at: number
  updated_at: number
}

/**
 * Durable owner-scoped control plane for context work.
 *
 * The immutable conversation graph and provider-native histories remain the
 * model-input authorities. This service owns only execution progress and
 * Cursor summary delivery. Neither state is reconstructed from transcript
 * content or compaction history after a restart.
 */
@Injectable()
export class ConversationContextRuntimeService implements OnModuleInit {
  private readonly logger = new Logger(ConversationContextRuntimeService.name)
  private stmtLatestOperation?: StatementSync
  private stmtActiveOperation?: StatementSync
  private stmtOperationById?: StatementSync
  private stmtOperationEvents?: StatementSync
  private stmtInsertOperation?: StatementSync
  private stmtInsertEvent?: StatementSync
  private stmtAdvanceOperation?: StatementSync
  private stmtInterruptDeliveries?: StatementSync
  private stmtInsertDelivery?: StatementSync
  private stmtGetDeliveryByCompaction?: StatementSync
  private stmtNextPendingDelivery?: StatementSync
  private stmtClaimDelivery?: StatementSync
  private stmtGetDeliveryById?: StatementSync
  private stmtSetDeliveryState?: StatementSync

  constructor(private readonly persistence: PersistenceService) {}

  onModuleInit(): void {
    const result = (this.stmtInterruptDeliveries ??= this.persistence.prepare(
      `UPDATE session_context_summary_deliveries
          SET state = 'interrupted',
              updated_at = ?
        WHERE state = 'dispatching'`
    )).run(Date.now())
    const interrupted = result.changes ?? 0
    if (interrupted > 0) {
      this.logger.warn(
        `Marked ${interrupted} interrupted Cursor summary deliveries after process restart`
      )
    }
  }

  startTurn(
    conversationId: string,
    input: StartCursorTurnInput,
    owner: ProjectionOwner = createMainProjectionOwner(
      ConversationId.of(conversationId)
    )
  ): CursorTurnState {
    this.assertOwner(conversationId, owner, "startTurn")
    this.assertOrigin(input.origin)
    const topLevelTurnId = requireExactDurableIdentifier(
      input.topLevelTurnId,
      "Context runtime top-level turn id"
    )
    const now = Date.now()
    const operationId = crypto.randomUUID()
    const initialReason = input.initialReason ?? "new_chat_turn"
    this.assertReason(initialReason)
    const detailsJson = this.serializeDetails(input.details)

    return this.persistence.runInImmediateTransaction(() => {
      const current = this.readActiveOperationRow(owner)
      if (current) {
        const currentTopLevelTurnId = requireExactDurableIdentifier(
          current.top_level_turn_id,
          "Active context runtime top-level turn id"
        )
        if (input.origin === "recovery") {
          if (currentTopLevelTurnId !== topLevelTurnId) {
            throw new Error(
              `Recovery ${topLevelTurnId} cannot attach to active context operation ${current.operation_id}/${currentTopLevelTurnId}`
            )
          }
          return this.hydrateState(owner, current)
        }
        if (input.origin !== "chat") {
          if (currentTopLevelTurnId !== topLevelTurnId) {
            throw new Error(
              `Continuation ${topLevelTurnId} cannot supersede active context operation ${current.operation_id}/${currentTopLevelTurnId}`
            )
          }
          return this.advanceInTransaction(owner, current, {
            phase: "continuing_after_tool",
            reason: initialReason,
            streamId: input.streamId,
            backend: input.backend,
            model: input.model,
            backendModel: input.backendModel,
            details: input.details,
          })
        }
        this.advanceInTransaction(owner, current, {
          phase: "aborted",
          reason: "superseded_stream",
          streamId: input.streamId,
          details: {
            successorOperationId: operationId,
          },
        })
      }

      ;(this.stmtInsertOperation ??= this.persistence.prepare(
        `INSERT INTO session_context_runtime_operations (
           conversation_id, owner_key, operation_id, operation_kind,
           top_level_turn_id, origin, phase, started_at, updated_at, attempt,
           revision, stream_id,
           backend, model, backend_model, terminal_at
         ) VALUES (?, ?, ?, 'turn', ?, ?, 'received', ?, ?, 0, 1, ?, ?, ?, ?, NULL)`
      )).run(
        conversationId,
        owner.ownerKey,
        operationId,
        topLevelTurnId,
        input.origin,
        now,
        now,
        input.streamId ?? null,
        input.backend ?? null,
        input.model ?? null,
        input.backendModel ?? null
      )
      this.insertEvent(
        owner,
        operationId,
        1,
        {
          phase: "received",
          reason: initialReason,
          at: now,
          attempt: 0,
          backend: input.backend,
          model: input.model,
          details: input.details,
        },
        detailsJson
      )
      return this.requireOperation(owner, operationId)
    })
  }

  transitionTurn(
    conversationId: string,
    operationId: string,
    input: CursorTurnTransitionInput,
    owner: ProjectionOwner = createMainProjectionOwner(
      ConversationId.of(conversationId)
    )
  ): CursorTurnState | undefined {
    this.assertOwner(conversationId, owner, "transitionTurn")
    const exactOperationId = requireExactDurableIdentifier(
      operationId,
      "Context runtime transition operation id"
    )
    this.assertPhase(input.phase)
    this.assertReason(input.reason)
    return this.persistence.runInImmediateTransaction(() => {
      const current = this.readOperationRow(owner, exactOperationId)
      if (!current) return undefined
      return this.advanceInTransaction(owner, current, input)
    })
  }

  getCurrentTurn(
    conversationId: string,
    owner: ProjectionOwner = createMainProjectionOwner(
      ConversationId.of(conversationId)
    )
  ): CursorTurnState | undefined {
    this.assertOwner(conversationId, owner, "getCurrentTurn")
    const row =
      this.readActiveOperationRow(owner) ?? this.readLatestOperationRow(owner)
    return row ? this.hydrateState(owner, row) : undefined
  }

  getActiveTurnForTopLevel(
    conversationId: string,
    topLevelTurnId: string,
    owner: ProjectionOwner = createMainProjectionOwner(
      ConversationId.of(conversationId)
    )
  ): CursorTurnState | undefined {
    this.assertOwner(conversationId, owner, "getActiveTurnForTopLevel")
    const exactTopLevelTurnId = requireExactDurableIdentifier(
      topLevelTurnId,
      "Context runtime active top-level turn id"
    )
    const row = this.readActiveOperationRow(owner)
    if (!row) return undefined
    return row.top_level_turn_id === exactTopLevelTurnId
      ? this.hydrateState(owner, row)
      : undefined
  }

  transitionToAsyncUserWait(
    conversationId: string,
    operationId: string,
    input: {
      streamId?: string
      pendingInteractionCount: number
    },
    owner: ProjectionOwner = createMainProjectionOwner(
      ConversationId.of(conversationId)
    )
  ): CursorTurnState {
    this.assertOwner(conversationId, owner, "transitionToAsyncUserWait")
    if (
      !Number.isSafeInteger(input.pendingInteractionCount) ||
      input.pendingInteractionCount < 1
    ) {
      throw new Error(
        "Async user wait requires a positive pending interaction count"
      )
    }
    const transitioned = this.transitionTurn(
      conversationId,
      operationId,
      {
        phase: "waiting_for_tools",
        reason: "async_user_interaction_pending",
        streamId: input.streamId,
        details: {
          pendingInteractionCount: input.pendingInteractionCount,
        },
      },
      owner
    )
    if (!transitioned) {
      throw new Error(
        `Cannot suspend missing context runtime operation ${operationId}`
      )
    }
    return transitioned
  }

  getRecentTurns(
    conversationId: string,
    limit = 16,
    owner: ProjectionOwner = createMainProjectionOwner(
      ConversationId.of(conversationId)
    )
  ): CursorTurnState[] {
    this.assertOwner(conversationId, owner, "getRecentTurns")
    const normalizedLimit = Math.max(1, Math.min(64, Math.floor(limit)))
    const rows = this.persistence
      .prepare(
        `SELECT operation_id, top_level_turn_id, origin, phase, started_at,
                updated_at, attempt, revision, stream_id, backend, model,
                backend_model
           FROM session_context_runtime_operations
          WHERE conversation_id = ? AND owner_key = ?
          ORDER BY started_at DESC, operation_id DESC
          LIMIT ?`
      )
      .all(
        conversationId,
        owner.ownerKey,
        normalizedLimit
      ) as unknown as RuntimeOperationRow[]
    return rows.map((row) => this.hydrateState(owner, row)).reverse()
  }

  enqueueSummary(input: {
    conversationId: string
    compactionId: string
    epoch: number
    summary: string
    owner?: ProjectionOwner
  }): CursorSummaryDelivery {
    const owner =
      input.owner ??
      createMainProjectionOwner(ConversationId.of(input.conversationId))
    this.assertOwner(input.conversationId, owner, "enqueueSummary")
    const compactionId = requireExactDurableIdentifier(
      input.compactionId,
      "Cursor summary compaction id"
    )
    const summary = input.summary.trim()
    if (!summary) {
      throw new Error("Cursor summary delivery requires non-empty summary")
    }
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) {
      throw new Error("Cursor summary delivery epoch must be non-negative")
    }
    const now = Date.now()
    const deliveryId = crypto.randomUUID()

    return this.persistence.runInImmediateTransaction(() => {
      const existing = this.readDeliveryByCompaction(
        owner,
        compactionId,
        input.epoch
      )
      if (existing) {
        if (existing.summary !== summary) {
          throw new Error(
            `Cursor summary ${compactionId}/${input.epoch} was retried with different content`
          )
        }
        return this.hydrateDelivery(owner, existing)
      }
      ;(this.stmtInsertDelivery ??= this.persistence.prepare(
        `INSERT INTO session_context_summary_deliveries (
           conversation_id, owner_key, delivery_id, compaction_id, epoch,
           summary, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )).run(
        input.conversationId,
        owner.ownerKey,
        deliveryId,
        compactionId,
        input.epoch,
        summary,
        now,
        now
      )
      return this.requireDeliveryById(owner, deliveryId)
    })
  }

  /**
   * Claim is the no-replay boundary. A process crash after this CAS leaves the
   * delivery interrupted on the next start; it is never inferred as pending
   * from compaction history and therefore cannot emit a duplicate report.
   */
  claimNextSummary(
    conversationId: string,
    owner: ProjectionOwner = createMainProjectionOwner(
      ConversationId.of(conversationId)
    )
  ): CursorSummaryDelivery | undefined {
    this.assertOwner(conversationId, owner, "claimNextSummary")
    return this.persistence.runInImmediateTransaction(() => {
      const row = (this.stmtNextPendingDelivery ??= this.persistence.prepare(
        `SELECT delivery_id, compaction_id, epoch, summary, state,
                created_at, updated_at
           FROM session_context_summary_deliveries
          WHERE conversation_id = ?
            AND owner_key = ?
            AND state = 'pending'
          ORDER BY created_at ASC, delivery_id ASC
          LIMIT 1`
      )).get(conversationId, owner.ownerKey) as SummaryDeliveryRow | undefined
      if (!row) return undefined
      const now = Date.now()
      const result = (this.stmtClaimDelivery ??= this.persistence.prepare(
        `UPDATE session_context_summary_deliveries
            SET state = 'dispatching', updated_at = ?
          WHERE conversation_id = ?
            AND owner_key = ?
            AND delivery_id = ?
            AND state = 'pending'`
      )).run(now, conversationId, owner.ownerKey, row.delivery_id)
      if ((result.changes ?? 0) !== 1) {
        throw new Error(
          `Cursor summary delivery claim lost its CAS: ${row.delivery_id}`
        )
      }
      return this.requireDeliveryById(owner, row.delivery_id)
    })
  }

  completeSummary(delivery: CursorSummaryDelivery): CursorSummaryDelivery {
    return this.setSummaryState(delivery, "delivered")
  }

  interruptSummary(delivery: CursorSummaryDelivery): CursorSummaryDelivery {
    return this.setSummaryState(delivery, "interrupted")
  }

  private advanceInTransaction(
    owner: ProjectionOwner,
    current: RuntimeOperationRow,
    input: CursorTurnTransitionInput
  ): CursorTurnState {
    const currentPhase = this.requirePhase(current.phase)
    if (TERMINAL_PHASES.has(currentPhase)) {
      if (
        currentPhase === input.phase &&
        this.hydrateState(owner, current).lastTransition.reason === input.reason
      ) {
        return this.hydrateState(owner, current)
      }
      throw new Error(
        `Context runtime operation ${current.operation_id} is terminal (${currentPhase})`
      )
    }

    const now = Date.now()
    const nextAttempt = input.incrementAttempt
      ? current.attempt + 1
      : current.attempt
    const nextRevision = current.revision + 1
    const result = (this.stmtAdvanceOperation ??= this.persistence.prepare(
      `UPDATE session_context_runtime_operations
          SET phase = ?,
              updated_at = ?,
              attempt = ?,
              revision = ?,
              stream_id = ?,
              backend = ?,
              model = ?,
              backend_model = ?,
              terminal_at = ?
        WHERE conversation_id = ?
          AND owner_key = ?
          AND operation_id = ?
          AND revision = ?`
    )).run(
      input.phase,
      now,
      nextAttempt,
      nextRevision,
      input.streamId ?? current.stream_id,
      input.backend ?? current.backend,
      input.model ?? current.model,
      input.backendModel ?? current.backend_model,
      TERMINAL_PHASES.has(input.phase) ? now : null,
      owner.conversationId,
      owner.ownerKey,
      current.operation_id,
      current.revision
    )
    if ((result.changes ?? 0) !== 1) {
      throw new Error(
        `Context runtime operation ${current.operation_id} lost revision ${current.revision}`
      )
    }
    this.insertEvent(owner, current.operation_id, nextRevision, {
      phase: input.phase,
      reason: input.reason,
      at: now,
      attempt: nextAttempt,
      backend: input.backend ?? current.backend ?? undefined,
      model: input.model ?? current.model ?? undefined,
      details: input.details,
    })
    return this.requireOperation(owner, current.operation_id)
  }

  private insertEvent(
    owner: ProjectionOwner,
    operationId: string,
    seq: number,
    transition: CursorTurnTransition,
    serializedDetails = this.serializeDetails(transition.details)
  ): void {
    ;(this.stmtInsertEvent ??= this.persistence.prepare(
      `INSERT INTO session_context_runtime_events (
         conversation_id, owner_key, operation_id, seq, phase, reason,
         occurred_at, attempt, backend, model, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )).run(
      owner.conversationId,
      owner.ownerKey,
      operationId,
      seq,
      transition.phase,
      transition.reason,
      transition.at,
      transition.attempt,
      transition.backend ?? null,
      transition.model ?? null,
      serializedDetails
    )
  }

  private readLatestOperationRow(
    owner: ProjectionOwner
  ): RuntimeOperationRow | undefined {
    return (this.stmtLatestOperation ??= this.persistence.prepare(
      `SELECT operation_id, top_level_turn_id, origin, phase, started_at,
              updated_at, attempt, revision, stream_id, backend, model,
              backend_model
        FROM session_context_runtime_operations
        WHERE conversation_id = ? AND owner_key = ?
        ORDER BY started_at DESC, rowid DESC
        LIMIT 1`
    )).get(owner.conversationId, owner.ownerKey) as
      | RuntimeOperationRow
      | undefined
  }

  private readActiveOperationRow(
    owner: ProjectionOwner
  ): RuntimeOperationRow | undefined {
    return (this.stmtActiveOperation ??= this.persistence.prepare(
      `SELECT operation_id, top_level_turn_id, origin, phase, started_at,
              updated_at, attempt, revision, stream_id, backend, model,
              backend_model
         FROM session_context_runtime_operations
        WHERE conversation_id = ?
          AND owner_key = ?
          AND terminal_at IS NULL
        LIMIT 1`
    )).get(owner.conversationId, owner.ownerKey) as
      | RuntimeOperationRow
      | undefined
  }

  private readOperationRow(
    owner: ProjectionOwner,
    operationId: string
  ): RuntimeOperationRow | undefined {
    return (this.stmtOperationById ??= this.persistence.prepare(
      `SELECT operation_id, top_level_turn_id, origin, phase, started_at,
              updated_at, attempt, revision, stream_id, backend, model,
              backend_model
         FROM session_context_runtime_operations
        WHERE conversation_id = ?
          AND owner_key = ?
          AND operation_id = ?
        LIMIT 1`
    )).get(owner.conversationId, owner.ownerKey, operationId) as
      | RuntimeOperationRow
      | undefined
  }

  private hydrateState(
    owner: ProjectionOwner,
    row: RuntimeOperationRow
  ): CursorTurnState {
    const phase = this.requirePhase(row.phase)
    const origin = this.requireOrigin(row.origin)
    const events = (this.stmtOperationEvents ??= this.persistence.prepare(
      `SELECT phase, reason, occurred_at, attempt, backend, model, details_json
         FROM session_context_runtime_events
        WHERE conversation_id = ?
          AND owner_key = ?
          AND operation_id = ?
        ORDER BY seq ASC`
    )).all(
      owner.conversationId,
      owner.ownerKey,
      row.operation_id
    ) as unknown as RuntimeTransitionRow[]
    if (events.length === 0) {
      throw new Error(
        `Context runtime operation ${row.operation_id} has no transition events`
      )
    }
    const transitions = events.map((event) => ({
      phase: this.requirePhase(event.phase),
      reason: this.requireReason(event.reason),
      at: this.requirePositiveInteger(event.occurred_at, "event occurred_at"),
      attempt: this.requireNonNegativeInteger(event.attempt, "event attempt"),
      backend: event.backend ?? undefined,
      model: event.model ?? undefined,
      details: this.parseDetails(event.details_json),
    }))
    return {
      id: requireExactDurableIdentifier(
        row.operation_id,
        "Context runtime operation id"
      ),
      conversationId: String(owner.conversationId),
      ownerKey: owner.ownerKey,
      topLevelTurnId: requireExactDurableIdentifier(
        row.top_level_turn_id,
        "Context runtime top-level turn id"
      ),
      origin,
      phase,
      startedAt: this.requirePositiveInteger(row.started_at, "started_at"),
      updatedAt: this.requirePositiveInteger(row.updated_at, "updated_at"),
      attempt: this.requireNonNegativeInteger(row.attempt, "attempt"),
      revision: this.requirePositiveInteger(row.revision, "revision"),
      streamId: row.stream_id ?? undefined,
      backend: row.backend ?? undefined,
      model: row.model ?? undefined,
      backendModel: row.backend_model ?? undefined,
      lastTransition: transitions.at(-1)!,
      transitions,
    }
  }

  private requireOperation(
    owner: ProjectionOwner,
    operationId: string
  ): CursorTurnState {
    const row = this.readOperationRow(owner, operationId)
    if (!row) {
      throw new Error(
        `Context runtime did not persist operation ${operationId} for ${owner.conversationId}/${owner.ownerKey}`
      )
    }
    return this.hydrateState(owner, row)
  }

  private readDeliveryByCompaction(
    owner: ProjectionOwner,
    compactionId: string,
    epoch: number
  ): SummaryDeliveryRow | undefined {
    return (this.stmtGetDeliveryByCompaction ??= this.persistence.prepare(
      `SELECT delivery_id, compaction_id, epoch, summary, state,
              created_at, updated_at
         FROM session_context_summary_deliveries
        WHERE conversation_id = ?
          AND owner_key = ?
          AND compaction_id = ?
          AND epoch = ?
        LIMIT 1`
    )).get(owner.conversationId, owner.ownerKey, compactionId, epoch) as
      | SummaryDeliveryRow
      | undefined
  }

  private requireDeliveryById(
    owner: ProjectionOwner,
    deliveryId: string
  ): CursorSummaryDelivery {
    const row = (this.stmtGetDeliveryById ??= this.persistence.prepare(
      `SELECT delivery_id, compaction_id, epoch, summary, state,
              created_at, updated_at
         FROM session_context_summary_deliveries
        WHERE conversation_id = ?
          AND owner_key = ?
          AND delivery_id = ?
        LIMIT 1`
    )).get(owner.conversationId, owner.ownerKey, deliveryId) as
      | SummaryDeliveryRow
      | undefined
    if (!row) {
      throw new Error(`Cursor summary delivery is missing: ${deliveryId}`)
    }
    return this.hydrateDelivery(owner, row)
  }

  private hydrateDelivery(
    owner: ProjectionOwner,
    row: SummaryDeliveryRow
  ): CursorSummaryDelivery {
    return {
      deliveryId: requireExactDurableIdentifier(
        row.delivery_id,
        "Cursor summary delivery id"
      ),
      conversationId: String(owner.conversationId),
      ownerKey: owner.ownerKey,
      compactionId: requireExactDurableIdentifier(
        row.compaction_id,
        "Cursor summary delivery compaction id"
      ),
      epoch: this.requireNonNegativeInteger(row.epoch, "summary epoch"),
      summary: row.summary,
      state: row.state,
      createdAt: this.requirePositiveInteger(
        row.created_at,
        "summary created_at"
      ),
      updatedAt: this.requirePositiveInteger(
        row.updated_at,
        "summary updated_at"
      ),
    }
  }

  private setSummaryState(
    delivery: CursorSummaryDelivery,
    state: "delivered" | "interrupted"
  ): CursorSummaryDelivery {
    if (delivery.state !== "dispatching") {
      throw new Error(
        `Cursor summary ${delivery.deliveryId} must be dispatching before ${state}`
      )
    }
    const owner = createMainProjectionOwner(
      ConversationId.of(delivery.conversationId)
    )
    if (delivery.ownerKey !== owner.ownerKey) {
      throw new Error(
        `Cursor summary ${delivery.deliveryId} has unsupported owner ${delivery.ownerKey}`
      )
    }
    const result = (this.stmtSetDeliveryState ??= this.persistence.prepare(
      `UPDATE session_context_summary_deliveries
          SET state = ?, updated_at = ?
        WHERE conversation_id = ?
          AND owner_key = ?
          AND delivery_id = ?
          AND state = 'dispatching'`
    )).run(
      state,
      Date.now(),
      delivery.conversationId,
      delivery.ownerKey,
      delivery.deliveryId
    )
    if ((result.changes ?? 0) !== 1) {
      throw new Error(
        `Cursor summary ${delivery.deliveryId} lost its dispatch CAS`
      )
    }
    return this.requireDeliveryById(owner, delivery.deliveryId)
  }

  private assertOwner(
    conversationId: string,
    owner: ProjectionOwner,
    operation: string
  ): void {
    assertProjectionOwner(owner, `ConversationContextRuntime.${operation}`)
    if (String(owner.conversationId) !== conversationId) {
      throw new Error(
        `ConversationContextRuntime.${operation}: conversation owner mismatch`
      )
    }
  }

  private assertOrigin(value: CursorTurnOrigin): void {
    if (!TURN_ORIGINS.has(value)) {
      throw new Error(`Invalid context runtime origin: ${String(value)}`)
    }
  }

  private requireOrigin(value: string): CursorTurnOrigin {
    const origin = value as CursorTurnOrigin
    this.assertOrigin(origin)
    return origin
  }

  private assertPhase(value: CursorTurnPhase): void {
    if (!TURN_PHASES.has(value)) {
      throw new Error(`Invalid context runtime phase: ${String(value)}`)
    }
  }

  private requirePhase(value: string): CursorTurnPhase {
    const phase = value as CursorTurnPhase
    this.assertPhase(phase)
    return phase
  }

  private assertReason(value: CursorTurnTransitionReason): void {
    if (!TURN_REASONS.has(value)) {
      throw new Error(`Invalid context runtime reason: ${String(value)}`)
    }
  }

  private requireReason(value: string): CursorTurnTransitionReason {
    const reason = value as CursorTurnTransitionReason
    this.assertReason(reason)
    return reason
  }

  private serializeDetails(
    details: CursorTurnDetails | undefined
  ): string | null {
    return details ? JSON.stringify(details) : null
  }

  private parseDetails(value: string | null): CursorTurnDetails | undefined {
    if (value === null) return undefined
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Context runtime transition details must be an object")
    }
    for (const [key, entry] of Object.entries(parsed)) {
      if (
        entry !== null &&
        typeof entry !== "string" &&
        typeof entry !== "number" &&
        typeof entry !== "boolean"
      ) {
        throw new Error(
          `Context runtime transition detail ${key} has an invalid value`
        )
      }
    }
    return parsed as CursorTurnDetails
  }

  private requirePositiveInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new Error(`Context runtime ${label} must be positive`)
    }
    return value as number
  }

  private requireNonNegativeInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`Context runtime ${label} must be non-negative`)
    }
    return value as number
  }
}

export function summarizeCursorTurnState(state: CursorTurnState): string {
  const parts = [
    `turn=${state.id}`,
    `conversation=${state.conversationId}`,
    `owner=${state.ownerKey}`,
    `topLevelTurn=${state.topLevelTurnId}`,
    `phase=${state.phase}`,
    `reason=${state.lastTransition.reason}`,
    `attempt=${state.attempt}`,
    `revision=${state.revision}`,
  ]
  if (state.backend) parts.push(`backend=${state.backend}`)
  if (state.backendModel) parts.push(`backendModel=${state.backendModel}`)
  if (state.model) parts.push(`model=${state.model}`)
  if (state.streamId) parts.push(`stream=${state.streamId}`)
  return parts.join(" ")
}
