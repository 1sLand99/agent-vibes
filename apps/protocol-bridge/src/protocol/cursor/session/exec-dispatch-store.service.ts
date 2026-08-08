import { Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import {
  requireExactDurableIdentifier,
  requireOptionalExactDurableIdentifier,
} from "../../../context/durable-identifier"
import { PersistenceService } from "../../../persistence"
import {
  SESSION_TXN_TAG,
  type SessionTxn,
  type SessionTxnInternal,
} from "./tool-call-ledger.service"
import {
  ConversationId,
  TurnId,
  type ConversationId as ConversationIdType,
  type TurnId as TurnIdType,
} from "../turn/turn.types"

/**
 * Durable lifecycle of one exact Cursor ExecServerMessage envelope.
 *
 * `queued` is an outbox-only record. `dispatching` means the caller has
 * claimed the row immediately before attempting an outbound write.
 * `dispatched` means that write completed successfully.
 * `awaiting_interrupted_resolution` means the original client attachment was
 * lost after delivery. Cursor's official interrupted-pending resolution is
 * then the sole terminal authority; the execution is neither replayed nor
 * addressed by an unsupported server control message.
 */
export type ExecDispatchState =
  | "queued"
  | "dispatching"
  | "dispatched"
  | "awaiting_interrupted_resolution"
  | "reattached"
  | "settled"
  | "cancelled"

export type ActiveExecDispatchState =
  | "queued"
  | "dispatching"
  | "dispatched"
  | "awaiting_interrupted_resolution"

export interface ExecDispatchRecord {
  conversationId: ConversationIdType
  streamEpoch: string
  execId: number
  protocolExecId: string
  turnId?: TurnIdType
  toolCallId?: string
  callId?: string
  modelCallId?: string
  dispatchKind: string
  /** Exact bytes of the original ExecServerMessage envelope. */
  frame: Buffer
  /** Human-readable tracing label; replay preserves it verbatim. */
  label: string
  state: ExecDispatchState
  queuedAt: number
  dispatchingAt?: number
  dispatchedAt?: number
  reattachedAt?: number
  settledAt?: number
  terminalReason?: string
}

export interface QueueExecDispatchInput {
  conversationId: ConversationIdType
  streamEpoch: string
  execId: number
  protocolExecId: string
  turnId?: TurnIdType
  toolCallId?: string
  callId?: string
  modelCallId?: string
  dispatchKind: string
  frame: Buffer
  label: string
  queuedAt?: number
}

interface DispatchRow {
  protocol_exec_id: string
  turn_id: string | null
  tool_call_id: string | null
  call_id: string | null
  model_call_id: string | null
  dispatch_kind: string
  frame_payload: Uint8Array
  label: string
  state: ExecDispatchState
  queued_at: number
  dispatching_at: number | null
  dispatched_at: number | null
  reattached_at: number | null
  settled_at: number | null
  terminal_reason: string | null
}

interface DurableExecIdentityRow {
  stream_epoch: string
  exec_id: number
  protocol_exec_id: string
}

const DISPATCH_COLUMNS = `
  protocol_exec_id, turn_id, tool_call_id, call_id, model_call_id,
  dispatch_kind, frame_payload, label, state, queued_at, dispatching_at,
  dispatched_at, reattached_at, settled_at, terminal_reason
`

const ACTIVE_DISPATCH_STATES = `
  'queued', 'dispatching', 'dispatched', 'awaiting_interrupted_resolution'
`

/**
 * Durable outbox for Cursor client-executed tools.
 *
 * Callers must make the physical write boundary explicit:
 *
 *   enqueue -> beginDelivery -> outbound.write succeeds -> markDelivered
 *
 * A delivered envelope whose attachment is lost is parked on the original
 * row until Cursor supplies its official interrupted-pending resolution.
 */
@Injectable()
export class ExecDispatchStore {
  private stmtInsertQueued?: StatementSync
  private stmtBeginDelivery?: StatementSync
  private stmtMarkDelivered?: StatementSync
  private stmtRequeueAfterWriteFailure?: StatementSync
  private stmtAwaitInterruptedResolution?: StatementSync
  private stmtSettleByClientResult?: StatementSync
  private stmtCancelExactInTransaction?: StatementSync
  private stmtCancelBySourceIdentity?: StatementSync
  private stmtFindDirectByClientResult?: StatementSync
  private stmtFindDirectByControlId?: StatementSync
  private stmtFindActiveByToolCall?: StatementSync
  private stmtListQueuedForReplay?: StatementSync
  private stmtListActiveForReattach?: StatementSync
  private stmtMarkReattached?: StatementSync
  private stmtCancelOpenByExecId?: StatementSync
  private stmtNextExecIdAfterHistory?: StatementSync

  constructor(private readonly persistence: PersistenceService) {}

  /**
   * Allocate the first process-local exec id after every durable envelope
   * used by this conversation. Parked envelopes retain their original slot,
   * so restart cannot reuse it before the official terminal arrives.
   */
  nextExecIdAfterHistory(conversationId: ConversationId): number {
    this.assertConversationId(conversationId, "nextExecIdAfterHistory")
    const rows = (this.stmtNextExecIdAfterHistory ??= this.persistence.prepare(
      `SELECT stream_epoch, exec_id, protocol_exec_id
         FROM session_exec_dispatches
        WHERE conversation_id = ?`
    )).all(conversationId) as unknown as DurableExecIdentityRow[]

    let maxExecId = 0
    for (const row of rows) {
      this.assertClientResultIdentity(
        conversationId,
        {
          streamEpoch: row.stream_epoch,
          execId: row.exec_id,
          protocolExecId: row.protocol_exec_id,
        },
        "nextExecIdAfterHistory durable row"
      )
      maxExecId = Math.max(maxExecId, row.exec_id)
    }
    const nextExecId = maxExecId + 1
    if (!Number.isSafeInteger(nextExecId) || nextExecId < 1) {
      throw new Error(
        `ExecDispatchStore.nextExecIdAfterHistory: exec id space exhausted ` +
          `conversation=${conversationId}`
      )
    }
    return nextExecId
  }

  /** Persist the immutable frame before it is eligible for transport. */
  enqueue(input: QueueExecDispatchInput): ExecDispatchRecord {
    const record = this.createQueuedRecord(input)
    this.insertQueuedRecord(record)
    return record
  }

  /**
   * Persist a new envelope inside the same MessageStore transaction that
   * settles its predecessor (for example edit read->write handoff).
   */
  enqueueInTransaction(
    txn: SessionTxn,
    input: QueueExecDispatchInput
  ): ExecDispatchRecord {
    this.assertTransaction(txn, "enqueueInTransaction")
    if (txn.conversationId !== input.conversationId) {
      throw new Error(
        `ExecDispatchStore.enqueueInTransaction: conversation mismatch ` +
          `txn=${txn.conversationId} input=${input.conversationId}`
      )
    }
    const record = this.createQueuedRecord(input)
    this.insertQueuedRecord(record)
    return record
  }

  private insertQueuedRecord(record: ExecDispatchRecord): void {
    const stmt = (this.stmtInsertQueued ??= this.persistence.prepare(
      `INSERT INTO session_exec_dispatches (
         conversation_id, stream_epoch, exec_id, protocol_exec_id, turn_id, tool_call_id,
         call_id, model_call_id, dispatch_kind, frame_payload, label, state,
         queued_at, dispatching_at, dispatched_at, reattached_at, settled_at,
         terminal_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL, NULL, NULL)`
    ))
    stmt.run(
      record.conversationId,
      record.streamEpoch,
      record.execId,
      record.protocolExecId,
      record.turnId ?? null,
      record.toolCallId ?? null,
      record.callId ?? null,
      record.modelCallId ?? null,
      record.dispatchKind,
      record.frame,
      record.label,
      record.queuedAt
    )
  }

  /** Claim a queued envelope immediately before its outbound write. */
  beginDelivery(
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number,
    protocolExecId: string,
    dispatchingAt: number = Date.now()
  ): ExecDispatchRecord {
    this.assertClientResultIdentity(
      conversationId,
      { streamEpoch, execId, protocolExecId },
      "beginDelivery"
    )
    this.assertTimestamp(dispatchingAt, "beginDelivery", "dispatchingAt")
    const result = (this.stmtBeginDelivery ??= this.persistence.prepare(
      `UPDATE session_exec_dispatches
          SET state = 'dispatching', dispatching_at = ?
        WHERE conversation_id = ?
          AND stream_epoch = ?
          AND exec_id = ?
          AND protocol_exec_id = ?
          AND state = 'queued'`
    )).run(
      dispatchingAt,
      conversationId,
      streamEpoch,
      execId,
      protocolExecId
    ) as { changes?: number }
    this.requireSingleTransition(
      result,
      "beginDelivery",
      conversationId,
      streamEpoch,
      execId,
      protocolExecId,
      "queued"
    )
    return this.requireDirectByClientResult(
      conversationId,
      streamEpoch,
      execId,
      protocolExecId,
      "beginDelivery"
    )
  }

  /** Mark a claimed envelope as successfully written to its owning BiDi. */
  markDelivered(
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number,
    protocolExecId: string,
    dispatchedAt: number = Date.now()
  ): ExecDispatchRecord {
    this.assertClientResultIdentity(
      conversationId,
      { streamEpoch, execId, protocolExecId },
      "markDelivered"
    )
    this.assertTimestamp(dispatchedAt, "markDelivered", "dispatchedAt")
    const result = (this.stmtMarkDelivered ??= this.persistence.prepare(
      `UPDATE session_exec_dispatches
          SET state = 'dispatched', dispatched_at = ?
        WHERE conversation_id = ?
          AND stream_epoch = ?
          AND exec_id = ?
          AND protocol_exec_id = ?
          AND state = 'dispatching'`
    )).run(
      dispatchedAt,
      conversationId,
      streamEpoch,
      execId,
      protocolExecId
    ) as { changes?: number }
    this.requireSingleTransition(
      result,
      "markDelivered",
      conversationId,
      streamEpoch,
      execId,
      protocolExecId,
      "dispatching"
    )
    return this.requireDirectByClientResult(
      conversationId,
      streamEpoch,
      execId,
      protocolExecId,
      "markDelivered"
    )
  }

  /**
   * Return a claimed envelope to the outbox only when the caller knows its
   * outbound write was not accepted. It is never an implicit retry path.
   */
  requeueAfterWriteFailure(
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number,
    protocolExecId: string,
    queuedAt: number = Date.now()
  ): ExecDispatchRecord {
    this.assertClientResultIdentity(
      conversationId,
      { streamEpoch, execId, protocolExecId },
      "requeueAfterWriteFailure"
    )
    this.assertTimestamp(queuedAt, "requeueAfterWriteFailure", "queuedAt")
    const result = (this.stmtRequeueAfterWriteFailure ??=
      this.persistence.prepare(
        `UPDATE session_exec_dispatches
            SET state = 'queued', queued_at = ?, dispatching_at = NULL
          WHERE conversation_id = ?
            AND stream_epoch = ?
            AND exec_id = ?
            AND protocol_exec_id = ?
            AND state = 'dispatching'`
      )).run(queuedAt, conversationId, streamEpoch, execId, protocolExecId) as {
      changes?: number
    }
    this.requireSingleTransition(
      result,
      "requeueAfterWriteFailure",
      conversationId,
      streamEpoch,
      execId,
      protocolExecId,
      "dispatching"
    )
    return this.requireDirectByClientResult(
      conversationId,
      streamEpoch,
      execId,
      protocolExecId,
      "requeueAfterWriteFailure"
    )
  }

  /**
   * Park one delivered or delivery-uncertain envelope after its original
   * attachment was lost. Cursor interrupted-pending resolutions are the only
   * accepted terminal for this state; the envelope is never replayed.
   */
  awaitInterruptedResolutionInTransaction(
    txn: SessionTxn,
    dispatch: Pick<
      ExecDispatchRecord,
      "conversationId" | "streamEpoch" | "execId" | "protocolExecId"
    >,
    parkedAt: number = Date.now()
  ): ExecDispatchRecord {
    this.assertTransaction(txn, "awaitInterruptedResolutionInTransaction")
    if (dispatch.conversationId !== txn.conversationId) {
      throw new Error(
        `ExecDispatchStore.awaitInterruptedResolutionInTransaction: conversation mismatch ` +
          `txn=${txn.conversationId} dispatch=${dispatch.conversationId}`
      )
    }
    this.assertClientResultIdentity(
      dispatch.conversationId,
      dispatch,
      "awaitInterruptedResolutionInTransaction"
    )
    this.assertTimestamp(
      parkedAt,
      "awaitInterruptedResolutionInTransaction",
      "parkedAt"
    )
    const result = (this.stmtAwaitInterruptedResolution ??=
      this.persistence.prepare(
        `UPDATE session_exec_dispatches
            SET state = 'awaiting_interrupted_resolution'
          WHERE conversation_id = ?
            AND stream_epoch = ?
            AND exec_id = ?
            AND protocol_exec_id = ?
            AND state IN ('dispatching', 'dispatched', 'awaiting_interrupted_resolution')`
      )).run(
      txn.conversationId,
      dispatch.streamEpoch,
      dispatch.execId,
      dispatch.protocolExecId
    ) as { changes?: number }
    this.requireSingleTransition(
      result,
      "awaitInterruptedResolutionInTransaction",
      txn.conversationId,
      dispatch.streamEpoch,
      dispatch.execId,
      dispatch.protocolExecId,
      "dispatching, dispatched or awaiting_interrupted_resolution"
    )
    return this.requireDirectByClientResult(
      txn.conversationId,
      dispatch.streamEpoch,
      dispatch.execId,
      dispatch.protocolExecId,
      "awaitInterruptedResolutionInTransaction"
    )
  }

  /**
   * Accept a terminal ExecClientMessage only for an exact in-flight identity.
   * `dispatching` is accepted because a result proves the outbound write
   * completed even if the process died before `markDelivered`.
   */
  acceptClientResult(
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number,
    protocolExecId: string,
    terminalReason?: string,
    settledAt: number = Date.now()
  ): ExecDispatchRecord {
    return this.acceptClientResultUnchecked(
      conversationId,
      streamEpoch,
      execId,
      protocolExecId,
      terminalReason,
      settledAt,
      "acceptClientResult"
    )
  }

  /** Same terminal transition, joined to the MessageStore graph transaction. */
  acceptClientResultInTransaction(
    txn: SessionTxn,
    streamEpoch: string,
    execId: number,
    protocolExecId: string,
    terminalReason?: string,
    settledAt: number = Date.now()
  ): ExecDispatchRecord {
    this.assertTransaction(txn, "acceptClientResultInTransaction")
    return this.acceptClientResultUnchecked(
      txn.conversationId,
      streamEpoch,
      execId,
      protocolExecId,
      terminalReason,
      settledAt,
      "acceptClientResultInTransaction"
    )
  }

  /**
   * Commit an explicit local abort. Unlike a real client result it may retire
   * a queued envelope, but it never manufactures a graph tool_result by
   * itself; the graph owner decides whether an abort result is legitimate.
   */
  cancelExactInTransaction(
    txn: SessionTxn,
    streamEpoch: string,
    execId: number,
    protocolExecId: string,
    terminalReason: string,
    cancelledAt: number = Date.now()
  ): ExecDispatchRecord {
    this.assertTransaction(txn, "cancelExactInTransaction")
    this.assertClientResultIdentity(
      txn.conversationId,
      { streamEpoch, execId, protocolExecId },
      "cancelExactInTransaction"
    )
    this.assertNonEmpty(
      terminalReason,
      "cancelExactInTransaction",
      "terminalReason"
    )
    this.assertTimestamp(cancelledAt, "cancelExactInTransaction", "cancelledAt")
    const result = (this.stmtCancelExactInTransaction ??=
      this.persistence.prepare(
        `UPDATE session_exec_dispatches
            SET state = 'cancelled', settled_at = ?, terminal_reason = ?
          WHERE conversation_id = ?
            AND stream_epoch = ?
            AND exec_id = ?
            AND protocol_exec_id = ?
            AND state IN (${ACTIVE_DISPATCH_STATES})`
      )).run(
      cancelledAt,
      terminalReason,
      txn.conversationId,
      streamEpoch,
      execId,
      protocolExecId
    ) as { changes?: number }
    this.requireSingleTransition(
      result,
      "cancelExactInTransaction",
      txn.conversationId,
      streamEpoch,
      execId,
      protocolExecId,
      "active"
    )
    return this.requireDirectByClientResult(
      txn.conversationId,
      streamEpoch,
      execId,
      protocolExecId,
      "cancelExactInTransaction"
    )
  }

  private acceptClientResultUnchecked(
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number,
    protocolExecId: string,
    terminalReason: string | undefined,
    settledAt: number,
    operation: "acceptClientResult" | "acceptClientResultInTransaction"
  ): ExecDispatchRecord {
    this.assertClientResultIdentity(
      conversationId,
      { streamEpoch, execId, protocolExecId },
      operation
    )
    this.assertTimestamp(settledAt, operation, "settledAt")
    const result = (this.stmtSettleByClientResult ??= this.persistence.prepare(
      `UPDATE session_exec_dispatches
          SET state = 'settled', settled_at = ?, terminal_reason = ?
        WHERE conversation_id = ?
          AND stream_epoch = ?
          AND exec_id = ?
          AND protocol_exec_id = ?
          AND state IN ('dispatching', 'dispatched', 'awaiting_interrupted_resolution')`
    )).run(
      settledAt,
      terminalReason ?? null,
      conversationId,
      streamEpoch,
      execId,
      protocolExecId
    ) as { changes?: number }
    this.requireSingleTransition(
      result,
      operation,
      conversationId,
      streamEpoch,
      execId,
      protocolExecId,
      "dispatching, dispatched or awaiting_interrupted_resolution"
    )
    return this.requireDirectByClientResult(
      conversationId,
      streamEpoch,
      execId,
      protocolExecId,
      operation
    )
  }

  /** An ExecClientControlMessage addresses its exact attachment slot. */
  cancelByControlSignal(
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number,
    terminalReason: string,
    cancelledAt: number = Date.now()
  ): ExecDispatchRecord {
    this.assertConversationId(conversationId, "cancelByControlSignal")
    this.assertControlIdentity({ streamEpoch, execId }, "cancelByControlSignal")
    this.assertNonEmpty(
      terminalReason,
      "cancelByControlSignal",
      "terminalReason"
    )
    this.assertTimestamp(cancelledAt, "cancelByControlSignal", "cancelledAt")
    return this.persistence.runInTransaction(() => {
      const source = this.findByControlId(conversationId, streamEpoch, execId)
      if (!source) {
        throw new Error(
          `ExecDispatchStore.cancelByControlSignal: no dispatch for ` +
            `conversation=${conversationId} streamEpoch=${streamEpoch} execId=${execId}`
        )
      }
      const result = (this.stmtCancelBySourceIdentity ??=
        this.persistence.prepare(
          `UPDATE session_exec_dispatches
              SET state = 'cancelled', settled_at = ?, terminal_reason = ?
            WHERE conversation_id = ?
              AND stream_epoch = ?
              AND exec_id = ?
              AND protocol_exec_id = ?
              AND state IN ('dispatching', 'dispatched', 'awaiting_interrupted_resolution')`
        )).run(
        cancelledAt,
        terminalReason,
        source.conversationId,
        source.streamEpoch,
        source.execId,
        source.protocolExecId
      ) as { changes?: number }
      this.requireSingleTransition(
        result,
        "cancelByControlSignal",
        source.conversationId,
        source.streamEpoch,
        source.execId,
        source.protocolExecId,
        "dispatching, dispatched or awaiting_interrupted_resolution"
      )
      return this.requireDirectByClientResult(
        source.conversationId,
        source.streamEpoch,
        source.execId,
        source.protocolExecId,
        "cancelByControlSignal"
      )
    })
  }

  /**
   * Find the exact durable dispatch addressed by a real client terminal.
   * Cursor numeric ids are attachment-local; no cross-attachment route is
   * inferred.
   */
  findByClientResult(
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number,
    protocolExecId?: string
  ): ExecDispatchRecord | undefined {
    if (protocolExecId === undefined) {
      return this.findByControlId(conversationId, streamEpoch, execId)
    }
    this.assertClientResultIdentity(
      conversationId,
      { streamEpoch, execId, protocolExecId },
      "findByClientResult"
    )
    return this.findDirectByClientResult(
      conversationId,
      streamEpoch,
      execId,
      protocolExecId
    )
  }

  /** Same lookup for a control frame that only carries the numeric slot. */
  findByControlId(
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number
  ): ExecDispatchRecord | undefined {
    this.assertConversationId(conversationId, "findByControlId")
    this.assertControlIdentity({ streamEpoch, execId }, "findByControlId")
    return this.findDirectByControlId(conversationId, streamEpoch, execId)
  }

  /** Active records include unsent, uncertain, sent, and parked work. */
  findActiveByToolCall(
    conversationId: ConversationId,
    toolCallId: string
  ): ExecDispatchRecord[] {
    this.assertConversationId(conversationId, "findActiveByToolCall")
    requireExactDurableIdentifier(
      toolCallId,
      "ExecDispatchStore.findActiveByToolCall: toolCallId"
    )
    const stmt = (this.stmtFindActiveByToolCall ??= this.persistence.prepare(
      `SELECT stream_epoch, exec_id, ${DISPATCH_COLUMNS}
         FROM session_exec_dispatches
        WHERE conversation_id = ?
          AND tool_call_id = ?
          AND state IN (${ACTIVE_DISPATCH_STATES})
        ORDER BY queued_at ASC, stream_epoch ASC, exec_id ASC`
    ))
    const rows = stmt.all(conversationId, toolCallId) as unknown as Array<
      DispatchRow & { stream_epoch: string; exec_id: number }
    >
    return rows.map((row) =>
      this.toRecord(conversationId, row.stream_epoch, row.exec_id, row)
    )
  }

  /** Return only durable queued envelopes for an explicit replay operation. */
  listQueuedForReplay(
    conversationId: ConversationId,
    streamEpoch: string
  ): ExecDispatchRecord[] {
    this.assertConversationId(conversationId, "listQueuedForReplay")
    requireExactDurableIdentifier(
      streamEpoch,
      "ExecDispatchStore.listQueuedForReplay: streamEpoch"
    )
    const stmt = (this.stmtListQueuedForReplay ??= this.persistence.prepare(
      `SELECT exec_id, ${DISPATCH_COLUMNS}
         FROM session_exec_dispatches
        WHERE conversation_id = ?
          AND stream_epoch = ?
          AND state = 'queued'
        ORDER BY queued_at ASC, exec_id ASC`
    ))
    const rows = stmt.all(conversationId, streamEpoch) as unknown as Array<
      DispatchRow & { exec_id: number }
    >
    return rows.map((row) =>
      this.toRecord(conversationId, streamEpoch, row.exec_id, row)
    )
  }

  /**
   * Explicit ResumeAction handoff for replayable ordinary envelopes. A
   * parked source is deliberately excluded because its terminal must arrive
   * through Cursor's official interrupted-pending resolution.
   */
  reattachForReplay(
    conversationId: ConversationId,
    newStreamEpoch: string,
    reattachedAt: number = Date.now()
  ): ExecDispatchRecord[] {
    this.assertConversationId(conversationId, "reattachForReplay")
    requireExactDurableIdentifier(
      newStreamEpoch,
      "ExecDispatchStore.reattachForReplay: newStreamEpoch"
    )
    this.assertTimestamp(reattachedAt, "reattachForReplay", "reattachedAt")
    const rows = (this.stmtListActiveForReattach ??= this.persistence.prepare(
      `SELECT stream_epoch, exec_id, ${DISPATCH_COLUMNS}
         FROM session_exec_dispatches
        WHERE conversation_id = ?
          AND stream_epoch <> ?
          AND state IN ('queued', 'dispatching', 'dispatched')
        ORDER BY queued_at ASC, stream_epoch ASC, exec_id ASC`
    )).all(conversationId, newStreamEpoch) as unknown as Array<
      DispatchRow & { stream_epoch: string; exec_id: number }
    >
    if (rows.length === 0) return []

    return this.persistence.runInTransaction(() => {
      const reattached: ExecDispatchRecord[] = []
      for (const row of rows) {
        const source = this.toRecord(
          conversationId,
          row.stream_epoch,
          row.exec_id,
          row
        )
        const updated = (this.stmtMarkReattached ??= this.persistence.prepare(
          `UPDATE session_exec_dispatches
              SET state = 'reattached', reattached_at = ?, terminal_reason = ?
            WHERE conversation_id = ?
              AND stream_epoch = ?
              AND exec_id = ?
              AND protocol_exec_id = ?
              AND state = ?`
        )).run(
          reattachedAt,
          `reattached:${newStreamEpoch}`,
          conversationId,
          source.streamEpoch,
          source.execId,
          source.protocolExecId,
          row.state
        ) as { changes?: number }
        if ((updated.changes ?? 0) !== 1) {
          throw new Error(
            `ExecDispatchStore.reattachForReplay: dispatch changed concurrently ` +
              `conversation=${conversationId} streamEpoch=${row.stream_epoch} ` +
              `execId=${row.exec_id}`
          )
        }
        reattached.push(
          this.enqueue({
            ...source,
            streamEpoch: newStreamEpoch,
            frame: Buffer.from(row.frame_payload),
            queuedAt: row.queued_at,
          })
        )
      }
      return reattached
    })
  }

  /**
   * Cancel unresolved slots during a known teardown. Queued rows are included
   * intentionally; no graph result is implied by this outbox transition.
   */
  cancelOpenByExecIds(
    conversationId: ConversationId,
    streamEpoch: string,
    execIds: readonly number[],
    terminalReason: string,
    cancelledAt: number = Date.now()
  ): number {
    this.assertConversationId(conversationId, "cancelOpenByExecIds")
    requireExactDurableIdentifier(
      streamEpoch,
      "ExecDispatchStore.cancelOpenByExecIds: streamEpoch"
    )
    this.assertNonEmpty(terminalReason, "cancelOpenByExecIds", "terminalReason")
    this.assertTimestamp(cancelledAt, "cancelOpenByExecIds", "cancelledAt")
    const normalizedIds = Array.from(
      new Set(
        execIds.filter((execId) => Number.isSafeInteger(execId) && execId > 0)
      )
    )
    if (normalizedIds.length === 0) return 0
    return this.persistence.runInTransaction(() => {
      let changed = 0
      for (const execId of normalizedIds) {
        const result = (this.stmtCancelOpenByExecId ??=
          this.persistence.prepare(
            `UPDATE session_exec_dispatches
                SET state = 'cancelled', settled_at = ?, terminal_reason = ?
              WHERE conversation_id = ?
                AND stream_epoch = ?
                AND exec_id = ?
                AND state IN (${ACTIVE_DISPATCH_STATES})`
          )).run(
          cancelledAt,
          terminalReason,
          conversationId,
          streamEpoch,
          execId
        ) as { changes?: number }
        changed += result.changes ?? 0
      }
      return changed
    })
  }

  private findDirectByClientResult(
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number,
    protocolExecId: string
  ): ExecDispatchRecord | undefined {
    const row = (this.stmtFindDirectByClientResult ??= this.persistence.prepare(
      `SELECT ${DISPATCH_COLUMNS}
           FROM session_exec_dispatches
          WHERE conversation_id = ?
            AND stream_epoch = ?
            AND exec_id = ?
            AND protocol_exec_id = ?
          LIMIT 1`
    )).get(conversationId, streamEpoch, execId, protocolExecId) as
      | DispatchRow
      | undefined
    return row
      ? this.toRecord(conversationId, streamEpoch, execId, row)
      : undefined
  }

  private findDirectByControlId(
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number
  ): ExecDispatchRecord | undefined {
    const row = (this.stmtFindDirectByControlId ??= this.persistence.prepare(
      `SELECT ${DISPATCH_COLUMNS}
           FROM session_exec_dispatches
          WHERE conversation_id = ? AND stream_epoch = ? AND exec_id = ?
          LIMIT 1`
    )).get(conversationId, streamEpoch, execId) as DispatchRow | undefined
    return row
      ? this.toRecord(conversationId, streamEpoch, execId, row)
      : undefined
  }

  private createQueuedRecord(
    input: QueueExecDispatchInput
  ): ExecDispatchRecord {
    this.assertClientResultIdentity(input.conversationId, input, "enqueue")
    this.assertNonEmpty(input.dispatchKind, "enqueue", "dispatchKind")
    this.assertNonEmpty(input.label, "enqueue", "label")
    if (!Buffer.isBuffer(input.frame) || input.frame.length === 0) {
      throw new Error(
        "ExecDispatchStore.enqueue: frame must be a non-empty Buffer"
      )
    }
    const queuedAt = input.queuedAt ?? Date.now()
    this.assertTimestamp(queuedAt, "enqueue", "queuedAt")
    return {
      conversationId: ConversationId.of(input.conversationId),
      streamEpoch: requireExactDurableIdentifier(
        input.streamEpoch,
        "ExecDispatchStore.enqueue: streamEpoch"
      ),
      execId: input.execId,
      protocolExecId: requireExactDurableIdentifier(
        input.protocolExecId,
        "ExecDispatchStore.enqueue: protocolExecId"
      ),
      turnId: input.turnId === undefined ? undefined : TurnId.of(input.turnId),
      toolCallId: requireOptionalExactDurableIdentifier(
        input.toolCallId,
        "ExecDispatchStore.enqueue: toolCallId"
      ),
      callId: requireOptionalExactDurableIdentifier(
        input.callId,
        "ExecDispatchStore.enqueue: callId"
      ),
      modelCallId: requireOptionalExactDurableIdentifier(
        input.modelCallId,
        "ExecDispatchStore.enqueue: modelCallId"
      ),
      dispatchKind: input.dispatchKind,
      frame: Buffer.from(input.frame),
      label: input.label,
      state: "queued",
      queuedAt,
    }
  }

  private requireDirectByClientResult(
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number,
    protocolExecId: string,
    operation: string
  ): ExecDispatchRecord {
    const record = this.findDirectByClientResult(
      conversationId,
      streamEpoch,
      execId,
      protocolExecId
    )
    if (!record) {
      throw new Error(
        `ExecDispatchStore.${operation}: transitioned source disappeared for ` +
          `conversation=${conversationId} streamEpoch=${streamEpoch} ` +
          `execId=${execId} protocolExecId=${protocolExecId}`
      )
    }
    return record
  }

  private requireSingleTransition(
    result: { changes?: number },
    operation: string,
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number,
    protocolExecId: string,
    expectedState: string
  ): void {
    if ((result.changes ?? 0) === 1) return
    throw new Error(
      `ExecDispatchStore.${operation}: no ${expectedState} record for ` +
        `conversation=${conversationId} streamEpoch=${streamEpoch} ` +
        `execId=${execId} protocolExecId=${protocolExecId}`
    )
  }

  private assertClientResultIdentity(
    conversationId: ConversationId,
    identity: Pick<
      QueueExecDispatchInput,
      "streamEpoch" | "execId" | "protocolExecId"
    >,
    operation: string
  ): void {
    this.assertConversationId(conversationId, operation)
    this.assertControlIdentity(identity, operation)
    requireExactDurableIdentifier(
      identity.protocolExecId,
      `ExecDispatchStore.${operation}: protocolExecId`
    )
  }

  private assertConversationId(
    conversationId: ConversationId,
    _operation: string
  ): void {
    ConversationId.of(conversationId)
  }

  private assertTransaction(txn: SessionTxn, operation: string): void {
    const internal = txn as SessionTxnInternal | undefined
    if (
      !internal ||
      internal.tag !== SESSION_TXN_TAG ||
      internal.persistence !== this.persistence
    ) {
      throw new Error(
        `ExecDispatchStore.${operation}: requires the active MessageStore transaction`
      )
    }
    this.assertConversationId(txn.conversationId, operation)
  }

  private assertControlIdentity(
    identity: Pick<QueueExecDispatchInput, "streamEpoch" | "execId">,
    operation: string
  ): void {
    requireExactDurableIdentifier(
      identity.streamEpoch,
      `ExecDispatchStore.${operation}: streamEpoch`
    )
    if (!Number.isInteger(identity.execId) || identity.execId <= 0) {
      throw new Error(
        `ExecDispatchStore.${operation}: execId must be a positive integer`
      )
    }
  }

  private assertNonEmpty(
    value: string,
    operation: string,
    field: string
  ): void {
    if (!value.trim()) {
      throw new Error(`ExecDispatchStore.${operation}: ${field} is required`)
    }
  }

  private assertTimestamp(
    value: number,
    operation: string,
    field: string
  ): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `ExecDispatchStore.${operation}: ${field} must be a positive epoch`
      )
    }
  }

  private toRecord(
    conversationId: ConversationId,
    streamEpoch: string,
    execId: number,
    row: DispatchRow
  ): ExecDispatchRecord {
    this.assertConversationId(conversationId, "toRecord")
    this.assertControlIdentity({ streamEpoch, execId }, "toRecord")
    return {
      conversationId: ConversationId.of(conversationId),
      streamEpoch: requireExactDurableIdentifier(
        streamEpoch,
        "ExecDispatchStore durable streamEpoch"
      ),
      execId,
      protocolExecId: requireExactDurableIdentifier(
        row.protocol_exec_id,
        "ExecDispatchStore durable protocolExecId"
      ),
      turnId: row.turn_id === null ? undefined : TurnId.of(row.turn_id),
      toolCallId: requireOptionalExactDurableIdentifier(
        row.tool_call_id ?? undefined,
        "ExecDispatchStore durable toolCallId"
      ),
      callId: requireOptionalExactDurableIdentifier(
        row.call_id ?? undefined,
        "ExecDispatchStore durable callId"
      ),
      modelCallId: requireOptionalExactDurableIdentifier(
        row.model_call_id ?? undefined,
        "ExecDispatchStore durable modelCallId"
      ),
      dispatchKind: row.dispatch_kind,
      frame: Buffer.from(row.frame_payload),
      label: row.label,
      state: row.state,
      queuedAt: row.queued_at,
      dispatchingAt: row.dispatching_at ?? undefined,
      dispatchedAt: row.dispatched_at ?? undefined,
      reattachedAt: row.reattached_at ?? undefined,
      settledAt: row.settled_at ?? undefined,
      terminalReason: row.terminal_reason ?? undefined,
    }
  }
}
