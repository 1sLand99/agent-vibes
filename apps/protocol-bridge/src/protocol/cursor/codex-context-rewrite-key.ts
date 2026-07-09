import type { CodexContextState } from "../../context"
import { safeJsonStringify } from "./safe-json"

export function buildCodexContextRewriteKey(
  context: CodexContextState | undefined
): string | undefined {
  if (!context) {
    return undefined
  }

  const replacement = context.activeWindow?.replacementHistory
  return safeJsonStringify({
    activeWindowId: context.activeWindow?.windowId || "",
    activeWindowNumber: context.activeWindow?.windowNumber || 0,
    activeCompactionId: context.activeWindow?.compactionId || "",
    replacementCompactionId: replacement?.compactionId || "",
    replacementWindowId: replacement?.windowId || "",
    replacementAnchorRecordId: replacement?.anchorRecordId || "",
    replacementAnchorRecordCount: replacement?.anchorRecordCount || 0,
    replacementItemSignature: replacement?.items?.length
      ? safeJsonStringify(replacement.items, {
          includeHashes: true,
          maxArrayItems: 10_000,
          maxObjectKeys: 1_000,
          maxStringLength: 64 * 1024,
        })
      : "",
    truncationMode: context.truncationPolicy?.mode || "",
    truncationLimit: context.truncationPolicy?.limit || 0,
  })
}
