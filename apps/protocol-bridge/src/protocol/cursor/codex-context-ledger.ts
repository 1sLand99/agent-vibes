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
  contextInitialized: boolean
  contextChanged: boolean
  changedKeys: string[]
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
  return previewCodexContextLedgerProjection(state, [], entries).contextMessages
}

export function previewCodexContextLedgerProjection(
  state: CodexContextLedgerState | undefined,
  visibleMessages: CodexExecutionRequest["messages"],
  entries: CodexContextEntry[]
): CodexContextLedgerProjection {
  const snapshot = state ?? createCodexContextLedgerState()
  const wasInitialized = snapshot.initialized
  const normalizedEntries = normalizeEntries(entries)
  const insertionIndex = findCurrentTurnContextInsertionIndex(visibleMessages)
  const pendingMessages = buildPendingContextMessages(
    snapshot,
    normalizedEntries,
    insertionIndex
  )
  const contextMessages = buildCurrentContextMessages(
    normalizedEntries,
    insertionIndex
  )
  const changedMessages = wasInitialized ? pendingMessages : []

  return {
    messages: mergeContextMessagesIntoVisibleMessages(
      contextMessages,
      visibleMessages
    ),
    contextMessages: contextMessages.map(({ role, content }) => ({
      role,
      content,
    })),
    addedContextMessages: pendingMessages.map(({ role, content }) => ({
      role,
      content,
    })),
    contextInitialized: !wasInitialized,
    contextChanged: changedMessages.length > 0,
    changedKeys: changedMessages.map((message) => message.key),
  }
}

export function projectCodexContextLedgerMessages(
  state: CodexContextLedgerState,
  visibleMessages: CodexExecutionRequest["messages"],
  entries: CodexContextEntry[]
): CodexContextLedgerProjection {
  const wasInitialized = state.initialized
  const normalizedEntries = normalizeEntries(entries)
  const insertionIndex = findCurrentTurnContextInsertionIndex(visibleMessages)
  const pendingMessages = buildPendingContextMessages(
    state,
    normalizedEntries,
    insertionIndex
  )

  if (!wasInitialized || pendingMessages.length > 0) {
    state.messages = buildCurrentContextMessages(
      normalizedEntries,
      insertionIndex
    )
    state.initialized = true
    state.latestSignaturesByKey = Object.fromEntries(
      normalizedEntries.map((entry) => [entry.key, signContextEntry(entry)])
    )
    state.latestRolesByKey = Object.fromEntries(
      normalizedEntries.map((entry) => [entry.key, entry.role])
    )
  }

  const changedMessages = wasInitialized ? pendingMessages : []

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
    contextInitialized: !wasInitialized,
    contextChanged: changedMessages.length > 0,
    changedKeys: changedMessages.map((message) => message.key),
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

  const pending: CodexContextLedgerAnchoredMessage[] = []
  for (const [key, signature] of Object.entries(state.latestSignaturesByKey)) {
    const current = entries.find((entry) => entry.key === key)
    if (!current) {
      pending.push({
        key,
        signature: `removed:${signature}`,
        role: state.latestRolesByKey[key] ?? "developer",
        content: "",
        beforeVisibleIndex,
      })
      continue
    }
    if (signContextEntry(current) !== signature) {
      pending.push(anchorContextEntry(current, beforeVisibleIndex))
    }
  }

  for (const entry of entries) {
    if (!(entry.key in state.latestSignaturesByKey)) {
      pending.push(anchorContextEntry(entry, beforeVisibleIndex))
    }
  }

  return pending
}

function buildCurrentContextMessages(
  entries: CodexContextEntry[],
  beforeVisibleIndex: number
): CodexContextLedgerAnchoredMessage[] {
  return entries.map((entry) => anchorContextEntry(entry, beforeVisibleIndex))
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
