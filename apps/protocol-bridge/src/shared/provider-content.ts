export type ProviderMessageContent = string | unknown[]

export type CodexReplacementHistoryItem = Record<string, unknown>

export const CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE = "codex_response_item"

export interface CodexRawResponseItemBlock {
  type: typeof CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE
  item: CodexReplacementHistoryItem
  [key: string]: unknown
}
