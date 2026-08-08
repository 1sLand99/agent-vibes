import type { ContentBlock, ImageBlock } from "../../../context/types"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import type { UserMessage, UserMessageAction } from "../../../gen/agent/v1_pb"
import type {
  CursorConversationEntry,
  CursorConversationStateProjection,
  CursorProtocolReferenceResolver,
  CursorRequestWireState,
} from "../codec/cursor-conversation-codec"
import type { CursorWireFrameRef } from "../tools/cursor-request-parser"
import { renderCursorHookAdditionalContext } from "../hooks/cursor-hook-contract"
import { getEffectiveCursorUserMessageAction } from "../tools/subscription-notification-action"

type CursorHistoryEntry = Extract<
  CursorConversationEntry,
  { source: "user_message_action_history" }
>

export interface CursorHistoryMessageMetadata extends Record<string, unknown> {
  source: "cursor_conversation_history"
  messageIndex: number
  tool?: {
    toolCallId: string
    toolName: string
    isError?: boolean
    hookAdditionalContexts: Array<{
      hookEventName: string
      content: string
    }>
  }
}

export interface CursorHistoryProjectedMessage {
  role: "user" | "assistant"
  content: ContentBlock[]
  metadata: CursorHistoryMessageMetadata
}

/**
 * Typed provenance for user messages carried by the current
 * `UserMessageAction`. It deliberately keeps only protocol facts that belong
 * in the durable graph; byte-exact frames and blobs stay in CursorWireStore.
 */
export interface CursorUserMessageActionMetadata extends Record<
  string,
  unknown
> {
  source: "cursor_user_message_action"
  placement: "prepend" | "current"
  /** Present only for `prepend_user_messages`, preserving its array order. */
  prependIndex?: number
  /** Cursor's own user-message identifier, when the client supplied one. */
  messageId?: string
  hookAdditionalContexts: Array<{
    hookEventName: string
    content: string
  }>
  cursorWireFrame: CursorWireFrameRef
}

export interface CursorUserMessageActionProjectedMessage {
  role: "user"
  content: ContentBlock[]
  metadata: CursorUserMessageActionMetadata
}

export interface CursorFreshHistoryProjectedMessage extends Omit<
  CursorHistoryProjectedMessage,
  "metadata"
> {
  metadata: CursorHistoryMessageMetadata & {
    cursorWireFrame: CursorWireFrameRef
  }
}

export interface CursorHistoryProjection {
  messages: CursorHistoryProjectedMessage[]
  /** Tool calls that were emitted but have no terminal history message yet. */
  openToolCallIds: string[]
}

/**
 * Complete first-graph projection for prior Cursor history. The current
 * UserMessageAction fields are intentionally excluded: they are accepted only
 * after the bridge opens the real runtime turn for that action.
 */
export interface CursorFreshHistoryBootstrapInput {
  history: readonly CursorConversationEntry[]
  conversationState?: CursorConversationStateProjection
  wireFrameRef: CursorWireFrameRef
}

export interface CursorFreshHistoryBootstrapProjection {
  messages: CursorFreshHistoryProjectedMessage[]
  /** Tool calls that were emitted by prior history but remain open. */
  openToolCallIds: string[]
}

export interface CursorUserMessageActionProjection {
  messages: CursorUserMessageActionProjectedMessage[]
}

export class CursorHistoryProjectionError extends Error {
  constructor(message: string) {
    super(`Cursor conversation_history projection failed: ${message}`)
    this.name = "CursorHistoryProjectionError"
  }
}

/**
 * Select the official user action from either Cursor transport envelope.
 * Callers must never reconstruct it from a text-only conversation mirror.
 */
export function getCursorUserMessageAction(
  wire:
    | Pick<CursorRequestWireState, "agentRunRequest" | "clientMessage">
    | undefined
): UserMessageAction | undefined {
  const runAction = wire?.agentRunRequest?.action?.action
  const runUserAction = getEffectiveCursorUserMessageAction(runAction)
  if (runUserAction) {
    return runUserAction
  }

  const clientMessage = wire?.clientMessage.message
  if (clientMessage?.case !== "conversationAction") return undefined
  return getEffectiveCursorUserMessageAction(clientMessage.value.action)
}

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set<ImageBlock["source"]["media_type"]>(
  ["image/jpeg", "image/png", "image/gif", "image/webp"]
)

function projectImage(data: string, mimeType: string | undefined): ImageBlock {
  if (
    !mimeType ||
    !SUPPORTED_IMAGE_MEDIA_TYPES.has(
      mimeType as ImageBlock["source"]["media_type"]
    )
  ) {
    throw new CursorHistoryProjectionError(
      `unsupported or missing image MIME type ${JSON.stringify(mimeType)}`
    )
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mimeType as ImageBlock["source"]["media_type"],
      data,
    },
  }
}

