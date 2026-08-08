import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import * as crypto from "crypto"
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
import { ConversationId } from "../turn/turn.types"

export type AsyncUserInteractionState =
  | "pending"
  | "resolved"
  | "continuing"
  | "completed"
  | "failed"
  | "cancelled"

export interface AsyncAskQuestionAnswer {
  readonly questionId: string
  readonly selectedOptionIds: readonly string[]
  readonly freeformText?: string
}

export type AsyncAskQuestionResolution =
  | {
      readonly resultCase: "success"
      readonly answers: readonly AsyncAskQuestionAnswer[]
    }
  | {
      readonly resultCase: "rejected"
      readonly rejectedReason: string
    }
  | {
      readonly resultCase: "error"
      readonly errorMessage: string
    }

export interface DurableAsyncUserInteraction {
  readonly conversationId: string
  readonly toolCallId: string
  readonly kind: "ask_question"
  readonly operationId: string
  readonly topLevelTurnId: string
  readonly streamId?: string
  readonly sourceMessageUuid: string
  readonly originalArgs: Record<string, unknown>
  readonly state: AsyncUserInteractionState
  readonly resolution?: AsyncAskQuestionResolution
  readonly resolutionFingerprint?: string
  readonly continuationPayload?: string
  readonly continuationSourceUuid?: string
  readonly createdAt: number
  readonly resolvedAt?: number
  readonly continuationStartedAt?: number
  readonly terminalAt?: number
  readonly terminalReason?: string
  readonly updatedAt: number
  readonly revision: number
}

export interface OpenAsyncAskQuestionInput {
  readonly toolCallId: string
  readonly operationId: string
  readonly topLevelTurnId: string
  readonly streamId?: string
  readonly sourceMessageUuid: string
  readonly originalArgs: Record<string, unknown>
  readonly createdAt?: number
}

export type AcceptAsyncAskQuestionResolutionResult =
  | {
      readonly kind: "accepted"
      readonly interaction: DurableAsyncUserInteraction
    }
  | {
      readonly kind: "duplicate"
      readonly interaction: DurableAsyncUserInteraction
    }
  | {
      readonly kind: "conflict"
      readonly interaction: DurableAsyncUserInteraction
    }
  | {
      readonly kind: "missing"
    }

export type ClaimAsyncUserInteractionContinuationResult =
  | {
      readonly kind: "claimed"
      readonly interaction: DurableAsyncUserInteraction
    }
  | {
      readonly kind: "duplicate"
      readonly interaction: DurableAsyncUserInteraction
    }
  | {
      readonly kind: "not_resolved"
      readonly interaction: DurableAsyncUserInteraction
    }
  | {
      readonly kind: "missing"
    }

interface AsyncUserInteractionRow {
  tool_call_id: string
  interaction_kind: string
  operation_id: string
  top_level_turn_id: string
  stream_id: string | null
  source_message_uuid: string
  original_args_json: string
  state: string
  resolution_case: string | null
  resolution_json: string | null
  resolution_fingerprint: string | null
  continuation_payload: string | null
  continuation_source_uuid: string | null
  created_at: number
  resolved_at: number | null
  continuation_started_at: number | null
  terminal_at: number | null
  terminal_reason: string | null
  updated_at: number
  revision: number
}

