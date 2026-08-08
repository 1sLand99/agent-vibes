import { Injectable } from "@nestjs/common"
import { assertTerminalSessionMemoryProvenance } from "./session-memory.service"
import { TokenCounterService } from "./token-counter.service"
import type {
  ContextProjectionAttachment,
  SessionMemorySummaryLike,
} from "./types"
import type { SessionTodoStatus } from "../protocol/cursor/session/session-persistence.service"

export interface SessionTodoAttachmentLike {
  id: string
  content: string
  status: SessionTodoStatus
  dependencies: string[]
}

// Re-export for convenient import by downstream consumers.
export type { SessionMemorySummaryLike } from "./types"

export interface ContextAttachmentSnapshot {
  readPaths: string[]
  fileStates: Array<{
    path: string
    beforeContent: string
    afterContent: string
  }>
  todos: SessionTodoAttachmentLike[]
  sessionMemory?: SessionMemorySummaryLike[]
  /**
   * Snapshots of every foreground sub-agent currently running on the
   * conversation. Multiple entries appear when the parent dispatched
   * several `task` tool calls in the same batch (cf.
   * `dispatchPreparedToolBatch`). Empty array when no sub-agent is
   * active.
   */
  activeSubAgents?: Array<{
    subagentId: string
    model: string
    turnCount: number
    toolCallCount: number
    modifiedFiles: string[]
    pendingToolCallIds: string[]
  }>
}

@Injectable()
export class ContextAttachmentBuilderService {
  private readonly TOTAL_ATTACHMENT_BUDGET = 2200
  private readonly MAX_ATTACHMENT_TOKENS = 700
  /** Per-snapshot caps for the file-content attachment. */
  private readonly FILE_SNAPSHOT_MAX_ATTACHMENT_TOKENS = 1600
  private readonly FILE_SNAPSHOT_MAX_FILES = 5
  private readonly FILE_SNAPSHOT_MAX_TOKENS_PER_FILE = 320
  private readonly FILE_SNAPSHOT_MAX_LINES_PER_FILE = 80

  constructor(private readonly tokenCounter: TokenCounterService) {}

  buildAttachments(
    snapshot: ContextAttachmentSnapshot,
    options?: { maxTokens?: number }
  ): ContextProjectionAttachment[] {
    const budget = Math.max(
      options?.maxTokens || this.TOTAL_ATTACHMENT_BUDGET,
      0
    )
    if (budget <= 0) return []

    const candidates: Array<ContextProjectionAttachment | null> = [
      this.buildSessionMemoryAttachment(snapshot),
      this.buildSubAgentAttachment(snapshot),
      this.buildTodosAttachment(snapshot),
      this.buildFileSnapshotsAttachment(snapshot),
      this.buildFileStatesAttachment(snapshot),
      this.buildReadPathsAttachment(snapshot),
    ]

    const attachments: ContextProjectionAttachment[] = []
    let consumed = 0

    for (const candidate of candidates) {
      if (!candidate) continue
      if (candidate.tokenCount <= 0) continue
      const fitted = this.fitAttachmentToBudget(candidate, budget - consumed)
      if (!fitted) continue
      attachments.push(fitted)
      consumed += fitted.tokenCount
    }

    return attachments
  }

  private buildSessionMemoryAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    const memories = snapshot.sessionMemory || []
    if (memories.length === 0) return null
    for (const [index, memory] of memories.entries()) {
      assertTerminalSessionMemoryProvenance(
        memory,
        `ContextAttachmentBuilderService: sessionMemory[${index}]`
      )
    }

