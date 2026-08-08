import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common"
import {
  type SessionRecord,
  type SessionStreamRecord,
  type QueuedEditDispatch,
  type SessionBackgroundCommand,
  SessionLifecycleService,
  requireCanonicalIdentifier,
} from "./session-lifecycle.service"
import type { TurnId } from "../turn/turn.types"
import {
  BackgroundCommandStore,
  type DurableBackgroundCommand,
} from "./background-command-store.service"

/**
 * Sole owner of per-conversation streaming and client-execution state:
 *
 *   - shell stream stdout/stderr accumulation
 *   - background command lifecycle
 *   - per-path edit serialisation (acquireOrQueueEdit / pickNextEditForPath)
 *   - InteractionQuery registration / resolution
 *   - currentStreamId rotation + pending rebind
 *   - cross-session sweeps for overdue deadlines and async-ask followups
 *
 * Records live only in `streamRecords`. Lifecycle callbacks provide session
 * metadata and dirty scheduling without duplicating stream state.
 */
@Injectable()
export class SessionStreamService {
  private readonly logger = new Logger(SessionStreamService.name)

  private readonly streamRecords = new Map<string, SessionStreamRecord>()

  constructor(
    @Inject(forwardRef(() => SessionLifecycleService))
    private readonly sessionLifecycle: SessionLifecycleService,
    private readonly backgroundCommands: BackgroundCommandStore
  ) {}

  // ── Record lifecycle ──────────────────────────────────────────

  getStreamRecord(conversationId: string): SessionStreamRecord | undefined {
    return this.streamRecords.get(conversationId)
  }

  createInitialRecord(
    conversationId: string,
    init: SessionStreamRecord
  ): SessionStreamRecord {
    this.streamRecords.set(conversationId, init)
    return init
  }

  deleteRecord(conversationId: string): boolean {
    return this.streamRecords.delete(conversationId)
  }

  iterateRecords(): IterableIterator<[string, SessionStreamRecord]> {
    return this.streamRecords.entries()
  }

  // ── shell streams ─────────────────────────────────────────────

