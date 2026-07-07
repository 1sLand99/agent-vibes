import { Injectable } from "@nestjs/common"
import { randomUUID } from "crypto"
import { formatSubAgentMemoryEntry } from "./sub-agent-memory-formatter"
import { TokenCounterService } from "./token-counter.service"
import {
  ContextSessionMemoryEntry,
  ContextSessionMemoryKind,
  ContextTranscriptRecord,
  extractText,
  normalizeContent,
} from "./types"

export interface SessionMemoryBuildOptions {
  sourceCompactionId: string
  archivedThroughRecordId?: string
  maxEntries?: number
}

@Injectable()
export class SessionMemoryCompactionService {
  private readonly MAX_MEMORY_ENTRIES = 64
  private readonly MAX_NEW_ENTRIES = 12
  private readonly MAX_ENTRY_TOKENS = 96

  constructor(private readonly tokenCounter: TokenCounterService) {}

  buildEntries(
    records: readonly ContextTranscriptRecord[],
    options: SessionMemoryBuildOptions
  ): ContextSessionMemoryEntry[] {
    if (records.length === 0) return []

    const candidates: Array<{
      kind: ContextSessionMemoryKind
      text: string
      sourceRecordId?: string
      createdAt: number
      weight: number
    }> = []

    this.collectObjective(records, candidates)
    this.collectDecisions(records, candidates)
    this.collectConstraints(records, candidates)
    this.collectVerification(records, candidates)
    this.collectRisks(records, candidates)
    this.collectCommands(records, candidates)
    this.collectSubAgentResults(records, candidates)
    this.collectProgress(records, candidates)
    this.collectFiles(records, candidates)
    this.collectOpenItems(records, candidates)

    return this.dedupeCandidates(
      candidates.filter((candidate) => this.isUsefulCandidate(candidate))
    )
      .sort((a, b) => b.weight - a.weight || b.createdAt - a.createdAt)
      .slice(0, options.maxEntries || this.MAX_NEW_ENTRIES)
      .map((candidate) => ({
        id: randomUUID(),
        kind: candidate.kind,
        text: this.trimToBudget(
          candidate.text,
          candidate.kind === "sub_agent" ? 180 : this.MAX_ENTRY_TOKENS
        ),
        sourceCompactionId: options.sourceCompactionId,
        sourceRecordId:
          candidate.sourceRecordId || options.archivedThroughRecordId,
        createdAt: candidate.createdAt,
        weight: candidate.weight,
      }))
  }

