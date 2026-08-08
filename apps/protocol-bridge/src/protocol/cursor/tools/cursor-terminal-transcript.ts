/**
 * Parse Cursor IDE terminal artifact files (`terminals/<id>.txt`).
 *
 * Format:
 *   ---
 *   pid: …
 *   status: running|succeeded|failed|aborted
 *   …
 *   ---
 *   <stdout/stderr body>
 *   ---
 *   exit_code: N
 *   elapsed_ms: …
 *   ended_at: …
 *   ---
 */

export type CursorTerminalTranscriptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "aborted"
  | "unknown"

export interface ParsedCursorTerminalTranscript {
  readonly headerStatus: CursorTerminalTranscriptStatus
  readonly exitCode?: number
  readonly aborted: boolean
  readonly endedAtMs?: number
  readonly terminal: boolean
}

function normalizeHeaderStatus(
  raw: string | undefined
): CursorTerminalTranscriptStatus {
  switch ((raw || "").trim().toLowerCase()) {
    case "running":
      return "running"
    case "succeeded":
    case "success":
    case "completed":
    case "done":
      return "succeeded"
    case "failed":
    case "error":
    case "failure":
      return "failed"
    case "aborted":
    case "cancelled":
    case "canceled":
      return "aborted"
    default:
      return "unknown"
  }
}

function parseFrontMatterBlock(block: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of block.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(":")
    if (colon <= 0) continue
    const key = trimmed.slice(0, colon).trim()
    let value = trimmed.slice(colon + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    fields[key] = value
  }
  return fields
}

function extractHeaderBlock(transcript: string): string | undefined {
  const match = transcript.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)
  return match?.[1]
}

function extractFooterBlock(transcript: string): string | undefined {
  const match = transcript.match(/\r?\n---\r?\n((?:[^\n]|[\n])*?)\r?\n---\s*$/u)
  return match?.[1]
}

export function parseCursorTerminalTranscript(
  transcript: string
): ParsedCursorTerminalTranscript {
  const header = parseFrontMatterBlock(extractHeaderBlock(transcript) || "")
  const footer = parseFrontMatterBlock(extractFooterBlock(transcript) || "")

  const headerStatus = normalizeHeaderStatus(header.status)
  const exitRaw = footer.exit_code ?? header.exit_code
  let exitCode: number | undefined
  if (exitRaw !== undefined && /^-?\d+$/u.test(exitRaw)) {
    exitCode = Number(exitRaw)
  } else if (headerStatus === "succeeded") {
    exitCode = 0
  } else if (headerStatus === "failed") {
    exitCode = 1
  } else if (headerStatus === "aborted") {
    exitCode = 130
  }

  const endedRaw = footer.ended_at ?? header.ended_at
  const endedAtMs = endedRaw !== undefined ? Date.parse(endedRaw) : Number.NaN

  const aborted =
    headerStatus === "aborted" ||
    footer.aborted === "true" ||
    header.aborted === "true"

  const terminal =
    exitRaw !== undefined ||
    headerStatus === "succeeded" ||
    headerStatus === "failed" ||
    headerStatus === "aborted"

  return {
    headerStatus,
    ...(exitCode !== undefined && terminal ? { exitCode } : {}),
    aborted,
    ...(Number.isFinite(endedAtMs) ? { endedAtMs } : {}),
    terminal,
  }
}
