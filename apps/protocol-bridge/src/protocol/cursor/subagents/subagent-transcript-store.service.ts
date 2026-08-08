/**
 * Append-only diagnostic export for sub-agents.
 *
 * Layout (mirrors what claude-code's SDK uses for `~/.claude/sub-agents/`):
 *
 *   ~/.cursor/subagents/<agentId>/
 *     metadata.json   — single-shot status snapshot
 *                       { agentId, agentType, parentToolCallId, status,
 *                         startedAt, completedAt, durationMs,
 *                         turnCount, toolCallCount, modifiedFiles, ... }
 *     transcript.jsonl — one JSONL record per LLM turn / tool call
 *                        for live progress reading
 *     result.txt       — the final assistant text (set on success)
 *
 * The store is purely a sink. Durable lifecycle and delivery state live in
 * `session_subagent_runs`; these files are never read to decide whether a run
 * exists, is running, or completed.
 * All writes are atomic at the record level (no locks required because the
 * bridge process is single-writer per subagentId).
 *
 * Files remain useful for operator inspection and Cursor's transcript link,
 * while `await_task` is the only supported programmatic result surface.
 */

import { Injectable, Logger } from "@nestjs/common"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs"
import { homedir } from "os"
import { join } from "path"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import type { ToolInterruptionReason } from "../session/tool-interruption"

export type SubagentTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "interrupted"

export interface SubagentTaskMetadata {
  agentId: string
  agentType: string
  parentToolCallId: string
  parentConversationId: string
  status: SubagentTaskStatus
  startedAt: number
  completedAt?: number
  durationMs?: number
  turnCount: number
  toolCallCount: number
  modifiedFiles: string[]
  /** Final assistant text (also written to result.txt). */
  finalText?: string
  /** Set when terminal status is not completed; kept parseable for automation. */
  errorMessage?: string
  errorReason?: ToolInterruptionReason
  /**
   * Serialised TaskSuccess.conversationSteps[] payload — assistant /
   * thinking / toolCall steps as the worker accumulates them. Stored as
   * a JSON-friendly opaque blob so external readers can serve the same
   * detail-panel contents the parent task bubble would render in the
   * foreground path. The bridge writes this incrementally per turn so
   * partial progress is visible mid-run.
   */
  conversationSteps?: unknown[]
}

export interface SubagentTranscriptRecord {
  ts: number
  /** Discriminator. Keeps the JSONL file readable by humans and easy to
   * grep with simple tools. */
  kind:
    | "turn_start"
    | "assistant_text"
    | "thinking"
    | "tool_call_start"
    | "tool_call_end"
    | "turn_end"
    | "completed"
    | "failed"
    | "killed"
    | "interrupted"
  data: Record<string, unknown>
}

@Injectable()
export class SubagentTranscriptStore {
  private readonly logger = new Logger(SubagentTranscriptStore.name)
  private static readonly AGENT_ID =
    /^subagent-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  private requireAgentId(agentId: string): string {
    const exactAgentId = requireExactDurableIdentifier(
      agentId,
      "sub-agent transcript agentId"
    )
    if (!SubagentTranscriptStore.AGENT_ID.test(exactAgentId)) {
      throw new Error(`Invalid sub-agent id: ${agentId}`)
    }
    return exactAgentId
  }

  /** Resolve a diagnostic path without mutating the filesystem. */
  getAgentDir(agentId: string): string {
    return join(homedir(), ".cursor", "subagents", this.requireAgentId(agentId))
  }

