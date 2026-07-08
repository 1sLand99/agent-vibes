import { Injectable, Logger } from "@nestjs/common"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import {
  ContextCompactionCandidate,
  ContextCompactionPlan,
  ContextCompactionService,
} from "./context-compaction.service"
import {
  ContextConversationState,
  ContextTranscriptRecord,
  extractText,
} from "./types"
import {
  buildTopicContinuityGuard,
  composeCompactHookMessage,
  extractLatestUserUtterance,
} from "./context-continuity-guard"

export interface ContextCompactRunnerSummaryRequest {
  prompt: string
  maxTokens: number
  candidate: ContextCompactionCandidate
  /**
   * Signal that gets aborted when the surrounding turn is superseded,
   * cancelled, or otherwise terminated. Required so the provider can pass
   * it through to the underlying LLM HTTP call. The provider is responsible
   * for honouring `signal.aborted` and for surfacing AbortError on
   * cancellation; the runner uses the rejection to short-circuit the
   * pipeline before any post-summary state mutations land.
   */
  signal: AbortSignal
}

export interface ContextCompactRunnerSummaryResult {
  summary: string
  hookUserMessage?: string
}

export type ContextCompactRunnerSummaryProvider = (
  request: ContextCompactRunnerSummaryRequest
) => Promise<ContextCompactRunnerSummaryResult>

export type ContextCompactRunnerHookProvider = (
  candidate: ContextCompactionCandidate
) => Promise<string | undefined>

@Injectable()
export class ContextCompactRunnerService {
  private readonly logger = new Logger(ContextCompactRunnerService.name)

  constructor(private readonly compaction: ContextCompactionService) {}

  /**
   * Run a directional ("partial") compaction anchored on a specific record.
   *
   * Mirrors Claude Code's `partialCompactConversation`
   * (services/compact/compact.ts:801) which exposes two modes:
   *   - `up_to`: keep `pivotRecordId` and everything after it; summarize
   *     everything before. Used for the "topic switch" pivot — the user's
   *     most recent message becomes the kept anchor and earlier exploration
   *     collapses into a summary.
   *   - `from`: keep everything before `pivotRecordId`; summarize the pivot
   *     and beyond. Useful when the user wants to roll a long tangent into
   *     a summary while preserving the original mainline.
   *
   * Returns undefined when the compaction service rejects the candidate
   * (pivot missing, integrity violation, empty side, etc.).
   */
  async compactAroundPivot(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    pivotRecordId: string,
    direction: "up_to" | "from",
    options: {
      maxTokens: number
      systemPromptTokens: number
      strategy?: "auto" | "manual" | "reactive"
      integrityMode?: "strict-adjacent" | "global"
      summaryProvider: ContextCompactRunnerSummaryProvider
      hookUserMessage?: string
      hookProvider?: ContextCompactRunnerHookProvider
      signal: AbortSignal
      meta?: {
        sessionId?: string
        conversationId?: string
        agentId?: string
        querySource?: string
        notifyPromptCacheCompaction?: () => void
      }
    }
  ): Promise<ContextCompactionPlan | undefined> {
    options.signal.throwIfAborted()
    const candidate =
      direction === "up_to"
        ? this.compaction.prepareUpToCompactionCandidate(
            state,
            snapshot,
            pivotRecordId,
            {
              maxTokens: options.maxTokens,
              systemPromptTokens: options.systemPromptTokens,
              strategy: options.strategy,
              integrityMode: options.integrityMode,
            }
          )
        : this.compaction.prepareFromCompactionCandidate(
            state,
            snapshot,
            pivotRecordId,
            {
              maxTokens: options.maxTokens,
              systemPromptTokens: options.systemPromptTokens,
              strategy: options.strategy,
              integrityMode: options.integrityMode,
            }
          )
    if (!candidate) return undefined

    const explicitHookUserMessage =
      options.hookUserMessage || (await options.hookProvider?.(candidate))
    options.signal.throwIfAborted()
    const summaryPrompt = this.buildSummaryPrompt(candidate.archivedRecords)
    const summaryResult = await options.summaryProvider({
      prompt: summaryPrompt,
      maxTokens: candidate.summaryBudget,
      candidate,
      signal: options.signal,
    })
    options.signal.throwIfAborted()
    const summary = this.stripAnalysisScaffold(summaryResult.summary).trim()
    if (!summary) {
      throw new Error(
        "LLM compact runner returned an empty summary (partial compaction)"
      )
    }

    const latestUserUtterance = extractLatestUserUtterance(state)
    const continuityGuard = buildTopicContinuityGuard(latestUserUtterance)
    const composedHookUserMessage = composeCompactHookMessage(
      summaryResult.hookUserMessage || explicitHookUserMessage,
      continuityGuard
    )

    const plan = this.compaction.applyGeneratedSummaryCompaction(
      state,
      snapshot,
      candidate,
      {
        summary,
        hookUserMessage: composedHookUserMessage,
        meta: options.meta,
      }
    )
    this.logger.log(
      `LLM compact runner partial(${direction}) applied commit=${plan.commit.id} pivot=${pivotRecordId} archived=${plan.commit.archivedMessageCount} summaryTokens=${plan.commit.summaryTokenCount}`
    )
    return plan
  }

