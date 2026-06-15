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

// Kiro / CodeWhisperer delivers Claude tool calls with the `<function_calls>`
// wrapper token degraded to the bare word "call" (verified from live request
// history: assistant turns arrive as `…\n\ncall\n<invoke name="Bash">…`). The
// inner `<invoke>` survives and is recovered normally; this matches the
// leftover wrapper word so it is not emitted as visible assistant text. Only a
// standalone token at a word boundary is matched, so prose like "recall" or
// "please call me" is never touched.
const MANGLED_WRAPPER_REMNANT = /(^|\s)(?:function_calls|call)\s*$/i

// Word forms the mangled `<function_calls>` wrapper can take. A trailing
// (possibly partial) occurrence at a word boundary is held back during
// streaming until we know whether an `<invoke>` follows.
const WRAPPER_WORDS: readonly string[] = ["function_calls", "call"]

/**
 * Length of the trailing run of word characters in `s` when that run sits at a
 * word boundary and is a prefix of a wrapper word (e.g. "c", "cal", "call",
 * "function_cal"). Returns 0 otherwise, so ordinary words are not held.
 */
function trailingWrapperWordLength(s: string): number {
  const match = s.match(/[A-Za-z_]+$/)
  if (!match) return 0
  const run = match[0]
  const startIdx = s.length - run.length
  if (startIdx > 0 && !/\s/.test(s[startIdx - 1]!)) return 0
  const lower = run.toLowerCase()
  return WRAPPER_WORDS.some((word) => word.startsWith(lower)) ? run.length : 0
}

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
        let preamble = this.buffer.slice(0, start)
        // A bare `<invoke>` (no surviving `<function_calls>` wrapper) means the
        // wrapper was mangled to the word "call"; strip that trailing remnant
        // so it never shows as assistant text. A real `<function_calls>` start
        // is left untouched.
        if (this.buffer.startsWith(INVOKE_OPEN, start)) {
          preamble = preamble.replace(MANGLED_WRAPPER_REMNANT, "$1")
        }
        if (preamble.length > 0) {
          this.callbacks.onText(preamble)
        }
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
    const hold = this.computeHoldbackLength()
    if (hold >= this.buffer.length) {
      // Entire buffer is held (partial marker / pending wrapper word); wait.
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
   * Number of trailing characters to withhold from plain-text emission until
   * more input arrives. Combines two cases that may complete in the next
   * chunk: (1) a partial start marker (e.g. "<", "<inv"), and (2) a standalone
   * wrapper word ("call" / "function_calls") that may be the mangled
   * `<function_calls>` opening immediately preceding an `<invoke>`. Holding the
   * wrapper word lets `drain` strip it once the `<invoke>` arrives; if plain
   * text follows instead, it is released verbatim on the next pass.
   */
  private computeHoldbackLength(): number {
    const buf = this.buffer
    const partial = this.partialStartMarkerSuffixLength()
    // Skip whitespace between a pending wrapper word and a partial start
    // marker (e.g. the "\n" in "call\n<inv").
    let boundary = buf.length - partial
    while (boundary > 0 && /\s/.test(buf[boundary - 1]!)) {
      boundary--
    }
    const wrapperLen = trailingWrapperWordLength(buf.slice(0, boundary))
    if (wrapperLen > 0) {
      // Hold the wrapper word plus any whitespace and the partial marker after
      // it, so `drain` can strip the whole remnant once `<invoke>` arrives.
      return buf.length - (boundary - wrapperLen)
    }
    return partial
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