const INTERACTION_COLUMNS = `
  tool_call_id, interaction_kind, operation_id, top_level_turn_id, stream_id,
  source_message_uuid, original_args_json, state, resolution_case,
  resolution_json, resolution_fingerprint, continuation_payload,
  continuation_source_uuid, created_at, resolved_at, continuation_started_at,
  terminal_at, terminal_reason, updated_at, revision
`

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseRecordJson(
  value: string,
  label: string
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`${label}: invalid JSON: ${(error as Error).message}`)
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label}: expected object`)
  }
  return parsed
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function normalizeResolution(
  value: AsyncAskQuestionResolution
): AsyncAskQuestionResolution {
  switch (value.resultCase) {
    case "success":
      return {
        resultCase: "success",
        answers: [...value.answers]
          .map((answer) => ({
            questionId:
              typeof answer.questionId === "string" ? answer.questionId : "",
            selectedOptionIds: [
              ...new Set(
                [...answer.selectedOptionIds].filter(
                  (id): id is string => typeof id === "string" && id.length > 0
                )
              ),
            ].sort(),
            ...(normalizeOptionalText(answer.freeformText)
              ? { freeformText: answer.freeformText }
              : {}),
          }))
          .sort((left, right) =>
            left.questionId.localeCompare(right.questionId)
          ),
      }
    case "rejected":
      return {
        resultCase: "rejected",
        rejectedReason: value.rejectedReason || "rejected",
      }
    case "error":
      return {
        resultCase: "error",
        errorMessage: value.errorMessage || "ask_question failed",
      }
  }
}

export function fingerprintAsyncAskQuestionResolution(
  value: AsyncAskQuestionResolution
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalizeResolution(value)))
    .digest("hex")
}

export function renderAsyncAskQuestionContinuationPayload(
  value: AsyncAskQuestionResolution
): string {
  const resolution = normalizeResolution(value)
  switch (resolution.resultCase) {
    case "success": {
      const answers = resolution.answers
        .map((answer) => {
          const values = [
            ...answer.selectedOptionIds,
            ...(answer.freeformText ? [answer.freeformText] : []),
          ]
          if (values.length === 0) return undefined
          const rendered = values.join(" — ")
          return answer.questionId
            ? `${answer.questionId}: ${rendered}`
            : rendered
        })
        .filter((entry): entry is string => entry !== undefined)
      return answers.length > 0
        ? `The user answered the pending question: ${answers.join(" | ")}`
        : "The user answered the pending question."
    }
    case "rejected":
      return `The user declined the pending question: ${resolution.rejectedReason}`
    case "error":
      return `The pending question failed: ${resolution.errorMessage}`
  }
}

function readResolution(
  row: AsyncUserInteractionRow
): AsyncAskQuestionResolution | undefined {
  if (row.resolution_json === null) return undefined
  const parsed = parseRecordJson(
    row.resolution_json,
    `Async user interaction ${row.tool_call_id} resolution`
  )
  switch (row.resolution_case) {
    case "success": {
      if (!Array.isArray(parsed.answers)) {
        throw new Error(
          `Async user interaction ${row.tool_call_id}: success requires answers`
        )
      }
      return normalizeResolution({
        resultCase: "success",
        answers: parsed.answers.map((entry) => {
          if (!isRecord(entry)) {
            throw new Error(
              `Async user interaction ${row.tool_call_id}: invalid answer`
            )
          }
          return {
            questionId:
              typeof entry.questionId === "string" ? entry.questionId : "",
            selectedOptionIds: Array.isArray(entry.selectedOptionIds)
              ? entry.selectedOptionIds.filter(
                  (id): id is string => typeof id === "string"
                )
              : [],
            freeformText:
              typeof entry.freeformText === "string"
                ? entry.freeformText
                : undefined,
          }
        }),
      })
    }
    case "rejected":
      return normalizeResolution({
        resultCase: "rejected",
        rejectedReason:
          typeof parsed.rejectedReason === "string"
            ? parsed.rejectedReason
            : "rejected",
      })
    case "error":
      return normalizeResolution({
        resultCase: "error",
        errorMessage:
          typeof parsed.errorMessage === "string"
            ? parsed.errorMessage
            : "ask_question failed",
      })
    default:
      throw new Error(
        `Async user interaction ${row.tool_call_id}: invalid resolution case ${String(row.resolution_case)}`
      )
  }
}

@Injectable()
export class AsyncUserInteractionStore implements OnModuleInit {
  private readonly logger = new Logger(AsyncUserInteractionStore.name)
  private stmtInsert?: StatementSync
  private stmtGet?: StatementSync
  private stmtListActive?: StatementSync
  private stmtListActiveConversationIds?: StatementSync
  private stmtListRecoverable?: StatementSync
  private stmtAcceptResolution?: StatementSync
  private stmtClaimContinuation?: StatementSync
  private stmtMarkTerminal?: StatementSync
  private stmtCancelActive?: StatementSync
  private readonly restartRecoverableContinuations = new Set<string>()

  constructor(private readonly persistence: PersistenceService) {}

  onModuleInit(): void {
    const rows = this.persistence
      .prepare(
        `SELECT conversation_id, tool_call_id
           FROM session_async_user_interactions
          WHERE state = 'continuing'
          ORDER BY updated_at ASC, conversation_id ASC, tool_call_id ASC`
      )
      .all() as unknown as Array<{
      conversation_id: string
      tool_call_id: string
    }>
    for (const row of rows) {
      const conversationId = ConversationId.of(row.conversation_id)
      const toolCallId = requireExactDurableIdentifier(
        row.tool_call_id,
        "Restart-recoverable async interaction toolCallId"
      )
      this.restartRecoverableContinuations.add(
        this.recoveryKey(conversationId, toolCallId)
      )
    }
    if (rows.length > 0) {
      this.logger.warn(
        `Found ${rows.length} interrupted async user continuation(s) for recovery`
      )
    }
  }

  openPendingInTransaction(
    txn: SessionTxn,
    input: OpenAsyncAskQuestionInput
  ): DurableAsyncUserInteraction {
    this.assertTransaction(txn, "openPendingInTransaction")
    const toolCallId = requireExactDurableIdentifier(
      input.toolCallId,
      "Async interaction toolCallId"
    )
    const operationId = requireExactDurableIdentifier(
      input.operationId,
      "Async interaction operationId"
    )
    const topLevelTurnId = requireExactDurableIdentifier(
      input.topLevelTurnId,
      "Async interaction topLevelTurnId"
    )
    const streamId = requireOptionalExactDurableIdentifier(
      input.streamId,
      "Async interaction streamId"
    )
    const sourceMessageUuid = requireExactDurableIdentifier(
      input.sourceMessageUuid,
      "Async interaction source message UUID"
    )
    if (!isRecord(input.originalArgs)) {
      throw new Error("Async interaction original args must be an object")
    }
    const createdAt = input.createdAt ?? Date.now()
    if (!Number.isSafeInteger(createdAt) || createdAt < 1) {
      throw new Error("Async interaction createdAt must be positive")
    }
    ;(this.stmtInsert ??= this.persistence.prepare(
      `INSERT INTO session_async_user_interactions (
         conversation_id, tool_call_id, interaction_kind, operation_id,
         top_level_turn_id, stream_id, source_message_uuid, original_args_json,
         state, resolution_case, resolution_json, resolution_fingerprint,
         continuation_payload, continuation_source_uuid, created_at,
         resolved_at, continuation_started_at, terminal_at, terminal_reason,
         updated_at, revision
       ) VALUES (
         ?, ?, 'ask_question', ?, ?, ?, ?, ?, 'pending',
         NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, 1
       )`
    )).run(
      txn.conversationId,
      toolCallId,
      operationId,
      topLevelTurnId,
      streamId ?? null,
      sourceMessageUuid,
      JSON.stringify(structuredClone(input.originalArgs)),
      createdAt,
      createdAt
    )
    return this.require(txn.conversationId, toolCallId)
  }

  get(
    conversationId: string,
    toolCallId: string
  ): DurableAsyncUserInteraction | undefined {
    const cid = ConversationId.of(conversationId)
    const exactToolCallId = requireExactDurableIdentifier(
      toolCallId,
      "Async interaction lookup toolCallId"
    )
    const row = (this.stmtGet ??= this.persistence.prepare(
      `SELECT ${INTERACTION_COLUMNS}
         FROM session_async_user_interactions
        WHERE conversation_id = ? AND tool_call_id = ?`
    )).get(cid, exactToolCallId) as AsyncUserInteractionRow | undefined
    return row ? this.toRecord(cid, row) : undefined
  }

  listActive(conversationId: string): DurableAsyncUserInteraction[] {
    const cid = ConversationId.of(conversationId)
    const rows = (this.stmtListActive ??= this.persistence.prepare(
      `SELECT ${INTERACTION_COLUMNS}
         FROM session_async_user_interactions
        WHERE conversation_id = ?
          AND state IN ('pending', 'resolved', 'continuing')
        ORDER BY created_at ASC, tool_call_id ASC`
    )).all(cid) as unknown as AsyncUserInteractionRow[]
    return rows.map((row) => this.toRecord(cid, row))
  }

  listActiveConversationIds(): string[] {
    const rows = (this.stmtListActiveConversationIds ??=
      this.persistence.prepare(
        `SELECT DISTINCT conversation_id
           FROM session_async_user_interactions
          WHERE state IN ('pending', 'resolved', 'continuing')
          ORDER BY conversation_id ASC`
      )).all() as unknown as Array<{ conversation_id: string }>
    return rows.map((row) => ConversationId.of(row.conversation_id) as string)
  }

  listRecoverable(conversationId: string): DurableAsyncUserInteraction[] {
    const cid = ConversationId.of(conversationId)
    const rows = (this.stmtListRecoverable ??= this.persistence.prepare(
      `SELECT ${INTERACTION_COLUMNS}
         FROM session_async_user_interactions
        WHERE conversation_id = ?
          AND state IN ('resolved', 'continuing')
        ORDER BY resolved_at ASC, tool_call_id ASC`
    )).all(cid) as unknown as AsyncUserInteractionRow[]
    return rows.map((row) => this.toRecord(cid, row))
  }

  acceptResolutionInTransaction(
    txn: SessionTxn,
    toolCallId: string,
    value: AsyncAskQuestionResolution
  ): AcceptAsyncAskQuestionResolutionResult {
    this.assertTransaction(txn, "acceptResolutionInTransaction")
    const exactToolCallId = requireExactDurableIdentifier(
      toolCallId,
      "Async interaction resolution toolCallId"
    )
    const resolution = normalizeResolution(value)
    const fingerprint = fingerprintAsyncAskQuestionResolution(resolution)
    const existing = this.get(txn.conversationId, exactToolCallId)
    if (!existing) return { kind: "missing" }
    if (existing.state !== "pending") {
      return existing.resolutionFingerprint === fingerprint
        ? { kind: "duplicate", interaction: existing }
        : { kind: "conflict", interaction: existing }
    }

    const now = Date.now()
    const result = (this.stmtAcceptResolution ??= this.persistence.prepare(
      `UPDATE session_async_user_interactions
          SET state = 'resolved',
              resolution_case = ?,
              resolution_json = ?,
              resolution_fingerprint = ?,
              continuation_payload = ?,
              resolved_at = ?,
              updated_at = ?,
              revision = revision + 1
        WHERE conversation_id = ?
          AND tool_call_id = ?
          AND state = 'pending'
          AND revision = ?`
    )).run(
      resolution.resultCase,
      JSON.stringify(resolution),
      fingerprint,
      renderAsyncAskQuestionContinuationPayload(resolution),
      now,
      now,
      txn.conversationId,
      exactToolCallId,
      existing.revision
    )
    if ((result.changes ?? 0) !== 1) {
      const raced = this.require(txn.conversationId, exactToolCallId)
      return raced.resolutionFingerprint === fingerprint
        ? { kind: "duplicate", interaction: raced }
        : { kind: "conflict", interaction: raced }
    }
    return {
      kind: "accepted",
      interaction: this.require(txn.conversationId, exactToolCallId),
    }
  }

  claimContinuationInTransaction(
    txn: SessionTxn,
    input: {
      readonly toolCallId: string
      readonly resolutionFingerprint: string
      readonly continuationSourceUuid: string
    }
  ): ClaimAsyncUserInteractionContinuationResult {
    this.assertTransaction(txn, "claimContinuationInTransaction")
    const toolCallId = requireExactDurableIdentifier(
      input.toolCallId,
      "Async interaction continuation toolCallId"
    )
    const sourceUuid = requireExactDurableIdentifier(
      input.continuationSourceUuid,
      "Async interaction continuation source UUID"
    )
    const fingerprint = input.resolutionFingerprint
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error(
        "Async interaction continuation fingerprint must be lowercase SHA-256"
      )
    }
    const existing = this.get(txn.conversationId, toolCallId)
    if (!existing) return { kind: "missing" }
    if (existing.resolutionFingerprint !== fingerprint) {
      return { kind: "not_resolved", interaction: existing }
    }
    if (existing.state !== "resolved") {
      return existing.continuationSourceUuid === sourceUuid
        ? { kind: "duplicate", interaction: existing }
        : { kind: "not_resolved", interaction: existing }
    }

    const now = Date.now()
    const result = (this.stmtClaimContinuation ??= this.persistence.prepare(
      `UPDATE session_async_user_interactions
          SET state = 'continuing',
              continuation_source_uuid = ?,
              continuation_started_at = ?,
              updated_at = ?,
              revision = revision + 1
        WHERE conversation_id = ?
          AND tool_call_id = ?
          AND state = 'resolved'
          AND resolution_fingerprint = ?
          AND revision = ?`
    )).run(
      sourceUuid,
      now,
      now,
      txn.conversationId,
      toolCallId,
      fingerprint,
      existing.revision
    )
    if ((result.changes ?? 0) !== 1) {
      const raced = this.require(txn.conversationId, toolCallId)
      return raced.continuationSourceUuid === sourceUuid
        ? { kind: "duplicate", interaction: raced }
        : { kind: "not_resolved", interaction: raced }
    }
    return {
      kind: "claimed",
      interaction: this.require(txn.conversationId, toolCallId),
    }
  }

  markContinuationTerminal(
    conversationId: string,
    toolCallId: string,
    outcome: "completed" | "failed"
  ): DurableAsyncUserInteraction | undefined {
    const cid = ConversationId.of(conversationId)
    const exactToolCallId = requireExactDurableIdentifier(
      toolCallId,
      "Async interaction terminal toolCallId"
    )
    return this.persistence.runInImmediateTransaction(() => {
      const existing = this.get(cid, exactToolCallId)
      if (!existing) return undefined
      if (existing.state === "completed" || existing.state === "failed") {
        return existing
      }
      if (existing.state !== "continuing") {
        throw new Error(
          `Async interaction ${exactToolCallId} cannot become ${outcome} from ${existing.state}`
        )
      }
      const now = Date.now()
      const result = (this.stmtMarkTerminal ??= this.persistence.prepare(
        `UPDATE session_async_user_interactions
            SET state = ?,
                terminal_at = ?,
                terminal_reason = ?,
                updated_at = ?,
                revision = revision + 1
          WHERE conversation_id = ?
            AND tool_call_id = ?
            AND state = 'continuing'
            AND revision = ?`
      )).run(
        outcome,
        now,
        outcome === "completed"
          ? "continuation completed"
          : "continuation failed",
        now,
        cid,
        exactToolCallId,
        existing.revision
      )
      if ((result.changes ?? 0) !== 1) {
        return this.require(cid, exactToolCallId)
      }
      return this.require(cid, exactToolCallId)
    })
  }

  cancelActive(conversationId: string, reason: string): number {
    const cid = ConversationId.of(conversationId)
    const normalizedReason = reason.trim()
    if (!normalizedReason || normalizedReason.includes("\u0000")) {
      throw new Error(
        "Async interaction cancellation reason must be non-empty and NUL-free"
      )
    }
    const now = Date.now()
    const cancelled = this.persistence.runInImmediateTransaction(() => {
      const result = (this.stmtCancelActive ??= this.persistence.prepare(
        `UPDATE session_async_user_interactions
            SET state = 'cancelled',
                terminal_at = ?,
                terminal_reason = ?,
                updated_at = ?,
                revision = revision + 1
          WHERE conversation_id = ?
            AND state IN ('pending', 'resolved', 'continuing')`
      )).run(now, normalizedReason, now, cid)
      return Number(result.changes ?? 0)
    })
    for (const key of this.restartRecoverableContinuations) {
      if (key.startsWith(`${cid}\u0000`)) {
        this.restartRecoverableContinuations.delete(key)
      }
    }
    return cancelled
  }

  claimRestartContinuationRecovery(
    conversationId: string,
    toolCallId: string
  ): boolean {
    const cid = ConversationId.of(conversationId)
    const exactToolCallId = requireExactDurableIdentifier(
      toolCallId,
      "Restart continuation recovery toolCallId"
    )
    return this.restartRecoverableContinuations.delete(
      this.recoveryKey(cid, exactToolCallId)
    )
  }

  private require(
    conversationId: string,
    toolCallId: string
  ): DurableAsyncUserInteraction {
    const interaction = this.get(conversationId, toolCallId)
    if (!interaction) {
      throw new Error(
        `Async user interaction disappeared conversation=${conversationId} toolCallId=${toolCallId}`
      )
    }
    return interaction
  }

  private toRecord(
    conversationId: string,
    row: AsyncUserInteractionRow
  ): DurableAsyncUserInteraction {
    if (row.interaction_kind !== "ask_question") {
      throw new Error(
        `Unsupported async user interaction kind ${row.interaction_kind}`
      )
    }
    if (
      row.state !== "pending" &&
      row.state !== "resolved" &&
      row.state !== "continuing" &&
      row.state !== "completed" &&
      row.state !== "failed" &&
      row.state !== "cancelled"
    ) {
      throw new Error(`Unsupported async user interaction state ${row.state}`)
    }
    const resolution = readResolution(row)
    return {
      conversationId,
      toolCallId: requireExactDurableIdentifier(
        row.tool_call_id,
        "Stored async interaction toolCallId"
      ),
      kind: "ask_question",
      operationId: requireExactDurableIdentifier(
        row.operation_id,
        "Stored async interaction operationId"
      ),
      topLevelTurnId: requireExactDurableIdentifier(
        row.top_level_turn_id,
        "Stored async interaction topLevelTurnId"
      ),
      streamId:
        requireOptionalExactDurableIdentifier(
          row.stream_id ?? undefined,
          "Stored async interaction streamId"
        ) ?? undefined,
      sourceMessageUuid: requireExactDurableIdentifier(
        row.source_message_uuid,
        "Stored async interaction source message UUID"
      ),
      originalArgs: parseRecordJson(
        row.original_args_json,
        `Async user interaction ${row.tool_call_id} original args`
      ),
      state: row.state,
      ...(resolution ? { resolution } : {}),
      ...(row.resolution_fingerprint
        ? { resolutionFingerprint: row.resolution_fingerprint }
        : {}),
      ...(row.continuation_payload !== null
        ? { continuationPayload: row.continuation_payload }
        : {}),
      ...(row.continuation_source_uuid
        ? {
            continuationSourceUuid: requireExactDurableIdentifier(
              row.continuation_source_uuid,
              "Stored async interaction continuation source UUID"
            ),
          }
        : {}),
      createdAt: row.created_at,
      ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
      ...(row.continuation_started_at !== null
        ? { continuationStartedAt: row.continuation_started_at }
        : {}),
      ...(row.terminal_at !== null ? { terminalAt: row.terminal_at } : {}),
      ...(row.terminal_reason !== null
        ? { terminalReason: row.terminal_reason }
        : {}),
      updatedAt: row.updated_at,
      revision: row.revision,
    }
  }

  private recoveryKey(conversationId: string, toolCallId: string): string {
    return `${conversationId}\u0000${toolCallId}`
  }

  private assertTransaction(txn: SessionTxn, operation: string): void {
    const internal = txn as SessionTxnInternal
    if (
      !txn ||
      txn.tag !== SESSION_TXN_TAG ||
      internal.persistence !== this.persistence
    ) {
      throw new Error(
        `AsyncUserInteractionStore.${operation}: requires the active MessageStore transaction`
      )
    }
  }
}
