/**
 * Decoder for the `v1` delta encoding chatgpt.com streams to its web client.
 *
 * The stream opens with a bare `"v1"` and then carries JSON-Patch-shaped
 * operations against a set of documents:
 *
 *   {"p":"","o":"add","c":0,"v":{message:…}}        open document on channel 0
 *   {"c":1,"v":{message:…}}                         same op, next channel
 *   {"p":"/message/content/parts/0","o":"append","v":"…"}
 *   {"o":"patch","c":0,"v":[{p,o,v},…]}             a batch against one channel
 *
 * `c` selects the document; a missing `p` or `o` inherits the last one used,
 * which is why the decoder has to remember them rather than treat each frame
 * independently. Control frames (`{"type":…}`) are passed through by kind.
 *
 * Only what the bridge needs is reconstructed: assistant text, tool calls, and
 * the end of the turn. Everything else is skipped rather than modelled.
 */

export type ChatGptWebStreamEvent =
  | { readonly kind: "text"; readonly delta: string }
  | { readonly kind: "reasoning"; readonly delta: string }
  | {
      readonly kind: "tool_call"
      readonly tool: string
      readonly payload: string
    }
  | { readonly kind: "done" }

interface Doc {
  message?: {
    author?: { role?: string }
    recipient?: string
    content?: { content_type?: string; parts?: unknown[]; text?: string }
    metadata?: { recipient?: string }
  }
}

export class ChatGptWebV1Decoder {
  private readonly docs = new Map<number, Doc>()
  /** Text already surfaced per channel, so only the new tail is emitted. */
  private readonly emitted = new Map<number, number>()
  private lastPath = ""
  private lastOp = "add"
  private lastChannel = 0
  private buffer = ""

  /** Feed raw SSE text; returns whatever became decodable. */
  push(raw: string): ChatGptWebStreamEvent[] {
    this.buffer += raw
    const lines = this.buffer.split("\n")
    // A trailing fragment may be half a line; keep it for the next push.
    this.buffer = lines.pop() ?? ""
    const events: ChatGptWebStreamEvent[] = []
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      const payload = line.slice(6).trim()
      if (!payload) continue
      if (payload === "[DONE]") {
        events.push({ kind: "done" })
        continue
      }
      let frame: unknown
      try {
        frame = JSON.parse(payload)
      } catch {
        continue
      }
      events.push(...this.applyFrame(frame))
    }
    return events
  }

  private applyFrame(frame: unknown): ChatGptWebStreamEvent[] {
    if (typeof frame === "string") return [] // the "v1" announcement
    if (!isRecord(frame)) return []

    if (typeof frame.type === "string") {
      return frame.type === "message_stream_complete" ? [{ kind: "done" }] : []
    }

    const channel = typeof frame.c === "number" ? frame.c : this.lastChannel
    const op = typeof frame.o === "string" ? frame.o : this.lastOp
    const pointer = typeof frame.p === "string" ? frame.p : this.lastPath
    this.lastChannel = channel
    this.lastOp = op
    this.lastPath = pointer

    if (op === "patch" && Array.isArray(frame.v)) {
      const events: ChatGptWebStreamEvent[] = []
      for (const sub of frame.v) {
        if (!isRecord(sub)) continue
        events.push(
          ...this.applyOne(
            channel,
            typeof sub.p === "string" ? sub.p : "",
            typeof sub.o === "string" ? sub.o : "replace",
            sub.v
          )
        )
      }
      return events
    }
    return this.applyOne(channel, pointer, op, frame.v)
  }

  private applyOne(
    channel: number,
    pointer: string,
    op: string,
    value: unknown
  ): ChatGptWebStreamEvent[] {
    if (op === "add" && pointer === "" && isRecord(value)) {
      this.docs.set(channel, value as Doc)
      this.emitted.set(channel, 0)
      return this.surface(channel)
    }

    const doc = this.docs.get(channel)
    if (!doc) return []

    if (op === "append" && typeof value === "string") {
      appendAtPointer(doc, pointer, value)
      return this.surface(channel)
    }
    if (op === "replace") {
      setAtPointer(doc, pointer, value)
      return this.surface(channel)
    }
    return []
  }

  /** Emit whatever new text this channel's document now holds. */
  private surface(channel: number): ChatGptWebStreamEvent[] {
    const doc = this.docs.get(channel)
    const message = doc?.message
    if (!message) return []

    const role = message.author?.role
    const contentType = message.content?.content_type
    const recipient = message.metadata?.recipient ?? message.recipient

    const parts = message.content?.parts
    const text =
      (Array.isArray(parts) && typeof parts[0] === "string"
        ? parts[0]
        : undefined) ??
      (typeof message.content?.text === "string"
        ? message.content.text
        : undefined)
    if (typeof text !== "string") return []

    const already = this.emitted.get(channel) ?? 0
    if (text.length <= already) return []
    this.emitted.set(channel, text.length)
    const delta = text.slice(already)

    // A message addressed to a tool carries the call itself, not prose.
    if (recipient && recipient !== "all") {
      return [{ kind: "tool_call", tool: recipient, payload: delta }]
    }
    if (role !== "assistant") return []
    if (contentType === "thoughts" || contentType === "reasoning_recap") {
      return [{ kind: "reasoning", delta }]
    }
    if (contentType !== "text") return []
    return [{ kind: "text", delta }]
  }
}

// ── JSON Pointer, only the two operations this stream uses ───────────────

function resolveParent(
  root: unknown,
  pointer: string
): { parent: Record<string, unknown> | unknown[]; key: string } | null {
  const parts = pointer.split("/").filter(Boolean)
  if (parts.length === 0) return null
  let current: unknown = root
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(current)) current = current[Number(part)]
    else if (isRecord(current)) current = current[part]
    else return null
  }
  if (!isRecord(current) && !Array.isArray(current)) return null
  return { parent: current, key: parts[parts.length - 1]! }
}

function appendAtPointer(root: unknown, pointer: string, value: string): void {
  const target = resolveParent(root, pointer)
  if (!target) return
  const { parent, key } = target
  if (Array.isArray(parent)) {
    const index = Number(key)
    const current = parent[index]
    parent[index] = `${typeof current === "string" ? current : ""}${value}`
    return
  }
  const existing = parent[key]
  parent[key] = `${typeof existing === "string" ? existing : ""}${value}`
}

function setAtPointer(root: unknown, pointer: string, value: unknown): void {
  const target = resolveParent(root, pointer)
  if (!target) return
  const { parent, key } = target
  if (Array.isArray(parent)) parent[Number(key)] = value
  else parent[key] = value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
