import { Injectable, Logger } from "@nestjs/common"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import {
  buildContextCompactPrompt,
  formatContextCompactSummary,
  type ContextCompactionMode,
} from "./context-compact-prompt"
import type { ContextModelProfile } from "./context-model-profile"
import {
  ContextCompactionCandidate,
  ContextCompactionInstallInput,
  ContextCompactionPlan,
  ContextCompactionService,
} from "./context-compaction.service"
import {
  ClaudeProjectionCapabilitySnapshot,
  ClaudeProjectionRecipe,
  ContextConversationState,
  ContextTranscriptRecord,
  UnifiedMessage,
} from "./types"

type LooseContentBlock = { type?: string; [key: string]: unknown }

function stripUserMediaBlock(block: LooseContentBlock): LooseContentBlock {
  if (block.type === "image" || block.type === "document") {
    return { type: "text", text: `[${block.type}]` }
  }
  if (block.type !== "tool_result" || !Array.isArray(block.content)) {
    return structuredClone(block)
  }
  const nestedContent: unknown[] = block.content
  return {
    ...structuredClone(block),
    content: nestedContent.map((part): unknown =>
      part && typeof part === "object"
        ? stripUserMediaBlock(part as LooseContentBlock)
        : part
    ),
  }
}

export function buildContextCompactSummaryMessages(
  records: readonly ContextTranscriptRecord[]
): UnifiedMessage[] {
  return records.map((record) => {
    const content =
      record.role === "user" && Array.isArray(record.content)
        ? record.content.map((block) =>
            stripUserMediaBlock(block as LooseContentBlock)
          )
        : structuredClone(record.content)
    const messageId = record.messageId || record.providerMessageId
    return {
      role: record.role,
      content: content as UnifiedMessage["content"],
      ...(messageId ? { messageId } : {}),
      ...(record.isMeta ? { isMeta: true } : {}),
      sourceUuid: record.id,
    }
  })
}

export interface ContextCompactRunnerSummaryRequest {
  mode: ContextCompactionMode
  prompt: string
  /** Native structured messages covered by this exact compact candidate. */
  messages: readonly UnifiedMessage[]
  /** Independent compact-summary output limit, never a context-window target. */
  maxTokens: number
  candidate: ContextCompactionCandidate
  signal: AbortSignal
}

export interface ContextCompactRunnerSummaryResult {
  summary: string
}

export type ContextCompactRunnerSummaryProvider = (
  request: ContextCompactRunnerSummaryRequest
) => Promise<ContextCompactRunnerSummaryResult>

export type ContextCompactRunnerHookProvider = (
  candidate: ContextCompactionCandidate
) => Promise<string | undefined>

interface CompactExecutionOptions {
  summaryProvider: ContextCompactRunnerSummaryProvider
  /**
   * Lifecycle boundary for a real compaction attempt. The runner invokes it
   * only after pressure/pivot selection produced an exact candidate and
   * immediately before hooks or provider work begin.
   */
  onAttemptStarted?: (
    candidate: ContextCompactionCandidate
  ) => void | Promise<void>
  /** Explicit compact prompt guidance; separate from post-compact hooks. */
  customInstructions?: string
  hookUserMessage?: string
  hookProvider?: ContextCompactRunnerHookProvider
  signal: AbortSignal
  /**
   * Required durable commit owner. It receives one fully planned compact
   * layout and must synchronously persist it before invoking `install`.
   *
   * The runner intentionally has no direct hot-state fallback: every caller
   * must make the durable projection transaction and its ContextPipeline
   * mutation authority explicit. This prevents a future caller from applying
   * an otherwise valid summary without installing the recovery layout that
   * selects it.
   */
  installPlan: (input: {
    candidate: ContextCompactionCandidate
    plan: ContextCompactionPlan
    install: () => void
  }) => void
}

@Injectable()
export class ContextCompactRunnerService {
  private readonly logger = new Logger(ContextCompactRunnerService.name)

  constructor(private readonly compaction: ContextCompactionService) {}

