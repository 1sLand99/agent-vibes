export interface CursorSseContentBlock {
  type: "text" | "tool_use" | "thinking"
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  thinking?: string
  signature?: string
}

export interface CursorSseDelta {
  type: "text_delta" | "input_json_delta" | "thinking_delta" | "signature_delta"
  text?: string
  partial_json?: string
  thinking?: string
  signature?: string
}

export interface CursorSseEventData {
  content_block?: CursorSseContentBlock
  delta?: CursorSseDelta
  message?: {
    id?: string
    [key: string]: unknown
  }
  index?: number
  usage?: {
    input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    output_tokens?: number
  }
}

export interface CursorSseEvent {
  type: string
  data: CursorSseEventData
}

export function parseCursorSseEvent(
  sseEvent: string,
  onError?: (message: string) => void
): CursorSseEvent | null {
  try {
    const lines = sseEvent.split("\n")
    let eventType = ""
    let eventData = ""

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.substring(7).trim()
      } else if (line.startsWith("data: ")) {
        eventData = line.substring(6).trim()
      }
    }

    if (!eventType || !eventData) {
      return null
    }

    return {
      type: eventType,
      data: JSON.parse(eventData) as CursorSseEventData,
    }
  } catch (error) {
    onError?.(`Failed to parse SSE event: ${String(error)}`)
    return null
  }
}