    const selected = memories
      .slice()
      .sort((a, b) => {
        const weightDelta = (b.weight || 0) - (a.weight || 0)
        if (weightDelta !== 0) return weightDelta
        return (b.createdAt || 0) - (a.createdAt || 0)
      })
      .slice(0, 16)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))

    const groupLabels: Record<string, string> = {
      objective: "Objectives",
      decision: "Decisions",
      constraint: "Constraints",
      verification: "Verification",
      risk: "Risks",
      command: "Commands",
      sub_agent: "Sub-agent results",
      progress: "Progress",
      file: "Files",
      open_item: "Open items",
    }
    const groupOrder = [
      "objective",
      "decision",
      "constraint",
      "verification",
      "risk",
      "command",
      "sub_agent",
      "progress",
      "file",
      "open_item",
    ]
    const lines: string[] = []
    for (const kind of groupOrder) {
      const group = selected.filter((memory) => memory.kind === kind)
      if (group.length === 0) continue
      lines.push(`${groupLabels[kind] || kind}:`)
      for (const memory of group) {
        lines.push(`- ${this.trimToBudget(memory.text, 120)}`)
      }
    }
    const footer =
      "Use this as durable session memory. Do not repeat old investigation unless a retained message contradicts it."

    return this.buildAttachment(
      "session_memory",
      "Session Memory",
      [...lines, "", footer].join("\n"),
      1400
    )
  }

  private buildReadPathsAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.readPaths.length === 0) return null

    const lines = snapshot.readPaths
      .slice(-20)
      .map((path) => `- ${path}`)
      .join("\n")

    return this.buildAttachment("read_paths", "Recently Read Files", lines)
  }

  private buildSubAgentAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    const subAgents = snapshot.activeSubAgents
    if (!subAgents || subAgents.length === 0) return null

    const sections: string[] = []
    for (const subAgent of subAgents) {
      const lines = [
        `- Sub-agent: ${subAgent.subagentId}`,
        `- Model: ${subAgent.model}`,
        `- Completed turns: ${subAgent.turnCount}`,
        `- Tool calls: ${subAgent.toolCallCount}`,
      ]
      if (subAgent.pendingToolCallIds.length > 0) {
        lines.push(
          `- Waiting on tools: ${subAgent.pendingToolCallIds.join(", ")}`
        )
      }
      if (subAgent.modifiedFiles.length > 0) {
        lines.push(
          ...subAgent.modifiedFiles
            .slice(-10)
            .map((filePath) => `- Modified file: ${filePath}`)
        )
      }
      sections.push(lines.join("\n"))
    }

    const heading =
      subAgents.length === 1
        ? "Active Sub-Agent"
        : `Active Sub-Agents (${subAgents.length})`
    return this.buildAttachment("sub_agent", heading, sections.join("\n\n"))
  }

  private buildFileStatesAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.fileStates.length === 0) return null

    const lines = snapshot.fileStates
      .slice(-10)
      .map((state) => {
        const beforeLines = state.beforeContent.split("\n").length
        const afterLines = state.afterContent.split("\n").length
        const delta = afterLines - beforeLines
        const changeLabel =
          delta === 0 ? "0 lines" : `${delta > 0 ? "+" : ""}${delta} lines`
        return `- ${state.path} (${changeLabel})`
      })
      .join("\n")

    return this.buildAttachment("file_states", "Tracked File Changes", lines)
  }

  /**
   * Render the most-recent file edits as an inline content snapshot so that
   * after a compaction the model still has direct visibility into the files
   * it was actively changing.  Without this attachment the post-compact turn
   * has to issue redundant read_file calls just to recover the same context.
   *
   * Each file is bounded both in lines and tokens so a single huge file
   * cannot starve the rest of the snapshot.  We always render the
   * post-edit (`afterContent`) view because that is what a follow-up
   * tool call would observe on disk.
   */
  private buildFileSnapshotsAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.fileStates.length === 0) return null

    const recentFiles = snapshot.fileStates.slice(-this.FILE_SNAPSHOT_MAX_FILES)
    const sections: string[] = []
    let consumedTokens = 0

    // Newest-first selection so the most recently touched file is least
    // likely to be dropped under tight budgets.  Re-render in chronological
    // order at the end for stable output.
    const reversed = [...recentFiles].reverse()
    for (const state of reversed) {
      if (consumedTokens >= this.FILE_SNAPSHOT_MAX_ATTACHMENT_TOKENS) break
      const remainingBudget =
        this.FILE_SNAPSHOT_MAX_ATTACHMENT_TOKENS - consumedTokens
      const perFileBudget = Math.min(
        this.FILE_SNAPSHOT_MAX_TOKENS_PER_FILE,
        remainingBudget
      )
      const section = this.renderFileSnapshotSection(
        state.path,
        state.afterContent,
        perFileBudget
      )
      if (!section) continue
      const sectionTokens = this.tokenCounter.countText(section)
      if (sectionTokens <= 0) continue
      if (consumedTokens + sectionTokens > remainingBudget) continue
      sections.push(section)
      consumedTokens += sectionTokens
    }

    if (sections.length === 0) return null
    sections.reverse()

    return this.buildAttachment(
      "file_snapshots",
      "Recent File Snapshots",
      sections.join("\n\n"),
      this.FILE_SNAPSHOT_MAX_ATTACHMENT_TOKENS
    )
  }

  private renderFileSnapshotSection(
    path: string,
    content: string,
    maxTokens: number
  ): string {
    const trimmedContent = content.replace(/\s+$/u, "")
    if (!trimmedContent) {
      return `- ${path}\n  (empty)`
    }

    const allLines = trimmedContent.split("\n")
    const totalLines = allLines.length
    const keptLines = allLines.slice(0, this.FILE_SNAPSHOT_MAX_LINES_PER_FILE)
    const truncatedByLines = keptLines.length < totalLines
    const body = keptLines.join("\n")
    const headerLines: string[] = [`- ${path} (${totalLines} lines total)`]

    let snippet = `${headerLines.join("\n")}\n\u0060\u0060\u0060\n${body}\n\u0060\u0060\u0060`
    if (truncatedByLines) {
      snippet += `\n  ... [truncated to first ${keptLines.length} of ${totalLines} lines]`
    }

    if (this.tokenCounter.countText(snippet) <= maxTokens) {
      return snippet
    }

    // Token-aware fallback: shrink line count exponentially until it fits.
    let candidateLineCount = keptLines.length
    while (candidateLineCount > 4) {
      candidateLineCount = Math.max(4, Math.floor(candidateLineCount * 0.7))
      const candidateLines = allLines.slice(0, candidateLineCount)
      const candidate =
        `- ${path} (${totalLines} lines total)\n` +
        `\u0060\u0060\u0060\n${candidateLines.join("\n")}\n\u0060\u0060\u0060\n` +
        `  ... [truncated to first ${candidateLineCount} of ${totalLines} lines]`
      if (this.tokenCounter.countText(candidate) <= maxTokens) {
        return candidate
      }
    }
    return ""
  }

  private buildTodosAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.todos.length === 0) return null

    const lines = snapshot.todos
      .slice(-20)
      .map((todo) => {
        const deps =
          todo.dependencies.length > 0
            ? ` deps=${todo.dependencies.join(",")}`
            : ""
        return `- [${todo.status}] ${todo.id}${deps}: ${todo.content}`
      })
      .join("\n")

    return this.buildAttachment("todos", "Todo State", lines)
  }

  private buildAttachment(
    kind: ContextProjectionAttachment["kind"],
    label: string,
    body: string,
    maxTokens?: number
  ): ContextProjectionAttachment {
    const budget = maxTokens ?? this.MAX_ATTACHMENT_TOKENS
    const header = `[Context attachment: ${label}]`
    const headerTokens = this.tokenCounter.countText(header)
    const bodyBudget = Math.max(0, budget - headerTokens)
    const trimmedBody = this.trimToBudget(body, bodyBudget)
    const content = trimmedBody ? `${header}\n${trimmedBody}` : header
    return {
      kind,
      label,
      content,
      tokenCount: this.tokenCounter.countText(content),
    }
  }

  /**
   * Never discard an entire lower-priority attachment merely because the
   * candidate was built for the nominal total budget.  Preserve its semantic
   * header and fit its body into the actual remaining space instead.
   */
  private fitAttachmentToBudget(
    attachment: ContextProjectionAttachment,
    maxTokens: number
  ): ContextProjectionAttachment | null {
    if (maxTokens <= 0) return null
    if (attachment.tokenCount <= maxTokens) return attachment

    const header = `[Context attachment: ${attachment.label}]`
    const headerTokens = this.tokenCounter.countText(header)
    if (headerTokens > maxTokens) return null

    const body = attachment.content.startsWith(`${header}\n`)
      ? attachment.content.slice(header.length + 1)
      : attachment.content
    const trimmedBody = this.trimToBudget(body, maxTokens - headerTokens)
    // A label without any retained fact is not context. Do not spend scarce
    // prompt budget on a header-only fragment.
    if (!trimmedBody) return null
    const content = `${header}\n${trimmedBody}`
    const tokenCount = this.tokenCounter.countText(content)
    if (tokenCount > maxTokens) {
      // `trimToBudget` is token-aware; reaching this guard means a provider
      // tokenizer cannot represent even the fixed header within the remaining
      // budget, so omitting is more honest than violating the budget.
      return null
    }
    return { ...attachment, content, tokenCount }
  }

  private trimToBudget(text: string, maxTokens: number): string {
    const value = text.trim()
    if (!value) return value
    if (maxTokens <= 0) return ""

    if (this.tokenCounter.countText(value) <= maxTokens) {
      return value
    }

    let end = value.length
    while (end > 64) {
      end = Math.floor(end * 0.8)
      const candidate = `${value.slice(0, end).trim()}\n...[truncated]`
      if (this.tokenCounter.countText(candidate) <= maxTokens) {
        return candidate
      }
    }

    return "...[truncated]"
  }
}