  async compactAroundPivot(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    pivotRecordId: string,
    direction: "up_to" | "from",
    options: {
      maxTokens: number
      systemPromptTokens: number
      contextProfile?: ContextModelProfile
      claudeCapability?: ClaudeProjectionCapabilitySnapshot
      /** Provider-owned checkpoint selected by the explicit Claude head. */
      claudeRecipe?: ClaudeProjectionRecipe
      strategy?: "auto" | "manual" | "reactive"
      integrityMode?: "strict-adjacent" | "global"
    } & CompactExecutionOptions
  ): Promise<ContextCompactionPlan | undefined> {
    options.signal.throwIfAborted()
    const candidate =
      direction === "up_to"
        ? this.compaction.prepareUpToCompactionCandidate(
            state,
            snapshot,
            pivotRecordId,
            options
          )
        : this.compaction.prepareFromCompactionCandidate(
            state,
            snapshot,
            pivotRecordId,
            options
          )
    if (!candidate) return undefined

    return this.summarizeAndApply(state, snapshot, candidate, options)
  }

  async compactIfNeeded(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      contextProfile?: ContextModelProfile
      claudeCapability?: ClaudeProjectionCapabilitySnapshot
      /** Provider-owned checkpoint selected by the explicit Claude head. */
      claudeRecipe?: ClaudeProjectionRecipe
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      /**
       * Exact token count from the already-built provider request candidate.
       * This count excludes `systemPromptTokens`, is allowed to be zero, and
       * must be finite and non-negative. When present, the compaction gate
       * reuses that exact provider measurement instead of projecting the same
       * graph a second time just to decide whether to compact.
       */
      projectedTokenCount?: number
      strategy?: "auto" | "manual" | "reactive"
      integrityMode?: "strict-adjacent" | "global"
      /** Explicit user action; does not alter the real request budget. */
      force?: boolean
    } & CompactExecutionOptions
  ): Promise<ContextCompactionPlan | undefined> {
    options.signal.throwIfAborted()
    const candidate = this.compaction.prepareCompactionCandidate(
      state,
      snapshot,
      options
    )
    if (!candidate) return undefined

    return this.summarizeAndApply(state, snapshot, candidate, options)
  }

  private async summarizeAndApply(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    candidate: ContextCompactionCandidate,
    options: CompactExecutionOptions
  ): Promise<ContextCompactionPlan> {
    const installPlan = options.installPlan
    if (typeof installPlan !== "function") {
      throw new Error(
        "Context compaction requires a durable installPlan authority"
      )
    }
    await options.onAttemptStarted?.(candidate)
    options.signal.throwIfAborted()
    const hookUserMessage =
      options.hookUserMessage || (await options.hookProvider?.(candidate))
    options.signal.throwIfAborted()

    const summaryResult = await options.summaryProvider({
      mode: candidate.mode,
      prompt: buildContextCompactPrompt(
        candidate.mode,
        options.customInstructions
      ),
      messages: buildContextCompactSummaryMessages(
        candidate.summaryInputRecords
      ),
      maxTokens: candidate.summaryOutputTokenLimit,
      candidate,
      signal: options.signal,
    })
    options.signal.throwIfAborted()

    const summary = formatContextCompactSummary(summaryResult.summary)
    if (!summary) {
      throw new Error(
        `LLM compact runner returned an empty ${candidate.mode} summary`
      )
    }

    const installInput: ContextCompactionInstallInput = {
      summary,
      hookUserMessage,
    }
    const plan = this.compaction.buildGeneratedSummaryCompactionPlan(
      state,
      snapshot,
      candidate,
      installInput
    )
    const preparedInstall =
      this.compaction.prepareGeneratedSummaryCompactionInstall(
        state,
        candidate,
        plan,
        installInput
      )
    let installCount = 0
    const install = (): void => {
      if (installCount !== 0) {
        throw new Error(
          `Context compaction durable authority invoked install more than once for ${plan.commit.id}`
        )
      }
      installCount += 1
      this.compaction.applyPreparedGeneratedSummaryCompaction(preparedInstall)
    }
    installPlan({ candidate, plan, install })
    if (installCount !== 1) {
      throw new Error(
        `Context compaction durable authority did not install ${plan.commit.id}`
      )
    }
    this.logger.log(
      `LLM compact runner ${candidate.mode} applied commit=${plan.commit.id} ` +
        `archived=${plan.commit.archivedMessageCount} summaryTokens=${plan.commit.summaryTokenCount}`
    )
    return plan
  }
}