  async compactIfNeeded(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      strategy?: "auto" | "manual" | "reactive"
      integrityMode?: "strict-adjacent" | "global"
      summaryProvider: ContextCompactRunnerSummaryProvider
      hookUserMessage?: string
      hookProvider?: ContextCompactRunnerHookProvider
      signal: AbortSignal
      meta?: {
        sessionId?: string
        conversationId?: string
        agentId?: string
        querySource?: string
        notifyPromptCacheCompaction?: () => void
      }
    }
  ): Promise<ContextCompactionPlan | undefined> {
    options.signal.throwIfAborted()
    const candidate = this.compaction.prepareCompactionCandidate(
      state,
      snapshot,
      options
    )
    if (!candidate) return undefined

    const explicitHookUserMessage =
      options.hookUserMessage || (await options.hookProvider?.(candidate))
    options.signal.throwIfAborted()
    const summaryPrompt = this.buildSummaryPrompt(candidate.archivedRecords)
    const summaryResult = await options.summaryProvider({
      prompt: summaryPrompt,
      maxTokens: candidate.summaryBudget,
      candidate,
      signal: options.signal,
    })
    options.signal.throwIfAborted()
    const summary = this.stripAnalysisScaffold(summaryResult.summary).trim()
    if (!summary) {
      throw new Error("LLM compact runner returned an empty summary")
    }

    const latestUserUtterance = extractLatestUserUtterance(state)
    const continuityGuard = buildTopicContinuityGuard(latestUserUtterance)
    const composedHookUserMessage = composeCompactHookMessage(
      summaryResult.hookUserMessage || explicitHookUserMessage,
      continuityGuard
    )

    const plan = this.compaction.applyGeneratedSummaryCompaction(
      state,
      snapshot,
      candidate,
      {
        summary,
        hookUserMessage: composedHookUserMessage,
        meta: options.meta,
      }
    )
    this.logger.log(
      `LLM compact runner applied commit=${plan.commit.id} archived=${plan.commit.archivedMessageCount} summaryTokens=${plan.commit.summaryTokenCount} guard=${continuityGuard ? "on" : "off"}`
    )
    return plan
  }

  /**
   * Structured summary prompt modeled on Claude Code's compact prompt.
   * The nine sections force the summarizer to surface the user's most recent
   * intent and the work in progress at the boundary, with an explicit guard
   * against re-entering tangential or already-completed older tasks. Without
   * this structure, summaries collapse into prose that loses the "where we
   * are right now" anchor and the post-compact model wanders back into
   * earlier topics that share vocabulary with the current request.
   */
  private buildSummaryPrompt(
    records: readonly ContextTranscriptRecord[]
  ): string {
    const transcript = records
      // Topic-continuity guards (hook_result) are transient post-compaction
      // instructions, not conversation content. If one falls inside a later
      // compaction's archived window it must NOT be fed to the summarizer:
      // folding "Most recent user request: <X>" into the summary would make
      // that stale claim permanent and re-shown every turn, resurrecting the
      // exact old-topic drift the guard was meant to prevent.
      .filter((record) => record.kind !== "hook_result")
      .map((record, index) => {
        const text = this.renderRecord(record)
        return `<message index="${index + 1}" role="${record.role}">\n${text}\n</message>`
      })
      .join("\n\n")

    return [
      "You are summarizing the EARLIER portion of an ongoing conversation. Any preserved messages after this summary remain the authoritative record of the current task; when no recent messages are preserved, the summary plus the latest user request defines the continuation.",
      "Capture the earlier technical details, code patterns, and architectural decisions thoroughly. Do NOT treat stale earlier tasks as current work: preserved recent messages, or the latest user request when no recent messages are preserved, define what is happening now and what comes next.",
      "",
      "Before writing the summary, wrap your reasoning in <analysis> tags. In your analysis:",
      "1. Walk every message chronologically. For each section identify the user's explicit requests, the assistant's approach, key decisions, technical concepts and code patterns, file names, full code snippets, function signatures, file edits, errors and how they were fixed, and any user feedback that redirected the work.",
      "2. Double-check completeness and technical accuracy.",
      "",
      "Then produce the summary in <summary> tags using exactly these nine sections:",
      "1. Primary Request and Intent: The user's explicit requests and intents in detail.",
      "2. Key Technical Concepts: Technologies, frameworks, libraries, files, and patterns discussed.",
      "3. Files and Code Sections: Specific files and code regions examined, modified, or created. Include important code snippets and explain why each file matters.",
      "4. Errors and Fixes: All errors encountered, how they were resolved, and any user feedback on each.",
      "5. Problem Solving: Problems solved and ongoing troubleshooting threads.",
      "6. All User Messages: List every user message that is not a tool result, in order. These anchor the user's evolving intent and must not be summarized away.",
      "7. Pending Tasks (historical): Tasks the user asked for during THIS EARLIER segment that were not yet complete at the cut-off, listed in the order they were raised. Mark them as historical — by now they may be done, abandoned, or superseded by a later topic. Do NOT present this as the current to-do list and do NOT pick the current task from here; the current task is defined only by the preserved recent messages and the continuity guard that follow.",
      "8. Current Work (historical): What was being worked on at the END of THIS EARLIER segment, with file names and code snippets. Treat this as historical context — it may already be completed or superseded by the preserved recent messages that follow. Do NOT present it as the current task.",
      '9. Next Step: Do NOT infer or propose a next step from this earlier segment. The preserved recent messages that follow this summary are authoritative for the current task and the next step. Write exactly: "Current task and next step: defer to the preserved recent messages below — do not resume a task from this earlier summary unless the recent messages explicitly continue it."',
      "",
      "Output format:",
      "<analysis>",
      "[Your chronological analysis]",
      "</analysis>",
      "",
      "<summary>",
      "1. Primary Request and Intent:",
      "...",
      "9. Next Step:",
      "...",
      "</summary>",
      "",
      "Do not answer the user. Do not call any tools. Return only the analysis and summary blocks.",
      "",
      "<conversation_segment>",
      transcript,
      "</conversation_segment>",
    ].join("\n")
  }

  /**
   * Drop the <analysis>…</analysis> scratchpad before persisting the
   * summary. Mirrors Claude Code's formatCompactSummary which strips the
   * analysis block so it never re-enters the post-compact context.
   */
  private stripAnalysisScaffold(raw: string): string {
    if (!raw) return ""
    const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/i)
    if (summaryMatch && summaryMatch[1]) {
      return summaryMatch[1].trim()
    }
    return raw.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim()
  }

  private renderRecord(record: ContextTranscriptRecord): string {
    if (typeof record.content === "string") {
      return record.content
    }
    const text = extractText(record.content)
    if (text.trim()) return text
    try {
      return JSON.stringify(record.content)
    } catch {
      return ""
    }
  }
}
