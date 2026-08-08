import type { ContentBlock, ToolResultBlock } from "../../../context/types"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import type { PersistedMessageRevision } from "./message-store.service"
import type { SessionMessage } from "./session-lifecycle.service"

export const TOOL_RESULT_STRUCTURED_CONTENT_REVISION =
  "tool_result_structured_content"
export const ASYNC_TOOL_RESULT_RESOLUTION_REVISION =
  "async_tool_result_resolution"
export const PROVIDER_PROJECTION_EXCLUSION_REVISION =
  "provider_projection_exclusion"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function readToolResultStructuredContentRevision(
  revision: Pick<PersistedMessageRevision, "payload">
): { toolUseId: string; structuredContent: Record<string, unknown> } {
  const toolUseId = revision.payload.toolUseId
  const structuredContent = revision.payload.structuredContent
  let exactToolUseId: string
  try {
    exactToolUseId = requireExactDurableIdentifier(
      toolUseId,
      `${TOOL_RESULT_STRUCTURED_CONTENT_REVISION} toolUseId`
    )
  } catch {
    throw new Error(
      `${TOOL_RESULT_STRUCTURED_CONTENT_REVISION}: missing toolUseId`
    )
  }
  if (!isRecord(structuredContent)) {
    throw new Error(
      `${TOOL_RESULT_STRUCTURED_CONTENT_REVISION}: structuredContent must be an object`
    )
  }
  return {
    toolUseId: exactToolUseId,
    structuredContent: structuredClone(structuredContent),
  }
}

function applyToolResultStructuredContentRevision(
  message: SessionMessage,
  revision: Pick<PersistedMessageRevision, "payload">
): SessionMessage {
  if (message.type !== "user" || !Array.isArray(message.message.content)) {
    throw new Error(
      `${TOOL_RESULT_STRUCTURED_CONTENT_REVISION}: target ${message.uuid} is not a user tool_result fragment`
    )
  }
  const { toolUseId, structuredContent } =
    readToolResultStructuredContentRevision(revision)
  let found = false
  const content: ContentBlock[] = (
    message.message.content as ContentBlock[]
  ).map((block): ContentBlock => {
    if (block.type !== "tool_result" || block.tool_use_id !== toolUseId) {
      return block
    }
    found = true
    const existing = isRecord(block.structuredContent)
      ? block.structuredContent
      : {}
    return {
      ...block,
      structuredContent: {
        ...structuredClone(existing),
        ...structuredContent,
      },
    } as ToolResultBlock
  })
  if (!found) {
    throw new Error(
      `${TOOL_RESULT_STRUCTURED_CONTENT_REVISION}: target ${message.uuid} does not contain tool_result ${toolUseId}`
    )
  }
  return {
    ...message,
    message: {
      ...message.message,
      content,
    },
  }
}

function readAsyncToolResultResolutionRevision(
  revision: Pick<PersistedMessageRevision, "payload">
): {
  toolUseId: string
  content: string
  isError: boolean
  structuredContent: Record<string, unknown>
} {
  const toolUseId = revision.payload.toolUseId
  const content = revision.payload.content
  const isError = revision.payload.isError
  const structuredContent = revision.payload.structuredContent
  let exactToolUseId: string
  try {
    exactToolUseId = requireExactDurableIdentifier(
      toolUseId,
      `${ASYNC_TOOL_RESULT_RESOLUTION_REVISION} toolUseId`
    )
  } catch {
    throw new Error(
      `${ASYNC_TOOL_RESULT_RESOLUTION_REVISION}: missing toolUseId`
    )
  }
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(
      `${ASYNC_TOOL_RESULT_RESOLUTION_REVISION}: content must be non-empty`
    )
  }
  if (typeof isError !== "boolean") {
    throw new Error(
      `${ASYNC_TOOL_RESULT_RESOLUTION_REVISION}: isError must be boolean`
    )
  }
  if (!isRecord(structuredContent)) {
    throw new Error(
      `${ASYNC_TOOL_RESULT_RESOLUTION_REVISION}: structuredContent must be an object`
    )
  }
  return {
    toolUseId: exactToolUseId,
    content,
    isError,
    structuredContent: structuredClone(structuredContent),
  }
}

function applyAsyncToolResultResolutionRevision(
  message: SessionMessage,
  revision: Pick<PersistedMessageRevision, "payload">
): SessionMessage {
  if (message.type !== "user" || !Array.isArray(message.message.content)) {
    throw new Error(
      `${ASYNC_TOOL_RESULT_RESOLUTION_REVISION}: target ${message.uuid} is not a user tool_result fragment`
    )
  }
  const replacement = readAsyncToolResultResolutionRevision(revision)
  let found = false
  const content: ContentBlock[] = (
    message.message.content as ContentBlock[]
  ).map((block): ContentBlock => {
    if (
      block.type !== "tool_result" ||
      block.tool_use_id !== replacement.toolUseId
    ) {
      return block
    }
    found = true
    return {
      ...block,
      content: replacement.content,
      is_error: replacement.isError,
      structuredContent: replacement.structuredContent,
    } as ToolResultBlock
  })
  if (!found) {
    throw new Error(
      `${ASYNC_TOOL_RESULT_RESOLUTION_REVISION}: target ${message.uuid} does not contain tool_result ${replacement.toolUseId}`
    )
  }
  return {
    ...message,
    message: {
      ...message.message,
      content,
    },
  }
}

function assertProviderProjectionExclusionRevision(
  revision: Pick<PersistedMessageRevision, "payload">
): void {
  const reason = revision.payload.reason
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error(
      `${PROVIDER_PROJECTION_EXCLUSION_REVISION}: reason is required`
    )
  }
}

/**
 * Replay the typed immutable revisions that affect the active message
 * projection. Unknown kinds intentionally remain owned by their dedicated
 * projectors (for example provider-finalization metadata).
 */
export function applyMessageRevisionProjection(
  message: SessionMessage,
  revisions: readonly Pick<
    PersistedMessageRevision,
    "revisionKind" | "payload"
  >[]
): SessionMessage {
  let projected = message
  for (const revision of revisions) {
    switch (revision.revisionKind) {
      case ASYNC_TOOL_RESULT_RESOLUTION_REVISION:
        projected = applyAsyncToolResultResolutionRevision(projected, revision)
        break
      case TOOL_RESULT_STRUCTURED_CONTENT_REVISION:
        projected = applyToolResultStructuredContentRevision(
          projected,
          revision
        )
        break
      case PROVIDER_PROJECTION_EXCLUSION_REVISION:
        assertProviderProjectionExclusionRevision(revision)
        projected = {
          ...projected,
          excludedFromProviderProjection: true,
        }
        break
      default:
        break
    }
  }
  return projected
}
