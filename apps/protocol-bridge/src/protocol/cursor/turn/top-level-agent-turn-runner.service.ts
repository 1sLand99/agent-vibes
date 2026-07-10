import { Injectable, Logger } from "@nestjs/common"
import type { ContextInvestigationMemoryEntry } from "../../../context/types"
import type {
  SessionActiveToolBatch,
  SessionTopLevelAgentTurnState,
} from "../session/session-lifecycle.service"
import { SessionLifecycleService } from "../session/session-lifecycle.service"
import { ContextStateService } from "../session/context-state.service"

export interface TopLevelContinuationBudgetOptions {
  conversationId: string
  continuationLabel: string
  maxRounds: number
}

export type TopLevelContinuationBudgetDecision =
  | {
      kind: "continue"
      round: number
      maxRounds: number
    }
  | {
      kind: "stop"
      round: number
      maxRounds: number
      notice: string
    }

export interface TopLevelContinuationLaneOptions {
  conversationId: string
  continuationLabel: string
  toolCallId: string
}

export interface TopLevelPreparedToolForState {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export interface TopLevelToolBatchCallbacks {
  isReadOnlyTool(toolName: string, input: Record<string, unknown>): boolean
  summarizeToolInput(toolName: string, input: Record<string, unknown>): string
}

export interface NoteTopLevelToolBatchOptions {
  conversationId: string
  assistantText: string
  tools: TopLevelPreparedToolForState[]
  callbacks: Pick<TopLevelToolBatchCallbacks, "isReadOnlyTool">
}

export interface RecordTopLevelToolResultOptions {
  conversationId: string
  toolCallId: string
  toolResultContent: string
  callbacks: Pick<TopLevelToolBatchCallbacks, "summarizeToolInput">
}

export interface RecordedTopLevelToolBatchSummary {
  summary: ContextInvestigationMemoryEntry
  batch: SessionActiveToolBatch
}

/**
 * Owns the top-level agent turn state that spans a user request and its tool
 * continuations. CursorConnectStreamService may still assemble protocol frames,
 * but it no longer creates, resets, increments, or completes this state itself.
 */
@Injectable()
export class TopLevelAgentTurnRunnerService {
  private readonly logger = new Logger(TopLevelAgentTurnRunnerService.name)
  private readonly lanes = new Map<string, Promise<void>>()
  private readonly investigationMemoryLimit = 8
  private readonly toolBatchSummaryDetailsLimit = 6

  constructor(
    private readonly contextState: ContextStateService,
    private readonly sessionLifecycle: SessionLifecycleService
  ) {}

  getState(conversationId: string): SessionTopLevelAgentTurnState {
    const record = this.contextState.getContextRecord(conversationId)
    if (!record) {
      throw new Error(`No context state for conversation ${conversationId}`)
    }
    if (!record.topLevelAgentTurnState) {
      record.topLevelAgentTurnState = this.createInitialState()
      this.sessionLifecycle.markSessionDirty(conversationId)
    }
    return record.topLevelAgentTurnState
  }

  resetState(conversationId: string): void {
    this.contextState.setTopLevelAgentTurnState(
      conversationId,
      this.createInitialState()
    )
    this.sessionLifecycle.markSessionDirty(conversationId)
  }

  createInitialState(): SessionTopLevelAgentTurnState {
    return {
      llmTurnCount: 1,
      continuationBudget: {
        continuationCount: 0,
        lastHistoryTokens: 0,
        lastDeltaTokens: 0,
        startedAt: Date.now(),
      },
    }
  }

  reserveContinuationRound(
    conversationId: string,
    options: Omit<TopLevelContinuationBudgetOptions, "conversationId">
  ): TopLevelContinuationBudgetDecision {
    const state = this.getState(conversationId)
    const currentRound =
      Number.isFinite(state.llmTurnCount) && state.llmTurnCount > 0
        ? Math.floor(state.llmTurnCount)
        : 1
    const nextRound = currentRound + 1
    state.llmTurnCount = nextRound
    this.sessionLifecycle.markSessionDirty(conversationId)

    if (nextRound <= options.maxRounds) {
      return {
        kind: "continue",
        round: nextRound,
        maxRounds: options.maxRounds,
      }
    }

    this.logger.warn(
      `[turn-runner] ${options.continuationLabel} reached max continuation rounds ` +
        `(${options.maxRounds}) for ${conversationId}; finalizing to prevent runaway`
    )
    return {
      kind: "stop",
      round: nextRound,
      maxRounds: options.maxRounds,
      notice:
        `I've reached the maximum number of LLM continuation rounds for this turn ` +
        `(${options.maxRounds}). Stopping here to avoid running unbounded - tell me how you'd like to continue.`,
    }
  }

  notePreparedToolBatch(options: NoteTopLevelToolBatchOptions): void {
    if (options.tools.length === 0) return

    const state = this.getState(options.conversationId)
    const readOnly = options.tools.every((tool) =>
      options.callbacks.isReadOnlyTool(tool.toolName, tool.input)
    )

    state.activeToolBatch = {
      batchId: crypto.randomUUID(),
      toolCallIds: options.tools.map((tool) => tool.toolCallId),
      assistantText: options.assistantText.trim(),
      readOnly,
      startedAt: Date.now(),
      tools: options.tools.map((tool) => ({
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        input: tool.input,
      })),
    }
    this.sessionLifecycle.markSessionDirty(options.conversationId)
  }

