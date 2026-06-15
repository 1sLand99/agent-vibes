/**
 * Streaming recovery for inline antml tool calls.
 *
 * AWS CodeWhisperer / Kiro normally streams Claude tool calls as native
 * `toolUseEvent` frames, which `event-stream.ts` turns into structured
 * `tool_use` blocks. In some states the underlying Claude model instead emits
 * the tool call as plain assistant TEXT in its internal antml syntax:
 *
 *   <function_calls>
 *   <invoke name="Bash">
 *   <parameter name="command">ls -la</parameter>
 *   </invoke>
 *   </function_calls>
 *
 * Without recovery that XML leaks verbatim to the client (Claude Code CLI /
 * Cursor), the tool never runs, and the turn closes as `end_turn`. This parser
 * watches the assistant text stream, extracts any such block, and re-emits it
 * through the same `onToolUse` path the native frames use, so the downstream
 * SSE builder produces a real `tool_use` block and `stop_reason: tool_use`.
 *
 * The parser is per-stream (each `parseKiroEventStream` call constructs its
 * own instance) and holds no shared mutable state, so concurrent streams never
 * interfere. It is intentionally gated by the caller to requests that actually
 * declared tools, so legitimate prose that happens to mention the syntax is
 * never stripped.
 */

import { randomUUID } from "crypto"
import type { KiroToolUse } from "./protocol-types"

const FUNCTION_CALLS_OPEN = "<function_calls>"
const FUNCTION_CALLS_CLOSE = "</function_calls>"
const INVOKE_OPEN = "<invoke"
const INVOKE_CLOSE = "</invoke>"

// Markers whose partial prefixes must be held back across chunk boundaries.
const START_MARKERS: readonly string[] = [FUNCTION_CALLS_OPEN, INVOKE_OPEN]

export interface AntmlParserCallbacks {
  onText: (text: string) => void
  onToolUse: (toolUse: KiroToolUse) => void
}

export class AntmlToolCallParser {
  private buffer = ""
  private emittedToolCall = false

  constructor(private readonly callbacks: AntmlParserCallbacks) {}

  /** True once at least one inline tool call has been recovered. */
  get emittedAnyToolCall(): boolean {
    return this.emittedToolCall
  }

  /** Feed a chunk of decoded assistant text. */
  push(text: string): void {
    if (!text) return
    this.buffer += text
    this.drain(false)
  }

  /** Finalize at stream end: emit complete tool calls and any trailing text. */
  flush(): void {
    this.drain(true)
  }

  private drain(final: boolean): void {
    while (this.buffer.length > 0) {
      const start = this.findToolCallStart()
      if (start < 0) {
        this.emitPlainText(final)
        return
      }
      if (start > 0) {
        this.callbacks.onText(this.buffer.slice(0, start))
        this.buffer = this.buffer.slice(start)
      }
      if (this.consumeCompleteBlock()) {
        continue
      }
      // Buffer head is an incomplete tool-call block.
      if (final) {
        // Emit any invokes that did complete; never re-leak a half-open tag.
        const emitted = this.parseAndEmitInvokes(this.buffer)
        if (!emitted) {
          // No complete invoke — it was not a real tool call after all, so
          // surface the text rather than silently swallowing assistant output.
          this.callbacks.onText(this.buffer)
        }
        this.buffer = ""
      }
      return
    }
  }

  private findToolCallStart(): number {
    let earliest = -1
    for (const marker of START_MARKERS) {
      const idx = this.buffer.indexOf(marker)
      if (idx >= 0 && (earliest < 0 || idx < earliest)) {
        earliest = idx
      }
    }
    return earliest
  }

  /**
   * If the buffer head holds a complete tool-call block, parse and emit it,
   * advance the buffer past it, and return true. Otherwise return false.
   */
  private consumeCompleteBlock(): boolean {
    let closeMarker: string
    if (this.buffer.startsWith(FUNCTION_CALLS_OPEN)) {
      closeMarker = FUNCTION_CALLS_CLOSE
    } else if (this.buffer.startsWith(INVOKE_OPEN)) {
      closeMarker = INVOKE_CLOSE
    } else {
      return false
    }

    const closeIdx = this.buffer.indexOf(closeMarker)
    if (closeIdx < 0) {
      return false
    }
    const end = closeIdx + closeMarker.length
    const block = this.buffer.slice(0, end)
    this.parseAndEmitInvokes(block)
    this.buffer = this.buffer.slice(end)
    return true
  }

  /**
   * Emit buffered text that is definitely not part of a tool-call marker.
   * Unless finalizing, hold back a trailing substring that could be the start
   * of a marker continuing in the next chunk.
   */
  private emitPlainText(final: boolean): void {
    if (this.buffer.length === 0) return
    if (final) {
      this.callbacks.onText(this.buffer)
      this.buffer = ""
      return
    }
    const hold = this.partialStartMarkerSuffixLength()
    if (hold >= this.buffer.length) {
      // Entire buffer is a partial marker; wait for more input.
      return
    }
    if (hold > 0) {
      this.callbacks.onText(this.buffer.slice(0, this.buffer.length - hold))
      this.buffer = this.buffer.slice(this.buffer.length - hold)
      return
    }
    this.callbacks.onText(this.buffer)
    this.buffer = ""
  }

  /**
   * Length of the trailing buffer suffix that is a non-empty proper prefix of
   * a start marker (e.g. "<", "<inv", "<function_cal"). Such a suffix may be
   * completed by the next chunk and must not be emitted as text yet.
   */
  private partialStartMarkerSuffixLength(): number {
    const lastLt = this.buffer.lastIndexOf("<")
    if (lastLt < 0) return 0
    const suffix = this.buffer.slice(lastLt)
    for (const marker of START_MARKERS) {
      if (marker.length > suffix.length && marker.startsWith(suffix)) {
        return suffix.length
      }
    }
    return 0
  }

  private parseAndEmitInvokes(block: string): boolean {
    // Regex is constructed per call so the parser holds no shared lastIndex
    // state across concurrent streams.
    const invokeRe = /<invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/invoke>/g
    let match: RegExpExecArray | null
    let emittedAny = false
    while ((match = invokeRe.exec(block)) !== null) {
      const name = (match[1] || "").trim()
      if (!name) continue
      const input = this.parseParameters(match[2] || "")
      this.callbacks.onToolUse({
        toolUseId: `toolu_${randomUUID().replace(/-/g, "")}`,
        name,
        input,
      })
      this.emittedToolCall = true
      emittedAny = true
    }
    return emittedAny
  }

  private parseParameters(inner: string): Record<string, unknown> {
    const paramRe =
      /<parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/parameter>/g
    const input: Record<string, unknown> = {}
    let match: RegExpExecArray | null
    while ((match = paramRe.exec(inner)) !== null) {
      const key = (match[1] || "").trim()
      if (!key) continue
      input[key] = coerceParameterValue(match[2] ?? "")
    }
    return input
  }
}

/**
 * Coerce an antml parameter's raw text value to a typed value. Claude emits
 * scalar values as bare text and structured values as JSON. Strings (including
 * multi-line shell commands) are kept verbatim; only unambiguous booleans,
 * null, finite numbers, and JSON object/array literals are converted.
 */
export function coerceParameterValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === "") return raw
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (trimmed === "null") return null
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    const num = Number(trimmed)
    if (Number.isFinite(num)) return num
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Not valid JSON — fall through and keep the raw string.
    }
  }
  return raw
}