  initShellStream(conversationId: string, toolCallId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return

    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (pendingCall) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput = {
        stdout: [],
        stderr: [],
        started: false,
      }
      this.logger.debug(`Initialized shell stream for ${toolCallId}`)
    }
  }

  appendShellStdout(
    conversationId: string,
    toolCallId: string,
    data: string
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return

    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.stdout.push(data)
      this.logger.debug(`Appended ${data.length} chars stdout to ${toolCallId}`)
    }
  }

  appendShellStderr(
    conversationId: string,
    toolCallId: string,
    data: string
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return

    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.stderr.push(data)
      this.logger.debug(`Appended ${data.length} chars stderr to ${toolCallId}`)
    }
  }

  markShellStarted(conversationId: string, toolCallId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return

    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.started = true
      this.logger.debug(`Marked shell started for ${toolCallId}`)
    }
  }

  setShellExit(
    conversationId: string,
    toolCallId: string,
    exitCode: number,
    signal?: string
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return

    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.exitCode = exitCode
      pendingCall.shellStreamOutput.signal = signal
      this.logger.debug(
        `Set shell exit for ${toolCallId}: code=${exitCode}, signal=${signal}`
      )
    }
  }

  getShellOutput(
    conversationId: string,
    toolCallId: string
  ): { stdout: string; stderr: string; exitCode?: number } | null {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return null

    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (!pendingCall?.shellStreamOutput) return null

    return {
      stdout: pendingCall.shellStreamOutput.stdout.join(""),
      stderr: pendingCall.shellStreamOutput.stderr.join(""),
      exitCode: pendingCall.shellStreamOutput.exitCode,
    }
  }

  isShellStreamComplete(conversationId: string, toolCallId: string): boolean {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return false
    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    return pendingCall?.shellStreamOutput?.exitCode !== undefined
  }

  // ── background commands ───────────────────────────────────────

  registerBackgroundCommand(
    conversationId: string,
    command: {
      commandId: string
      originToolCallId: string
      execIds?: Iterable<number>
      command: string
      cwd: string
      pid?: number
      terminalsFolder?: string
      stdout?: string
      stderr?: string
      msToWait?: number
      backgroundReason?: number
      startedAt?: number
    }
  ): SessionBackgroundCommand | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return undefined

    const commandId = requireCanonicalIdentifier(
      command.commandId,
      "background commandId"
    )
    const originToolCallId = requireCanonicalIdentifier(
      command.originToolCallId,
      "background originToolCallId"
    )

    const backgroundCommand = this.backgroundCommands.register(conversationId, {
      ...command,
      commandId,
      originToolCallId,
    })
    session.lastActivityAt = new Date()
    this.sessionLifecycle.markSessionDirty(conversationId)
    return backgroundCommand
  }

  getBackgroundCommand(
    conversationId: string,
    commandId: string
  ): SessionBackgroundCommand | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return undefined
    const canonicalCommandId = requireCanonicalIdentifier(
      commandId,
      "background commandId"
    )
    return this.backgroundCommands.get(conversationId, canonicalCommandId)
  }

  findBackgroundCommandByToolCallId(
    conversationId: string,
    toolCallId: string
  ): SessionBackgroundCommand | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return undefined
    const canonicalToolCallId = requireCanonicalIdentifier(
      toolCallId,
      "background originToolCallId"
    )
    return this.backgroundCommands.findByToolCallId(
      conversationId,
      canonicalToolCallId
    )
  }

  markPendingShellToolBackgrounded(
    conversationId: string,
    toolCallId: string,
    commandId: string
  ): SessionBackgroundCommand | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return undefined

    const canonicalToolCallId = requireCanonicalIdentifier(
      toolCallId,
      "background originToolCallId"
    )
    const canonicalCommandId = requireCanonicalIdentifier(
      commandId,
      "background commandId"
    )

    const existing = this.findBackgroundCommandByToolCallId(
      conversationId,
      canonicalToolCallId
    )
    if (existing) return existing

    const pendingToolCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      canonicalToolCallId
    )
    if (!pendingToolCall) return undefined

    const output = pendingToolCall.shellStreamOutput
    return this.registerBackgroundCommand(conversationId, {
      commandId: canonicalCommandId,
      originToolCallId: canonicalToolCallId,
      execIds: pendingToolCall.execIds,
      command:
        typeof pendingToolCall.toolInput.command === "string"
          ? pendingToolCall.toolInput.command
          : typeof pendingToolCall.toolInput.cmd === "string"
            ? pendingToolCall.toolInput.cmd
            : "",
      cwd:
        typeof pendingToolCall.toolInput.cwd === "string"
          ? pendingToolCall.toolInput.cwd
          : typeof pendingToolCall.toolInput.workingDirectory === "string"
            ? pendingToolCall.toolInput.workingDirectory
            : "",
      terminalsFolder: session.requestContextEnv?.terminalsFolder,
      stdout: output?.stdout.join("") || "",
      stderr: output?.stderr.join("") || "",
    })
  }

  findBackgroundCommandByExecId(
    conversationId: string,
    execIdNumber: number
  ): SessionBackgroundCommand | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session || !Number.isSafeInteger(execIdNumber) || execIdNumber <= 0) {
      return undefined
    }
    for (const command of this.backgroundCommands.list(conversationId)) {
      if (command.execIds.includes(execIdNumber)) {
        return command
      }
    }
    return undefined
  }

  appendBackgroundCommandOutput(
    conversationId: string,
    commandId: string,
    stream: "stdout" | "stderr",
    data: string
  ): boolean {
    const updated = this.backgroundCommands.appendOutput(
      conversationId,
      commandId,
      stream,
      data
    )
    if (updated) this.sessionLifecycle.markSessionDirty(conversationId)
    return updated
  }

  replaceBackgroundCommandOutput(
    conversationId: string,
    commandId: string,
    stdout: string,
    stderr: string
  ): boolean {
    const updated = this.backgroundCommands.replaceOutput(
      conversationId,
      commandId,
      stdout,
      stderr
    )
    if (updated) this.sessionLifecycle.markSessionDirty(conversationId)
    return updated
  }

  updateBackgroundCommandTerminalFileLength(
    conversationId: string,
    commandId: string,
    length: number
  ): boolean {
    const updated = this.backgroundCommands.setTerminalFileLength(
      conversationId,
      commandId,
      length
    )
    if (updated) this.sessionLifecycle.markSessionDirty(conversationId)
    return updated
  }

  setBackgroundCommandExit(
    conversationId: string,
    commandId: string,
    exitCode: number,
    aborted = false
  ): boolean {
    const updated = this.backgroundCommands.setExit(
      conversationId,
      commandId,
      exitCode,
      aborted
    )
    if (updated) this.sessionLifecycle.markSessionDirty(conversationId)
    return updated
  }

  // ── per-path edit serialisation ───────────────────────────────

  acquireOrQueueEdit(
    conversationId: string,
    toolCallId: string,
    path: string
  ): { acquired: boolean } {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) {
      return { acquired: true }
    }
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.includes("\u0000")
    ) {
      throw new Error("edit path must be a non-empty local path")
    }
    const pending = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (pending) {
      pending.editPath = path
    }

    const holder = stream!.editPathHolderByPath.get(path)
    if (!holder) {
      stream!.editPathHolderByPath.set(path, toolCallId)
      return { acquired: true }
    }

    if (holder === toolCallId) {
      // Idempotent: same tool call already holds the slot.
      return { acquired: true }
    }

    let queue = stream!.editPathQueueByPath.get(path)
    if (!queue) {
      queue = []
      stream!.editPathQueueByPath.set(path, queue)
    }
    if (!queue.some((item) => item.toolCallId === toolCallId)) {
      queue.push({
        toolCallId,
        path,
        enqueuedAt: Date.now(),
      })
    }
    return { acquired: false }
  }

  pickNextEditForPath(
    conversationId: string,
    path: string
  ): QueuedEditDispatch | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) return undefined

    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.includes("\u0000")
    ) {
      throw new Error("edit path must be a non-empty local path")
    }

    if (stream!.editPathHolderByPath.has(path)) {
      // 上一持有者尚未释放，调用方应等待。
      return undefined
    }

    const queue = stream!.editPathQueueByPath.get(path)
    if (!queue || queue.length === 0) {
      stream!.editPathQueueByPath.delete(path)
      return undefined
    }

    const next = queue.shift()!
    if (queue.length === 0) {
      stream!.editPathQueueByPath.delete(path)
    }
    stream!.editPathHolderByPath.set(path, next.toolCallId)
    return next
  }

  // ── stream id rotation + rebind ───────────────────────────────

  rotateStreamId(conversationId: string): string {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) return ""
    const newId = crypto.randomUUID()
    const oldId = stream!.currentStreamId
    stream!.currentStreamId = newId
    session.lastActivityAt = new Date()
    this.logger.debug(
      `Rotated streamId for ${conversationId}: ${oldId.substring(0, 8)} -> ${newId.substring(0, 8)}`
    )
    this.sessionLifecycle.markSessionDirty(conversationId)
    return newId
  }

  getCurrentStreamId(conversationId: string): string | undefined {
    return this.streamRecords.get(conversationId)?.currentStreamId
  }

  isCurrentStream(conversationId: string, streamId: string): boolean {
    if (!streamId) return false
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) return false
    return stream!.currentStreamId === streamId
  }

  rebindPendingToolCallsToCurrentStream(conversationId: string): number {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (
      !session ||
      this.sessionLifecycle.pendingToolCallCount(session.conversationId) === 0
    )
      return 0

    const currentStreamId = stream!.currentStreamId
    let reboundCount = 0

    for (const [, pending] of this.sessionLifecycle.listPendingToolCallEntries(
      session.conversationId
    )) {
      // Only an input-EOF recovery is replayable on resumeAction. A cold
      // interrupted-pending resolution and a recovered sidechain terminal are
      // intentionally still awaiting their exact client acknowledgement.
      // Moving either entry to the generic stream path would make a terminal
      // route look runnable again and could feed it into a parent continuation.
      const resumeEligible =
        pending.executionStatus === "awaitingClientResult" &&
        pending.executionRecoveryReason === "input_eof"
      const streamChanged =
        pending.streamId !== currentStreamId &&
        pending.executionRecoveryReason !== "interrupted_pending_resolution" &&
        pending.executionRecoveryReason !== "subagent_restart"
      const statusChanged = resumeEligible
      if (streamChanged) {
        pending.streamId = currentStreamId
      }
      if (statusChanged) {
        pending.executionStatus = "running"
        pending.executionRecoveryReason = undefined
      }
      if (streamChanged || statusChanged) {
        reboundCount++
      }
    }

    if (reboundCount > 0) {
      this.sessionLifecycle.markSessionDirty(conversationId)
    }

    return reboundCount
  }

  // ── interaction queries ───────────────────────────────────────

  registerInteractionQuery(
    conversationId: string,
    queryType: string,
    payload?: Record<string, unknown>,
    options?: {
      turnId?: TurnId
      kind?: string
      deadline?: number
      streamId?: string
      blocksTurn?: boolean
    }
  ): { id: number; promise: Promise<any> } {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }

    stream!.interactionQueryId++
    const queryId = stream!.interactionQueryId

    let resolve!: (response: any) => void
    let reject!: (error: Error) => void
    const promise = new Promise<any>((res, rej) => {
      resolve = res
      reject = rej
    })

    stream!.pendingInteractionQueries.set(queryId, {
      resolve,
      reject,
      queryType,
      payload,
      turnId: options?.turnId,
      kind: options?.kind,
      deadline: options?.deadline,
      streamId: options?.streamId,
      blocksTurn: options?.blocksTurn,
      createdAt: Date.now(),
    })
    session.lastActivityAt = new Date()

    this.logger.log(
      `Registered InteractionQuery id=${queryId} type=${queryType} ` +
        `kind=${options?.kind ?? "(none)"} ` +
        `deadline=${options?.deadline ? new Date(options.deadline).toISOString() : "(none)"} ` +
        `for ${conversationId}`
    )

    this.sessionLifecycle.markSessionDirty(conversationId)
    return { id: queryId, promise }
  }

  hasBlockingInteractionQueries(conversationId: string): boolean {
    const stream = this.streamRecords.get(conversationId)
    return Boolean(
      stream &&
      Array.from(stream.pendingInteractionQueries.values()).some(
        (query) => query.blocksTurn !== false
      )
    )
  }

  interruptPendingInteractionQueries(
    conversationId: string,
    reason: string
  ): number {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session || !stream || stream.pendingInteractionQueries.size === 0) {
      return 0
    }

    const wasPending =
      this.sessionLifecycle.pendingToolCallCount(conversationId) > 0 ||
      this.hasBlockingInteractionQueries(conversationId)
    const entries = Array.from(stream.pendingInteractionQueries.entries())
    stream.pendingInteractionQueries.clear()

    const interruptedAt = Date.now()
    for (const [queryId, pending] of entries) {
      pending.resolve({
        approved: false,
        resultCase: "interrupted",
        rawResponse: {
          reason,
          queryId,
          queryType: pending.queryType,
          kind: pending.kind,
          streamId: pending.streamId,
          interruptedAt,
        },
      })
    }

    session.lastActivityAt = new Date()
    this.sessionLifecycle.markSessionDirty(conversationId)
    this.sessionLifecycle.notifyIfBecameIdleAfter(session, wasPending)
    this.logger.warn(
      `Interrupted ${entries.length} pending interaction quer${
        entries.length === 1 ? "y" : "ies"
      } for ${conversationId}: ${reason}`
    )
    return entries.length
  }

  resolveInteractionQuery(
    conversationId: string,
    queryId: number,
    response: any
  ): { queryType: string; payload?: Record<string, unknown> } | null {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) {
      this.logger.warn(
        `resolveInteractionQuery: session not found ${conversationId}`
      )
      return null
    }

    const pending = stream!.pendingInteractionQueries.get(queryId)
    if (!pending) {
      this.logger.warn(
        `resolveInteractionQuery: no pending query id=${queryId}`
      )
      return null
    }

    const wasPending =
      this.sessionLifecycle.pendingToolCallCount(conversationId) > 0 ||
      this.hasBlockingInteractionQueries(conversationId)

    this.logger.log(
      `Resolve InteractionQuery id=${queryId} type=${pending.queryType}`
    )
    pending.resolve(response)
    stream!.pendingInteractionQueries.delete(queryId)
    session.lastActivityAt = new Date()
    this.sessionLifecycle.markSessionDirty(conversationId)
    this.sessionLifecycle.notifyIfBecameIdleAfter(session, wasPending)
    return {
      queryType: pending.queryType,
      payload: pending.payload,
    }
  }

  // ── cross-session interaction-query sweeps ────

  listOverdueInteractionQueries(now: number = Date.now()): Array<{
    conversationId: string
    queryId: number
    kind: string | undefined
    deadline: number
  }> {
    const interactionQueries: Array<{
      conversationId: string
      queryId: number
      kind: string | undefined
      deadline: number
    }> = []

    for (const [conversationId, stream] of this.streamRecords.entries()) {
      for (const [queryId, iq] of stream.pendingInteractionQueries) {
        if (typeof iq.deadline !== "number") continue
        if (iq.deadline > now) continue
        interactionQueries.push({
          conversationId,
          queryId,
          kind: iq.kind,
          deadline: iq.deadline,
        })
      }
    }

    return interactionQueries
  }

  // ─── Field accessors ──────────────────────────────────────────

  getBackgroundCommands(
    conversationId: string
  ): Map<string, SessionBackgroundCommand> {
    return new Map(
      this.backgroundCommands
        .list(conversationId)
        .map((command) => [command.commandId, command])
    )
  }

  getDurableBackgroundCommand(
    conversationId: string,
    commandId: string
  ): DurableBackgroundCommand | undefined {
    return this.backgroundCommands.get(conversationId, commandId)
  }
  getPendingToolCallByExecId(conversationId: string): Map<number, string> {
    return (
      this.streamRecords.get(conversationId)?.pendingToolCallByExecId ??
      new Map<never, never>()
    )
  }
  getEditPathHolderByPath(conversationId: string): Map<string, string> {
    return (
      this.streamRecords.get(conversationId)?.editPathHolderByPath ??
      new Map<never, never>()
    )
  }
  getEditPathQueueByPath(
    conversationId: string
  ): Map<string, QueuedEditDispatch[]> {
    return (
      this.streamRecords.get(conversationId)?.editPathQueueByPath ??
      new Map<never, never>()
    )
  }
  getPendingInteractionQueries(
    conversationId: string
  ): SessionStreamRecord["pendingInteractionQueries"] {
    return (
      this.streamRecords.get(conversationId)?.pendingInteractionQueries ??
      new Map<never, never>()
    )
  }
  getInteractionQueryId(conversationId: string): number {
    return this.streamRecords.get(conversationId)?.interactionQueryId ?? 0
  }
  mapPendingToolCallByExecId(
    conversationId: string,
    execId: number,
    toolCallId: string
  ): void {
    const s = this.streamRecords.get(conversationId)
    if (!s) return
    s.pendingToolCallByExecId.set(execId, toolCallId)
  }
  consumePendingToolCallByExecId(
    conversationId: string,
    execId: number
  ): string | undefined {
    const s = this.streamRecords.get(conversationId)
    if (!s) return undefined
    const id = s.pendingToolCallByExecId.get(execId)
    if (id !== undefined) s.pendingToolCallByExecId.delete(execId)
    return id
  }
}

// Re-export so callers that previously imported types from
// session-lifecycle.service.ts continue to compile.
export type { SessionRecord }