  mergeEntries(
    existing: readonly ContextSessionMemoryEntry[] | undefined,
    additions: readonly ContextSessionMemoryEntry[]
  ): ContextSessionMemoryEntry[] {
    const byKey = new Map<string, ContextSessionMemoryEntry>()
    for (const entry of [...(existing || []), ...additions]) {
      if (!entry.text.trim()) continue
      if (!this.isUsefulMemoryEntry(entry)) continue
      const key = this.fingerprint(entry.kind, entry.text)
      const previous = byKey.get(key)
      if (!previous || entry.weight > previous.weight) {
        byKey.set(key, entry)
      }
    }

    return Array.from(byKey.values())
      .sort((a, b) => b.weight - a.weight || b.createdAt - a.createdAt)
      .slice(0, this.MAX_MEMORY_ENTRIES)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  toAttachmentSummaries(
    entries: readonly ContextSessionMemoryEntry[] | undefined
  ): Array<{
    kind: ContextSessionMemoryKind
    text: string
    createdAt?: number
    weight?: number
  }> {
    return (entries || [])
      .filter((entry) => this.isUsefulMemoryEntry(entry))
      .map((entry) => ({
        kind: entry.kind,
        text: entry.text,
        createdAt: entry.createdAt,
        weight: entry.weight,
      }))
  }

  private collectObjective(
    records: readonly ContextTranscriptRecord[],
    candidates: Array<{
      kind: ContextSessionMemoryKind
      text: string
      sourceRecordId?: string
      createdAt: number
      weight: number
    }>
  ): void {
    const firstUser = records.find(
      (record) =>
        record.role === "user" && !!this.normalizeUserAuthoredText(record)
    )
    const lastUser = [...records]
      .reverse()
      .find(
        (record) =>
          record.role === "user" && !!this.normalizeUserAuthoredText(record)
      )
    const source = lastUser || firstUser
    if (!source) return
    const text = this.normalizeUserAuthoredText(source)
    if (!text) return
    candidates.push({
      kind: "objective",
      text: `Current objective or latest direction: ${text.slice(0, 240)}`,
      sourceRecordId: source.id,
      createdAt: source.createdAt,
      weight: 100,
    })
  }

  private collectDecisions(
    records: readonly ContextTranscriptRecord[],
    candidates: Array<{
      kind: ContextSessionMemoryKind
      text: string
      sourceRecordId?: string
      createdAt: number
      weight: number
    }>
  ): void {
    const patterns = [
      /\bdecided\b/i,
      /\baccepted\b/i,
      /\bchosen\b/i,
      /\buse\b.+\binstead\b/i,
      /采用/u,
      /选择/u,
      /决定/u,
      /方向/u,
    ]
    this.collectSentences(records, patterns, "decision", 92, candidates)
  }

  private collectConstraints(
    records: readonly ContextTranscriptRecord[],
    candidates: Array<{
      kind: ContextSessionMemoryKind
      text: string
      sourceRecordId?: string
      createdAt: number
      weight: number
    }>
  ): void {
    const patterns = [
      /\bmust\b/i,
      /\bdo not\b/i,
      /\bdon't\b/i,
      /\bonly\b/i,
      /禁止/u,
      /不要/u,
      /必须/u,
      /只能/u,
    ]
    this.collectSentences(records, patterns, "constraint", 96, candidates)
  }

  private collectProgress(
    records: readonly ContextTranscriptRecord[],
    candidates: Array<{
      kind: ContextSessionMemoryKind
      text: string
      sourceRecordId?: string
      createdAt: number
      weight: number
    }>
  ): void {
    const assistantRecords = records
      .filter(
        (record) =>
          record.role === "assistant" &&
          !!this.normalizeConversationText(record)
      )
      .slice(-4)
    for (const record of assistantRecords) {
      const text = this.normalizeConversationText(record)
      if (text.length < 40) continue
      candidates.push({
        kind: "progress",
        text: `Progress: ${text.slice(0, 220)}`,
        sourceRecordId: record.id,
        createdAt: record.createdAt,
        weight: 70,
      })
    }
  }

  private collectVerification(
    records: readonly ContextTranscriptRecord[],
    candidates: Array<{
      kind: ContextSessionMemoryKind
      text: string
      sourceRecordId?: string
      createdAt: number
      weight: number
    }>
  ): void {
    const patterns = [
      /\bpassed\b/i,
      /\bfailed\b/i,
      /\bsucceeded\b/i,
      /\bverified\b/i,
      /\btypecheck\b/i,
      /\blint\b/i,
      /\btests?\b/i,
      /\bnpm\s+(run|--workspace)\b/i,
      /✓/u,
      /✅/u,
      /通过/u,
      /失败/u,
      /验证/u,
      /报错/u,
    ]
    this.collectSentences(records, patterns, "verification", 86, candidates)
  }

  private collectRisks(
    records: readonly ContextTranscriptRecord[],
    candidates: Array<{
      kind: ContextSessionMemoryKind
      text: string
      sourceRecordId?: string
      createdAt: number
      weight: number
    }>
  ): void {
    const patterns = [
      /\broot cause\b/i,
      /\bcause\b/i,
      /\brisk\b/i,
      /\bregression\b/i,
      /\bdefect\b/i,
      /\bbottleneck\b/i,
      /\blatency\b/i,
      /原因/u,
      /风险/u,
      /缺陷/u,
      /瓶颈/u,
      /耗时/u,
    ]
    this.collectSentences(records, patterns, "risk", 82, candidates)
  }

  private collectCommands(
    records: readonly ContextTranscriptRecord[],
    candidates: Array<{
      kind: ContextSessionMemoryKind
      text: string
      sourceRecordId?: string
      createdAt: number
      weight: number
    }>
  ): void {
    const seen = new Set<string>()
    const commandPattern =
      /(?:^|[\s`])((?:npm|pnpm|yarn|git|gh|uv|python3?|node|npx|tsc|jest|pytest|cargo|go|docker|kubectl)\s+[^\n`。！？]{2,180})/gim

    for (const record of records) {
      for (const command of this.extractToolCommands(record)) {
        if (seen.has(command)) continue
        seen.add(command)
        candidates.push({
          kind: "command",
          text: `Command run: ${command}`,
          sourceRecordId: record.id,
          createdAt: record.createdAt,
          weight: 84,
        })
      }

      const text = this.normalizeConversationText(record)
      for (const match of text.matchAll(commandPattern)) {
        const command = this.squash(match[1] || "")
        if (!command || seen.has(command)) continue
        seen.add(command)
        candidates.push({
          kind: "command",
          text: `Command mentioned: ${command}`,
          sourceRecordId: record.id,
          createdAt: record.createdAt,
          weight: 78,
        })
      }
    }
  }

  private collectFiles(
    records: readonly ContextTranscriptRecord[],
    candidates: Array<{
      kind: ContextSessionMemoryKind
      text: string
      sourceRecordId?: string
      createdAt: number
      weight: number
    }>
  ): void {
    const pathPattern =
      /(?:\/|\.\/|\.\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9_.-]+)?/g
    const seen = new Set<string>()
    for (let i = records.length - 1; i >= 0 && seen.size < 12; i--) {
      const record = records[i]!
      const text = this.normalizeConversationText(record)
      for (const match of text.matchAll(pathPattern)) {
        const path = match[0]?.trim()
        if (!path || seen.has(path)) continue
        seen.add(path)
        candidates.push({
          kind: "file",
          text: `Relevant path: ${path}`,
          sourceRecordId: record.id,
          createdAt: record.createdAt,
          weight: 68,
        })
      }
    }
  }

