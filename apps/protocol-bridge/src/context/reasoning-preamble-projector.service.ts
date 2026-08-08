import { Injectable } from "@nestjs/common"
import type { BackendType } from "../llm/shared/model-router.service"
import { getBackendCapability } from "../llm/shared/backend-capability"
import { requireExactDurableIdentifier } from "./durable-identifier"
import type { ContextTokenizer } from "./context-model-profile"
import { TokenCounterService } from "./token-counter.service"
import type { LooseMessageContent } from "./types"

/**
 * Required inputs for a text reasoning projection. The history is the exact
 * durable graph candidate selected for the outbound request, before the
 * backend-specific wire sanitizer removes thinking blocks.
 */
export interface ReasoningPreambleBudget {
  /** Remaining input-token headroom available to the preamble. */
  remainingTokens: number
  /** Optional caller-owned ceiling inside that headroom. */
  hardCeilingTokens?: number
  /** Tokenizer selected for the exact outbound candidate. */
  tokenizer: ContextTokenizer
}

/**
 * A thinking block selected from the candidate's durable graph history.
 * This is a projection value only: it is never cached or independently
 * persisted, so a cold mount derives the same result from the same graph.
 */
export interface ReasoningRecord {
  id: string
  sourceUuid: string
  text: string
  tokens: number
}

export interface ReasoningPreamble {
  /** XML-tagged text spliced into Kiro's next user-content payload. */
  text: string
  /** Durable reasoning fragments represented by the preamble. */
  recordsUsed: readonly ReasoningRecord[]
  /** Exact token cost of `text`, including framing. */
  tokens: number
}

/**
 * The minimal graph-backed shape needed to derive a reasoning preamble. A
 * candidate can contain other provider/context messages, but only entries
 * with a durable source UUID are admitted here.
 */
export interface GraphBackedReasoningCandidateMessage {
  role: "user" | "assistant"
  sourceUuid: string
  content: LooseMessageContent
}

export interface ReasoningPreambleBuildInput {
  targetBackend: BackendType
  /** Exact graph-backed history selected for this candidate. */
  history: readonly GraphBackedReasoningCandidateMessage[]
  budget: ReasoningPreambleBudget
}

/**
 * The text preamble is a bounded secondary claim on input headroom. It must
 * leave room for the current user input, tool definitions, and compaction
 * material owned by the request planner.
 */
const PREAMBLE_BUDGET_FRACTION = 0.15

/** Do not inject framing plus a token-sized fragment that cannot help. */
const PREAMBLE_MIN_USEFUL_TOKENS = 200

/**
 * Projects Kiro's text-only reasoning continuity from the durable candidate.
 *
 * The service intentionally owns no conversation state. The graph is the
 * sole authority for reasoning history, and the caller supplies the exact
 * candidate that will be sent. That makes a cold mount, retry measurement,
 * and accepted request equivalent whenever their graph candidate is equal.
 */
@Injectable()
export class ReasoningPreambleProjectorService {
  constructor(private readonly tokenCounter: TokenCounterService) {}

  buildPreamble(input: ReasoningPreambleBuildInput): ReasoningPreamble | null {
    const capability = getBackendCapability(input.targetBackend)
    switch (capability.continuityStrategy) {
      case "text_preamble":
        break
      case "native_signature":
      case "native_rollout":
      case "none":
        return null
      default: {
        const exhaustive: never = capability.continuityStrategy
        void exhaustive
        throw new Error("Unknown reasoning continuity strategy")
      }
    }

    const allowed = this.computeAllowedTokens(input.budget)
    if (allowed < PREAMBLE_MIN_USEFUL_TOKENS) return null

    const records = this.extractThinkingRecords(
      input.history,
      input.budget.tokenizer
    )
    if (records.length === 0) return null

    // A tool continuation only needs another text replay when the immediately
    // preceding assistant slice introduced new thinking. This fact is present
    // in the candidate graph itself; no process-local "already injected"
    // marker can change the answer across a restart.
    if (
      this.isToolContinuation(input.history) &&
      !this.latestAssistantSliceContainsThinking(input.history)
    ) {
      return null
    }

    return this.projectNewestRecordsWithinBudget(
      records,
      allowed,
      input.budget.tokenizer
    )
  }