  recordCompletedToolResult(
    options: RecordTopLevelToolResultOptions
  ): RecordedTopLevelToolBatchSummary | undefined {
    const state = this.getState(options.conversationId)
    const activeBatch = state.activeToolBatch
    if (!activeBatch) return undefined

    const trackedTool = activeBatch.tools.find(
      (tool) => tool.toolCallId === options.toolCallId
    )
    if (!trackedTool) return undefined

    trackedTool.resultSummary = this.buildToolResultSummaryPreview(
      options.toolResultContent
    )

    const completed = activeBatch.tools.every(
      (tool) => typeof tool.resultSummary === "string"
    )
    if (!completed) {
      this.sessionLifecycle.markSessionDirty(options.conversationId)
      return undefined
    }

    const summary = this.buildCompletedToolBatchSummary(
      activeBatch,
      options.callbacks
    )
    state.activeToolBatch = undefined
    this.contextState.appendInvestigationMemory(
      options.conversationId,
      summary,
      this.investigationMemoryLimit
    )
    this.sessionLifecycle.markSessionDirty(options.conversationId)
    return { summary, batch: activeBatch }
  }

  async runExclusive<T>(
    options: TopLevelContinuationLaneOptions,
    run: () => Promise<T>
  ): Promise<T> {
    const conversationId = options.conversationId
    const previous = this.lanes.get(conversationId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const current = previous.catch(() => undefined).then(() => gate)
    this.lanes.set(conversationId, current)

    await previous.catch(() => undefined)
    try {
      return await run()
    } finally {
      release()
      if (this.lanes.get(conversationId) === current) {
        this.lanes.delete(conversationId)
      }
    }
  }

  private buildCompletedToolBatchSummary(
    batch: SessionActiveToolBatch,
    callbacks: Pick<TopLevelToolBatchCallbacks, "summarizeToolInput">
  ): ContextInvestigationMemoryEntry {
    const label = this.buildToolBatchLabel(batch)
    const detailLines = batch.tools
      .slice(0, this.toolBatchSummaryDetailsLimit)
      .map((tool) => {
        const inputSummary = callbacks.summarizeToolInput(
          tool.toolName,
          tool.input
        )
        const resultSummary = tool.resultSummary || "completed"
        return `- ${tool.toolName}: ${inputSummary}; result=${resultSummary}`
      })
    const details = [
      batch.assistantText
        ? `Intent: ${this.truncateForToolSummary(batch.assistantText, 180)}`
        : "",
      ...detailLines,
      batch.tools.length > this.toolBatchSummaryDetailsLimit
        ? `- ...and ${batch.tools.length - this.toolBatchSummaryDetailsLimit} more tool result(s)`
        : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n")

    return {
      batchId: batch.batchId,
      label,
      details,
      toolCallIds: [...batch.toolCallIds],
      toolCount: batch.tools.length,
      readOnly: batch.readOnly,
      createdAt: Date.now(),
    }
  }

  private buildToolBatchLabel(batch: SessionActiveToolBatch): string {
    const counts = new Map<string, number>()
    for (const tool of batch.tools) {
      counts.set(tool.toolName, (counts.get(tool.toolName) || 0) + 1)
    }

    const dominantTool = Array.from(counts.entries()).sort(
      (a, b) => b[1] - a[1]
    )[0]?.[0]
    const firstTool = batch.tools[0]

    if (dominantTool === "read_file" || dominantTool === "read_file_v2") {
      const paths = batch.tools
        .map((tool) => this.pickToolPath(tool.input))
        .filter((value): value is string => !!value)
      if (paths.length > 0) {
        return `Read ${paths.slice(0, 2).join(", ")}${paths.length > 2 ? "..." : ""}`
      }
    }

    if (dominantTool === "grep_search") {
      const query = this.pickToolQuery(firstTool?.input)
      if (query) {
        return `Searched for ${this.truncateForToolSummary(query, 36)}`
      }
    }

    if (dominantTool === "run_terminal_command") {
      const command = this.pickShellCommand(firstTool?.input)
      if (command) {
        return `Ran ${this.truncateForToolSummary(command, 36)}`
      }
    }

    if (dominantTool === "exec_command") {
      const command = this.pickShellCommand(firstTool?.input)
      if (command) {
        return `Ran ${this.truncateForToolSummary(command, 36)}`
      }
    }

    if (dominantTool === "read_lints") {
      return "Read lint diagnostics"
    }

    return `Completed ${batch.tools.length} investigative tool call${batch.tools.length === 1 ? "" : "s"}`
  }

  private buildToolResultSummaryPreview(content: string): string {
    const compact = content.replace(/\s+/g, " ").trim()
    return this.truncateForToolSummary(compact, 160)
  }

  private pickToolPath(
    input: Record<string, unknown> | undefined
  ): string | null {
    if (!input) return null
    const candidates = [
      input.path,
      input.SearchPath,
      input.searchPath,
      input.search_path,
      input.AbsolutePath,
      input.absolutePath,
      input.absolute_path,
      input.DirectoryPath,
      input.directoryPath,
      input.directory_path,
      input.TargetFile,
      input.targetFile,
      input.target_file,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim()
      }
    }
    return null
  }

  private pickToolQuery(
    input: Record<string, unknown> | undefined
  ): string | null {
    if (!input) return null
    const candidates = [input.query, input.Query, input.pattern, input.Pattern]
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim()
      }
    }
    return null
  }

  private pickShellCommand(
    input: Record<string, unknown> | undefined
  ): string | null {
    if (!input) return null
    const candidates = [input.command, input.cmd]
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim()
      }
    }
    return null
  }

  private truncateForToolSummary(value: string, maxChars: number): string {
    const normalized = value.replace(/\s+/g, " ").trim()
    if (normalized.length <= maxChars) return normalized
    return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
  }
}