function hasBytes(value: Uint8Array | undefined): boolean {
  return !!value && value.length > 0
}

/**
 * Cursor's `text_blob_id` points at an alternate transport body for the
 * ordinary UTF-8 `UserMessage.text` field. Decode that body exactly once from
 * the conversation-bound resolver. There is intentionally no JSON/rich-text
 * discovery or lossy decoder fallback here.
 */
function decodeTextBlob(
  blobId: Uint8Array,
  resolver: CursorProtocolReferenceResolver | undefined,
  placement: "prepend" | "current"
): string {
  const bytes = resolver?.resolveBlob(blobId)
  if (!bytes) {
    throw new CursorHistoryProjectionError(
      `${placement} user message text_blob_id could not be resolved in its conversation`
    )
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new CursorHistoryProjectionError(
      `${placement} user message text_blob_id is not valid UTF-8: ${(error as Error).message}`
    )
  }
}

function projectSelectedImage(
  userMessage: UserMessage,
  imageIndex: number,
  resolver: CursorProtocolReferenceResolver | undefined
): ImageBlock {
  const image = userMessage.selectedContext?.selectedImages[imageIndex]
  if (!image) {
    throw new CursorHistoryProjectionError(
      `user message selected image ${imageIndex} is missing`
    )
  }

  let bytes: Uint8Array | undefined
  switch (image.dataOrBlobId.case) {
    case "data":
      bytes = image.dataOrBlobId.value
      break
    case "blobIdWithData":
      bytes = image.dataOrBlobId.value.data
      break
    case "blobId":
      bytes = resolver?.resolveBlob(image.dataOrBlobId.value)
      break
    case undefined:
      throw new CursorHistoryProjectionError(
        `user message selected image ${imageIndex} has no data or blob reference`
      )
  }

  if (!bytes || bytes.length === 0) {
    throw new CursorHistoryProjectionError(
      `user message selected image ${imageIndex} could not be resolved exactly`
    )
  }

  return projectImage(Buffer.from(bytes).toString("base64"), image.mimeType)
}

function projectUserMessageActionMessage(
  userMessage: UserMessage | undefined,
  placement: "prepend" | "current",
  prependIndex: number | undefined,
  resolver: CursorProtocolReferenceResolver | undefined,
  wireFrameRef: CursorWireFrameRef
): CursorUserMessageActionProjectedMessage {
  if (!userMessage) {
    throw new CursorHistoryProjectionError(
      `${placement} user message is missing`
    )
  }

  const textBlobId = userMessage.textBlobId
  const hasTextBlob = hasBytes(textBlobId)
  if (hasTextBlob && userMessage.text.length > 0) {
    throw new CursorHistoryProjectionError(
      `${placement} user message carries both text and text_blob_id`
    )
  }

  const content: ContentBlock[] = []
  // Cursor places beforeSubmitPrompt hook context before the visible user
  // query and renders each carrier as an escaped system reminder.
  for (const context of userMessage.hookAdditionalContexts) {
    const rendered = renderCursorHookAdditionalContext(context.content)
    if (rendered) {
      content.push({ type: "text", text: rendered })
    }
  }
  const text = hasTextBlob
    ? decodeTextBlob(textBlobId!, resolver, placement)
    : userMessage.text
  if (text.length > 0) {
    content.push({ type: "text", text })
  }
  for (
    let imageIndex = 0;
    imageIndex < (userMessage.selectedContext?.selectedImages.length ?? 0);
    imageIndex++
  ) {
    content.push(projectSelectedImage(userMessage, imageIndex, resolver))
  }
  if (
    content.length === 0 &&
    ((userMessage.richText && userMessage.richText.length > 0) ||
      hasBytes(userMessage.richTextBlobId))
  ) {
    throw new CursorHistoryProjectionError(
      `${placement} user message has only rich_text or rich_text_blob_id without a typed model body`
    )
  }
  if (content.length === 0) {
    throw new CursorHistoryProjectionError(
      `${placement} user message has no projectable text or image content`
    )
  }

  return {
    role: "user",
    content,
    metadata: {
      source: "cursor_user_message_action",
      placement,
      ...(prependIndex !== undefined ? { prependIndex } : {}),
      ...(userMessage.messageId ? { messageId: userMessage.messageId } : {}),
      hookAdditionalContexts: userMessage.hookAdditionalContexts.map(
        (context) => ({
          hookEventName: context.hookEventName,
          content: context.content,
        })
      ),
      cursorWireFrame: { ...wireFrameRef },
    },
  }
}

