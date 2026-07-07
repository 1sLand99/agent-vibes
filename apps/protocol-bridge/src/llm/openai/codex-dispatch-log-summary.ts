import * as crypto from "crypto"

export type CodexDispatchTransport =
  | "http"
  | "http-stream"
  | "websocket"
  | "websocket-stream"

export interface CodexDispatchLogSummaryOptions {
  slotLabel: string
  modelName: string
  transport: CodexDispatchTransport
  omitAccountId: boolean
  accountId?: string | null
  workspaceId?: string | null
  headers: Record<string, string | undefined>
}

export function buildCodexDispatchLogLine(
  options: CodexDispatchLogSummaryOptions
): string {
  return (
    `[Codex][Dispatch] slot=${redactSlotLabel(options.slotLabel)} ` +
    `model=${options.modelName} ` +
    `transport=${options.transport} ` +
    `omitAccountId=${options.omitAccountId} ` +
    `accountId=${formatSensitiveLogValue(options.accountId)} ` +
    `workspaceId=${formatSensitiveLogValue(options.workspaceId)} ` +
    `orgHeader=${formatSensitiveLogValue(options.headers["OpenAI-Organization"])} ` +
    `accountHeader=${formatSensitiveLogValue(options.headers["Chatgpt-Account-Id"])}`
  )
}

function redactSlotLabel(slotLabel: string): string {
  const trimmed = slotLabel.trim()
  if (!trimmed) return "none"

  const match = trimmed.match(/^(.+?)\s+\((.+)\)$/)
  if (!match) return formatSensitiveLogValue(trimmed)

  return `${formatSensitiveLogValue(match[1])} (${formatSensitiveLogValue(
    match[2]
  )})`
}

function formatSensitiveLogValue(value: string | null | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) return "null"
  return `redacted:${fingerprintSensitiveValue(trimmed)}`
}

function fingerprintSensitiveValue(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8)
}
