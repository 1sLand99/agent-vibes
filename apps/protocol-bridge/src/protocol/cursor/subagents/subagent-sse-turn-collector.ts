export interface SubAgentSseToolCall {
  id: string
  name: string
  inputJson: string
}

export interface SubAgentSseTurnResult {
  fullText: string
  toolCalls: SubAgentSseToolCall[]
}

export interface SubAgentSseEvent {
  type: string
  data: {
    content_block?: {
      type?: string
      id?: string
      name?: string
    }
    delta?: {
      type?: string
      text?: string
      thinking?: string
      partial_json?: string
    }
  }
}

export interface SubAgentSseTurnUpdate {
  textDelta?: string
  thinkingDelta?: string
  completedToolCall?: SubAgentSseToolCall
}

export class SubAgentSseTurnCollector {
  private fullText = ""
  private readonly toolCalls: SubAgentSseToolCall[] = []
  private currentToolCall: SubAgentSseToolCall | null = null

  apply(event: SubAgentSseEvent): SubAgentSseTurnUpdate {
    if (event.type === "content_block_start") {
      const block = event.data.content_block
      if (block?.type === "tool_use" && block.id && block.name) {
        this.currentToolCall = {
          id: block.id,
          name: block.name,
          inputJson: "",
        }
      }
      return {}
    }

    if (event.type === "content_block_delta") {
      const delta = event.data.delta
      if (delta?.type === "text_delta" && delta.text) {
        this.fullText += delta.text
        return { textDelta: delta.text }
      }
      if (delta?.type === "thinking_delta" && delta.thinking) {
        return { thinkingDelta: delta.thinking }
      }
      if (delta?.type === "input_json_delta" && this.currentToolCall) {
        this.currentToolCall.inputJson += delta.partial_json || ""
      }
      return {}
    }

    if (event.type === "content_block_stop" && this.currentToolCall) {
      const completedToolCall = this.currentToolCall
      this.toolCalls.push(completedToolCall)
      this.currentToolCall = null
      return { completedToolCall }
    }

    return {}
  }

  result(): SubAgentSseTurnResult {
    return {
      fullText: this.fullText,
      toolCalls: [...this.toolCalls],
    }
  }
}