  private collectSubAgentResults(
    records: readonly ContextTranscriptRecord[],
    candidates: Array<{
      kind: ContextSessionMemoryKind
      text: string
      sourceRecordId?: string
      createdAt: number
      weight: number
    }>
  ): void {
    const toolUses = new Map<
      string,
      { name: string; input: Record<string, unknown> }
    >()
    for (const record of records) {
      if (record.role !== "assistant") continue
      for (const block of normalizeContent(record.content)) {
        if (block.type !== "tool_use") continue
        toolUses.set(block.id, {
          name: block.name,
          input: block.input || {},
        })
      }
    }

    const seen = new Set<string>()
    for (const record of records) {
      if (record.role !== "user") continue
      for (const block of normalizeContent(record.content)) {
        if (block.type !== "tool_result") continue
        const toolUse = toolUses.get(block.tool_use_id)
        const rawText = extractText(block.content)
        const text = this.squash(rawText)
        const rawTaskSuccess = block.structuredContent?.taskSuccess
        const isTaskResult =
          toolUse?.name.toLowerCase() === "task" ||
          this.isRecord(rawTaskSuccess) ||
          /(?:Sub-agent execution summary:|Sub-agent result metadata:|Background sub-agent spawned\.|agentId:\s*\S+)/i.test(
            text
          )
        if (!isTaskResult || !text) continue

        const summary = this.summarizeSubAgentMemory(
          rawText,
          toolUse?.input || {},
          this.isRecord(rawTaskSuccess) ? rawTaskSuccess : undefined
        )
        if (!summary || seen.has(summary)) continue
        seen.add(summary)
        candidates.push({
          kind: "sub_agent",
          // formatSubAgentMemoryEntry already includes the
          // `Sub-agent result: ` prefix; do not double-prefix.
          text: summary,
          sourceRecordId: record.id,
          createdAt: record.createdAt,
          weight: 94,
        })
      }
    }
  }

