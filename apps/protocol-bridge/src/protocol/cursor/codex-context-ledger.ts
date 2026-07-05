import type {
  CodexConversationMessage,
  CodexExecutionRequest,
} from "../../llm/openai/codex-native-types"
import { stableCodexJsonStringify } from "../../llm/openai/codex-incremental"

export interface CodexContextEntry {
  key: string
  role: "developer" | "user"
  content: CodexConversationMessage["content"]
}

export interface CodexContextLedgerAnchoredMessage extends CodexConversationMessage {
  key: string
  signature: string
  beforeVisibleIndex: number
}

export interface CodexContextLedgerState {
  initialized: boolean
  messages: CodexContextLedgerAnchoredMessage[]
  latestSignaturesByKey: Record<string, string>
  latestRolesByKey: Record<string, "developer" | "user">
}

export interface CodexContextLedgerProjection {
  messages: CodexExecutionRequest["messages"]
  contextMessages: CodexConversationMessage[]
  addedContextMessages: CodexConversationMessage[]
}

export function createCodexContextLedgerState(): CodexContextLedgerState {
  return {
    initialized: false,
    messages: [],
    latestSignaturesByKey: {},
    latestRolesByKey: {},
  }
}

export function previewCodexContextLedgerMessages(
  state: CodexContextLedgerState | undefined,
  entries: CodexContextEntry[]
): CodexConversationMessage[] {
  const pending = buildPendingContextMessages(
    state ?? createCodexContextLedgerState(),
    normalizeEntries(entries),
    0
  )
  return [
    ...((state?.messages ?? []) as CodexConversationMessage[]),
    ...pending,
  ].map(({ role, content }) => ({ role, content }))
}

export function projectCodexContextLedgerMessages(
  state: CodexContextLedgerState,
  visibleMessages: CodexExecutionRequest["messages"],
  entries: CodexContextEntry[]
): CodexContextLedgerProjection {
  const normalizedEntries = normalizeEntries(entries)
  const insertionIndex = state.initialized
    ? findCurrentTurnContextInsertionIndex(visibleMessages)
    : 0
  const pendingMessages = buildPendingContextMessages(
    state,
    normalizedEntries,
    insertionIndex
  )

  if (!state.initialized || pendingMessages.length > 0) {
    state.messages.push(...pendingMessages)
    state.initialized = true
    state.latestSignaturesByKey = Object.fromEntries(
      normalizedEntries.map((entry) => [entry.key, signContextEntry(entry)])
    )
    state.latestRolesByKey = Object.fromEntries(
      normalizedEntries.map((entry) => [entry.key, entry.role])
    )
  }

  return {
    messages: mergeContextMessagesIntoVisibleMessages(
      state.messages,
      visibleMessages
    ),
    contextMessages: state.messages.map(({ role, content }) => ({
      role,
      content,
    })),
    addedContextMessages: pendingMessages.map(({ role, content }) => ({
      role,
      content,
    })),
  }
}

function buildPendingContextMessages(
  state: CodexContextLedgerState,
  entries: CodexContextEntry[],
  beforeVisibleIndex: number
): CodexContextLedgerAnchoredMessage[] {
  if (!state.initialized) {
    return entries.map((entry) => anchorContextEntry(entry, beforeVisibleIndex))
  }

  const currentKeys = new Set(entries.map((entry) => entry.key))
  const pending: CodexContextLedgerAnchoredMessage[] = []
  for (const [key, signature] of Object.entries(state.latestSignaturesByKey)) {
    if (currentKeys.has(key)) {
      continue
    }
    pending.push({
      key,
      signature: `removed:${signature}`,
      role: state.latestRolesByKey[key] ?? "developer",
      content: renderRemovedContextEntry(key),
      beforeVisibleIndex,
    })
  }

  for (const entry of entries) {
    const signature = signContextEntry(entry)
    if (state.latestSignaturesByKey[entry.key] === signature) {
      continue
    }
    pending.push(anchorContextEntry(entry, beforeVisibleIndex))
  }

  return pending
}

function anchorContextEntry(
  entry: CodexContextEntry,
  beforeVisibleIndex: number
): CodexContextLedgerAnchoredMessage {
  return {
    key: entry.key,
    signature: signContextEntry(entry),
    role: entry.role,
    content: entry.content,
    beforeVisibleIndex,
  }
}

function mergeContextMessagesIntoVisibleMessages(
  contextMessages: CodexContextLedgerAnchoredMessage[],
  visibleMessages: CodexExecutionRequest["messages"]
): CodexExecutionRequest["messages"] {
  const byIndex = new Map<number, CodexContextLedgerAnchoredMessage[]>()
  for (const message of contextMessages) {
    const index = Math.max(
      0,
      Math.min(message.beforeVisibleIndex, visibleMessages.length)
    )
    const existing = byIndex.get(index)
    if (existing) {
      existing.push(message)
    } else {
      byIndex.set(index, [message])
    }
  }

  const merged: CodexExecutionRequest["messages"] = []
  for (let index = 0; index <= visibleMessages.length; index++) {
    for (const message of byIndex.get(index) ?? []) {
      merged.push({ role: message.role, content: message.content })
    }
    const visibleMessage = visibleMessages[index]
    if (visibleMessage) {
      merged.push(visibleMessage)
    }
  }
  return merged
}

function findCurrentTurnContextInsertionIndex(
  visibleMessages: CodexExecutionRequest["messages"]
): number {
  for (let index = visibleMessages.length - 1; index >= 0; index--) {
    const message = visibleMessages[index]
    if (message?.role === "user") {
      return messageContainsToolResult(message) ? index + 1 : index
    }
  }
  return visibleMessages.length
}

function messageContainsToolResult(
  message: CodexConversationMessage | undefined
): boolean {
  if (!message || !Array.isArray(message.content)) {
    return false
  }
  return message.content.some(
    (block) =>
      !!block && typeof block === "object" && block.type === "tool_result"
  )
}

function normalizeEntries(entries: CodexContextEntry[]): CodexContextEntry[] {
  const normalized: CodexContextEntry[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = entry.key.trim()
    if (!key || seen.has(key) || isEmptyContent(entry.content)) {
      continue
    }
    seen.add(key)
    normalized.push({
      key,
      role: entry.role,
      content:
        typeof entry.content === "string"
          ? entry.content.trim()
          : entry.content,
    })
  }
  return normalized
}

function isEmptyContent(content: CodexConversationMessage["content"]): boolean {
  return typeof content === "string" ? content.trim().length === 0 : false
}

function signContextEntry(entry: CodexContextEntry): string {
  return stableCodexJsonStringify({
    key: entry.key,
    role: entry.role,
    content: entry.content,
  })
}

function renderRemovedContextEntry(key: string): string {
  return [
    "<context_update>",
    `The previously supplied Cursor context section \`${key}\` is no longer present for the current turn.`,
    "</context_update>",
  ].join("\n")
}
