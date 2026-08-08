import { Injectable, Logger } from "@nestjs/common"
import type {
  SessionActiveToolBatch,
  SessionTopLevelAgentTurnState,
} from "../session/session-lifecycle.service"
import { SessionLifecycleService } from "../session/session-lifecycle.service"
import { ContextStateService } from "../session/context-state.service"
import type { TurnId } from "./turn.types"
import type { BackendType } from "../../../llm/shared/model-router.service"
import type { ResolvedSubagentOverride } from "../subagents/subagent-model-override"
import type { CodexContextSynchronizationReceipt } from "../session/projection-request-scope"

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
}

export interface NoteTopLevelToolBatchOptions {
  conversationId: string
  graphTurnId: TurnId
  providerBackend: BackendType
  providerModel: string
  toolUseSummaryOverride?: ResolvedSubagentOverride
  assistantText: string
  tools: TopLevelPreparedToolForState[]
  callbacks: Pick<TopLevelToolBatchCallbacks, "isReadOnlyTool">
}

export interface RecordTopLevelToolResultOptions {
  conversationId: string
  graphTurnId: TurnId
  toolCallId: string
  toolResultContent: string
}

export interface CompletedTopLevelToolBatch {
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

  constructor(
    private readonly contextState: ContextStateService,
    private readonly sessionLifecycle: SessionLifecycleService
  ) {}

  getState(conversationId: string): SessionTopLevelAgentTurnState {
    const record = this.contextState.getContextRecord(conversationId)
    if (!record) {
      throw new Error(`No context state for conversation ${conversationId}`)
    }
    if (!record.topLevelAgentTurnState?.topLevelTurnId) {
      throw new Error(
        `No active top-level agent turn for conversation ${conversationId}`
      )
    }
    return record.topLevelAgentTurnState
  }

  beginTopLevelTurn(conversationId: string, topLevelTurnId: TurnId): void {
    this.contextState.beginTopLevelAgentTurn(
      conversationId,
      this.createInitialState(topLevelTurnId)
    )
  }

  /**
   * Release turn-local working state when its graph execution terminates
   * without completing the batch. Accepted graph fragments stay durable; a
   * later result for this graph turn must not finish or summarize a newer
   * top-level request's active batch.
   */
  abortGraphTurn(conversationId: string, graphTurnId: TurnId): boolean {
    const record = this.contextState.getContextRecord(conversationId)
    const state = record?.topLevelAgentTurnState
    const activeBatch = state?.activeToolBatch
    if (!state || !activeBatch || activeBatch.graphTurnId !== graphTurnId) {
      return false
    }
    state.activeToolBatch = undefined
    this.sessionLifecycle.markSessionDirty(conversationId)
    return true
  }

  createInitialState(topLevelTurnId: TurnId): SessionTopLevelAgentTurnState {
    return {
      topLevelTurnId,
      llmTurnCount: 1,
      codexContextRevision: 0,
      continuationBudget: {
        continuationCount: 0,
        lastHistoryTokens: 0,
        lastDeltaTokens: 0,
        startedAt: Date.now(),
      },
    }
  }

  captureCodexContextSynchronization(
    conversationId: string
  ): CodexContextSynchronizationReceipt {
    const state = this.getState(conversationId)
    const topLevelTurnId = state.topLevelTurnId
    if (!topLevelTurnId) {
      throw new Error(
        `Cannot capture Codex context without a top-level turn for ${conversationId}`
      )
    }
    const revision = state.codexContextRevision
    return Object.freeze({
      topLevelTurnId,
      revision,
      mode:
        state.acceptedCodexContextRevision === revision
          ? "retain"
          : "synchronize",
    })
  }

  invalidateCodexContext(conversationId: string): void {
    const state = this.getState(conversationId)
    state.codexContextRevision += 1
    this.sessionLifecycle.markSessionDirty(conversationId)
  }

  acceptCodexContextSynchronization(
    conversationId: string,
    receipt: CodexContextSynchronizationReceipt
  ): void {
    const state = this.getState(conversationId)
    if (
      state.topLevelTurnId !== receipt.topLevelTurnId ||
      state.codexContextRevision !== receipt.revision
    ) {
      throw new Error(
        `Codex context synchronization became stale for ${conversationId}`
      )
    }
    state.acceptedCodexContextRevision = receipt.revision
    this.sessionLifecycle.markSessionDirty(conversationId)
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
      topLevelTurnId: state.topLevelTurnId!,
      graphTurnId: options.graphTurnId,
      providerBackend: options.providerBackend,
      providerModel: options.providerModel,
      toolUseSummaryOverride:
        options.toolUseSummaryOverride === undefined
          ? undefined
          : Object.freeze({ ...options.toolUseSummaryOverride }),
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
  ): CompletedTopLevelToolBatch | undefined {
    const state = this.getState(options.conversationId)
    const activeBatch = state.activeToolBatch
    if (!activeBatch) return undefined
    if (
      activeBatch.topLevelTurnId !== state.topLevelTurnId ||
      activeBatch.graphTurnId !== options.graphTurnId
    ) {
      return undefined
    }

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

    state.activeToolBatch = undefined
    this.sessionLifecycle.markSessionDirty(options.conversationId)
    return { batch: activeBatch }
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

  private buildToolResultSummaryPreview(content: string): string {
    const compact = content.replace(/\s+/g, " ").trim()
    if (compact.length <= 160) return compact
    return `${compact.slice(0, 157).trimEnd()}...`
  }
}