  private ensureAgentDir(agentId: string): string {
    const dir = this.getAgentDir(agentId)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  getTranscriptPath(agentId: string): string {
    return join(this.getAgentDir(agentId), "transcript.jsonl")
  }

  getMetadataPath(agentId: string): string {
    return join(this.getAgentDir(agentId), "metadata.json")
  }

  /**
   * JSON.stringify replacer that turns BigInt values into base-10
   * strings. Required because conversationSteps[] embeds proto
   * ToolCall envelopes whose generated TypeScript types use bigint for
   * 64-bit integer fields (exit codes / durations / etc.). Without
   * this replacer, every metadata write throws
   * `TypeError: Do not know how to serialize a BigInt` and the
   * mid-run progress sync silently fails — leaving turnCount /
   * toolCallCount frozen at spawn-time zeros.
   */
  private static stringifyMetadata(value: unknown): string {
    return JSON.stringify(
      value,
      (_key: string, raw: unknown): unknown =>
        typeof raw === "bigint" ? raw.toString() : raw,
      2
    )
  }

  /** Initial metadata write at spawn time. Overwrites any prior content
   * for this id (collisions shouldn't happen because agentId is
   * timestamp+random). */
  initMetadata(metadata: SubagentTaskMetadata): void {
    const agentId = this.requireAgentId(metadata.agentId)
    try {
      writeFileSync(
        join(this.ensureAgentDir(agentId), "metadata.json"),
        `${SubagentTranscriptStore.stringifyMetadata(metadata)}\n`,
        "utf8"
      )
    } catch (error) {
      this.logger.error(
        `Failed to write metadata for ${metadata.agentId}: ${String(error)}`
      )
    }
  }

  /** Read a diagnostic snapshot. Callers must not use it as lifecycle truth. */
  readMetadata(agentId: string): SubagentTaskMetadata | undefined {
    const exactAgentId = this.requireAgentId(agentId)
    const path = this.getMetadataPath(exactAgentId)
    if (!existsSync(path)) return undefined
    try {
      const raw = readFileSync(path, "utf8")
      const parsed = JSON.parse(raw) as SubagentTaskMetadata
      if (this.requireAgentId(parsed.agentId) !== exactAgentId) {
        throw new Error(
          `Sub-agent metadata identity mismatch: expected ${exactAgentId}, got ${parsed.agentId}`
        )
      }
      return parsed
    } catch (error) {
      this.logger.warn(
        `Failed to read metadata for ${agentId}: ${String(error)}`
      )
      return undefined
    }
  }

  /** Atomic-ish update — read, mutate, write. Single-writer per agentId
   * so race-free. */
  updateMetadata(
    agentId: string,
    mutator: (current: SubagentTaskMetadata) => SubagentTaskMetadata
  ): SubagentTaskMetadata | undefined {
    const exactAgentId = this.requireAgentId(agentId)
    const current = this.readMetadata(exactAgentId)
    if (!current) return undefined
    const next = mutator(current)
    try {
      if (this.requireAgentId(next.agentId) !== exactAgentId) {
        throw new Error(
          `Sub-agent metadata identity mismatch: expected ${exactAgentId}, got ${next.agentId}`
        )
      }
      writeFileSync(
        join(this.ensureAgentDir(exactAgentId), "metadata.json"),
        `${SubagentTranscriptStore.stringifyMetadata(next)}\n`,
        "utf8"
      )
      return next
    } catch (error) {
      this.logger.error(
        `Failed to update metadata for ${agentId}: ${String(error)}`
      )
      return undefined
    }
  }

  /** Append a record to the transcript JSONL. */
  appendTranscript(agentId: string, record: SubagentTranscriptRecord): void {
    const exactAgentId = this.requireAgentId(agentId)
    try {
      appendFileSync(
        join(this.ensureAgentDir(exactAgentId), "transcript.jsonl"),
        `${JSON.stringify(record)}\n`,
        "utf8"
      )
    } catch (error) {
      this.logger.warn(
        `Failed to append transcript for ${agentId}: ${String(error)}`
      )
    }
  }

  /** Write the final assistant text to result.txt. Truncates anything
   * previously there (background sub-agent has exactly one final
   * answer). */
  writeResult(agentId: string, text: string): void {
    const exactAgentId = this.requireAgentId(agentId)
    try {
      writeFileSync(
        join(this.ensureAgentDir(exactAgentId), "result.txt"),
        text,
        "utf8"
      )
    } catch (error) {
      this.logger.error(
        `Failed to write result for ${agentId}: ${String(error)}`
      )
    }
  }
}
