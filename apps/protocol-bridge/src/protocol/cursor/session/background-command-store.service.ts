import { Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import {
  requireExactDurableIdentifier,
  requireOptionalExactDurableIdentifier,
} from "../../../context/durable-identifier"
import { PersistenceService } from "../../../persistence"
import type { SessionBackgroundCommand } from "./session-lifecycle.service"
import {
  SESSION_TXN_TAG,
  type SessionTxn,
  type SessionTxnInternal,
} from "./tool-call-ledger.service"
import { ConversationId } from "../turn/turn.types"

export interface RegisterBackgroundCommandInput {
  readonly commandId: string
  readonly originToolCallId: string
  readonly execIds?: Iterable<number>
  readonly command: string
  readonly cwd: string
  readonly pid?: number
  readonly terminalsFolder?: string
  readonly stdout?: string
  readonly stderr?: string
  readonly msToWait?: number
  readonly backgroundReason?: number
  readonly startedAt?: number
}

export interface BackgroundShellCompletionIdentity {
  readonly commandId: string
  readonly originToolCallId: string
}

export interface RecordBackgroundShellCompletionInput extends BackgroundShellCompletionIdentity {
  readonly taskId: string
  readonly toolCallId?: string
  readonly status?: number
  readonly reason?: number
  readonly outputPath?: string
  readonly completedAt?: number
}

interface BackgroundCommandRow {
  command_id: string
  origin_tool_call_id: string
  exec_ids_json: string
  command: string
  cwd: string
  pid: number | null
  terminals_folder: string | null
  status: SessionBackgroundCommand["status"]
  stdout: string
  stderr: string
  exit_code: number | null
  ms_to_wait: number | null
  background_reason: number | null
  last_terminal_file_length: number | null
  started_at: number
  updated_at: number
  completed_at: number | null
  completion_task_id: string | null
  completion_tool_call_id: string | null
  completion_status: number | null
  completion_reason: number | null
  output_path: string | null
  delivery_state: "none" | "pending" | "delivered"
  delivery_source_uuid: string | null
  delivered_at: number | null
}

export interface DurableBackgroundCommand extends SessionBackgroundCommand {
  completionTaskId?: string
  completionToolCallId?: string
  completionStatus?: number
  completionReason?: number
  outputPath?: string
  deliveryState: "none" | "pending" | "delivered"
  deliverySourceUuid?: string
  deliveredAt?: number
}

const BACKGROUND_COLUMNS = `
  command_id, origin_tool_call_id, exec_ids_json, command, cwd, pid,
  terminals_folder, status, stdout, stderr, exit_code, ms_to_wait,
  background_reason, last_terminal_file_length, started_at, updated_at,
  completed_at, completion_task_id, completion_tool_call_id,
  completion_status, completion_reason, output_path, delivery_state,
  delivery_source_uuid, delivered_at
`

@Injectable()
export class BackgroundCommandStore {
  private stmtFindByCommand?: StatementSync
  private stmtFindByToolCall?: StatementSync
  private stmtList?: StatementSync
  private stmtInsert?: StatementSync
  private stmtAppendOutput?: StatementSync
  private stmtReplaceOutput?: StatementSync
  private stmtSetTerminalFileLength?: StatementSync
  private stmtSetExit?: StatementSync
  private stmtRecordCompletion?: StatementSync
  private stmtDeliver?: StatementSync

  constructor(private readonly persistence: PersistenceService) {}

  register(
    conversationId: string,
    input: RegisterBackgroundCommandInput
  ): DurableBackgroundCommand {
    const cid = ConversationId.of(conversationId)
    const normalized = this.normalizeRegistration(input)
    return this.persistence.runInImmediateTransaction(() => {
      const byCommand = this.get(cid, normalized.commandId)
      const byToolCall = this.findByToolCallId(cid, normalized.originToolCallId)
      const existing = byCommand ?? byToolCall
      if (existing) {
        if (
          existing.commandId !== normalized.commandId ||
          existing.originToolCallId !== normalized.originToolCallId
        ) {
          throw new Error(
            `BackgroundCommandStore.register: identity conflict ` +
              `conversation=${cid} commandId=${normalized.commandId} ` +
              `toolCallId=${normalized.originToolCallId}`
          )
        }
        const immutableMatches =
          JSON.stringify(existing.execIds) ===
            JSON.stringify(normalized.execIds) &&
          existing.command === normalized.command &&
          existing.cwd === normalized.cwd &&
          existing.pid === normalized.pid &&
          existing.terminalsFolder === normalized.terminalsFolder &&
          existing.msToWait === normalized.msToWait &&
          existing.backgroundReason === normalized.backgroundReason &&
          existing.stdout.join("") === normalized.stdout &&
          existing.stderr.join("") === normalized.stderr &&
          existing.startedAt === normalized.startedAt
        if (!immutableMatches) {
          throw new Error(
            `BackgroundCommandStore.register: replay changed immutable command data ` +
              `conversation=${cid} commandId=${normalized.commandId}`
          )
        }
        return existing
      }
      ;(this.stmtInsert ??= this.persistence.prepare(
        `INSERT INTO session_background_commands (
           conversation_id, command_id, origin_tool_call_id, exec_ids_json,
           command, cwd, pid, terminals_folder, status, stdout, stderr,
           exit_code, ms_to_wait, background_reason,
           last_terminal_file_length, started_at, updated_at, completed_at,
           delivery_state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, NULL, ?, ?, NULL, ?, ?, NULL, 'none')`
      )).run(
        cid,
        normalized.commandId,
        normalized.originToolCallId,
        JSON.stringify(normalized.execIds),
        normalized.command,
        normalized.cwd,
        normalized.pid ?? null,
        normalized.terminalsFolder ?? null,
        normalized.stdout,
        normalized.stderr,
        normalized.msToWait ?? null,
        normalized.backgroundReason ?? null,
        normalized.startedAt,
        normalized.startedAt
      )
      const created = this.get(cid, normalized.commandId)
      if (!created) {
        throw new Error(
          `BackgroundCommandStore.register: inserted command disappeared ${normalized.commandId}`
        )
      }
      return created
    })
  }

  get(
    conversationId: string,
    commandId: string
  ): DurableBackgroundCommand | undefined {
    const cid = ConversationId.of(conversationId)
    const exactCommandId = requireExactDurableIdentifier(
      commandId,
      "BackgroundCommandStore.get commandId"
    )
    const row = (this.stmtFindByCommand ??= this.persistence.prepare(
      `SELECT ${BACKGROUND_COLUMNS}
         FROM session_background_commands
        WHERE conversation_id = ? AND command_id = ?`
    )).get(cid, exactCommandId) as BackgroundCommandRow | undefined
    return row ? this.toRecord(row) : undefined
  }

  findByToolCallId(
    conversationId: string,
    toolCallId: string
  ): DurableBackgroundCommand | undefined {
    const cid = ConversationId.of(conversationId)
    const exactToolCallId = requireExactDurableIdentifier(
      toolCallId,
      "BackgroundCommandStore.findByToolCallId toolCallId"
    )
    const row = (this.stmtFindByToolCall ??= this.persistence.prepare(
      `SELECT ${BACKGROUND_COLUMNS}
         FROM session_background_commands
        WHERE conversation_id = ? AND origin_tool_call_id = ?`
    )).get(cid, exactToolCallId) as BackgroundCommandRow | undefined
    return row ? this.toRecord(row) : undefined
  }

  list(conversationId: string): DurableBackgroundCommand[] {
    const cid = ConversationId.of(conversationId)
    const rows = (this.stmtList ??= this.persistence.prepare(
      `SELECT ${BACKGROUND_COLUMNS}
         FROM session_background_commands
        WHERE conversation_id = ?
        ORDER BY started_at, command_id`
    )).all(cid) as unknown as BackgroundCommandRow[]
    return rows.map((row) => this.toRecord(row))
  }

  appendOutput(
    conversationId: string,
    commandId: string,
    stream: "stdout" | "stderr",
    data: string
  ): boolean {
    if (!data) return false
    const cid = ConversationId.of(conversationId)
    const exactCommandId = requireExactDurableIdentifier(
      commandId,
      "BackgroundCommandStore.appendOutput commandId"
    )
    if (data.includes("\u0000")) {
      throw new Error("BackgroundCommandStore.appendOutput: NUL is forbidden")
    }
    const column = stream === "stdout" ? "stdout" : "stderr"
    this.stmtAppendOutput = this.persistence.prepare(
      `UPDATE session_background_commands
          SET ${column} = ${column} || ?, updated_at = ?
        WHERE conversation_id = ? AND command_id = ?`
    )
    const result = this.stmtAppendOutput.run(
      data,
      Date.now(),
      cid,
      exactCommandId
    )
    return (result.changes ?? 0) === 1
  }

  replaceOutput(
    conversationId: string,
    commandId: string,
    stdout: string,
    stderr: string
  ): boolean {
    const cid = ConversationId.of(conversationId)
    const exactCommandId = requireExactDurableIdentifier(
      commandId,
      "BackgroundCommandStore.replaceOutput commandId"
    )
    const exactStdout = this.text(stdout, "stdout")
    const exactStderr = this.text(stderr, "stderr")
    const result = (this.stmtReplaceOutput ??= this.persistence.prepare(
      `UPDATE session_background_commands
          SET stdout = ?, stderr = ?, updated_at = ?
        WHERE conversation_id = ? AND command_id = ?`
    )).run(exactStdout, exactStderr, Date.now(), cid, exactCommandId)
    return (result.changes ?? 0) === 1
  }

  setTerminalFileLength(
    conversationId: string,
    commandId: string,
    length: number
  ): boolean {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(
        "BackgroundCommandStore.setTerminalFileLength: length must be non-negative"
      )
    }
    const cid = ConversationId.of(conversationId)
    const exactCommandId = requireExactDurableIdentifier(
      commandId,
      "BackgroundCommandStore.setTerminalFileLength commandId"
    )
    const result = (this.stmtSetTerminalFileLength ??= this.persistence.prepare(
      `UPDATE session_background_commands
            SET last_terminal_file_length = ?, updated_at = ?
          WHERE conversation_id = ? AND command_id = ?`
    )).run(length, Date.now(), cid, exactCommandId)
    return (result.changes ?? 0) === 1
  }

  setExit(
    conversationId: string,
    commandId: string,
    exitCode: number,
    aborted = false,
    completedAt = Date.now()
  ): boolean {
    if (!Number.isSafeInteger(exitCode)) {
      throw new Error(
        "BackgroundCommandStore.setExit: exitCode must be an integer"
      )
    }
    const cid = ConversationId.of(conversationId)
    const exactCommandId = requireExactDurableIdentifier(
      commandId,
      "BackgroundCommandStore.setExit commandId"
    )
    const status = aborted ? "aborted" : exitCode === 0 ? "completed" : "failed"
    const result = (this.stmtSetExit ??= this.persistence.prepare(
      `UPDATE session_background_commands
          SET exit_code = ?, status = ?, updated_at = ?, completed_at = ?
        WHERE conversation_id = ? AND command_id = ?
          AND status = 'running'`
    )).run(exitCode, status, completedAt, completedAt, cid, exactCommandId)
    if ((result.changes ?? 0) === 1) return true
    const existing = this.get(cid, exactCommandId)
    return (
      existing !== undefined &&
      existing.exitCode === exitCode &&
      existing.status === status
    )
  }

  recordCompletion(
    conversationId: string,
    input: RecordBackgroundShellCompletionInput
  ): DurableBackgroundCommand {
    const cid = ConversationId.of(conversationId)
    const commandId = requireExactDurableIdentifier(
      input.commandId,
      "BackgroundCommandStore.recordCompletion commandId"
    )
    const originToolCallId = requireExactDurableIdentifier(
      input.originToolCallId,
      "BackgroundCommandStore.recordCompletion originToolCallId"
    )
    const taskId = requireExactDurableIdentifier(
      input.taskId,
      "BackgroundCommandStore.recordCompletion taskId"
    )
    const toolCallId = requireOptionalExactDurableIdentifier(
      input.toolCallId,
      "BackgroundCommandStore.recordCompletion toolCallId"
    )
    if (toolCallId && toolCallId !== originToolCallId) {
      throw new Error(
        `BackgroundCommandStore.recordCompletion: official toolCallId mismatch ` +
          `expected=${originToolCallId} actual=${toolCallId}`
      )
    }
    const outputPath = this.optionalPath(input.outputPath, "outputPath")
    const completedAt = input.completedAt ?? Date.now()
    if (!Number.isSafeInteger(completedAt) || completedAt <= 0) {
      throw new Error(
        "BackgroundCommandStore.recordCompletion: completedAt must be a positive epoch"
      )
    }
    if (input.status !== undefined && ![0, 1, 2, 3].includes(input.status)) {
      throw new Error(
        "BackgroundCommandStore.recordCompletion: invalid completion status"
      )
    }
    if (input.reason !== undefined && ![0, 1, 2].includes(input.reason)) {
      throw new Error(
        "BackgroundCommandStore.recordCompletion: invalid completion reason"
      )
    }
    return this.persistence.runInImmediateTransaction(() => {
      const existing = this.get(cid, commandId)
      if (!existing || existing.originToolCallId !== originToolCallId) {
        throw new Error(
          `BackgroundCommandStore.recordCompletion: command identity not found ` +
            `conversation=${cid} commandId=${commandId} toolCallId=${originToolCallId}`
        )
      }
      if (existing.deliveryState !== "none") {
        if (
          existing.completionTaskId !== taskId ||
          existing.completionToolCallId !== toolCallId ||
          existing.completionStatus !== input.status ||
          existing.completionReason !== input.reason ||
          existing.outputPath !== outputPath
        ) {
          throw new Error(
            `BackgroundCommandStore.recordCompletion: completion replay changed identity ${commandId}`
          )
        }
        return existing
      }
      const terminalStatus = (() => {
        if (input.status === 1) return "completed" as const
        if (input.status === 2) return "failed" as const
        if (input.status === 3) return "aborted" as const
        if (existing.status !== "running") return existing.status
        throw new Error(
          `BackgroundCommandStore.recordCompletion: terminal completion has no ` +
            `terminal status conversation=${cid} commandId=${commandId}`
        )
      })()
      const exitCode = input.status === 1 ? 0 : existing.exitCode
      const result = (this.stmtRecordCompletion ??= this.persistence.prepare(
        `UPDATE session_background_commands
          SET status = ?, exit_code = COALESCE(exit_code, ?),
              updated_at = ?, completed_at = COALESCE(completed_at, ?),
              completion_task_id = ?, completion_tool_call_id = ?,
              completion_status = ?, completion_reason = ?, output_path = ?,
              delivery_state = 'pending'
        WHERE conversation_id = ? AND command_id = ?
          AND origin_tool_call_id = ? AND delivery_state = 'none'`
      )).run(
        terminalStatus,
        exitCode ?? null,
        completedAt,
        completedAt,
        taskId,
        toolCallId ?? null,
        input.status ?? null,
        input.reason ?? null,
        outputPath ?? null,
        cid,
        commandId,
        originToolCallId
      )
      if ((result.changes ?? 0) !== 1) {
        throw new Error(
          `BackgroundCommandStore.recordCompletion: terminal transition was not applied ${commandId}`
        )
      }
      const recorded = this.get(cid, commandId)
      if (!recorded) {
        throw new Error(
          `BackgroundCommandStore.recordCompletion: terminal command disappeared ${commandId}`
        )
      }
      return recorded
    })
  }

  markDeliveredInTransaction(
    txn: SessionTxn,
    delivery: BackgroundShellCompletionIdentity,
    sourceRecordUuid: string,
    deliveredAt = Date.now()
  ): void {
    this.assertTransaction(txn, "markDeliveredInTransaction")
    const commandId = requireExactDurableIdentifier(
      delivery.commandId,
      "BackgroundCommandStore.markDelivered commandId"
    )
    const originToolCallId = requireExactDurableIdentifier(
      delivery.originToolCallId,
      "BackgroundCommandStore.markDelivered originToolCallId"
    )
    const sourceUuid = requireExactDurableIdentifier(
      sourceRecordUuid,
      "BackgroundCommandStore.markDelivered sourceRecordUuid"
    )
    const result = (this.stmtDeliver ??= this.persistence.prepare(
      `UPDATE session_background_commands
          SET delivery_state = 'delivered', delivery_source_uuid = ?,
              delivered_at = ?, updated_at = ?
        WHERE conversation_id = ? AND command_id = ?
          AND origin_tool_call_id = ? AND delivery_state = 'pending'`
    )).run(
      sourceUuid,
      deliveredAt,
      deliveredAt,
      txn.conversationId,
      commandId,
      originToolCallId
    )
    if ((result.changes ?? 0) !== 1) {
      throw new Error(
        `BackgroundCommandStore.markDelivered: no pending completion ` +
          `conversation=${txn.conversationId} commandId=${commandId}`
      )
    }
  }

  private normalizeRegistration(input: RegisterBackgroundCommandInput) {
    const commandId = requireExactDurableIdentifier(
      input.commandId,
      "BackgroundCommandStore.register commandId"
    )
    const originToolCallId = requireExactDurableIdentifier(
      input.originToolCallId,
      "BackgroundCommandStore.register originToolCallId"
    )
    const execIds = [...(input.execIds ?? [])].map((value) => {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(
          "BackgroundCommandStore.register: execIds must be positive integers"
        )
      }
      return value
    })
    if (new Set(execIds).size !== execIds.length) {
      throw new Error("BackgroundCommandStore.register: duplicate execIds")
    }
    const command = this.text(input.command, "command")
    const cwd = this.text(input.cwd, "cwd")
    const terminalsFolder = this.optionalPath(
      input.terminalsFolder,
      "terminalsFolder"
    )
    const startedAt = input.startedAt ?? Date.now()
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) {
      throw new Error(
        "BackgroundCommandStore.register: startedAt must be a positive epoch"
      )
    }
    return {
      commandId,
      originToolCallId,
      execIds,
      command,
      cwd,
      pid: this.optionalNonNegativeInteger(input.pid, "pid"),
      terminalsFolder,
      stdout: this.text(input.stdout ?? "", "stdout"),
      stderr: this.text(input.stderr ?? "", "stderr"),
      msToWait: this.optionalNonNegativeInteger(input.msToWait, "msToWait"),
      backgroundReason: this.optionalInteger(
        input.backgroundReason,
        "backgroundReason"
      ),
      startedAt,
    }
  }

  private text(value: string, field: string): string {
    if (typeof value !== "string" || value.includes("\u0000")) {
      throw new Error(
        `BackgroundCommandStore: ${field} must be a NUL-free string`
      )
    }
    return value
  }

  private optionalPath(value: string | undefined, field: string) {
    if (value === undefined) return undefined
    const exact = this.text(value, field)
    if (exact.length === 0) {
      throw new Error(`BackgroundCommandStore: ${field} must be non-empty`)
    }
    return exact
  }

  private optionalInteger(value: number | undefined, field: string) {
    if (value === undefined) return undefined
    if (!Number.isSafeInteger(value)) {
      throw new Error(`BackgroundCommandStore: ${field} must be an integer`)
    }
    return value
  }

  private optionalNonNegativeInteger(value: number | undefined, field: string) {
    const integer = this.optionalInteger(value, field)
    if (integer !== undefined && integer < 0) {
      throw new Error(`BackgroundCommandStore: ${field} must be non-negative`)
    }
    return integer
  }

  private assertTransaction(txn: SessionTxn, operation: string): void {
    const internal = txn as SessionTxnInternal | undefined
    if (
      !internal ||
      internal.tag !== SESSION_TXN_TAG ||
      internal.persistence !== this.persistence
    ) {
      throw new Error(
        `BackgroundCommandStore.${operation}: requires the active graph transaction`
      )
    }
  }

  private toRecord(row: BackgroundCommandRow): DurableBackgroundCommand {
    let execIds: unknown
    try {
      execIds = JSON.parse(row.exec_ids_json)
    } catch {
      throw new Error(
        `BackgroundCommandStore: invalid exec_ids_json for ${row.command_id}`
      )
    }
    if (
      !Array.isArray(execIds) ||
      execIds.some(
        (value) => !Number.isSafeInteger(value) || (value as number) <= 0
      ) ||
      new Set(execIds).size !== execIds.length
    ) {
      throw new Error(
        `BackgroundCommandStore: invalid durable exec ids for ${row.command_id}`
      )
    }
    return {
      commandId: requireExactDurableIdentifier(
        row.command_id,
        "BackgroundCommandStore durable commandId"
      ),
      originToolCallId: requireExactDurableIdentifier(
        row.origin_tool_call_id,
        "BackgroundCommandStore durable originToolCallId"
      ),
      execIds: execIds as number[],
      command: row.command,
      cwd: row.cwd,
      pid: row.pid ?? undefined,
      terminalsFolder: row.terminals_folder ?? undefined,
      status: row.status,
      stdout: row.stdout ? [row.stdout] : [],
      stderr: row.stderr ? [row.stderr] : [],
      exitCode: row.exit_code ?? undefined,
      msToWait: row.ms_to_wait ?? undefined,
      backgroundReason: row.background_reason ?? undefined,
      lastTerminalFileLength: row.last_terminal_file_length ?? undefined,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
      completionTaskId: requireOptionalExactDurableIdentifier(
        row.completion_task_id ?? undefined,
        "BackgroundCommandStore durable completionTaskId"
      ),
      completionToolCallId: requireOptionalExactDurableIdentifier(
        row.completion_tool_call_id ?? undefined,
        "BackgroundCommandStore durable completionToolCallId"
      ),
      completionStatus: row.completion_status ?? undefined,
      completionReason: row.completion_reason ?? undefined,
      outputPath: row.output_path ?? undefined,
      deliveryState: row.delivery_state,
      deliverySourceUuid: requireOptionalExactDurableIdentifier(
        row.delivery_source_uuid ?? undefined,
        "BackgroundCommandStore durable deliverySourceUuid"
      ),
      deliveredAt: row.delivered_at ?? undefined,
    }
  }
}