  private collectOpenItems(
    records: readonly ContextTranscriptRecord[],
    candidates: Array<{
      kind: ContextSessionMemoryKind
      text: string
      sourceRecordId?: string
      createdAt: number
      weight: number
    }>
  ): void {
    const patterns = [
      /\bTODO\b/i,
      /\bnext\b/i,
      /\bremaining\b/i,
      /\bfollow[- ]?up\b/i,
      /待办/u,
      /剩余/u,
      /下一步/u,
      /还需要/u,
    ]
    this.collectSentences(records, patterns, "open_item", 72, candidates)
  }

  private summarizeSubAgentMemory(
    rawText: string,
    input: Record<string, unknown>,
    taskSuccess?: Record<string, unknown>
  ): string | null {
    const normalized = this.squash(rawText)
    const agentId =
      this.pickString(taskSuccess, ["agentId", "agent_id"]) ||
      this.matchFirst(normalized, /\bagentId:\s*([^\s]+)/i)
    if (!agentId) {
      // Without an agentId we cannot dedup against the live entry
      // written at completion time, so re-emitting from the
      // transcript would just create a parallel near-duplicate.
      // Skip — the live entry already covers this sub-agent.
      return null
    }

    const task =
      this.pickString(input, ["prompt", "task", "description"]) ||
      this.pickString(input, ["subagent_type", "subagentType", "type"])
    const agentType =
      this.pickString(input, ["subagent_type", "subagentType", "type"]) ||
      this.matchFirst(normalized, /\bagentType:\s*([^\s]+)/i)
    const toolCallsText = this.matchFirst(normalized, /\btool calls:\s*(\d+)/i)
    const toolCallCount = toolCallsText
      ? Number.parseInt(toolCallsText, 10)
      : undefined
    const finalText = this.extractSubAgentFinalText(rawText, 320)
    const toolEvidence = this.extractSubAgentToolEvidence(rawText)

    return formatSubAgentMemoryEntry(
      {
        agentId,
        agentType: agentType || undefined,
        task: task || undefined,
        toolCallCount:
          toolCallCount !== undefined && Number.isFinite(toolCallCount)
            ? toolCallCount
            : undefined,
        resultText: finalText || undefined,
        evidenceText: toolEvidence || undefined,
      },
      {
        // Match the streaming-side write so an entry rebuilt from
        // the transcript stays roughly the same shape.
        resultMaxChars: 320,
        evidenceMaxChars: 420,
        taskMaxChars: 180,
        totalMaxChars: 700,
      }
    )
  }

  /**
   * Pull the sub-agent's free-form final answer out of the rendered
   * tool_result, capped to roughly `maxChars` characters.
   *
   * Strategy: sections are separated by `\n---\n`; the first one is
   * the final block (everything before the first metadata fence).
   * Within that block we drop lines that match well-known metadata
   * prefixes (`agentId:`, `transcript:` etc.) so a stray header line
   * doesn't dominate the limited budget.
   *
   * `maxChars` mirrors the formatter's `resultMaxChars`. We measure
   * by characters rather than tokens because the formatter clips by
   * characters too — counting tokens here would just double-clip.
   */
  private extractSubAgentFinalText(rawText: string, maxChars: number): string {
    const beforeSummary = rawText.split(/\n\s*---\s*\n/u)[0] || rawText
    const lines = beforeSummary
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(
        (line) =>
          !/^(?:Sub-agent execution summary:|Sub-agent result metadata:|Key tool evidence:|Tool calls:|Background sub-agent spawned\.|agentId:|agentType:|model:|transcript:|result:)/i.test(
            line
          )
      )
    if (lines.length === 0) return ""

    // Greedy fill: keep adding lines until we hit the character cap.
    // Earlier code used a hard `slice(0, 4)` which clipped long
    // research / plan answers in half. We still want a hard upper
    // bound so a runaway final block doesn't blow the formatter's
    // total budget.
    const accumulated: string[] = []
    let consumed = 0
    for (const line of lines) {
      const next =
        accumulated.length === 0
          ? line
          : `${accumulated[accumulated.length - 1]} ${line}`
      const projected =
        consumed + line.length + (accumulated.length > 0 ? 1 : 0)
      if (projected > maxChars && accumulated.length > 0) break
      accumulated.push(line)
      consumed = next.length
    }
    return this.squash(accumulated.join(" "))
  }

