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
    `[Codex][Dispatch] slot=${options.slotLabel} ` +
    `model=${options.modelName} ` +
    `transport=${options.transport} ` +
    `omitAccountId=${options.omitAccountId} ` +
    `accountId=${JSON.stringify(options.accountId || null)} ` +
    `workspaceId=${JSON.stringify(options.workspaceId || null)} ` +
    `orgHeader=${JSON.stringify(options.headers["OpenAI-Organization"] || null)} ` +
    `accountHeader=${JSON.stringify(options.headers["Chatgpt-Account-Id"] || null)}`
  )
}
