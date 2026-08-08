import { Injectable, Logger } from "@nestjs/common"

import { ContextStateService } from "../session/context-state.service"
import type { SubagentGraphBranch } from "../session/subagent-graph"
import type { SubagentRunRecord } from "../session/subagent-run-store.service"
import type { WorkspaceScope } from "../session/workspace-scope"
import {
  requireSubagentProviderRequestReceipt,
  type SubagentProviderRequestReceipt,
} from "../session/projection-request-scope"
import {
  FrozenCapabilityInvocationResolver,
  type FrozenCapabilityPresentationInvocation,
  type ResolvedFrozenCapabilityInvocation,
} from "./subagent-capability-runtime"
import { findLastSubagentAssistantText } from "./subagent-graph-metrics"
import { buildSubagentToolResultRejectionMetadata } from "./subagent-tool-result-presentation"
import type { SubAgentAssistantContentBlock } from "./subagent-sse-turn-collector"
import { SubagentTranscriptStore } from "./subagent-transcript-store.service"

export interface BackgroundWorkerHostDeps {
  runFrozenCapability(
    conversationId: string,
    run: SubagentRunRecord,
    invocation: ResolvedFrozenCapabilityInvocation,
    workspaceScope: WorkspaceScope,
    options: { abortSignal: AbortSignal }
  ): Promise<{ content: string; status: "success" | "error" }>
  runSubAgentLlmTurn(
    conversationId: string,
    ctx: {
      run: SubagentRunRecord
      branch: SubagentGraphBranch
      abortSignal: AbortSignal
    }
  ): Promise<BackgroundWorkerLlmTurnResult>
  buildAssistantStep(text: string): unknown
  buildToolCallStep(args: {
    invocation: FrozenCapabilityPresentationInvocation
    callId: string
    parsedInput: Record<string, unknown>
    resultContent: string
    outcome: { status: "success" | "error" }
  }): {
    conversationStep: unknown
    toolResultMetadata: Record<string, unknown>
  }
}

/**
 * A worker only receives a workspace authority with an accepted provider
 * response. Failure and cancellation never carry a prepare-time authority.
 */
export type BackgroundWorkerLlmTurnResult =
  | {
      readonly kind: "accepted"
      readonly fullText: string
      /** The one accepted provider block sequence already committed to graph. */
      readonly assistantContent: readonly SubAgentAssistantContentBlock[]
      readonly rawResponseItems: Record<string, unknown>[]
      readonly requestReceipt: SubagentProviderRequestReceipt
    }
  | {
      readonly kind: "failed"
      readonly error: string
    }

interface BackgroundWorkerMetrics {
  turnCount: number
  toolCallCount: number
  conversationSteps: unknown[]
}

export type BackgroundWorkerOutcome =
  | (BackgroundWorkerMetrics & {
      status: "completed"
      finalText: string
    })
  | (BackgroundWorkerMetrics & {
      status: "failed"
      errorMessage: string
    })
  | (BackgroundWorkerMetrics & {
      status: "aborted"
      errorMessage: string
    })

/**
 * The worker can observe only that its signal was aborted. Whether that
 * signal represents an explicit `kill_agent`, shutdown, or another
 * interruption belongs to the owning TurnHandle and is classified there.
 */
export type BackgroundWorkerTerminalOutcome =
  | (BackgroundWorkerMetrics & {
      status: "completed"
      finalText: string
    })
  | (BackgroundWorkerMetrics & {
      status: "failed" | "killed" | "interrupted"
      errorMessage: string
    })

export interface RunBackgroundWorkerArgs {
  conversationId: string
  /** The persisted child run is the sole runtime authority. */
  run: SubagentRunRecord
  branch: SubagentGraphBranch
  signal: AbortSignal
  host: BackgroundWorkerHostDeps
}

interface DurableBackgroundGraphMetrics {
  turnCount: number
  toolCallCount: number
}

/**
 * Executes one detached sub-agent sidechain. It owns no spawn identity, run
 * status, delivery state, or cancellation controller; those belong to the
 * TurnLifecycle and SubagentRunStore. Transcript files are diagnostic exports.
 */
@Injectable()
export class SubagentBackgroundWorker {
  private readonly logger = new Logger(SubagentBackgroundWorker.name)

  constructor(
    private readonly transcriptStore: SubagentTranscriptStore,
    private readonly contextState: ContextStateService
  ) {}