  private extractSubAgentToolEvidence(rawText: string): string {
    const lines = rawText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
    const start = lines.findIndex((line) =>
      /^(?:Key tool evidence:|Tool calls:)/i.test(line)
    )
    if (start < 0) return ""
    return this.squash(
      lines
        .slice(start + 1)
        .filter((line) => /^\d+\.\s+/.test(line))
        .slice(0, 5)
        .join(" ")
    )
  }

  private collectSentences(
    records: readonly ContextTranscriptRecord[],
    patterns: readonly RegExp[],
    kind: ContextSessionMemoryKind,
    weight: number,
    candidates: Array<{
      kind: ContextSessionMemoryKind
      text: string
      sourceRecordId?: string
      createdAt: number
      weight: number
    }>
  ): void {
    for (let i = records.length - 1; i >= 0 && candidates.length < 64; i--) {
      const record = records[i]!
      const text = this.normalizeConversationText(record)
      if (!text) continue
      const sentences = text
        .split(/(?<=[.!?。！？\n])/u)
        .map((line) => line.trim())
        .filter(Boolean)
      for (let j = sentences.length - 1; j >= 0; j--) {
        const sentence = sentences[j]!
        if (!patterns.some((pattern) => pattern.test(sentence))) continue
        const normalized = this.squash(sentence)
        if (!normalized) continue
        candidates.push({
          kind,
          text: normalized.slice(0, 260),
          sourceRecordId: record.id,
          createdAt: record.createdAt,
          weight,
        })
      }
    }
  }

  private dedupeCandidates<T extends { kind: string; text: string }>(
    candidates: readonly T[]
  ): T[] {
    const seen = new Set<string>()
    const result: T[] = []
    for (const candidate of candidates) {
      const key = this.fingerprint(candidate.kind, candidate.text)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(candidate)
    }
    return result
  }

  private fingerprint(kind: string, text: string): string {
    return `${kind}:${this.stripMemoryPrefix(text)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, 140)}`
  }

  private isUsefulCandidate(candidate: {
    kind: ContextSessionMemoryKind
    text: string
  }): boolean {
    const text = this.squash(candidate.text)
    const minLength =
      candidate.kind === "file" || candidate.kind === "command" ? 8 : 16
    if (text.length < minLength) return false
    if (
      /(?:happy to help|let me know|i can help|i can continue|sure,?|understood)/i.test(
        text
      )
    ) {
      return false
    }
    if (/(?:如果你愿意|如果需要|我可以继续|你回复我|我会帮你)/u.test(text)) {
      return false
    }
    if (
      candidate.kind === "progress" &&
      !/(?:implemented|updated|fixed|changed|ran|verified|passed|failed|修复|实现|更新|验证|运行|通过|失败|apps\/|src\/)/i.test(
        text
      )
    ) {
      return false
    }
    if (this.isSyntheticMemoryText(this.stripMemoryPrefix(text))) {
      return false
    }
    return true
  }

  private isUsefulMemoryEntry(entry: {
    kind: ContextSessionMemoryKind
    text: string
  }): boolean {
    return this.isUsefulCandidate({
      kind: entry.kind,
      text: entry.text,
    })
  }

  private stripMemoryPrefix(text: string): string {
    return text
      .replace(/^Current objective or latest direction:\s*/i, "")
      .replace(/^Progress:\s*/i, "")
      .replace(/^Relevant path:\s*/i, "")
      .replace(/^Command (?:run|mentioned):\s*/i, "")
      .replace(/^Sub-agent result:\s*/i, "")
  }

  private normalizeConversationText(record: ContextTranscriptRecord): string {
    if (!this.isVisibleConversationRecord(record)) return ""
    return this.normalizeVisibleText(record.content)
  }

