import { createHash } from "crypto"
import type {
  CodexAppendOnlyAttachmentLedgerEntry,
  CodexAppendOnlyAttachmentLedgerState,
  ContextConversationState,
  ContextProjectionAttachment,
  ProjectedContextMessage,
} from "./types"

const DEFAULT_CODEX_ATTACHMENT_TRUNCATION_POLICY = {
  mode: "bytes" as const,
  limit: 10_000,
}

export function projectCodexAppendOnlyAttachments(
  state: ContextConversationState,
  visibleMessages: ProjectedContextMessage[],
  attachments: ContextProjectionAttachment[],
  options?: {
    commitId?: string
    mutate?: boolean
    now?: () => number
  }
): ProjectedContextMessage[] {
  if (attachments.length === 0) {
    return mergeCodexAppendOnlyAttachments(
      visibleMessages,
      state.codexContext?.appendOnlyAttachmentLedger?.entries || []
    )
  }

  const mutate = options?.mutate !== false
  const ledger = mutate
    ? ensureMutableLedger(state)
    : cloneLedger(state.codexContext?.appendOnlyAttachmentLedger)
  const visibleTailIndex = visibleMessages.length
  const now = options?.now || Date.now

  for (const attachment of attachments) {
    const signature = buildAttachmentSignature(attachment)
    const previousSignature = ledger.latestSignaturesByKind[attachment.kind]
    if (previousSignature === signature) {
      continue
    }

    const entry: CodexAppendOnlyAttachmentLedgerEntry = {
      kind: attachment.kind,
      label: attachment.label,
      signature,
      beforeVisibleIndex: visibleTailIndex,
      role: "user",
      content: renderAppendOnlyAttachmentContent(
        attachment,
        Boolean(previousSignature)
      ),
      source: "attachment",
      isMeta: true,
      attachmentKind: attachment.kind,
      ...(options?.commitId ? { commitId: options.commitId } : {}),
      createdAt: now(),
    }
    ledger.entries.push(entry)
    ledger.latestSignaturesByKind[attachment.kind] = signature
    ledger.version += 1
  }

  return mergeCodexAppendOnlyAttachments(visibleMessages, ledger.entries)
}

export function buildAttachmentSignature(
  attachment: ContextProjectionAttachment
): string {
  return createHash("sha256")
    .update(attachment.kind)
    .update("\0")
    .update(attachment.content)
    .digest("hex")
}

function ensureMutableLedger(
  state: ContextConversationState
): CodexAppendOnlyAttachmentLedgerState {
  if (!state.codexContext) {
    state.codexContext = {
      historyVersion: 0,
      truncationPolicy: { ...DEFAULT_CODEX_ATTACHMENT_TRUNCATION_POLICY },
    }
  }
  if (!state.codexContext.appendOnlyAttachmentLedger) {
    state.codexContext.appendOnlyAttachmentLedger = {
      version: 0,
      entries: [],
      latestSignaturesByKind: {},
    }
  }
  return state.codexContext.appendOnlyAttachmentLedger
}

function cloneLedger(
  ledger: CodexAppendOnlyAttachmentLedgerState | undefined
): CodexAppendOnlyAttachmentLedgerState {
  return {
    version: ledger?.version || 0,
    entries: ledger?.entries
      ? ledger.entries.map((entry) => ({ ...entry }))
      : [],
    latestSignaturesByKind: {
      ...(ledger?.latestSignaturesByKind || {}),
    },
  }
}

function renderAppendOnlyAttachmentContent(
  attachment: ContextProjectionAttachment,
  supersedesPrevious: boolean
): string {
  if (!supersedesPrevious) {
    return attachment.content
  }

  const notice = `This ${attachment.label} attachment supersedes earlier ${attachment.label} attachments in this Codex conversation.`
  return attachment.content.replace(
    /^(\[Context attachment:[^\]]+\])(\r?\n)?/u,
    `$1\n${notice}\n`
  )
}

function mergeCodexAppendOnlyAttachments(
  visibleMessages: ProjectedContextMessage[],
  entries: readonly CodexAppendOnlyAttachmentLedgerEntry[]
): ProjectedContextMessage[] {
  if (entries.length === 0) {
    return visibleMessages
  }

  const entriesByVisibleIndex = new Map<
    number,
    CodexAppendOnlyAttachmentLedgerEntry[]
  >()
  for (const entry of entries) {
    const index = clampVisibleIndex(
      entry.beforeVisibleIndex,
      visibleMessages.length
    )
    const bucket = entriesByVisibleIndex.get(index)
    if (bucket) {
      bucket.push(entry)
    } else {
      entriesByVisibleIndex.set(index, [entry])
    }
  }

  const merged: ProjectedContextMessage[] = []
  for (let index = 0; index <= visibleMessages.length; index++) {
    const bucket = entriesByVisibleIndex.get(index)
    if (bucket) {
      for (const entry of bucket) {
        merged.push({
          role: entry.role,
          content: entry.content,
          source: entry.source,
          isMeta: entry.isMeta,
          attachmentKind: entry.attachmentKind,
          ...(entry.commitId ? { commitId: entry.commitId } : {}),
        })
      }
    }
    if (index < visibleMessages.length) {
      merged.push(visibleMessages[index]!)
    }
  }
  return merged
}

function clampVisibleIndex(index: number, visibleLength: number): number {
  if (!Number.isFinite(index)) {
    return visibleLength
  }
  return Math.max(0, Math.min(Math.floor(index), visibleLength))
}