/**
 * Cursor builds `prepend_user_messages` for every action, not only the first
 * one. Preserve that field order and never coalesce messages by visible text.
 */
export function projectCursorUserMessageAction(input: {
  action: UserMessageAction
  resolver?: CursorProtocolReferenceResolver
  wireFrameRef: CursorWireFrameRef
}): CursorUserMessageActionProjection {
  const messages: CursorUserMessageActionProjectedMessage[] = []
  for (
    let prependIndex = 0;
    prependIndex < input.action.prependUserMessages.length;
    prependIndex++
  ) {
    messages.push(
      projectUserMessageActionMessage(
        input.action.prependUserMessages[prependIndex],
        "prepend",
        prependIndex,
        input.resolver,
        input.wireFrameRef
      )
    )
  }
  messages.push(
    projectUserMessageActionMessage(
      input.action.userMessage,
      "current",
      undefined,
      input.resolver,
      input.wireFrameRef
    )
  )
  return { messages }
}

function assertFreshConversationStateIsEmpty(
  conversationState: CursorConversationStateProjection | undefined
): void {
  if (!conversationState) return
  if (
    conversationState.state.turns.length === 0 &&
    conversationState.entries.length === 0
  ) {
    return
  }
  throw new CursorHistoryProjectionError(
    "fresh session received a non-empty conversation_state without typed conversation_history"
  )
}

