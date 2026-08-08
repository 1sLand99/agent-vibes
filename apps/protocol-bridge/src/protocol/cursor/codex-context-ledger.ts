import type { ContextProjectionAttachment } from "../../context"
import { requireExactDurableIdentifier } from "../../context/durable-identifier"
import { stableCodexJsonStringify } from "../../llm/openai/codex-incremental"
import type { CodexConversationMessage } from "../../llm/openai/codex-native-types"

/**
 * Provider-owned context is intentionally separate from the durable graph
 * history. `buildCodexContextDelta` binds these entries to native input items
 * under `codex-context:<key>`; they must never be projected as generic
 * `UnifiedMessage` rows.
 */
export interface CodexContextEntry {
  key: string
  role: "developer" | "user"
  content: CodexConversationMessage["content"]
}

const DYNAMIC_ATTACHMENT_KEY_PREFIX = "attachment:"

/**
 * Adds the current dynamic attachment snapshot to the provider-native context
 * set. A kind has exactly one replaceable key, so a content change is handled
 * by the Codex context-delta replacement path rather than by appending another
 * synthetic history message.
 */
export function buildCodexContextEntries(
  baseEntries: readonly CodexContextEntry[],
  attachments: readonly ContextProjectionAttachment[] = []
): CodexContextEntry[] {
  return normalizeCodexContextEntries([
    ...baseEntries,
    ...attachments.map((attachment) => ({
      key: `${DYNAMIC_ATTACHMENT_KEY_PREFIX}${attachment.kind}`,
      role: "user" as const,
      content: attachment.content,
    })),
  ])
}

/**
 * The canonical signature is deliberately based on the exact provider input
 * shape. Request caches can use it without relying on transcript position or
 * a fabricated graph identity for dynamic context.
 */
export function buildCodexContextEntrySignature(
  entries: readonly CodexContextEntry[]
): string {
  return stableCodexJsonStringify(
    normalizeCodexContextEntries(entries).map(({ key, role, content }) => ({
      key,
      role,
      content,
    }))
  )
}

function normalizeCodexContextEntries(
  entries: readonly CodexContextEntry[]
): CodexContextEntry[] {
  const normalized: CodexContextEntry[] = []
  const keys = new Set<string>()
  for (const entry of entries) {
    const key = requireExactDurableIdentifier(
      entry.key,
      "Codex context entry key"
    )
    if (keys.has(key)) {
      throw new Error(`Codex context contains duplicate key ${key}`)
    }
    if (typeof entry.content === "string" && !entry.content.trim()) {
      throw new Error(`Codex context entry ${key} has empty content`)
    }
    keys.add(key)
    normalized.push({
      key,
      role: entry.role,
      content: entry.content,
    })
  }
  return normalized
}