  async run(args: RunBackgroundWorkerArgs): Promise<BackgroundWorkerOutcome> {
    const initialMetrics = this.readDurableGraphMetrics(args)
    const maxTurns = args.run.spawnRequest.maxTurns
    const capabilityResolver = new FrozenCapabilityInvocationResolver()
    const conversationSteps: unknown[] = []

    this.transcriptStore.appendTranscript(args.run.agentId, {
      ts: Date.now(),
      kind: "turn_start",
      data: { turnIndex: 0, message: "background sub-agent started" },
    })

    try {
      for (
        let persistedTurnCount = initialMetrics.turnCount;
        maxTurns === null || persistedTurnCount < maxTurns;
        persistedTurnCount++
      ) {
        args.signal.throwIfAborted()
        this.transcriptStore.appendTranscript(args.run.agentId, {
          ts: Date.now(),
          kind: "turn_start",
          data: { turnIndex: persistedTurnCount + 1 },
        })

        const llmResult = await args.host.runSubAgentLlmTurn(
          args.conversationId,
          {
            run: args.run,
            branch: args.branch,
            abortSignal: args.signal,
          }
        )
        args.signal.throwIfAborted()
        if (llmResult.kind === "failed") {
          throw new Error(`LLM turn failed: ${llmResult.error}`)
        }
        const requestReceipt = requireSubagentProviderRequestReceipt({
          receipt: llmResult.requestReceipt,
          branch: args.branch,
        })

        if (llmResult.fullText) {
          this.exportAssistantText(args, llmResult.fullText, conversationSteps)
        }

        const acceptedToolCalls = llmResult.assistantContent.flatMap((block) =>
          block.type === "tool_use" ? [block] : []
        )

        if (acceptedToolCalls.length === 0) {
          const finalText = llmResult.fullText.trim()
          if (!finalText) {
            throw new Error(
              "Sub-agent completed without a final assistant answer."
            )
          }
          return {
            status: "completed",
            finalText: llmResult.fullText,
            ...this.readDurableGraphMetrics(args),
            conversationSteps,
          }
        }
        const workspaceScope = requestReceipt.workspaceScope

        let completedToolCalls = 0
        for (const toolCall of acceptedToolCalls) {
          args.signal.throwIfAborted()
          // The collector validates every accepted tool block before the
          // graph append. Use the exact persisted input rather than carrying
          // a second serialized tool-call representation through the worker.
          const parsedInput = structuredClone(toolCall.input)
          let resultContent: string | undefined
          let resultStatus: "success" | "error" = "error"
          const resolved = capabilityResolver.resolve({
            toolContract: args.run.spawnRequest.toolContract,
            phase: "background",
            modelToolName: toolCall.name,
            parsedJson: parsedInput,
          })
          if (
            resolved.kind === "tool_error" &&
            resolved.code !== "unknown_capability"
          ) {
            throw new Error(
              `Frozen child capability resolution is not persistable: ${resolved.code}: ${resolved.message}`
            )
          }
          let dispatchInvocation: ResolvedFrozenCapabilityInvocation | undefined
          let presentationInvocation:
            | FrozenCapabilityPresentationInvocation
            | undefined
          let rejectionMetadata: Record<string, unknown> | undefined

          this.transcriptStore.appendTranscript(args.run.agentId, {
            ts: Date.now(),
            kind: "tool_call_start",
            data: { id: toolCall.id, name: toolCall.name, input: parsedInput },
          })

          if (resolved.kind !== "resolved") {
            resultStatus = "error"
            resultContent = formatFrozenCapabilityToolError(resolved)
            if (resolved.kind === "rejected") {
              presentationInvocation = resolved
            } else if (resolved.kind === "unowned") {
              rejectionMetadata = {
                ...buildSubagentToolResultRejectionMetadata({
                  version: 1,
                  capabilityId: resolved.capabilityId,
                  phase: resolved.phase,
                  modelToolName: resolved.modelToolName,
                  code: resolved.code,
                }),
              }
            } else if (resolved.code === "unknown_capability") {
              rejectionMetadata = {
                ...buildSubagentToolResultRejectionMetadata({
                  version: 1,
                  capabilityId: null,
                  phase: "background",
                  modelToolName: resolved.modelToolName,
                  code: "unknown_capability",
                }),
              }
            }
          } else {
            dispatchInvocation = resolved
            presentationInvocation = resolved
            try {
              const result = await args.host.runFrozenCapability(
                args.conversationId,
                args.run,
                dispatchInvocation,
                workspaceScope,
                { abortSignal: args.signal }
              )
              args.signal.throwIfAborted()
              resultStatus = result.status
              resultContent = result.content
            } catch (error) {
              args.signal.throwIfAborted()
              resultStatus = "error"
              resultContent = `[tool error] ${String(error)}`
            }
          }

          if (resultContent === undefined) {
            throw new Error(
              `Tool ${toolCall.name} completed without a result projection.`
            )
          }

          this.transcriptStore.appendTranscript(args.run.agentId, {
            ts: Date.now(),
            kind: "tool_call_end",
            data: {
              id: toolCall.id,
              name: presentationInvocation?.entry.name ?? toolCall.name,
              status: resultStatus,
              contentPreview: resultContent.slice(0, 1000),
            },
          })
          // Unknown calls have no frozen Cursor owner and cannot be guessed
          // into a ToolCall case. Every such terminal instead carries its
          // strict rejection fact; a known owner whose schema rejected input
          // carries the corresponding exact error ToolCall fact.
          const presentation = presentationInvocation
            ? args.host.buildToolCallStep({
                invocation: presentationInvocation,
                callId: toolCall.id,
                parsedInput,
                resultContent,
                outcome: { status: resultStatus },
              })
            : undefined
          if (presentation) {
            conversationSteps.push(presentation.conversationStep)
          }
          this.contextState.appendSubagentGraphMessage(
            args.conversationId,
            args.branch,
            "user",
            [
              {
                type: "tool_result",
                tool_use_id: toolCall.id,
                content: resultContent,
                is_error: resultStatus === "error",
              },
            ],
            presentation || rejectionMetadata
              ? {
                  toolResultMetadata: new Map([
                    [
                      toolCall.id,
                      presentation?.toolResultMetadata ?? rejectionMetadata!,
                    ],
                  ]),
                }
              : undefined
          )
          completedToolCalls += 1
        }

        this.transcriptStore.appendTranscript(args.run.agentId, {
          ts: Date.now(),
          kind: "turn_end",
          data: {
            turnIndex: persistedTurnCount + 1,
            toolCallCount: completedToolCalls,
          },
        })
        const durableMetrics = this.readDurableGraphMetrics(args)
        this.exportProgress(
          args.run.agentId,
          durableMetrics.turnCount,
          durableMetrics.toolCallCount,
          conversationSteps
        )
      }

      const finalText = findLastSubagentAssistantText(
        this.contextState.getSubagentGraphMessages(
          args.conversationId,
          args.branch
        )
      )
      if (!finalText?.trim()) {
        throw new Error(
          "Sub-agent exhausted its explicit turn limit without an assistant answer."
        )
      }
      return {
        status: "completed",
        finalText,
        ...this.readDurableGraphMetrics(args),
        conversationSteps,
      }
    } catch (error) {
      const aborted = args.signal.aborted
      const errorMessage = aborted
        ? args.signal.reason instanceof Error
          ? args.signal.reason.message
          : "Sub-agent execution was interrupted."
        : error instanceof Error
          ? error.message
          : String(error)
      this.logger[aborted ? "warn" : "error"](
        `[BackgroundSubAgent] ${args.run.agentId} ${aborted ? "interrupted" : "failed"}: ${errorMessage}`
      )
      return {
        status: aborted ? "aborted" : "failed",
        errorMessage,
        ...this.readDurableGraphMetrics(args),
        conversationSteps,
      }
    }
  }

