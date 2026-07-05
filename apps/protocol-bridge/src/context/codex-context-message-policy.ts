import type { UnifiedMessage } from "./types"

function messageContainsToolResult(message: UnifiedMessage): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => block?.type === "tool_result")
}

function isMovableCodexMetaMessage(message: UnifiedMessage): boolean {
  return (
    message.role === "user" &&
    message.isMeta === true &&
    !messageContainsToolResult(message)
  )
}

export function orderCodexMetaMessagesBeforeTranscript(
  messages: UnifiedMessage[]
): UnifiedMessage[] {
  const metaPrefix: UnifiedMessage[] = []
  const transcript: UnifiedMessage[] = []
  let changed = false
  let seenTranscript = false

  for (const message of messages) {
    if (isMovableCodexMetaMessage(message)) {
      metaPrefix.push(message)
      if (seenTranscript) {
        changed = true
      }
      continue
    }

    seenTranscript = true
    transcript.push(message)
  }

  return changed ? [...metaPrefix, ...transcript] : messages
}
