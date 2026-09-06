import { CodexApiError } from "./codex-api-error"
import { readCodexResponseOutcome } from "./codex-response-outcome"
import { createAbortPromise } from "../shared/abort-signal"

/** HTTP streaming and aggregation share the same terminal and cleanup contract. */
export async function* readCodexResponseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let buffer = ""
  try {
    for (;;) {
      signal?.throwIfAborted()
      const abort = createAbortPromise(signal, "Codex HTTP stream aborted")
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await Promise.race([
          reader.read(),
          ...(abort.promise ? [abort.promise] : []),
        ])
      } finally {
        abort.cleanup()
      }
      buffer += result.done
        ? `${decoder.decode()}\n\n`
        : decoder.decode(result.value, { stream: true })
      buffer = buffer.replace(/\r\n/g, "\n")
      for (;;) {
        const separator = buffer.indexOf("\n\n")
        if (separator < 0) break
        const raw = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        const data = raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
        if (!data || data.trim() === "[DONE]") continue
        let event: Record<string, unknown>
        try {
          event = JSON.parse(data) as Record<string, unknown>
        } catch {
          throw new CodexApiError(
            502,
            "Codex stream contains invalid JSON",
            undefined,
            "invalid_response"
          )
        }
        if (
          !event ||
          typeof event !== "object" ||
          Array.isArray(event) ||
          typeof event.type !== "string"
        )
          throw new CodexApiError(
            502,
            "Codex stream contains an invalid event",
            undefined,
            "invalid_response"
          )
        const outcome = readCodexResponseOutcome(event, {
          allowMaxOutputIncomplete: true,
        })
        yield event
        if (outcome) return
      }
      if (result.done)
        throw new CodexApiError(
          502,
          "Codex stream closed before a terminal response",
          undefined,
          "stream_closed"
        )
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024)
        throw new CodexApiError(
          502,
          "Codex SSE event exceeds the buffer limit",
          undefined,
          "invalid_response"
        )
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