function parseToolArguments(
  argsJson: string,
  toolCallId: string
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch (error) {
    throw new CursorHistoryProjectionError(
      `tool call ${toolCallId} has invalid args_json: ${(error as Error).message}`
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CursorHistoryProjectionError(
      `tool call ${toolCallId} args_json must encode an object`
    )
  }
  return parsed as Record<string, unknown>
}

function requireToolIdentity(
  toolCallId: string,
  toolName: string,
  messageIndex: number
): { toolCallId: string; toolName: string } {
  try {
    return {
      toolCallId: requireExactDurableIdentifier(
        toolCallId,
        `message ${messageIndex} tool_call_id`
      ),
      toolName: requireExactDurableIdentifier(
        toolName,
        `message ${messageIndex} tool_name`
      ),
    }
  } catch (error) {
    throw new CursorHistoryProjectionError(
      `message ${messageIndex} has an invalid tool identity: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

function assertContentOrder(
  entries: readonly CursorHistoryEntry[],
  messageIndex: number
): void {
  let previousIndex = -1
  for (const entry of entries) {
    if (!("contentIndex" in entry)) continue
    if (entry.contentIndex <= previousIndex) {
      throw new CursorHistoryProjectionError(
        `message ${messageIndex} content indexes are not strictly ordered`
      )
    }
    previousIndex = entry.contentIndex
  }
}

/**
 * Convert Cursor's typed `UserMessageAction.conversation_history` into the
 * provider-neutral session graph without flattening content or inventing a
 * repair. Unknown cases and malformed tool edges fail closed; the exact wire
 * frame remains available in CursorWireStore for diagnosis/replay.
 */
export function projectCursorConversationHistory(
  entries: readonly CursorConversationEntry[]
): CursorHistoryProjection {
  const historyEntries: CursorHistoryEntry[] = []
  for (const entry of entries) {
    if (entry.source !== "user_message_action_history") {
      throw new CursorHistoryProjectionError(
        `received non-history entry ${entry.kind}`
      )
    }
    historyEntries.push(entry)
  }

  const groups: CursorHistoryEntry[][] = []
  for (const entry of historyEntries) {
    const previous = groups[groups.length - 1]
    if (!previous || previous[0]!.messageIndex !== entry.messageIndex) {
      if (previous && entry.messageIndex <= previous[0]!.messageIndex) {
        throw new CursorHistoryProjectionError(
          "message indexes are not strictly ordered"
        )
      }
      groups.push([entry])
    } else {
      previous.push(entry)
    }
  }

  const messages: CursorHistoryProjectedMessage[] = []
  const openToolCalls = new Map<string, string>()
  const seenToolCallIds = new Set<string>()

  for (const group of groups) {
    const first = group[0]!
    const messageIndex = first.messageIndex
    if (
      group.some(
        (entry) => entry.message.message.case !== first.message.message.case
      )
    ) {
      throw new CursorHistoryProjectionError(
        `message ${messageIndex} contains mixed protobuf message cases`
      )
    }
    if (group.some((entry) => entry.kind === "opaque_history_message")) {
      throw new CursorHistoryProjectionError(
        `message ${messageIndex} contains an unsupported opaque content case`
      )
    }

    const metadata: CursorHistoryMessageMetadata = {
      source: "cursor_conversation_history",
      messageIndex,
    }

    if (first.message.message.case === "user") {
      assertContentOrder(group, messageIndex)
      const content: ContentBlock[] = group.map((entry) => {
        if (entry.kind === "history_user_text") {
          return { type: "text", text: entry.text }
        }
        if (entry.kind === "history_user_image") {
          return projectImage(entry.data, entry.mimeType)
        }
        throw new CursorHistoryProjectionError(
          `message ${messageIndex} contains ${entry.kind} in a user envelope`
        )
      })
      messages.push({ role: "user", content, metadata })
      continue
    }

    if (first.message.message.case === "assistant") {
      assertContentOrder(group, messageIndex)
      const content: ContentBlock[] = group.map((entry) => {
        if (entry.kind === "history_assistant_text") {
          return { type: "text", text: entry.text }
        }
        if (entry.kind === "history_assistant_reasoning") {
          return {
            type: "thinking",
            thinking: entry.text,
            ...(entry.signature ? { signature: entry.signature } : {}),
          }
        }
        if (entry.kind === "history_assistant_redacted_reasoning") {
          return { type: "redacted_thinking", data: entry.data }
        }
        if (entry.kind === "history_assistant_tool_call") {
          const { toolCallId, toolName } = requireToolIdentity(
            entry.toolCallId,
            entry.toolName,
            messageIndex
          )
          if (seenToolCallIds.has(toolCallId)) {
            throw new CursorHistoryProjectionError(
              `tool_call_id ${toolCallId} is duplicated`
            )
          }
          seenToolCallIds.add(toolCallId)
          openToolCalls.set(toolCallId, toolName)
          return {
            type: "tool_use",
            id: toolCallId,
            name: toolName,
            input: parseToolArguments(entry.argsJson, toolCallId),
          }
        }
        throw new CursorHistoryProjectionError(
          `message ${messageIndex} contains ${entry.kind} in an assistant envelope`
        )
      })
      messages.push({ role: "assistant", content, metadata })
      continue
    }

    if (first.message.message.case === "tool") {
      if (group.length !== 1 || first.kind !== "history_tool_result") {
        throw new CursorHistoryProjectionError(
          `tool message ${messageIndex} did not decode to one exact result`
        )
      }
      const { toolCallId, toolName } = requireToolIdentity(
        first.toolCallId,
        first.toolName,
        messageIndex
      )
      const originalToolName = openToolCalls.get(toolCallId)
      if (!originalToolName) {
        throw new CursorHistoryProjectionError(
          `tool result ${toolCallId} has no preceding open tool call`
        )
      }
      if (originalToolName !== toolName) {
        throw new CursorHistoryProjectionError(
          `tool result ${toolCallId} tool_name does not match its preceding tool call`
        )
      }
      const resultContent: ContentBlock[] = first.content.map((item) => {
        if (item.kind === "text") {
          return { type: "text", text: item.text }
        }
        if (item.kind === "image") {
          return projectImage(item.data, item.mimeType)
        }
        throw new CursorHistoryProjectionError(
          `tool result ${toolCallId} contains an unknown content case`
        )
      })
      for (const context of first.hookAdditionalContexts) {
        const rendered = renderCursorHookAdditionalContext(context.content)
        if (rendered) {
          resultContent.push({ type: "text", text: rendered })
        }
      }
      openToolCalls.delete(toolCallId)
      metadata.tool = {
        toolCallId,
        toolName,
        ...(first.isError !== undefined ? { isError: first.isError } : {}),
        hookAdditionalContexts: first.hookAdditionalContexts.map((context) => ({
          hookEventName: context.hookEventName,
          content: context.content,
        })),
      }
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: resultContent,
            ...(first.isError !== undefined ? { is_error: first.isError } : {}),
          },
        ],
        metadata,
      })
      continue
    }

    throw new CursorHistoryProjectionError(
      `message ${messageIndex} has no recognized protobuf message case`
    )
  }

  return { messages, openToolCallIds: [...openToolCalls.keys()] }
}

/**
 * Project the authoritative prior history into a fresh graph seed. Incoming
 * action fields are deliberately left for the real turn append path, so no
 * imported fragment receives an invented runtime turn id.
 */
export function projectCursorFreshHistoryBootstrap(
  input: CursorFreshHistoryBootstrapInput
): CursorFreshHistoryBootstrapProjection {
  if (input.history.length === 0) {
    assertFreshConversationStateIsEmpty(input.conversationState)
  }

  const projectedHistory = projectCursorConversationHistory(input.history)
  return {
    messages: projectedHistory.messages.map((message) => ({
      ...message,
      metadata: {
        ...message.metadata,
        cursorWireFrame: { ...input.wireFrameRef },
      },
    })),
    openToolCallIds: projectedHistory.openToolCallIds,
  }
}