  private extractThinkingRecords(
    history: readonly GraphBackedReasoningCandidateMessage[],
    tokenizer: ContextTokenizer
  ): ReasoningRecord[] {
    const records: ReasoningRecord[] = []
    const seen = new Set<string>()
    for (const message of history) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        continue
      }
      let sourceUuid: string
      try {
        sourceUuid = requireExactDurableIdentifier(
          message.sourceUuid,
          "Reasoning preamble durable source UUID"
        )
      } catch {
        throw new Error(
          "Reasoning preamble requires non-empty exact durable source identities for assistant history"
        )
      }
      for (
        let blockIndex = 0;
        blockIndex < message.content.length;
        blockIndex++
      ) {
        const text = this.readThinkingText(message.content[blockIndex])
        if (!text) continue
        const id = `${sourceUuid}:${blockIndex}`
        if (seen.has(id)) {
          throw new Error(
            `Reasoning preamble candidate contains duplicate durable thinking source ${id}`
          )
        }
        seen.add(id)
        records.push({
          id,
          sourceUuid,
          text,
          tokens: this.tokenCounter.countText(text, true, tokenizer),
        })
      }
    }
    return records
  }

  private isToolContinuation(
    history: readonly GraphBackedReasoningCandidateMessage[]
  ): boolean {
    return this.isToolResultUserMessage(history.at(-1))
  }

  private latestAssistantSliceContainsThinking(
    history: readonly GraphBackedReasoningCandidateMessage[]
  ): boolean {
    let index = history.length - 1
    while (index >= 0 && this.isToolResultUserMessage(history[index])) {
      index -= 1
    }
    while (index >= 0 && history[index]?.role === "assistant") {
      const content = history[index]!.content
      if (
        Array.isArray(content) &&
        content.some((block) => this.readThinkingText(block) !== undefined)
      ) {
        return true
      }
      index -= 1
    }
    return false
  }

  private projectNewestRecordsWithinBudget(
    records: readonly ReasoningRecord[],
    allowedTokens: number,
    tokenizer: ContextTokenizer
  ): ReasoningPreamble | null {
    const packedNewestFirst: ReasoningRecord[] = []
    let recordTokens = 0
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index]!
      if (recordTokens + record.tokens > allowedTokens) break
      packedNewestFirst.push(record)
      recordTokens += record.tokens
    }

    if (packedNewestFirst.length === 0) {
      return this.projectTruncatedNewestRecord(
        records[records.length - 1]!,
        allowedTokens,
        tokenizer
      )
    }

    // Restore chronological order for the model, then account for XML
    // framing exactly. If framing pushes a multi-record projection over the
    // cap, discard the oldest selected record before trimming the newest one.
    const packed = packedNewestFirst.reverse()
    while (packed.length > 1) {
      const text = this.formatPreamble(packed)
      const tokens = this.tokenCounter.countText(text, true, tokenizer)
      if (tokens <= allowedTokens) {
        return { text, recordsUsed: packed, tokens }
      }
      packed.shift()
    }
    return this.projectTruncatedNewestRecord(
      packed[0]!,
      allowedTokens,
      tokenizer
    )
  }

  private projectTruncatedNewestRecord(
    record: ReasoningRecord,
    allowedTokens: number,
    tokenizer: ContextTokenizer
  ): ReasoningPreamble | null {
    const codePoints = Array.from(record.text)
    let low = 0
    let high = codePoints.length
    let bestText = ""
    let bestTokens = 0
    while (low <= high) {
      const length = (low + high) >> 1
      const candidateText = codePoints
        .slice(codePoints.length - length)
        .join("")
      const text = this.formatPreamble([{ ...record, text: candidateText }])
      const tokens = this.tokenCounter.countText(text, true, tokenizer)
      if (tokens <= allowedTokens) {
        bestText = candidateText
        bestTokens = tokens
        low = length + 1
      } else {
        high = length - 1
      }
    }
    if (!bestText.trim()) return null
    const text = this.formatPreamble([{ ...record, text: bestText }])
    return {
      text,
      recordsUsed: [
        {
          ...record,
          text: bestText,
          tokens: this.tokenCounter.countText(bestText, true, tokenizer),
        },
      ],
      tokens: bestTokens || this.tokenCounter.countText(text, true, tokenizer),
    }
  }

  private computeAllowedTokens(budget: ReasoningPreambleBudget): number {
    const fraction = Math.floor(
      Math.max(0, budget.remainingTokens) * PREAMBLE_BUDGET_FRACTION
    )
    if (budget.hardCeilingTokens === undefined) return fraction
    return Math.min(fraction, Math.max(0, budget.hardCeilingTokens))
  }

  private readBlockType(block: unknown): string | undefined {
    if (!block || typeof block !== "object") return undefined
    const type = (block as { type?: unknown }).type
    return typeof type === "string" ? type : undefined
  }

  private isToolResultUserMessage(
    message: GraphBackedReasoningCandidateMessage | undefined
  ): boolean {
    return (
      message?.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some(
        (block) => this.readBlockType(block) === "tool_result"
      )
    )
  }

  private readThinkingText(block: unknown): string | undefined {
    if (this.readBlockType(block) !== "thinking") return undefined
    const thinking = (block as { thinking?: unknown }).thinking
    if (typeof thinking !== "string") return undefined
    const text = thinking.trim()
    return text || undefined
  }

  private formatPreamble(
    records: readonly Pick<ReasoningRecord, "text">[]
  ): string {
    const lines = [
      "<previous_thinking>",
      "NOTE: The text below is YOUR OWN earlier private reasoning from this " +
        "task, replayed only because this backend cannot carry it structurally. " +
        "Use it silently to keep continuity. Do NOT acknowledge, agree with, " +
        "quote, summarize, or restate it, and do not treat it as a new user " +
        "message — just continue the task from where it left off.",
      "",
    ]
    for (const record of records) {
      lines.push(record.text.trim(), "---")
    }
    if (lines.at(-1) === "---") lines.pop()
    lines.push("</previous_thinking>")
    return `${lines.join("\n")}\n\n`
  }
}
