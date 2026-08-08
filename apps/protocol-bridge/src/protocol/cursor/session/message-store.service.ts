import { Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import {
  requireExactDurableIdentifier,
  requireOptionalExactDurableIdentifier,
} from "../../../context/durable-identifier"
import { PersistenceService } from "../../../persistence"
import type { ContentBlock, ToolResultBlock } from "../../../context/types"
import type { ConversationId, TurnId } from "../turn/turn.types"
import {
  ToolCallLedger,
  type SessionTxn,
  type SessionTxnInternal,
  SESSION_TXN_TAG,
} from "./tool-call-ledger.service"

/** Content that belongs to an assistant transcript fragment. */
export type AssistantContentBlock = Exclude<
  ContentBlock,
  ToolResultBlock | { type: "cache_edits" }
>

/**
 * Immutable graph identity carried by every durable transcript fragment.
 * Provider identifiers deliberately do not imply uniqueness: a streamed
 * provider message may have many local content-block fragments.
 */
export interface MessageGraphIdentity {
  parentUuid?: string
  logicalParentUuid?: string
  sourceToolAssistantUuid?: string
  provider?: string
  providerMessageId?: string
  blockOccurrence?: number
  turnId?: TurnId
  threadId?: string
  branchId?: string
  agentId?: string
  isSidechain?: boolean
  forkSourceUuid?: string
  forkLineage?: readonly string[]
  timestamp?: number
}

export interface AssistantBlockOpts extends MessageGraphIdentity {
  /**
   * Imported Cursor history predates any bridge runtime turn. Its assistant
   * fragments must therefore retain a NULL graph turn instead of receiving a
   * synthetic initial-turn identity.
   */
  turnId?: TurnId
  /** Final provider metadata arrives as a later message revision. */
  metadata?: Record<string, unknown>
}

export interface ToolResultBlockOpts extends MessageGraphIdentity {
  /**
   * Imported Cursor history has no bridge runtime turn. Its later official
   * tool_result must retain that NULL identity rather than borrowing the
   * current live turn.
   */
  turnId?: TurnId
  metadata?: Record<string, unknown>
}

export interface UserMessageOpts extends MessageGraphIdentity {
  isMeta?: boolean
  metadata?: Record<string, unknown>
}

export interface PersistedMessage extends MessageGraphIdentity {
  conversationId: ConversationId
  seq: number
  uuid: string
  role: "user" | "assistant"
  isMeta: boolean
  timestamp: number
  content: ContentBlock[]
  metadata?: Record<string, unknown>
}

export interface PersistedMessageRevision {
  conversationId: ConversationId
  messageUuid: string
  revisionSeq: number
  revisionKind: string
  payload: Record<string, unknown>
  createdAt: number
}

export interface AppendResult {
  recordUuid: string
  seq: number
  /**
   * Exact row accepted by the current transaction. Callers use this receipt
   * to prepare their mounted read model before the transaction returns,
   * rather than re-reading SQLite after commit and creating an ambiguous
   * "durable but reported failed" boundary.
   */
  message: PersistedMessage
}

export interface AppendMessageRevisionArgs {
  messageUuid: string
  revisionKind: string
  payload: Record<string, unknown>
  createdAt?: number
}

/**
 * SQLite owner for the durable conversation graph.
 *
 * The table stores accepted fragments immediately. There is intentionally no
 * in-memory commit/rollback protocol here: a failed or interrupted turn is a
 * fact that belongs in turn_events, not a reason to delete its transcript.
 * Later usage/stop/signature data is append-only in session_message_revisions.
 */
@Injectable()
export class MessageStore {
  private stmtMaxSeq?: StatementSync
  private stmtInsert?: StatementSync
  private stmtGetByConversation?: StatementSync
  private stmtGetByThread?: StatementSync
  private stmtGetAfterSeq?: StatementSync
  private stmtGetByUuid?: StatementSync
  private stmtLatestUuid?: StatementSync
  private stmtNextOccurrence?: StatementSync
  private stmtGetToolUseUuid?: StatementSync
  private stmtGetToolResultUuid?: StatementSync
  private stmtMessageExists?: StatementSync
  private stmtHasMessages?: StatementSync
  private stmtNextRevisionSeq?: StatementSync
  private stmtInsertRevision?: StatementSync
  private stmtGetRevisions?: StatementSync
  private stmtGetSubagentBranchRevisions?: StatementSync
  private stmtGetAllRevisions?: StatementSync

  constructor(
    private readonly persistence: PersistenceService,
    private readonly ledger: ToolCallLedger
  ) {}

  runInTransaction<T>(
    conversationId: ConversationId,
    fn: (txn: SessionTxn) => T
  ): T {
    const txn: SessionTxnInternal = {
      conversationId,
      tag: SESSION_TXN_TAG,
      persistence: this.persistence,
      acceptedToolResultReceipts: new Map(),
    }
    return this.persistence.runInImmediateTransaction(() => fn(txn))
  }

  hasMessages(conversationId: ConversationId): boolean {
    return Boolean(
      (this.stmtHasMessages ??= this.persistence.prepare(
        `SELECT 1 FROM session_messages
          WHERE conversation_id = ?
          LIMIT 1`
      )).get(conversationId)
    )
  }

  appendAssistantBlock(
    txn: SessionTxn,
    block: AssistantContentBlock,
    opts: AssistantBlockOpts
  ): AppendResult {
    return this.appendInternal(txn, {
      role: "assistant",
      content: [block],
      isMeta: false,
      metadata: opts.metadata,
      graph: opts,
    })
  }

  appendToolResultBlock(
    txn: SessionTxn,
    block: ToolResultBlock,
    opts: ToolResultBlockOpts
  ): AppendResult {
    this.assertTxn(txn)
    if (!this.ledger.isOpen(txn.conversationId, block.tool_use_id)) {
      throw new Error(
        `MessageStore.appendToolResultBlock: no open ledger entry for ` +
          `conversation=${txn.conversationId} tool_use_id=${block.tool_use_id}`
      )
    }
    const sourceToolAssistantUuid =
      opts.sourceToolAssistantUuid ??
      this.findToolUseMessageUuid(txn.conversationId, block.tool_use_id)
    if (!sourceToolAssistantUuid) {
      throw new Error(
        `MessageStore.appendToolResultBlock: ledger tool_use has no transcript fragment ` +
          `conversation=${txn.conversationId} tool_use_id=${block.tool_use_id}`
      )
    }
    const graph = this.resolveToolResultGraphIdentity(
      txn.conversationId,
      sourceToolAssistantUuid,
      opts
    )
    const append = this.appendInternal(txn, {
      role: "user",
      content: [block],
      isMeta: false,
      metadata: opts.metadata,
      graph: {
        ...graph,
        parentUuid: opts.parentUuid ?? sourceToolAssistantUuid,
        sourceToolAssistantUuid,
      },
    })
    this.ledger.close(txn, {
      toolUseId: block.tool_use_id,
      closeMessageSeq: append.seq,
    })
    txn.acceptedToolResultReceipts.set(block.tool_use_id, {
      recordUuid: append.recordUuid,
      seq: append.seq,
    })
    return append
  }

  /**
   * Assert that a mutation trigger is the exact normal tool-result receipt
   * appended by this still-open `MessageStore.runInTransaction` callback.
   * A previously committed historical receipt is valid as a mutation target,
   * but cannot be reused later as a new mutation trigger.
   */
  assertAcceptedToolResultReceiptInTransaction(
    txn: SessionTxn,
    input: { toolUseId: string; recordUuid: string }
  ): void {
    this.assertTxn(txn)
    const toolUseId = requireExactDurableIdentifier(
      input.toolUseId,
      "MessageStore accepted tool-result receipt toolUseId"
    )
    const recordUuid = requireExactDurableIdentifier(
      input.recordUuid,
      "MessageStore accepted tool-result receipt UUID"
    )
    const receipt = txn.acceptedToolResultReceipts.get(toolUseId)
    if (!receipt || receipt.recordUuid !== recordUuid) {
      throw new Error(
        `MessageStore: mutation trigger is not this transaction's accepted tool_result ` +
          `conversation=${txn.conversationId} toolUseId=${toolUseId}`
      )
    }
  }

  /**
   * Used only by the explicit interruption path after the ledger has already
   * moved to aborted. It persists the observed terminal record; it never
   * synthesizes one during normal transcript writes.
   */
  appendAbortToolResultBlock(
    txn: SessionTxn,
    block: ToolResultBlock,
    opts: ToolResultBlockOpts
  ): AppendResult {
    this.assertTxn(txn)
    const sourceToolAssistantUuid =
      opts.sourceToolAssistantUuid ??
      this.findToolUseMessageUuid(txn.conversationId, block.tool_use_id)
    if (!sourceToolAssistantUuid) {
      throw new Error(
        `MessageStore.appendAbortToolResultBlock: ledger tool_use has no transcript fragment ` +
          `conversation=${txn.conversationId} tool_use_id=${block.tool_use_id}`
      )
    }
    const graph = this.resolveToolResultGraphIdentity(
      txn.conversationId,
      sourceToolAssistantUuid,
      opts
    )
    return this.appendInternal(txn, {
      role: "user",
      content: [block],
      isMeta: false,
      metadata: opts.metadata,
      graph: {
        ...graph,
        parentUuid: opts.parentUuid ?? sourceToolAssistantUuid,
        sourceToolAssistantUuid,
      },
    })
  }

  private resolveToolResultGraphIdentity(
    conversationId: ConversationId,
    sourceToolAssistantUuid: string,
    opts: ToolResultBlockOpts
  ): ToolResultBlockOpts {
    const source = this.getMessageByUuid(
      conversationId,
      sourceToolAssistantUuid
    )
    if (!source || source.role !== "assistant") {
      throw new Error(
        `MessageStore: tool_result source is not an assistant graph fragment ` +
          `conversation=${conversationId} uuid=${sourceToolAssistantUuid}`
      )
    }
    const inherited = {
      turnId: source.turnId,
      threadId: source.threadId,
      branchId: source.branchId,
      agentId: source.agentId,
      isSidechain: source.isSidechain,
      forkSourceUuid: source.forkSourceUuid,
      forkLineage: source.forkLineage,
    }
    for (const [field, expected] of Object.entries(inherited)) {
      const actual = opts[field as keyof typeof inherited]
      if (
        actual !== undefined &&
        JSON.stringify(actual) !== JSON.stringify(expected)
      ) {
        throw new Error(
          `MessageStore: tool_result graph identity conflicts with tool_use ` +
            `conversation=${conversationId} uuid=${sourceToolAssistantUuid} ` +
            `field=${field}`
        )
      }
    }
    return {
      ...opts,
      ...inherited,
    }
  }

  appendUserMessage(
    txn: SessionTxn,
    content: ContentBlock[],
    opts: UserMessageOpts = {}
  ): AppendResult {
    return this.appendInternal(txn, {
      role: "user",
      content,
      isMeta: opts.isMeta === true,
      metadata: opts.metadata,
      graph: opts,
    })
  }

  /**
   * Append finalization/projection metadata without mutating the accepted
   * fragment. Callers must choose a typed revision kind; this store performs
   * no content reconciliation or heuristic merge.
   */
  appendMessageRevision(
    txn: SessionTxn,
    args: AppendMessageRevisionArgs
  ): PersistedMessageRevision {
    this.assertTxn(txn)
    const messageUuid = requireExactDurableIdentifier(
      args.messageUuid,
      "MessageStore.appendMessageRevision messageUuid"
    )
    const revisionKind = requireExactDurableIdentifier(
      args.revisionKind,
      "MessageStore.appendMessageRevision revisionKind"
    )
    const exists = (this.stmtMessageExists ??= this.persistence.prepare(
      `SELECT 1 FROM session_messages
        WHERE conversation_id = ? AND uuid = ? LIMIT 1`
    )).get(txn.conversationId, messageUuid)
    if (!exists) {
      throw new Error(
        `MessageStore.appendMessageRevision: unknown message ` +
          `conversation=${txn.conversationId} uuid=${messageUuid}`
      )
    }
    const next = (this.stmtNextRevisionSeq ??= this.persistence.prepare(
      `SELECT COALESCE(MAX(revision_seq), 0) + 1 AS next_seq
         FROM session_message_revisions
        WHERE conversation_id = ? AND message_uuid = ?`
    )).get(txn.conversationId, messageUuid) as { next_seq: number } | undefined
    const revisionSeq = next?.next_seq ?? 1
    const createdAt = args.createdAt ?? Date.now()
    const payloadJson = JSON.stringify(args.payload)
    ;(this.stmtInsertRevision ??= this.persistence.prepare(
      `INSERT INTO session_message_revisions (
         conversation_id, message_uuid, revision_seq, revision_kind,
         payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )).run(
      txn.conversationId,
      messageUuid,
      revisionSeq,
      revisionKind,
      payloadJson,
      createdAt
    )
    return {
      conversationId: txn.conversationId,
      messageUuid,
      revisionSeq,
      revisionKind,
      payload: args.payload,
      createdAt,
    }
  }

  getMessages(conversationId: ConversationId): PersistedMessage[] {
    const stmt = (this.stmtGetByConversation ??= this.persistence.prepare(
      `SELECT seq, uuid, parent_uuid, logical_parent_uuid,
              source_tool_assistant_uuid, provider, provider_message_id,
              role, is_meta, block_occurrence, turn_id, thread_id,
              branch_id, agent_id, is_sidechain, fork_source_uuid,
              fork_lineage_json,
              timestamp, content_json, metadata_json
         FROM session_messages
        WHERE conversation_id = ?
        ORDER BY seq ASC`
    ))
    const rows = stmt.all(conversationId) as unknown as MessageRow[]
    return rows.map((row) => this.rowToMessage(conversationId, row))
  }

  /**
   * Read one durable sidechain thread. This is the only read path used to
   * rebuild a sub-agent prompt; transcript/export artifacts are deliberately
   * not consulted here.
   */
  getSubagentBranchMessages(
    conversationId: ConversationId,
    threadId: string
  ): PersistedMessage[] {
    const exactThreadId = requireExactDurableIdentifier(
      threadId,
      "MessageStore.getSubagentBranchMessages threadId"
    )
    const stmt = (this.stmtGetByThread ??= this.persistence.prepare(
      `SELECT seq, uuid, parent_uuid, logical_parent_uuid,
              source_tool_assistant_uuid, provider, provider_message_id,
              role, is_meta, block_occurrence, turn_id, thread_id,
              branch_id, agent_id, is_sidechain, fork_source_uuid,
              fork_lineage_json,
              timestamp, content_json, metadata_json
         FROM session_messages
        WHERE conversation_id = ?
          AND thread_id = ?
          AND is_sidechain = 1
        ORDER BY seq ASC`
    ))
    const rows = stmt.all(
      conversationId,
      exactThreadId
    ) as unknown as MessageRow[]
    return rows.map((row) => this.rowToMessage(conversationId, row))
  }

  /**
   * Resolve the durable graph record that owns a tool-use id. The lookup is
   * intentionally ledger-backed so an arbitrary content-shaped row cannot be
   * used as a fork source.
   */
  getToolUseMessage(
    conversationId: ConversationId,
    toolUseId: string
  ): PersistedMessage | undefined {
    const exactToolUseId = requireExactDurableIdentifier(
      toolUseId,
      "MessageStore.getToolUseMessage toolUseId"
    )
    const uuid = this.findToolUseMessageUuid(conversationId, exactToolUseId)
    return uuid ? this.getMessageByUuid(conversationId, uuid) : undefined
  }

  /**
   * Resolve a terminal tool-result through the ledger's close sequence.
   * This intentionally does not scan message text: callers that need a
   * durable source relation either get the ledger-owned graph UUID or fail.
   */
  getToolResultMessage(
    conversationId: ConversationId,
    toolUseId: string
  ): PersistedMessage | undefined {
    const exactToolUseId = requireExactDurableIdentifier(
      toolUseId,
      "MessageStore.getToolResultMessage toolUseId"
    )
    const row = (this.stmtGetToolResultUuid ??= this.persistence.prepare(
      `SELECT m.uuid
         FROM tool_call_ledger l
         JOIN session_messages m
           ON m.conversation_id = l.conversation_id
          AND m.seq = l.close_message_seq
        WHERE l.conversation_id = ?
          AND l.tool_use_id = ?
          AND l.state = 'closed'
          AND l.close_message_seq IS NOT NULL
        LIMIT 1`
    )).get(conversationId, exactToolUseId) as { uuid?: string } | undefined
    if (!row?.uuid) return undefined
    const message = this.getMessageByUuid(conversationId, row.uuid)
    if (!message) {
      throw new Error(
        `MessageStore.getToolResultMessage: closed ledger result is missing ` +
          `conversation=${conversationId} toolUseId=${exactToolUseId}`
      )
    }
    const hasMatchingResult = message.content.some(
      (block) =>
        block.type === "tool_result" && block.tool_use_id === exactToolUseId
    )
    if (!hasMatchingResult) {
      throw new Error(
        `MessageStore.getToolResultMessage: close sequence does not own the result ` +
          `conversation=${conversationId} toolUseId=${exactToolUseId}`
      )
    }
    return message
  }

  getMessagesAfter(
    conversationId: ConversationId,
    seqExclusive: number
  ): PersistedMessage[] {
    const stmt = (this.stmtGetAfterSeq ??= this.persistence.prepare(
      `SELECT seq, uuid, parent_uuid, logical_parent_uuid,
              source_tool_assistant_uuid, provider, provider_message_id,
              role, is_meta, block_occurrence, turn_id, thread_id,
              branch_id, agent_id, is_sidechain, fork_source_uuid,
              fork_lineage_json,
              timestamp, content_json, metadata_json
         FROM session_messages
        WHERE conversation_id = ? AND seq > ?
        ORDER BY seq ASC`
    ))
    const rows = stmt.all(
      conversationId,
      seqExclusive
    ) as unknown as MessageRow[]
    return rows.map((row) => this.rowToMessage(conversationId, row))
  }

  getMessageByUuid(
    conversationId: ConversationId,
    uuid: string
  ): PersistedMessage | undefined {
    const exactUuid = requireExactDurableIdentifier(
      uuid,
      "MessageStore.getMessageByUuid uuid"
    )
    const stmt = (this.stmtGetByUuid ??= this.persistence.prepare(
      `SELECT seq, uuid, parent_uuid, logical_parent_uuid,
              source_tool_assistant_uuid, provider, provider_message_id,
              role, is_meta, block_occurrence, turn_id, thread_id,
              branch_id, agent_id, is_sidechain, fork_source_uuid,
              fork_lineage_json,
              timestamp, content_json, metadata_json
         FROM session_messages
        WHERE conversation_id = ? AND uuid = ?
        LIMIT 1`
    ))
    const row = stmt.get(conversationId, exactUuid) as MessageRow | undefined
    return row ? this.rowToMessage(conversationId, row) : undefined
  }

  getMessageRevisions(
    conversationId: ConversationId,
    messageUuid: string
  ): PersistedMessageRevision[] {
    const exactMessageUuid = requireExactDurableIdentifier(
      messageUuid,
      "MessageStore.getMessageRevisions messageUuid"
    )
    const stmt = (this.stmtGetRevisions ??= this.persistence.prepare(
      `SELECT revision_seq, revision_kind, payload_json, created_at
         FROM session_message_revisions
        WHERE conversation_id = ? AND message_uuid = ?
        ORDER BY revision_seq ASC`
    ))
    const rows = stmt.all(
      conversationId,
      exactMessageUuid
    ) as unknown as Array<{
      revision_seq: number
      revision_kind: string
      payload_json: string
      created_at: number
    }>
    return rows.map((row) => ({
      conversationId,
      messageUuid: exactMessageUuid,
      revisionSeq: requirePositiveRevisionSequence(
        row.revision_seq,
        `MessageStore revision sequence conversation=${conversationId} uuid=${exactMessageUuid}`
      ),
      revisionKind: requireExactDurableIdentifier(
        row.revision_kind,
        "MessageStore stored revision kind"
      ),
      payload: this.parseObjectJson(
        row.payload_json,
        `revision payload conversation=${conversationId} uuid=${exactMessageUuid}`
      ),
      createdAt: requirePositiveTimestamp(
        row.created_at,
        `MessageStore revision createdAt conversation=${conversationId} uuid=${exactMessageUuid}`
      ),
    }))
  }

  /**
   * Read revisions for exactly one durable sidechain thread in one query.
   * This avoids both an N-query loop and the unrelated parent-graph revision
   * scan that `getAllMessageRevisions` would perform.
   */
  getSubagentBranchMessageRevisions(
    conversationId: ConversationId,
    threadId: string
  ): PersistedMessageRevision[] {
    const exactThreadId = requireExactDurableIdentifier(
      threadId,
      "MessageStore.getSubagentBranchMessageRevisions threadId"
    )
    const stmt = (this.stmtGetSubagentBranchRevisions ??=
      this.persistence.prepare(
        `SELECT revision.message_uuid, revision.revision_seq,
                revision.revision_kind, revision.payload_json,
                revision.created_at
           FROM session_message_revisions AS revision
           JOIN session_messages AS message
             ON message.conversation_id = revision.conversation_id
            AND message.uuid = revision.message_uuid
          WHERE revision.conversation_id = ?
            AND message.thread_id = ?
            AND message.is_sidechain = 1
          ORDER BY message.seq ASC, revision.revision_seq ASC`
      ))
    const rows = stmt.all(conversationId, exactThreadId) as unknown as Array<{
      message_uuid: string
      revision_seq: number
      revision_kind: string
      payload_json: string
      created_at: number
    }>
    return rows.map((row) => ({
      conversationId,
      messageUuid: requireExactDurableIdentifier(
        row.message_uuid,
        "MessageStore stored sidechain revision message UUID"
      ),
      revisionSeq: requirePositiveRevisionSequence(
        row.revision_seq,
        `MessageStore sidechain revision sequence conversation=${conversationId}`
      ),
      revisionKind: requireExactDurableIdentifier(
        row.revision_kind,
        "MessageStore stored sidechain revision kind"
      ),
      payload: this.parseObjectJson(
        row.payload_json,
        `sidechain revision payload conversation=${conversationId} uuid=${row.message_uuid}`
      ),
      createdAt: requirePositiveTimestamp(
        row.created_at,
        `MessageStore sidechain revision createdAt conversation=${conversationId}`
      ),
    }))
  }

  /**
   * Read all revisions for a graph projection in one query. Recovery uses
   * this instead of issuing one revision lookup per transcript fragment.
   */
  getAllMessageRevisions(
    conversationId: ConversationId
  ): PersistedMessageRevision[] {
    const stmt = (this.stmtGetAllRevisions ??= this.persistence.prepare(
      `SELECT message_uuid, revision_seq, revision_kind, payload_json, created_at
         FROM session_message_revisions
        WHERE conversation_id = ?
        ORDER BY message_uuid ASC, revision_seq ASC`
    ))
    const rows = stmt.all(conversationId) as unknown as Array<{
      message_uuid: string
      revision_seq: number
      revision_kind: string
      payload_json: string
      created_at: number
    }>
    return rows.map((row) => ({
      conversationId,
      messageUuid: requireExactDurableIdentifier(
        row.message_uuid,
        "MessageStore stored revision message UUID"
      ),
      revisionSeq: requirePositiveRevisionSequence(
        row.revision_seq,
        `MessageStore revision sequence conversation=${conversationId}`
      ),
      revisionKind: requireExactDurableIdentifier(
        row.revision_kind,
        "MessageStore stored revision kind"
      ),
      payload: this.parseObjectJson(
        row.payload_json,
        `revision payload conversation=${conversationId} uuid=${row.message_uuid}`
      ),
      createdAt: requirePositiveTimestamp(
        row.created_at,
        `MessageStore revision createdAt conversation=${conversationId}`
      ),
    }))
  }

  private appendInternal(
    txn: SessionTxn,
    args: {
      role: "user" | "assistant"
      content: ContentBlock[]
      metadata?: Record<string, unknown>
      isMeta: boolean
      graph: MessageGraphIdentity
    }
  ): AppendResult {
    this.assertTxn(txn)
    assertDurableContentBlocks(args.content, "content write")
    const graph = requireMessageGraphIdentity(args.graph)
    const seq = this.nextMessageSeq(txn.conversationId)
    const uuid = crypto.randomUUID()
    const parentUuid = graph.parentUuid ?? this.latestUuid(txn.conversationId)
    const blockOccurrence =
      graph.blockOccurrence ??
      this.nextBlockOccurrence(
        txn.conversationId,
        graph.provider,
        graph.providerMessageId
      )
    const timestamp = graph.timestamp ?? Date.now()
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new Error("MessageStore.append: timestamp must be a positive epoch")
    }
    const insert = (this.stmtInsert ??= this.persistence.prepare(
      `INSERT INTO session_messages (
         conversation_id, seq, uuid, parent_uuid, logical_parent_uuid,
         source_tool_assistant_uuid, provider, provider_message_id, role,
         is_meta, block_occurrence, turn_id, thread_id, branch_id, agent_id,
         is_sidechain, fork_source_uuid, fork_lineage_json, timestamp,
         content_json, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ))
    const persistedTimestamp = Math.floor(timestamp)
    const contentJson = JSON.stringify(args.content)
    const metadataJson = args.metadata ? JSON.stringify(args.metadata) : null
    insert.run(
      txn.conversationId,
      seq,
      uuid,
      parentUuid ?? null,
      graph.logicalParentUuid ?? null,
      graph.sourceToolAssistantUuid ?? null,
      graph.provider ?? null,
      graph.providerMessageId ?? null,
      args.role,
      args.isMeta ? 1 : 0,
      blockOccurrence,
      graph.turnId ?? null,
      graph.threadId ?? null,
      graph.branchId ?? null,
      graph.agentId ?? null,
      graph.isSidechain === true ? 1 : 0,
      graph.forkSourceUuid ?? null,
      graph.forkLineage ? JSON.stringify([...graph.forkLineage]) : null,
      persistedTimestamp,
      contentJson,
      metadataJson
    )
    return {
      recordUuid: uuid,
      seq,
      message: {
        conversationId: txn.conversationId,
        seq,
        uuid,
        parentUuid,
        logicalParentUuid: graph.logicalParentUuid,
        sourceToolAssistantUuid: graph.sourceToolAssistantUuid,
        provider: graph.provider,
        providerMessageId: graph.providerMessageId,
        role: args.role,
        isMeta: args.isMeta,
        blockOccurrence,
        turnId: graph.turnId,
        threadId: graph.threadId,
        branchId: graph.branchId,
        agentId: graph.agentId,
        isSidechain: graph.isSidechain === true,
        forkSourceUuid: graph.forkSourceUuid,
        forkLineage: graph.forkLineage ? [...graph.forkLineage] : undefined,
        timestamp: persistedTimestamp,
        // Use the exact JSON representation written above. This keeps the
        // transaction receipt byte-semantically aligned with a cold read
        // when optional object properties were omitted by JSON encoding.
        content: JSON.parse(contentJson) as ContentBlock[],
        metadata: metadataJson
          ? (JSON.parse(metadataJson) as Record<string, unknown>)
          : undefined,
      },
    }
  }

  private nextMessageSeq(conversationId: ConversationId): number {
    const row = (this.stmtMaxSeq ??= this.persistence.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM session_messages WHERE conversation_id = ?`
    )).get(conversationId) as { next_seq: number } | undefined
    return row?.next_seq ?? 1
  }

  private latestUuid(conversationId: ConversationId): string | undefined {
    const row = (this.stmtLatestUuid ??= this.persistence.prepare(
      `SELECT uuid FROM session_messages
        WHERE conversation_id = ?
        ORDER BY seq DESC LIMIT 1`
    )).get(conversationId) as { uuid: string } | undefined
    return requireOptionalExactDurableIdentifier(
      row?.uuid,
      "MessageStore stored latest UUID"
    )
  }

  private nextBlockOccurrence(
    conversationId: ConversationId,
    provider: string | undefined,
    providerMessageId: string | undefined
  ): number {
    if (!provider || !providerMessageId) return 0
    const row = (this.stmtNextOccurrence ??= this.persistence.prepare(
      `SELECT COALESCE(MAX(block_occurrence), -1) + 1 AS next_occurrence
         FROM session_messages
        WHERE conversation_id = ? AND provider = ? AND provider_message_id = ?`
    )).get(conversationId, provider, providerMessageId) as
      | { next_occurrence: number }
      | undefined
    return row?.next_occurrence ?? 0
  }

  private findToolUseMessageUuid(
    conversationId: ConversationId,
    toolUseId: string
  ): string | undefined {
    const row = (this.stmtGetToolUseUuid ??= this.persistence.prepare(
      `SELECT message.uuid
         FROM tool_call_ledger ledger
         JOIN session_messages message
           ON message.conversation_id = ledger.conversation_id
          AND message.seq = ledger.open_message_seq
        WHERE ledger.conversation_id = ? AND ledger.tool_use_id = ?
        LIMIT 1`
    )).get(conversationId, toolUseId) as { uuid: string } | undefined
    return requireOptionalExactDurableIdentifier(
      row?.uuid,
      "MessageStore stored tool-use source UUID"
    )
  }

  private rowToMessage(
    conversationId: ConversationId,
    row: MessageRow
  ): PersistedMessage {
    if (!Number.isSafeInteger(row.seq) || row.seq < 1) {
      throw new Error(
        `MessageStore: invalid stored sequence for ${conversationId}`
      )
    }
    if (
      (row.role !== "user" && row.role !== "assistant") ||
      (row.is_meta !== 0 && row.is_meta !== 1) ||
      (row.is_sidechain !== 0 && row.is_sidechain !== 1) ||
      !Number.isSafeInteger(row.block_occurrence) ||
      row.block_occurrence < 0 ||
      !Number.isSafeInteger(row.timestamp) ||
      row.timestamp <= 0
    ) {
      throw new Error(
        `MessageStore: invalid stored graph metadata for ${conversationId}`
      )
    }
    const uuid = requireExactDurableIdentifier(
      row.uuid,
      "MessageStore stored UUID"
    )
    const graph = requireMessageGraphIdentity({
      parentUuid: row.parent_uuid ?? undefined,
      logicalParentUuid: row.logical_parent_uuid ?? undefined,
      sourceToolAssistantUuid: row.source_tool_assistant_uuid ?? undefined,
      provider: row.provider ?? undefined,
      providerMessageId: row.provider_message_id ?? undefined,
      turnId: row.turn_id ? (row.turn_id as TurnId) : undefined,
      threadId: row.thread_id ?? undefined,
      branchId: row.branch_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      isSidechain: row.is_sidechain === 1,
      forkSourceUuid: row.fork_source_uuid ?? undefined,
      forkLineage: row.fork_lineage_json
        ? this.parseStringArray(
            row.fork_lineage_json,
            `fork lineage conversation=${conversationId} uuid=${uuid}`
          )
        : undefined,
      blockOccurrence: row.block_occurrence,
      timestamp: row.timestamp,
    })
    return {
      conversationId,
      seq: row.seq,
      uuid,
      parentUuid: graph.parentUuid,
      logicalParentUuid: graph.logicalParentUuid,
      sourceToolAssistantUuid: graph.sourceToolAssistantUuid,
      provider: graph.provider,
      providerMessageId: graph.providerMessageId,
      role: row.role,
      isMeta: row.is_meta === 1,
      blockOccurrence: row.block_occurrence,
      turnId: graph.turnId,
      threadId: graph.threadId,
      branchId: graph.branchId,
      agentId: graph.agentId,
      isSidechain: graph.isSidechain === true,
      forkSourceUuid: graph.forkSourceUuid,
      forkLineage: graph.forkLineage,
      timestamp: row.timestamp,
      content: this.parseContentJson(
        row.content_json,
        `content conversation=${conversationId} uuid=${row.uuid}`
      ),
      metadata: row.metadata_json
        ? this.parseObjectJson(
            row.metadata_json,
            `metadata conversation=${conversationId} uuid=${row.uuid}`
          )
        : undefined,
    }
  }

  private parseContentJson(value: string, label: string): ContentBlock[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      throw new Error(
        `MessageStore: invalid ${label}: ${(error as Error).message}`
      )
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `MessageStore: invalid ${label}: expected content block array`
      )
    }
    assertDurableContentBlocks(parsed, label)
    return parsed
  }

  private parseObjectJson(
    value: string,
    label: string
  ): Record<string, unknown> {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      throw new Error(
        `MessageStore: invalid ${label}: ${(error as Error).message}`
      )
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`MessageStore: invalid ${label}: expected object`)
    }
    return parsed as Record<string, unknown>
  }

  private parseStringArray(value: string, label: string): string[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      throw new Error(
        `MessageStore: invalid ${label}: ${(error as Error).message}`
      )
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((entry) => typeof entry !== "string")
    ) {
      throw new Error(`MessageStore: invalid ${label}: expected string array`)
    }
    return parsed.map((entry, index) =>
      requireExactDurableIdentifier(entry, `MessageStore ${label}[${index}]`)
    )
  }

  private assertTxn(txn: SessionTxn): asserts txn is SessionTxnInternal {
    if (!txn || txn.tag !== SESSION_TXN_TAG) {
      throw new Error(
        "MessageStore: write methods require a SessionTxn from runInTransaction()"
      )
    }
  }
}

interface MessageRow {
  seq: number
  uuid: string
  parent_uuid: string | null
  logical_parent_uuid: string | null
  source_tool_assistant_uuid: string | null
  provider: string | null
  provider_message_id: string | null
  role: "user" | "assistant"
  is_meta: number
  block_occurrence: number
  turn_id: string | null
  thread_id: string | null
  branch_id: string | null
  agent_id: string | null
  is_sidechain: number
  fork_source_uuid: string | null
  fork_lineage_json: string | null
  timestamp: number
  content_json: string
  metadata_json: string | null
}

function requireMessageGraphIdentity(
  graph: MessageGraphIdentity
): MessageGraphIdentity {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    throw new Error("MessageStore: graph identity must be an object")
  }
  if (
    graph.isSidechain !== undefined &&
    typeof graph.isSidechain !== "boolean"
  ) {
    throw new Error("MessageStore: graph isSidechain must be boolean")
  }
  if (
    graph.blockOccurrence !== undefined &&
    (!Number.isSafeInteger(graph.blockOccurrence) || graph.blockOccurrence < 0)
  ) {
    throw new Error("MessageStore: graph blockOccurrence must be non-negative")
  }
  if (
    graph.timestamp !== undefined &&
    (!Number.isFinite(graph.timestamp) || graph.timestamp <= 0)
  ) {
    throw new Error("MessageStore: graph timestamp must be positive")
  }
  const forkLineage = graph.forkLineage?.map((entry, index) =>
    requireExactDurableIdentifier(
      entry,
      `MessageStore graph fork lineage ${index}`
    )
  )
  return {
    ...graph,
    parentUuid: requireOptionalExactDurableIdentifier(
      graph.parentUuid,
      "MessageStore graph parent UUID"
    ),
    logicalParentUuid: requireOptionalExactDurableIdentifier(
      graph.logicalParentUuid,
      "MessageStore graph logical parent UUID"
    ),
    sourceToolAssistantUuid: requireOptionalExactDurableIdentifier(
      graph.sourceToolAssistantUuid,
      "MessageStore graph source tool assistant UUID"
    ),
    provider: requireOptionalExactDurableIdentifier(
      graph.provider,
      "MessageStore graph provider"
    ),
    providerMessageId: requireOptionalExactDurableIdentifier(
      graph.providerMessageId,
      "MessageStore graph provider message id"
    ),
    turnId: requireOptionalExactDurableIdentifier(
      graph.turnId,
      "MessageStore graph turn id"
    ) as TurnId | undefined,
    threadId: requireOptionalExactDurableIdentifier(
      graph.threadId,
      "MessageStore graph thread id"
    ),
    branchId: requireOptionalExactDurableIdentifier(
      graph.branchId,
      "MessageStore graph branch id"
    ),
    agentId: requireOptionalExactDurableIdentifier(
      graph.agentId,
      "MessageStore graph agent id"
    ),
    forkSourceUuid: requireOptionalExactDurableIdentifier(
      graph.forkSourceUuid,
      "MessageStore graph fork source UUID"
    ),
    ...(forkLineage ? { forkLineage } : {}),
  }
}

function requirePositiveRevisionSequence(
  value: unknown,
  label: string
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value as number
}

function requirePositiveTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value as number
}

/**
 * Durable graph content is a closed, JSON-exact protocol value.  Do not let
 * JSON.stringify coerce malformed runtime data (for example undefined array
 * entries or non-finite numbers) into a different cold-recovery payload.
 */
function assertDurableContentBlocks(
  value: unknown,
  label: string
): asserts value is ContentBlock[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `MessageStore: invalid ${label}: expected content block array`
    )
  }
  assertJsonValue(value, label, new Set<object>())
  for (const [index, block] of value.entries()) {
    assertDurableContentBlock(block, `${label}[${index}]`)
  }
}

function assertDurableContentBlock(value: unknown, label: string): void {
  const block = requirePlainRecord(value, label)
  const type = requireNonBlankString(block, "type", label)

  switch (type) {
    case "text":
      requireString(block, "text", label)
      assertCacheControl(block, label)
      return
    case "tool_use":
      requireDurableContentIdentifier(block, "id", label)
      requireDurableContentIdentifier(block, "name", label)
      requirePlainRecord(block.input, `${label}.input`)
      assertCacheControl(block, label)
      return
    case "tool_result": {
      requireDurableContentIdentifier(block, "tool_use_id", label)
      const content = block.content
      if (typeof content !== "string") {
        assertDurableContentBlocks(content, `${label}.content`)
      }
      if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
        throw new Error(
          `MessageStore: invalid ${label}.is_error: expected boolean`
        )
      }
      if (block.structuredContent !== undefined) {
        requirePlainRecord(
          block.structuredContent,
          `${label}.structuredContent`
        )
      }
      if (block.cache_reference !== undefined) {
        requireDurableContentIdentifier(block, "cache_reference", label)
      }
      assertCacheControl(block, label)
      return
    }
    case "image": {
      if (
        block.detail !== undefined &&
        block.detail !== "auto" &&
        block.detail !== "low" &&
        block.detail !== "high" &&
        block.detail !== "original"
      ) {
        throw new Error(
          `MessageStore: invalid ${label}.detail: unsupported image detail`
        )
      }
      const source = requirePlainRecord(block.source, `${label}.source`)
      if (source.type !== "base64") {
        throw new Error(
          `MessageStore: invalid ${label}.source.type: expected base64`
        )
      }
      const mediaType = requireString(source, "media_type", `${label}.source`)
      if (
        mediaType !== "image/jpeg" &&
        mediaType !== "image/png" &&
        mediaType !== "image/gif" &&
        mediaType !== "image/webp"
      ) {
        throw new Error(
          `MessageStore: invalid ${label}.source.media_type: unsupported image type`
        )
      }
      requireString(source, "data", `${label}.source`)
      assertCacheControl(block, label)
      return
    }
    case "thinking":
      requireString(block, "thinking", label)
      if (block.signature !== undefined) {
        requireString(block, "signature", label)
      }
      assertCacheControl(block, label)
      return
    case "redacted_thinking":
      requireString(block, "data", label)
      assertCacheControl(block, label)
      return
    case "cache_edits":
      if (!Array.isArray(block.edits)) {
        throw new Error(`MessageStore: invalid ${label}.edits: expected array`)
      }
      for (const [index, edit] of block.edits.entries()) {
        const entry = requirePlainRecord(edit, `${label}.edits[${index}]`)
        if (entry.type !== "delete") {
          throw new Error(
            `MessageStore: invalid ${label}.edits[${index}].type: expected delete`
          )
        }
        requireDurableContentIdentifier(
          entry,
          "cache_reference",
          `${label}.edits[${index}]`
        )
      }
      return
    default:
      throw new Error(
        `MessageStore: invalid ${label}.type: unsupported durable content block ${JSON.stringify(type)}`
      )
  }
}

function assertCacheControl(
  block: Record<string, unknown>,
  label: string
): void {
  if (block.cache_control === undefined) return
  const cacheControl = requirePlainRecord(
    block.cache_control,
    `${label}.cache_control`
  )
  requireNonBlankString(cacheControl, "type", `${label}.cache_control`)
  if (cacheControl.ttl !== undefined) {
    requireString(cacheControl, "ttl", `${label}.cache_control`)
  }
}

function requirePlainRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`MessageStore: invalid ${label}: expected plain object`)
  }
  return value as Record<string, unknown>
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  label: string
): string {
  const fieldValue = value[field]
  if (typeof fieldValue !== "string") {
    throw new Error(`MessageStore: invalid ${label}.${field}: expected string`)
  }
  return fieldValue
}

function requireNonBlankString(
  value: Record<string, unknown>,
  field: string,
  label: string
): string {
  const fieldValue = requireString(value, field, label)
  if (!fieldValue.trim()) {
    throw new Error(
      `MessageStore: invalid ${label}.${field}: expected non-blank string`
    )
  }
  return fieldValue
}

function requireDurableContentIdentifier(
  value: Record<string, unknown>,
  field: string,
  label: string
): string {
  return requireExactDurableIdentifier(
    value[field],
    `MessageStore ${label}.${field}`
  )
}

function assertJsonValue(
  value: unknown,
  label: string,
  ancestors: Set<object>
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return
    throw new Error(`MessageStore: invalid ${label}: non-finite number`)
  }
  if (typeof value !== "object") {
    throw new Error(`MessageStore: invalid ${label}: expected JSON value`)
  }
  if (ancestors.has(value)) {
    throw new Error(`MessageStore: invalid ${label}: circular JSON value`)
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`MessageStore: invalid ${label}: expected plain array`)
      }
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          throw new Error(
            `MessageStore: invalid ${label}[${index}]: sparse array`
          )
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error(
            `MessageStore: invalid ${label}[${index}]: expected enumerable data value`
          )
        }
        assertJsonValue(descriptor.value, `${label}[${index}]`, ancestors)
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue
        if (
          typeof key !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= value.length
        ) {
          throw new Error(
            `MessageStore: invalid ${label}: arrays may not carry non-index properties`
          )
        }
      }
      return
    }

    const prototype = Object.getPrototypeOf(value) as object | null
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`MessageStore: invalid ${label}: expected plain object`)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new Error(
          `MessageStore: invalid ${label}: symbol properties are not JSON`
        )
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(
          `MessageStore: invalid ${label}.${key}: expected enumerable data value`
        )
      }
      assertJsonValue(descriptor.value, `${label}.${key}`, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}
