import { Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import { PersistenceService } from "../../../persistence"
import { ConversationId, type TurnId } from "../turn/turn.types"
import { MessageStore, type PersistedMessage } from "./message-store.service"
import type {
  SubagentGraphBranch,
  SubagentGraphIdentity,
} from "./subagent-graph"
import {
  assertProjectionOwner,
  createSubagentProjectionOwner,
  type ProjectionOwner,
  type SubagentProjectionBranchSnapshot,
  type SubagentProjectionOwner,
} from "./projection-owner"
import {
  SubagentRunStore,
  type CreateSubagentRunInput,
  type SubagentRunRecord,
} from "./subagent-run-store.service"
import {
  SESSION_TXN_TAG,
  type SessionTxn,
  type SessionTxnInternal,
} from "./tool-call-ledger.service"

interface BranchHeadRow {
  head_uuid: string
  revision: number
}

/**
 * The only authority accepted by a sidechain graph write. It is deliberately
 * private to the session layer: a generic graph caller cannot smuggle branch
 * fields, a parent UUID, or a historical execution lease into an append.
 */
export type SubagentBranchWriteAuthority =
  | {
      readonly kind: "root"
      readonly branch: SubagentGraphBranch
      readonly runCreate: CreateSubagentRunInput
    }
  | {
      readonly kind: "continuation"
      readonly branch: SubagentGraphBranch
    }
  | {
      readonly kind: "recovered"
      readonly branch: SubagentGraphBranch
      readonly source: PersistedMessage
    }
  | {
      readonly kind: "abort"
      readonly source: PersistedMessage
    }

export interface SubagentBranchAppendPlan {
  readonly kind: SubagentBranchWriteAuthority["kind"]
  readonly branch: SubagentGraphBranch
  readonly run: SubagentRunRecord
  /** Loaded once for this transaction; every accepted row must belong to it. */
  readonly executionTurns: ReadonlySet<TurnId>
  /** The chronological branch tail used by the first ordinary fragment. */
  readonly parentUuid: string
  readonly expectedHead?: Readonly<{ uuid: string; revision: number }>
}

/** A stale writer must restart from the durable branch head, never fork it. */
export class SubagentBranchHeadConflictError extends Error {
  constructor(conversationId: ConversationId, agentId: string) {
    super(
      `SubagentBranchStore: branch head changed while appending ` +
        `conversation=${conversationId} agentId=${agentId}`
    )
    this.name = "SubagentBranchHeadConflictError"
  }
}

/**
 * Durable authority for one sub-agent graph branch.
 *
 * The run owns immutable branch identity. This store owns the mutable
 * chronological head and its CAS revision. Every append and every read
 * resolves these facts from SQLite; no hot transcript/cache is authority.
 */
@Injectable()
export class SubagentBranchStore {
  private stmtGetHead?: StatementSync
  private stmtInsertHead?: StatementSync
  private stmtAdvanceHead?: StatementSync

  constructor(
    private readonly persistence: PersistenceService,
    private readonly messageStore: MessageStore,
    private readonly subagentRunStore: SubagentRunStore
  ) {}

  /**
   * Build a pre-create branch request from the exact parent task graph source.
   * The root append independently derives the same source in its transaction,
   * therefore this prospective value can never become durable authority.
   */
  resolveProspectiveBranch(
    conversationId: string,
    args: {
      subagentId: string
      parentToolCallId: string
      executionTurnId: TurnId
    }
  ): SubagentGraphBranch {
    const cid = ConversationId.of(conversationId)
    const subagentId = this.requireIdentifier(args.subagentId, "subagentId")
    const parentToolCallId = this.requireIdentifier(
      args.parentToolCallId,
      "parentToolCallId"
    )
    const source = this.messageStore.getToolUseMessage(cid, parentToolCallId)
    if (!source) {
      throw new Error(
        `openSubagentGraphBranch: parent task tool_use is not a durable graph record ` +
          `conversation=${conversationId} toolUseId=${parentToolCallId}`
      )
    }
    if (!source.turnId) {
      throw new Error(
        `openSubagentGraphBranch: parent task graph record has no turn id ` +
          `conversation=${conversationId} uuid=${source.uuid}`
      )
    }
    if (source.turnId === args.executionTurnId) {
      throw new Error(
        `openSubagentGraphBranch: child execution turn reuses parent turn ` +
          `conversation=${conversationId} toolUseId=${parentToolCallId}`
      )
    }
    const ownsRequestedToolUse = source.content.some(
      (block) =>
        block.type === "tool_use" &&
        block.id === parentToolCallId &&
        block.name === "task"
    )
    if (!ownsRequestedToolUse) {
      throw new Error(
        `openSubagentGraphBranch: ledger source does not contain requested task tool_use ` +
          `conversation=${conversationId} toolUseId=${parentToolCallId} uuid=${source.uuid}`
      )
    }
    const inherited = source.forkLineage ? [...source.forkLineage] : []
    if (inherited.includes(source.uuid)) {
      throw new Error(
        `openSubagentGraphBranch: fork lineage already contains its source ` +
          `conversation=${conversationId} uuid=${source.uuid}`
      )
    }
    const threadId = `subagent:${subagentId}`
    return {
      conversationId: cid,
      parentToolCallId,
      subagentId,
      threadId,
      branchId: threadId,
      agentId: subagentId,
      forkSourceUuid: source.uuid,
      forkLineage: [...inherited, source.uuid],
      // A lease is intentionally not part of static branch identity.
      turnId: args.executionTurnId,
    }
  }

  /** Resolve an existing branch from the run's static durable identity. */
  resolveExistingBranch(
    conversationId: string,
    args: {
      subagentId: string
      parentToolCallId: string
      executionTurnId: TurnId
    }
  ): SubagentGraphBranch | undefined {
    const cid = ConversationId.of(conversationId)
    const subagentId = this.requireIdentifier(args.subagentId, "subagentId")
    const run = this.subagentRunStore.get(cid, subagentId)
    if (!run) return undefined
    if (
      run.parentToolCallId !==
      this.requireIdentifier(args.parentToolCallId, "parentToolCallId")
    ) {
      throw new Error(
        `openSubagentGraphBranch: durable parent task owner mismatch ` +
          `conversation=${conversationId} agentId=${subagentId}`
      )
    }
    if (
      run.status !== "running" ||
      run.executionTurnId !== args.executionTurnId
    ) {
      throw new Error(
        `SubagentBranchStore: execution lease is not the current run owner ` +
          `conversation=${conversationId} agentId=${run.agentId} turn=${args.executionTurnId}`
      )
    }
    return this.branchForRun(run, args.executionTurnId)
  }

  /**
   * Convert an already verified durable branch into the only supported child
   * projection owner. Projection writers never accept a hand-assembled
   * thread/branch tuple as authority.
   */
  createProjectionOwner(
    branch: SubagentGraphIdentity
  ): SubagentProjectionOwner {
    const run = this.requireRun(branch.conversationId, branch.agentId)
    this.assertProjectionIdentityMatchesRun(branch, run)
    if (
      branch.subagentId !== run.agentId ||
      branch.parentToolCallId !== run.parentToolCallId
    ) {
      throw new Error(
        `SubagentBranchStore: projection branch task identity does not match durable run ` +
          `conversation=${run.conversationId} agentId=${run.agentId}`
      )
    }
    return createSubagentProjectionOwner({
      conversationId: run.conversationId,
      agentId: run.agentId,
      threadId: run.threadId,
      branchId: run.branchId,
      forkSourceUuid: run.forkSourceUuid,
      forkLineage: run.forkLineage,
    })
  }

  /**
   * Discover a child owner only from an existing durable run. This is used by
   * cold mounting; callers never recreate a branch tuple from runtime state.
   */
  createProjectionOwnerForAgent(
    conversationId: ConversationId,
    agentId: string
  ): SubagentProjectionOwner {
    const run = this.requireRun(
      conversationId,
      this.requireIdentifier(agentId, "agentId")
    )
    return this.createProjectionOwner(
      this.branchForRun(run, run.executionTurnId)
    )
  }

  /**
   * Verify a projection owner's complete static identity against its durable
   * branch. This deliberately does not infer identity from ownerKey: an
   * ownerKey is only a storage coordinate, never branch authority.
   */
  verifyProjectionOwner(owner: ProjectionOwner): SubagentRunRecord | undefined {
    assertProjectionOwner(owner, "SubagentBranchStore.verifyProjectionOwner")
    if (owner.kind === "main") return undefined
    const run = this.requireRun(owner.conversationId, owner.agentId)
    this.assertProjectionIdentityMatchesRun(owner, run)
    return run
  }

  /** Resolve the current durable branch scope for an already verified owner. */
  readProjectionBranch(owner: SubagentProjectionOwner): SubagentGraphBranch {
    const run = this.verifyProjectionOwner(owner)
    if (!run) {
      throw new Error(
        "SubagentBranchStore: main owner cannot resolve a child branch"
      )
    }
    const executionTurns = this.executionTurnSet(run)
    this.requireExecutionLease(run, run.executionTurnId, executionTurns)
    this.requireVerifiedHead(owner.conversationId, run, executionTurns)
    return this.branchForRun(run, run.executionTurnId)
  }

  /**
   * Read the durable branch receipt for a mounted child projection.  This is
   * deliberately branch-store-owned: callers must not manufacture a hot
   * snapshot from a message array or a hand-assembled thread identity.
   */
  readProjectionBranchSnapshot(
    owner: SubagentProjectionOwner
  ): SubagentProjectionBranchSnapshot {
    const run = this.verifyProjectionOwner(owner)
    if (!run) {
      throw new Error(
        "SubagentBranchStore: main owner cannot read a child branch snapshot"
      )
    }
    const executionTurns = this.executionTurnSet(run)
    this.requireExecutionLease(run, run.executionTurnId, executionTurns)
    const head = this.requireVerifiedHead(
      owner.conversationId,
      run,
      executionTurns
    )
    return {
      headUuid: head.uuid,
      headRevision: head.revision,
      executionTurnId: run.executionTurnId,
    }
  }

  /**
   * Reject a child hot projection as soon as its branch head or current
   * execution lease has moved.  A caller must remount from durable graph data
   * instead of continuing from an old transcript slice.
   */
  assertProjectionBranchSnapshotCurrent(
    owner: SubagentProjectionOwner,
    snapshot: SubagentProjectionBranchSnapshot
  ): void {
    const current = this.readProjectionBranchSnapshot(owner)
    if (
      current.headUuid !== snapshot.headUuid ||
      current.headRevision !== snapshot.headRevision ||
      current.executionTurnId !== snapshot.executionTurnId
    ) {
      throw new Error(
        `SubagentBranchStore: mounted projection is stale ` +
          `conversation=${owner.conversationId} agentId=${owner.agentId}`
      )
    }
  }

  /**
   * Validate a graph watermark or layout message against an explicit owner.
   * Main ownership excludes every sidechain row. A child owner validates the
   * exact immutable run tuple and any retained historical execution lease.
   */
  verifyProjectionGraphRecord(
    owner: ProjectionOwner,
    graphUuid: string
  ): PersistedMessage {
    const message = this.messageStore.getMessageByUuid(
      owner.conversationId,
      this.requireIdentifier(graphUuid, "projection graph UUID")
    )
    if (!message) {
      throw new Error(
        `SubagentBranchStore: projection graph record is missing ` +
          `conversation=${owner.conversationId} uuid=${graphUuid}`
      )
    }
    this.verifyProjectionGraphRecords(owner, [message])
    return message
  }

  verifyProjectionGraphRecords(
    owner: ProjectionOwner,
    messages: readonly PersistedMessage[]
  ): void {
    const run = this.verifyProjectionOwner(owner)
    if (!run) {
      for (const message of messages) {
        if (message.isSidechain) {
          throw new Error(
            `SubagentBranchStore: main projection cannot read sidechain graph row ` +
              `conversation=${owner.conversationId} uuid=${message.uuid}`
          )
        }
      }
      return
    }
    const executionTurns = this.executionTurnSet(run)
    for (const message of messages) {
      this.assertMessageMatchesRun(message, run, executionTurns)
    }
  }

  /**
   * Resolve every sidechain write from one transaction-local authority. Root
   * creation, normal continuation, late recovered terminal, and graph abort
   * therefore use the same identity/head validation and same CAS protocol.
   */
  prepareAppendInTransaction(
    txn: SessionTxn,
    authority: SubagentBranchWriteAuthority
  ): SubagentBranchAppendPlan {
    this.assertTransaction(txn, "prepareAppendInTransaction")
    switch (authority.kind) {
      case "root":
        return this.prepareRootInTransaction(
          txn,
          authority.branch,
          authority.runCreate
        )
      case "continuation":
        return this.prepareContinuationInTransaction(txn, authority.branch)
      case "recovered":
        return this.prepareRecoveredInTransaction(
          txn,
          authority.branch,
          authority.source
        )
      case "abort":
        return this.prepareAbortInTransaction(txn, authority.source)
    }
  }

  /**
   * Read-side validation intentionally uses one run lookup and one execution
   * set lookup for the complete branch. Revisions are loaded separately in a
   * single branch-scoped query by MessageStore.
   */
  verifyBranchRead(
    branch: SubagentGraphBranch,
    messages: readonly PersistedMessage[]
  ): SubagentRunRecord {
    const run = this.requireRun(branch.conversationId, branch.subagentId)
    this.assertBranchMatchesRun(branch, run)
    const executionTurns = this.executionTurnSet(run)
    this.requireExecutionLease(run, branch.turnId, executionTurns)
    if (messages.length === 0) {
      throw new Error(
        `SubagentBranchStore: durable branch has no graph rows ` +
          `conversation=${branch.conversationId} agentId=${run.agentId}`
      )
    }
    for (const message of messages) {
      this.assertMessageMatchesRun(message, run, executionTurns)
    }
    const head = this.getHead(branch.conversationId, run.agentId)
    const tail = messages.at(-1)
    if (!head || !tail || tail.uuid !== head.uuid) {
      throw new Error(
        `SubagentBranchStore: branch head does not match durable branch tail ` +
          `conversation=${branch.conversationId} agentId=${run.agentId}`
      )
    }
    return run
  }

  /** Advance the durable tail only after graph and ledger append succeeded. */
  advanceInTransaction(
    txn: SessionTxn,
    plan: SubagentBranchAppendPlan,
    accepted: readonly PersistedMessage[]
  ): void {
    this.assertTransaction(txn, "advanceInTransaction")
    if (accepted.length === 0) {
      throw new Error(
        "SubagentBranchStore: cannot advance an empty branch append"
      )
    }
    for (const message of accepted) {
      this.assertMessageMatchesRun(message, plan.run, plan.executionTurns)
    }
    const first = accepted[0]!
    const firstBlock = first.content[0]
    if (
      firstBlock?.type !== "tool_result" &&
      first.parentUuid !== plan.parentUuid
    ) {
      throw new Error(
        `SubagentBranchStore: first ordinary fragment does not extend durable head ` +
          `conversation=${txn.conversationId} agentId=${plan.run.agentId}`
      )
    }
    const tail = accepted.at(-1)!
    if (plan.kind === "root") {
      const result = (this.stmtInsertHead ??= this.persistence.prepare(
        `INSERT INTO session_subagent_branch_heads (
           conversation_id, agent_id, head_uuid, revision
         ) VALUES (?, ?, ?, 1)`
      )).run(txn.conversationId, plan.run.agentId, tail.uuid) as {
        changes?: number
      }
      if ((result.changes ?? 0) !== 1) {
        throw new SubagentBranchHeadConflictError(
          txn.conversationId,
          plan.run.agentId
        )
      }
      return
    }

    const expected = plan.expectedHead
    if (!expected) {
      throw new Error(
        "SubagentBranchStore: non-root append has no expected head"
      )
    }
    const result = (this.stmtAdvanceHead ??= this.persistence.prepare(
      `UPDATE session_subagent_branch_heads
          SET head_uuid = ?, revision = revision + 1
        WHERE conversation_id = ?
          AND agent_id = ?
          AND head_uuid = ?
          AND revision = ?`
    )).run(
      tail.uuid,
      txn.conversationId,
      plan.run.agentId,
      expected.uuid,
      expected.revision
    ) as { changes?: number }
    if ((result.changes ?? 0) !== 1) {
      throw new SubagentBranchHeadConflictError(
        txn.conversationId,
        plan.run.agentId
      )
    }
  }

  private prepareRootInTransaction(
    txn: SessionTxn,
    branch: SubagentGraphBranch,
    input: CreateSubagentRunInput
  ): SubagentBranchAppendPlan {
    const run = this.subagentRunStore.createInTransaction(txn, input)
    this.assertBranchMatchesRun(branch, run)
    if (branch.turnId !== run.executionTurnId || run.status !== "running") {
      throw new Error(
        `SubagentBranchStore: root execution lease does not own created run ` +
          `conversation=${txn.conversationId} agentId=${run.agentId}`
      )
    }
    if (this.getHead(txn.conversationId, run.agentId)) {
      throw new Error(
        `SubagentBranchStore: created run already has a branch head ` +
          `conversation=${txn.conversationId} agentId=${run.agentId}`
      )
    }
    const executionTurns = this.executionTurnSet(run)
    this.requireExecutionLease(run, branch.turnId, executionTurns)
    return {
      kind: "root",
      branch: this.branchForRun(run, branch.turnId),
      run,
      executionTurns,
      parentUuid: run.forkSourceUuid,
    }
  }

  private prepareContinuationInTransaction(
    txn: SessionTxn,
    branch: SubagentGraphBranch
  ): SubagentBranchAppendPlan {
    const run = this.requireRun(txn.conversationId, branch.subagentId)
    this.assertBranchMatchesRun(branch, run)
    if (run.status !== "running" || run.executionTurnId !== branch.turnId) {
      throw new Error(
        `SubagentBranchStore: branch has no active durable execution ` +
          `conversation=${txn.conversationId} agentId=${run.agentId} turn=${branch.turnId}`
      )
    }
    const executionTurns = this.executionTurnSet(run)
    this.requireExecutionLease(run, branch.turnId, executionTurns)
    const head = this.requireVerifiedHead(
      txn.conversationId,
      run,
      executionTurns
    )
    return {
      kind: "continuation",
      branch: this.branchForRun(run, branch.turnId),
      run,
      executionTurns,
      parentUuid: head.uuid,
      expectedHead: head,
    }
  }

  private prepareRecoveredInTransaction(
    txn: SessionTxn,
    branch: SubagentGraphBranch,
    source: PersistedMessage
  ): SubagentBranchAppendPlan {
    const run = this.requireRun(txn.conversationId, branch.subagentId)
    this.assertBranchMatchesRun(branch, run)
    if (run.status !== "interrupted" || run.deliveryState !== "delivered") {
      throw new Error(
        `SubagentBranchStore: recovered sidechain terminal has no delivered interrupted run ` +
          `conversation=${txn.conversationId} agentId=${run.agentId}`
      )
    }
    const executionTurns = this.executionTurnSet(run)
    this.requireExecutionLease(run, branch.turnId, executionTurns)
    this.assertMessageMatchesRun(source, run, executionTurns)
    if (source.turnId !== branch.turnId) {
      throw new Error(
        `SubagentBranchStore: recovered source does not belong to the requested execution lease ` +
          `conversation=${txn.conversationId} agentId=${run.agentId}`
      )
    }
    const head = this.requireVerifiedHead(
      txn.conversationId,
      run,
      executionTurns
    )
    return {
      kind: "recovered",
      branch: this.branchForRun(run, source.turnId),
      run,
      executionTurns,
      parentUuid: head.uuid,
      expectedHead: head,
    }
  }

  private prepareAbortInTransaction(
    txn: SessionTxn,
    source: PersistedMessage
  ): SubagentBranchAppendPlan {
    if (!source.isSidechain || !source.agentId || !source.turnId) {
      throw new Error(
        `SubagentBranchStore: abort source is not an owned sidechain row ` +
          `conversation=${txn.conversationId} uuid=${source.uuid}`
      )
    }
    const run = this.requireRun(txn.conversationId, source.agentId)
    const executionTurns = this.executionTurnSet(run)
    this.assertMessageMatchesRun(source, run, executionTurns)
    const head = this.requireVerifiedHead(
      txn.conversationId,
      run,
      executionTurns
    )
    return {
      kind: "abort",
      branch: this.branchForRun(run, source.turnId),
      run,
      executionTurns,
      parentUuid: head.uuid,
      expectedHead: head,
    }
  }

  private requireVerifiedHead(
    conversationId: ConversationId,
    run: SubagentRunRecord,
    executionTurns: ReadonlySet<TurnId>
  ): { uuid: string; revision: number } {
    const head = this.getHead(conversationId, run.agentId)
    if (!head) {
      throw new Error(
        `SubagentBranchStore: durable run has no branch head ` +
          `conversation=${conversationId} agentId=${run.agentId}`
      )
    }
    const message = this.messageStore.getMessageByUuid(
      conversationId,
      head.uuid
    )
    if (!message) {
      throw new Error(
        `SubagentBranchStore: branch head graph row is missing ` +
          `conversation=${conversationId} agentId=${run.agentId} uuid=${head.uuid}`
      )
    }
    this.assertMessageMatchesRun(message, run, executionTurns)
    return head
  }

  private getHead(
    conversationId: ConversationId,
    agentId: string
  ): { uuid: string; revision: number } | undefined {
    const row = (this.stmtGetHead ??= this.persistence.prepare(
      `SELECT head_uuid, revision
         FROM session_subagent_branch_heads
        WHERE conversation_id = ? AND agent_id = ?
        LIMIT 1`
    )).get(conversationId, agentId) as BranchHeadRow | undefined
    if (!row) return undefined
    if (!Number.isSafeInteger(row.revision) || row.revision <= 0) {
      throw new Error(
        `SubagentBranchStore: invalid branch head revision for ` +
          `conversation=${conversationId} agentId=${agentId}`
      )
    }
    return {
      uuid: this.requireIdentifier(row.head_uuid, "stored branch head uuid"),
      revision: row.revision,
    }
  }

  private branchForRun(
    run: SubagentRunRecord,
    executionTurnId: TurnId
  ): SubagentGraphBranch {
    return {
      conversationId: run.conversationId,
      parentToolCallId: run.parentToolCallId,
      subagentId: run.agentId,
      threadId: run.threadId,
      branchId: run.branchId,
      agentId: run.agentId,
      forkSourceUuid: run.forkSourceUuid,
      forkLineage: [...run.forkLineage],
      turnId: executionTurnId,
    }
  }

  private requireRun(
    conversationId: ConversationId,
    agentId: string
  ): SubagentRunRecord {
    const run = this.subagentRunStore.get(conversationId, agentId)
    if (!run) {
      throw new Error(
        `SubagentBranchStore: branch has no durable run ` +
          `conversation=${conversationId} agentId=${agentId}`
      )
    }
    return run
  }

  private requireExecutionLease(
    run: SubagentRunRecord,
    executionTurnId: TurnId,
    executionTurns: ReadonlySet<TurnId>
  ): void {
    if (!executionTurns.has(executionTurnId)) {
      throw new Error(
        `SubagentBranchStore: execution lease is not owned by run ` +
          `conversation=${run.conversationId} agentId=${run.agentId} turn=${executionTurnId}`
      )
    }
  }

  private executionTurnSet(run: SubagentRunRecord): Set<TurnId> {
    return new Set(
      this.subagentRunStore
        .listExecutions(run.conversationId, run.agentId)
        .map((execution) => execution.executionTurnId)
    )
  }

  private assertBranchMatchesRun(
    branch: SubagentGraphBranch,
    run: SubagentRunRecord
  ): void {
    this.assertProjectionIdentityMatchesRun(branch, run)
    if (
      branch.subagentId !== run.agentId ||
      branch.parentToolCallId !== run.parentToolCallId
    ) {
      throw new Error(
        `SubagentBranchStore: branch task identity does not match durable run ` +
          `conversation=${run.conversationId} agentId=${run.agentId}`
      )
    }
  }

  private assertProjectionIdentityMatchesRun(
    branch: Pick<
      SubagentGraphIdentity,
      | "conversationId"
      | "agentId"
      | "threadId"
      | "branchId"
      | "forkSourceUuid"
      | "forkLineage"
    >,
    run: SubagentRunRecord
  ): void {
    if (
      branch.conversationId !== run.conversationId ||
      branch.agentId !== run.agentId ||
      branch.threadId !== run.threadId ||
      branch.branchId !== run.branchId ||
      branch.forkSourceUuid !== run.forkSourceUuid ||
      !this.equalStringArrays(branch.forkLineage, run.forkLineage)
    ) {
      throw new Error(
        `SubagentBranchStore: projection branch identity does not match durable run ` +
          `conversation=${run.conversationId} agentId=${run.agentId}`
      )
    }
  }

  private assertMessageMatchesRun(
    message: PersistedMessage,
    run: SubagentRunRecord,
    executionTurns: ReadonlySet<TurnId>
  ): void {
    if (
      message.threadId !== run.threadId ||
      message.branchId !== run.branchId ||
      message.agentId !== run.agentId ||
      message.isSidechain !== true ||
      message.forkSourceUuid !== run.forkSourceUuid ||
      !message.turnId ||
      !executionTurns.has(message.turnId) ||
      !this.equalStringArrays(message.forkLineage, run.forkLineage)
    ) {
      throw new Error(
        `SubagentBranchStore: sidechain graph identity mismatch ` +
          `conversation=${run.conversationId} agentId=${run.agentId} uuid=${message.uuid}`
      )
    }
  }

  private equalStringArrays(
    left: readonly string[] | undefined,
    right: readonly string[]
  ): boolean {
    return (
      Array.isArray(left) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    )
  }

  private requireIdentifier(value: unknown, label: string): string {
    let exact: string
    try {
      exact = requireExactDurableIdentifier(
        value,
        `SubagentBranchStore ${label}`
      )
    } catch {
      throw new Error(
        `SubagentBranchStore: ${label} must be a non-empty identifier`
      )
    }
    if (exact.length > 1024) {
      throw new Error(
        `SubagentBranchStore: ${label} must be a non-empty identifier`
      )
    }
    return exact
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
        `SubagentBranchStore.${operation}: requires the active MessageStore transaction`
      )
    }
  }
}
