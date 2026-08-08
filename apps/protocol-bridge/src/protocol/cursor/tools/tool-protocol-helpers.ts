export interface EditFailureSelection {
  startLine?: number
  endLine?: number
  allowMultiple?: boolean
  searchText?: string
  replaceTextLength?: number
  chunkIndex?: number
}

export interface NumberedLineEntry {
  LineNumber: number
  Text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function pickFirstNumber(
  input: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const candidate = input[key]
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.floor(candidate)
    }
  }
  return undefined
}

function pickFirstBoolean(
  input: Record<string, unknown>,
  keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const candidate = input[key]
    if (typeof candidate === "boolean") return candidate
  }
  return undefined
}

function pickFirstRawString(
  input: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const candidate = input[key]
    if (typeof candidate === "string") return candidate
  }
  return undefined
}

function splitContentLines(content: string): string[] {
  if (content.length === 0) return []

  const lines = content.split(/\r?\n/)
  if (
    lines.length > 0 &&
    lines[lines.length - 1] === "" &&
    /\r?\n$/.test(content)
  ) {
    lines.pop()
  }
  return lines
}

export function extractEditFailureSelection(
  toolInput: Record<string, unknown>,
  warning?: string
): EditFailureSelection | undefined {
  const replacementChunks = Array.isArray(toolInput.replacementChunks)
    ? toolInput.replacementChunks
    : []
  const chunkIndexMatch = warning?.match(/replacement chunk (\d+)/i)
  const chunkIndex = chunkIndexMatch
    ? Math.max(0, Number.parseInt(chunkIndexMatch[1] || "1", 10) - 1)
    : undefined
  const selected =
    chunkIndex != null &&
    Number.isInteger(chunkIndex) &&
    chunkIndex >= 0 &&
    chunkIndex < replacementChunks.length &&
    isRecord(replacementChunks[chunkIndex])
      ? replacementChunks[chunkIndex]
      : toolInput

  return {
    startLine: pickFirstNumber(selected, [
      "startLine",
      "start_line",
      "StartLine",
    ]),
    endLine: pickFirstNumber(selected, ["endLine", "end_line", "EndLine"]),
    allowMultiple: pickFirstBoolean(selected, [
      "allowMultiple",
      "allow_multiple",
      "AllowMultiple",
    ]),
    searchText: pickFirstRawString(selected, [
      "targetContent",
      "target_content",
      "TargetContent",
      "search",
      "old_text",
    ]),
    replaceTextLength:
      pickFirstRawString(selected, [
        "replacementContent",
        "replacement_content",
        "ReplacementContent",
        "replace",
        "new_text",
      ])?.length ?? undefined,
    chunkIndex,
  }
}

export function buildNumberedLineEntries(
  content: string,
  startLine = 1
): {
  lines: NumberedLineEntry[]
  endLine: number
  text: string
} {
  const safeStartLine =
    typeof startLine === "number" && Number.isFinite(startLine)
      ? Math.max(1, Math.floor(startLine))
      : 1
  const lines = splitContentLines(content).map((line, index) => ({
    LineNumber: safeStartLine + index,
    Text: line,
  }))
  const lastLineNumber =
    (lines.length > 0 ? lines[lines.length - 1]!.LineNumber : undefined) ??
    safeStartLine

  return {
    lines,
    endLine: lastLineNumber,
    text: lines.map((line) => `${line.LineNumber} | ${line.Text}`).join("\n"),
  }
}

export function formatLineNumberedSnippet(
  content: string,
  options?: {
    startLine?: number
    endLine?: number
    maxLines?: number
  }
): { snippet: string; startLine: number; endLine: number; truncated: boolean } {
  if (!content) {
    return { snippet: "", startLine: 1, endLine: 0, truncated: false }
  }
  const lines = splitContentLines(content)
  const maxLines = Math.max(1, options?.maxLines ?? 160)
  const rawStart =
    typeof options?.startLine === "number" && Number.isFinite(options.startLine)
      ? Math.max(1, Math.floor(options.startLine))
      : 1
  const rawEnd =
    typeof options?.endLine === "number" && Number.isFinite(options.endLine)
      ? Math.max(rawStart, Math.floor(options.endLine))
      : Math.max(rawStart, Math.min(lines.length, rawStart + maxLines - 1))
  const endLine = Math.min(lines.length || rawEnd, rawEnd)
  const lineCount = Math.max(0, endLine - rawStart + 1)
  const visibleCount = Math.min(lineCount, maxLines)
  const visibleEnd = rawStart + visibleCount - 1
  const numbered = lines
    .slice(rawStart - 1, visibleEnd)
    .map((line, index) => `${rawStart + index} | ${line}`)
    .join("\n")

  return {
    snippet: numbered,
    startLine: rawStart,
    endLine: visibleEnd,
    truncated: lineCount > visibleCount,
  }
}