  private normalizeUserAuthoredText(record: ContextTranscriptRecord): string {
    if (record.role !== "user") return ""
    return this.normalizeConversationText(record)
  }

  private isVisibleConversationRecord(
    record: ContextTranscriptRecord
  ): boolean {
    if (record.kind && record.kind !== "message") return false
    if (record.isMeta) return false
    const text = this.normalizeVisibleText(record.content)
    return !!text && !this.isSyntheticMemoryText(text)
  }

  private normalizeVisibleText(
    content: ContextTranscriptRecord["content"]
  ): string {
    if (typeof content === "string") {
      const text = this.squash(content)
      return this.isSyntheticMemoryText(text) ? "" : text
    }
    const parts: string[] = []
    for (const block of normalizeContent(content)) {
      const record = block as unknown as Record<string, unknown>
      if (typeof record.text === "string") {
        parts.push(record.text)
      } else if (typeof record.input_text === "string") {
        parts.push(record.input_text)
      } else if (typeof record.output_text === "string") {
        parts.push(record.output_text)
      }
    }
    const text = this.squash(parts.join("\n"))
    return this.isSyntheticMemoryText(text) ? "" : text
  }

  private isSyntheticMemoryText(text: string): boolean {
    const normalized = this.squash(text)
    if (!normalized) return true
    return (
      /^(?:\[Context (?:attachment|summary|collapse|attachment removed)|\[Result of an earlier tool call|\[tool_result stored\])/i.test(
        normalized
      ) ||
      /^Current Codex turn context:/i.test(normalized) ||
      /^# AGENTS\.md instructions\b/i.test(normalized) ||
      /^<environment_context>/i.test(normalized) ||
      /^<turn_aborted>/i.test(normalized) ||
      /^Grep completed:\s*pattern=/i.test(normalized) ||
      /\bDocumentId:\s*tool_result:/i.test(normalized) ||
      /\bStoredPath:\s*\/.*\/\.agent-vibes\/tool-results\//i.test(normalized) ||
      /\/\.agent-vibes\/tool-results\//i.test(normalized)
    )
  }

  private extractToolCommands(record: ContextTranscriptRecord): string[] {
    if (typeof record.content === "string") return []
    const commands: string[] = []
    for (const block of normalizeContent(record.content)) {
      if (block.type !== "tool_use") continue
      if (!/(?:run_terminal_command|terminal|shell|bash)/i.test(block.name)) {
        continue
      }
      const input = block.input || {}
      const command =
        typeof input.command === "string"
          ? input.command
          : typeof input.cmd === "string"
            ? input.cmd
            : typeof input.script === "string"
              ? input.script
              : ""
      if (command.trim()) {
        commands.push(this.squash(command))
      }
    }
    return commands
  }

  private trimToBudget(text: string, maxTokens: number): string {
    const value = this.squash(text)
    if (this.tokenCounter.countText(value) <= maxTokens) return value
    let end = value.length
    while (end > 80) {
      end = Math.floor(end * 0.82)
      const candidate = `${value.slice(0, end).trim()} ...`
      if (this.tokenCounter.countText(candidate) <= maxTokens) return candidate
    }
    return `${value.slice(0, 80).trim()} ...`
  }

  private squash(text: string): string {
    return text.replace(/\s+/g, " ").trim()
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  private pickString(
    value: Record<string, unknown> | undefined,
    keys: readonly string[]
  ): string {
    if (!value) return ""
    for (const key of keys) {
      const candidate = value[key]
      if (typeof candidate === "string" && candidate.trim()) {
        return this.squash(candidate)
      }
    }
    return ""
  }

  private matchFirst(text: string, pattern: RegExp): string {
    const match = text.match(pattern)
    return (match?.[1] || "").trim()
  }

  private clip(text: string, maxChars: number): string {
    const normalized = this.squash(text)
    return normalized.length > maxChars
      ? `${normalized.slice(0, maxChars - 1)}…`
      : normalized
  }
}
