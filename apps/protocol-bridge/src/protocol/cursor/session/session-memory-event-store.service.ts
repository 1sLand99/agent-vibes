import { Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import { formatSubAgentMemoryEntry } from "../../../context/sub-agent-memory-formatter"
import { SessionMemoryService } from "../../../context/session-memory.service"
import type {
  ContextSessionMemoryEntry,
  SubAgentMemoryEvent,
  SubAgentMemoryPayload,
} from "../../../context/types"
import { PersistenceService } from "../../../persistence"
import type { ConversationId } from "../turn/turn.types"
import { decodeSubagentTerminalDeliveries } from "../subagents/subagent-terminal-delivery"
import { SESSION_TXN_TAG, type SessionTxn } from "./tool-call-ledger.service"

export interface PersistedSubAgentMemoryEvent extends SubAgentMemoryEvent {
  /** Monotonic per-conversation append order. */
  seq: number
  /** Monotonic revision for one lifecycle event identity. */
  revision: number
}

interface StoredMemoryEventRow {
  seq: number
  source_event_id: string
  revision: number
  kind: string
  source_tool_use_id: string
  source_record_uuid: string
  source_kind: string
  payload_json: string
  weight: number
  created_at: number
}

interface SourceRecordRow {
  role: string
  content_json: string
  metadata_json: string | null
}

/**
 * Append-only owner of structured sub-agent session memory.
 *
 * It intentionally stores only typed lifecycle facts and an exact graph
 * relation. The model-facing text is materialized from `payload_json` at
 * read time; no report string is parsed to recover memory after compaction or
 * restart.
 */
@Injectable()
export class SessionMemoryEventStore {
  private stmtNextSeq?: StatementSync
  private stmtFindLatest?: StatementSync
  private stmtInsert?: StatementSync
  private stmtList?: StatementSync
  private stmtFindSourceRecord?: StatementSync

  constructor(
    private readonly persistence: PersistenceService,
    private readonly sessionMemory: SessionMemoryService
  ) {}

  /**
   * Appends beside an accepted graph fragment. The opaque transaction token
   * makes it impossible to accidentally split a foreground task result and
   * its memory event into separate commits.
   */
  appendInTransaction(
    txn: SessionTxn,
    input: SubAgentMemoryEvent
  ): PersistedSubAgentMemoryEvent {
    this.assertTxn(txn)
    if (input.conversationId !== txn.conversationId) {
      throw new Error(
        "SessionMemoryEventStore: event conversation does not match transaction"
      )
    }
    return this.appendUnchecked(input)
  }

  private appendUnchecked(
    input: SubAgentMemoryEvent
  ): PersistedSubAgentMemoryEvent {
    const normalized = this.normalize(input)

    const existing = (this.stmtFindLatest ??= this.persistence.prepare(
      `SELECT seq, source_event_id, revision, kind, source_tool_use_id,
              source_record_uuid, source_kind, payload_json, weight, created_at
         FROM session_memory_events
        WHERE conversation_id = ? AND source_event_id = ?
        ORDER BY revision DESC
        LIMIT 1`
    )).get(normalized.conversationId, normalized.sourceEventId) as
      | StoredMemoryEventRow
      | undefined
    if (existing) {
      const restored = this.decodeRow(normalized.conversationId, existing)
      this.assertImmutableProvenance(restored, normalized)
      if (this.isSameEvent(restored, normalized)) {
        return restored
      }
    }

    this.assertSourceRecord(normalized)

    const seq = this.nextSeq(normalized.conversationId)
    const revision = existing ? existing.revision + 1 : 1
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error(
        `SessionMemoryEventStore: invalid revision for ${normalized.conversationId}/${normalized.sourceEventId}`
      )
    }
    ;(this.stmtInsert ??= this.persistence.prepare(
      `INSERT INTO session_memory_events (
         conversation_id, seq, source_event_id, revision, kind,
         source_tool_use_id, source_record_uuid, source_kind, payload_json,
         weight, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )).run(
      normalized.conversationId,
      seq,
      normalized.sourceEventId,
      revision,
      "sub_agent",
      normalized.sourceToolUseId,
      normalized.sourceRecordUuid,
      normalized.sourceKind,
      JSON.stringify(normalized.payload),
      normalized.weight,
      normalized.createdAt
    )
    return { ...normalized, seq, revision }
  }

  /** Raw append order for audit and restart reconstruction. */
  list(conversationId: ConversationId): PersistedSubAgentMemoryEvent[] {
    const rows = (this.stmtList ??= this.persistence.prepare(
      `SELECT seq, source_event_id, revision, kind, source_tool_use_id,
              source_record_uuid, source_kind, payload_json, weight, created_at
         FROM session_memory_events
        WHERE conversation_id = ?
        ORDER BY seq ASC`
    )).all(conversationId) as unknown as StoredMemoryEventRow[]
    let previousSeq = 0
    return rows.map((row) => {
      if (!Number.isSafeInteger(row.seq) || row.seq <= previousSeq) {
        throw new Error(
          `SessionMemoryEventStore: invalid append sequence for ${conversationId}`
        )
      }
      previousSeq = row.seq
      return this.decodeRow(conversationId, row)
    })
  }

  /**
   * Materializes only the newest revision of each event identity into the
   * runtime state. Capacity is delegated to SessionMemoryService so warm and
   * cold projections share exactly the same retention rule.
   */
  listMaterialized(
    conversationId: ConversationId
  ): ContextSessionMemoryEntry[] {
    const latestByEvent = new Map<string, PersistedSubAgentMemoryEvent>()
    for (const event of this.list(conversationId)) {
      const previous = latestByEvent.get(event.sourceEventId)
      if (previous && event.revision <= previous.revision) {
        throw new Error(
          `SessionMemoryEventStore: non-monotonic revision for ${conversationId}/${event.sourceEventId}`
        )
      }
      latestByEvent.set(event.sourceEventId, event)
    }
    const entries = [...latestByEvent.values()].map((event) =>
      this.toMemoryEntry(event)
    )
    return this.sessionMemory.mergeEntries([], entries)
  }

  private nextSeq(conversationId: ConversationId): number {
    const row = (this.stmtNextSeq ??= this.persistence.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM session_memory_events
        WHERE conversation_id = ?`
    )).get(conversationId) as { next_seq?: number } | undefined
    const next = row?.next_seq
    if (!Number.isSafeInteger(next) || !next || next < 1) {
      throw new Error(
        `SessionMemoryEventStore: cannot allocate sequence for ${conversationId}`
      )
    }
    return next
  }

  private assertSourceRecord(
    event: Omit<PersistedSubAgentMemoryEvent, "seq" | "revision">
  ): void {
    const row = (this.stmtFindSourceRecord ??= this.persistence.prepare(
      `SELECT role, content_json, metadata_json
         FROM session_messages
        WHERE conversation_id = ? AND uuid = ?
        LIMIT 1`
    )).get(event.conversationId, event.sourceRecordUuid) as
      | SourceRecordRow
      | undefined
    if (!row) {
      throw new Error(
        `SessionMemoryEventStore: source graph record is missing for ${event.conversationId}/${event.sourceRecordUuid}`
      )
    }
    let content: unknown
    try {
      content = JSON.parse(row.content_json)
    } catch (error) {
      throw new Error(
        `SessionMemoryEventStore: invalid source graph content for ${event.conversationId}/${event.sourceRecordUuid}: ${(error as Error).message}`
      )
    }
    if (!Array.isArray(content)) {
      throw new Error(
        `SessionMemoryEventStore: source graph content is not a block array for ${event.conversationId}/${event.sourceRecordUuid}`
      )
    }
    const matched =
      event.sourceKind === "tool_result"
        ? content.some((block) => {
            if (!block || typeof block !== "object") return false
            const value = block as Record<string, unknown>
            return (
              value.type === "tool_result" &&
              value.tool_use_id === event.sourceToolUseId
            )
          })
        : event.sourceKind === "control_notification"
          ? this.isExactControlNotificationSource(row, content, event)
          : false
    if (!matched) {
      throw new Error(
        `SessionMemoryEventStore: source graph record does not own ${event.sourceKind} ${event.sourceToolUseId}`
      )
    }
  }

  private isExactControlNotificationSource(
    row: SourceRecordRow,
    content: unknown[],
    event: Omit<PersistedSubAgentMemoryEvent, "seq" | "revision">
  ): boolean {
    if (row.role !== "user" || row.metadata_json === null) return false
    let metadata: unknown
    try {
      metadata = JSON.parse(row.metadata_json)
    } catch {
      return false
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return false
    }
    const value = metadata as Record<string, unknown>
    if (value.source !== "cursor_control_continuation") return false
    let deliveries
    try {
      deliveries = decodeSubagentTerminalDeliveries(
        value.subagentTerminalDeliveries
      )
    } catch {
      return false
    }
    const ownsDelivery = deliveries.some(
      (delivery) =>
        delivery.route === "control_notification" &&
        delivery.agentId === event.payload.agentId &&
        delivery.parentToolCallId === event.sourceToolUseId
    )
    return (
      ownsDelivery &&
      content.some(
        (block) =>
          !!block &&
          typeof block === "object" &&
          !Array.isArray(block) &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string" &&
          ((block as Record<string, unknown>).text as string).trim().length > 0
      )
    )
  }

  private normalize(input: SubAgentMemoryEvent): Omit<
    PersistedSubAgentMemoryEvent,
    "seq" | "revision"
  > & {
    conversationId: ConversationId
  } {
    const sourceEventId = this.requireExactIdentifier(
      input.sourceEventId,
      "sourceEventId"
    )
    const sourceToolUseId = this.requireExactIdentifier(
      input.sourceToolUseId,
      "sourceToolUseId"
    )
    const sourceRecordUuid = this.requireExactIdentifier(
      input.sourceRecordUuid,
      "sourceRecordUuid"
    )
    if (
      input.sourceKind !== "tool_result" &&
      input.sourceKind !== "control_notification"
    ) {
      throw new Error(
        "SessionMemoryEventStore: sourceKind must be tool_result or control_notification"
      )
    }
    if (!Number.isSafeInteger(input.weight) || input.weight < 0) {
      throw new Error(
        "SessionMemoryEventStore: weight must be a non-negative integer"
      )
    }
    if (!Number.isSafeInteger(input.createdAt) || input.createdAt <= 0) {
      throw new Error(
        "SessionMemoryEventStore: createdAt must be a positive integer"
      )
    }
    const conversationId = this.requireExactIdentifier(
      input.conversationId,
      "conversationId"
    ) as ConversationId
    return {
      conversationId,
      sourceEventId,
      sourceToolUseId,
      sourceRecordUuid,
      sourceKind: input.sourceKind,
      payload: this.normalizePayload(input.payload),
      weight: input.weight,
      createdAt: input.createdAt,
    }
  }

  private normalizePayload(payload: unknown): SubAgentMemoryPayload {
    this.assertExactFields(
      payload,
      [
        "agentId",
        "agentType",
        "status",
        "turnCount",
        "toolCallCount",
        "durationMs",
        "modifiedFiles",
        "resultText",
        "evidence",
        "task",
      ],
      "payload"
    )
    const agentId = this.requireNonEmptyText(payload.agentId, "payload.agentId")
    const status = this.requireNonEmptyText(payload.status, "payload.status")
    const evidence = Array.isArray(payload.evidence)
      ? payload.evidence.map((item) => {
          this.assertExactFields(
            item,
            ["toolName", "summary"],
            "payload.evidence item"
          )
          return {
            toolName: this.requireNonEmptyText(
              item.toolName,
              "payload.evidence.toolName"
            ),
            summary: this.requireNonEmptyText(
              item.summary,
              "payload.evidence.summary"
            ),
          }
        })
      : (() => {
          throw new Error(
            "SessionMemoryEventStore: payload.evidence must be an array"
          )
        })()
    const optionalText = (
      value: unknown,
      field: string
    ): string | undefined => {
      if (value === undefined) return undefined
      return this.requireNonEmptyText(value, field)
    }
    const optionalNumber = (
      value: unknown,
      field: string
    ): number | undefined => {
      if (value === undefined) return undefined
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      ) {
        throw new Error(
          `SessionMemoryEventStore: ${field} must be a non-negative integer`
        )
      }
      return value
    }
    const agentType = optionalText(payload.agentType, "payload.agentType")
    const turnCount = optionalNumber(payload.turnCount, "payload.turnCount")
    const toolCallCount = optionalNumber(
      payload.toolCallCount,
      "payload.toolCallCount"
    )
    const durationMs = optionalNumber(payload.durationMs, "payload.durationMs")
    const resultText = optionalText(payload.resultText, "payload.resultText")
    const task = optionalText(payload.task, "payload.task")
    const modifiedFiles =
      payload.modifiedFiles === undefined
        ? undefined
        : Array.isArray(payload.modifiedFiles)
          ? payload.modifiedFiles.map((file) =>
              this.requireNonEmptyText(file, "payload.modifiedFiles")
            )
          : (() => {
              throw new Error(
                "SessionMemoryEventStore: payload.modifiedFiles must be an array"
              )
            })()
    return {
      agentId,
      ...(agentType ? { agentType } : {}),
      status,
      ...(turnCount !== undefined ? { turnCount } : {}),
      ...(toolCallCount !== undefined ? { toolCallCount } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(modifiedFiles ? { modifiedFiles } : {}),
      ...(resultText ? { resultText } : {}),
      evidence,
      ...(task ? { task } : {}),
    }
  }

  private assertExactFields(
    value: unknown,
    allowedFields: readonly string[],
    field: string
  ): asserts value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`SessionMemoryEventStore: ${field} must be an object`)
    }
    const allowed = new Set(allowedFields)
    const unsupported = Object.keys(value).filter((key) => !allowed.has(key))
    if (unsupported.length > 0) {
      throw new Error(
        `SessionMemoryEventStore: ${field} contains unsupported field(s): ${unsupported.join(", ")}`
      )
    }
  }

  private decodeRow(
    conversationId: ConversationId,
    row: StoredMemoryEventRow
  ): PersistedSubAgentMemoryEvent {
    if (row.kind !== "sub_agent") {
      throw new Error(
        `SessionMemoryEventStore: unsupported memory kind ${row.kind}`
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(row.payload_json)
    } catch (error) {
      throw new Error(
        `SessionMemoryEventStore: invalid payload for ${conversationId}/${row.source_event_id}: ${(error as Error).message}`
      )
    }
    const normalized = this.normalize({
      conversationId,
      sourceEventId: row.source_event_id,
      sourceToolUseId: row.source_tool_use_id,
      sourceRecordUuid: row.source_record_uuid,
      sourceKind: row.source_kind as SubAgentMemoryEvent["sourceKind"],
      payload: payload as SubAgentMemoryPayload,
      weight: row.weight,
      createdAt: row.created_at,
    })
    if (!Number.isSafeInteger(row.seq) || row.seq < 1) {
      throw new Error(
        `SessionMemoryEventStore: invalid sequence for ${conversationId}/${row.source_event_id}`
      )
    }
    if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
      throw new Error(
        `SessionMemoryEventStore: invalid revision for ${conversationId}/${row.source_event_id}`
      )
    }
    return {
      ...normalized,
      seq: row.seq,
      revision: row.revision,
    }
  }

  private toMemoryEntry(
    event: PersistedSubAgentMemoryEvent
  ): ContextSessionMemoryEntry {
    const text = formatSubAgentMemoryEntry(event.payload)
    return {
      id: event.sourceEventId,
      kind: "sub_agent",
      text,
      sourceEventId: event.sourceEventId,
      sourceToolUseId: event.sourceToolUseId,
      sourceRecordUuid: event.sourceRecordUuid,
      sourceKind: event.sourceKind,
      revision: event.revision,
      createdAt: event.createdAt,
      weight: event.weight,
    }
  }

  private isSameEvent(
    existing: PersistedSubAgentMemoryEvent,
    candidate: Omit<PersistedSubAgentMemoryEvent, "seq" | "revision">
  ): boolean {
    return (
      existing.sourceEventId === candidate.sourceEventId &&
      existing.sourceToolUseId === candidate.sourceToolUseId &&
      existing.sourceRecordUuid === candidate.sourceRecordUuid &&
      existing.sourceKind === candidate.sourceKind &&
      existing.weight === candidate.weight &&
      existing.createdAt === candidate.createdAt &&
      JSON.stringify(existing.payload) === JSON.stringify(candidate.payload)
    )
  }

  /**
   * `sourceEventId` identifies one accepted terminal delivery. Later rows may
   * revise its lifecycle payload, but they must never rebind the event to a
   * different task invocation, graph fragment, or delivery route.
   */
  private assertImmutableProvenance(
    existing: PersistedSubAgentMemoryEvent,
    candidate: Omit<PersistedSubAgentMemoryEvent, "seq" | "revision">
  ): void {
    if (
      existing.sourceToolUseId !== candidate.sourceToolUseId ||
      existing.sourceRecordUuid !== candidate.sourceRecordUuid ||
      existing.sourceKind !== candidate.sourceKind
    ) {
      throw new Error(
        `SessionMemoryEventStore: provenance is immutable for ${candidate.conversationId}/${candidate.sourceEventId}`
      )
    }
  }

  private requireNonEmptyText(value: unknown, field: string): string {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.includes("\u0000")
    ) {
      throw new Error(`SessionMemoryEventStore: ${field} is required`)
    }
    return value
  }

  private requireExactIdentifier(value: unknown, field: string): string {
    const identifier = requireExactDurableIdentifier(
      value,
      `SessionMemoryEventStore ${field}`
    )
    if (/\s/.test(identifier)) {
      throw new Error(
        `SessionMemoryEventStore: ${field} must be a non-empty whitespace-free identifier`
      )
    }
    return identifier
  }

  private assertTxn(txn: SessionTxn): void {
    if (!txn || txn.tag !== SESSION_TXN_TAG) {
      throw new Error(
        "SessionMemoryEventStore: appendInTransaction requires a MessageStore transaction"
      )
    }
  }
}