  private exportAssistantText(
    args: RunBackgroundWorkerArgs,
    text: string,
    conversationSteps: unknown[]
  ): void {
    this.transcriptStore.appendTranscript(args.run.agentId, {
      ts: Date.now(),
      kind: "assistant_text",
      data: { text },
    })
    conversationSteps.push(args.host.buildAssistantStep(text))
  }

  private exportProgress(
    agentId: string,
    turnCount: number,
    toolCallCount: number,
    conversationSteps: unknown[]
  ): void {
    this.transcriptStore.updateMetadata(agentId, (current) => ({
      ...current,
      turnCount,
      toolCallCount,
      conversationSteps: [...conversationSteps],
    }))
  }

  /**
   * A handoff never carries counters from an ephemeral foreground context.
   * The immutable child graph is the complete execution history across
   * foreground and background leases, so it is the only source for budgets
   * and terminal counts.
   */
  private readDurableGraphMetrics(
    args: Pick<RunBackgroundWorkerArgs, "conversationId" | "branch">
  ): DurableBackgroundGraphMetrics {
    let turnCount = 0
    let toolCallCount = 0
    for (const message of this.contextState.getSubagentGraphMessages(
      args.conversationId,
      args.branch
    )) {
      if (message.type !== "assistant") continue
      turnCount += 1
      const content = message.message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "tool_use"
        ) {
          toolCallCount += 1
        }
      }
    }
    return { turnCount, toolCallCount }
  }
}

function formatFrozenCapabilityToolError(
  result: Exclude<
    ReturnType<FrozenCapabilityInvocationResolver["resolve"]>,
    ResolvedFrozenCapabilityInvocation
  >
): string {
  return `[tool error] ${result.code}: ${result.message}`
}
