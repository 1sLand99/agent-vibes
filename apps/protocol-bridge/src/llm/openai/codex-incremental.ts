import type { CodexInputItem } from "./codex-native-types"
import { isCodexApiVisibleInputItem } from "./codex-response-items"

export interface CodexLastResponseSnapshot {
  responseId: string
  itemsAdded: CodexInputItem[]
}

export type CodexIncrementalInputResult =
  | { ok: true; input: CodexInputItem[] }
  | {
      ok: false
      reason: "static_fields_changed"
      changedStaticKeys: string[]
    }
  | {
      ok: false
      reason: "input_not_extension"
      inputMismatch: CodexInputMismatch
    }

export interface CodexInputMismatch {
  baselineLength: number
  requestLength: number
  mismatchIndex?: number
  baselineType?: string
  requestType?: string
}

export interface CodexContinuationState {
  lastResponse?: CodexLastResponseSnapshot
  lastRequest?: Record<string, unknown>
}

export type CodexContinuationDecision =
  | {
      mode: "full"
      reason: "no_baseline"
      request: Record<string, unknown>
      nextState: CodexContinuationState
    }
  | {
      mode: "incremental"
      request: Record<string, unknown>
      previousResponseId: string
      incrementalItemCount: number
      nextState: CodexContinuationState
    }
  | {
      mode: "full_reset"
      reason: "static_fields_changed"
      changedStaticKeys: string[]
      request: Record<string, unknown>
      nextState: CodexContinuationState
    }
  | {
      mode: "full_reset"
      reason: "input_not_extension"
      inputMismatch: CodexInputMismatch
      request: Record<string, unknown>
      nextState: CodexContinuationState
    }

const TRANSPORT_ONLY_REQUEST_FIELDS = new Set([
  "input",
  "previous_response_id",
  "generate",
  // Official Codex sends WebSocket client metadata separately from the
  // semantic ResponsesApiRequest compared by get_incremental_items().
  "client_metadata",
])

export function stripCodexRequestForIncrementalCompare(
  request: Record<string, unknown>
): Record<string, unknown> {
  const stripped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(request)) {
    if (TRANSPORT_ONLY_REQUEST_FIELDS.has(key)) {
      continue
    }
    stripped[key] = value
  }
  return stripped
}

export function stableCodexJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

export function codexRequestIncrementalSignature(
  request: Record<string, unknown>
): string {
  return stableCodexJsonStringify(
    stripCodexRequestForIncrementalCompare(request)
  )
}

export function getCodexIncrementalInput(
  request: Record<string, unknown>,
  previousRequest: Record<string, unknown>,
  lastResponse: CodexLastResponseSnapshot,
  allowEmptyDelta: boolean
): CodexIncrementalInputResult {
  const changedStaticKeys = diffCodexStaticRequestKeys(request, previousRequest)
  if (changedStaticKeys.length > 0) {
    return {
      ok: false,
      reason: "static_fields_changed",
      changedStaticKeys,
    }
  }

  const previousInput = canonicalizeCodexInputItemsForContinuation(
    getCodexInputItems(previousRequest)
  )
  const requestInput = canonicalizeCodexInputItemsForContinuation(
    getCodexInputItems(request)
  )
  const responseInput = canonicalizeCodexInputItemsForContinuation(
    lastResponse.itemsAdded
  )
  const baseline = [...previousInput, ...responseInput]
  if (
    requestInput.length < baseline.length ||
    (!allowEmptyDelta && requestInput.length === baseline.length)
  ) {
    return {
      ok: false,
      reason: "input_not_extension",
      inputMismatch: {
        baselineLength: baseline.length,
        requestLength: requestInput.length,
      },
    }
  }

  for (let index = 0; index < baseline.length; index++) {
    if (
      stableCodexJsonStringify(requestInput[index]) !==
      stableCodexJsonStringify(baseline[index])
    ) {
      return {
        ok: false,
        reason: "input_not_extension",
        inputMismatch: {
          baselineLength: baseline.length,
          requestLength: requestInput.length,
          mismatchIndex: index,
          baselineType: getCodexInputItemType(baseline[index]),
          requestType: getCodexInputItemType(requestInput[index]),
        },
      }
    }
  }

  return { ok: true, input: requestInput.slice(baseline.length) }
}

/**
 * Codex continuation state is compared against the semantic Responses API
 * input stream, not the raw websocket event stream. The request builder never
 * emits empty text messages, so empty upstream `message` output items must not
 * become part of the continuation baseline.
 */
export function canonicalizeCodexInputItemsForContinuation(
  items: CodexInputItem[]
): CodexInputItem[] {
  const result: CodexInputItem[] = []
  for (const item of items) {
    const canonical = canonicalizeCodexInputItemForContinuation(item)
    if (canonical) {
      result.push(canonical)
    }
  }
  return result
}

export function prepareCodexContinuationRequest(
  request: Record<string, unknown>,
  state: CodexContinuationState,
  allowEmptyDelta: boolean
): CodexContinuationDecision {
  const lastResponse = state.lastResponse
  const lastRequest = state.lastRequest
  if (!lastResponse?.responseId || !lastRequest) {
    return {
      mode: "full",
      reason: "no_baseline",
      request,
      nextState: {
        lastRequest: request,
        lastResponse: undefined,
      },
    }
  }

  const result = getCodexIncrementalInput(
    request,
    lastRequest,
    lastResponse,
    allowEmptyDelta
  )
  if (!result.ok) {
    if (result.reason === "static_fields_changed") {
      return {
        mode: "full_reset",
        reason: "static_fields_changed",
        changedStaticKeys: result.changedStaticKeys,
        request,
        nextState: {
          lastRequest: request,
          lastResponse: undefined,
        },
      }
    }

    return {
      mode: "full_reset",
      reason: "input_not_extension",
      inputMismatch: result.inputMismatch,
      request,
      nextState: {
        lastRequest: request,
        lastResponse: undefined,
      },
    }
  }

  return {
    mode: "incremental",
    request: {
      ...request,
      input: result.input,
      previous_response_id: lastResponse.responseId,
    },
    previousResponseId: lastResponse.responseId,
    incrementalItemCount: result.input.length,
    nextState: {
      lastRequest: request,
      lastResponse,
    },
  }
}

function diffCodexStaticRequestKeys(
  request: Record<string, unknown>,
  previousRequest: Record<string, unknown>
): string[] {
  const current = stripCodexRequestForIncrementalCompare(request)
  const previous = stripCodexRequestForIncrementalCompare(previousRequest)
  const keys = new Set([...Object.keys(current), ...Object.keys(previous)])
  const changed: string[] = []
  for (const key of [...keys].sort()) {
    if (
      stableCodexJsonStringify(current[key]) !==
      stableCodexJsonStringify(previous[key])
    ) {
      changed.push(key)
    }
  }
  return changed
}

function getCodexInputItemType(item: CodexInputItem | undefined): string {
  const type =
    item && typeof (item as { type?: unknown }).type === "string"
      ? ((item as { type: string }).type || "").trim()
      : ""
  return type || "unknown"
}

function getCodexInputItems(
  request: Record<string, unknown>
): CodexInputItem[] {
  return Array.isArray(request.input) ? (request.input as CodexInputItem[]) : []
}

function canonicalizeCodexInputItemForContinuation(
  item: CodexInputItem | undefined
): CodexInputItem | undefined {
  if (!item) return undefined
  const type = (item as { type?: unknown }).type

  if (type === "message") {
    const message = item as Extract<CodexInputItem, { type: "message" }>
    const role = typeof message.role === "string" ? message.role : "assistant"
    if (role === "system") {
      return undefined
    }
    const content = canonicalizeCodexContentArray(message.content)
    if (content.length === 0) {
      return undefined
    }
    return stripCodexContinuationMetadata({
      ...message,
      role,
      content,
    })
  }

  if (type === "function_call") {
    const call = item as Extract<CodexInputItem, { type: "function_call" }>
    return stripCodexContinuationMetadata({
      ...call,
      call_id: typeof call.call_id === "string" ? call.call_id : "",
      name: typeof call.name === "string" ? call.name : "",
      arguments:
        typeof call.arguments === "string"
          ? call.arguments
          : JSON.stringify(
              (call as unknown as Record<string, unknown>).arguments ?? {}
            ),
    })
  }

  if (type === "custom_tool_call") {
    const call = item as Extract<CodexInputItem, { type: "custom_tool_call" }>
    return stripCodexContinuationMetadata({
      ...call,
      call_id: typeof call.call_id === "string" ? call.call_id : "",
      name: typeof call.name === "string" ? call.name : "",
      input:
        typeof call.input === "string"
          ? call.input
          : JSON.stringify(
              (call as unknown as Record<string, unknown>).input ?? ""
            ),
    })
  }

  if (type === "function_call_output") {
    const output = item as Extract<
      CodexInputItem,
      { type: "function_call_output" }
    >
    const outputParts = Array.isArray(output.output)
      ? canonicalizeCodexContentArray(output.output)
      : undefined
    return stripCodexContinuationMetadata({
      ...output,
      call_id: typeof output.call_id === "string" ? output.call_id : "",
      output: outputParts
        ? outputParts.length > 0
          ? outputParts
          : ""
        : typeof output.output === "string"
          ? output.output
          : JSON.stringify(
              (output as unknown as Record<string, unknown>).output ?? ""
            ),
    })
  }

  if (type === "custom_tool_call_output") {
    const output = item as Extract<
      CodexInputItem,
      { type: "custom_tool_call_output" }
    >
    return stripCodexContinuationMetadata({
      ...output,
      call_id: typeof output.call_id === "string" ? output.call_id : "",
      output:
        typeof output.output === "string"
          ? output.output
          : JSON.stringify(
              (output as unknown as Record<string, unknown>).output ?? ""
            ),
    })
  }

  if (isCodexApiVisibleInputItem(item)) {
    return stripCodexContinuationMetadata({
      ...(item as Record<string, unknown>),
    }) as CodexInputItem
  }

  return undefined
}

function stripCodexContinuationMetadata<T extends object>(item: T): T {
  const copy = { ...(item as Record<string, unknown>) }
  delete copy.id
  delete copy.internal_chat_message_metadata_passthrough
  return copy as T
}

function canonicalizeCodexContentArray(
  content: Array<Record<string, unknown>> | undefined
): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return []
  const result: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue
    }
    const type = typeof part.type === "string" ? part.type : ""
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = typeof part.text === "string" ? part.text : ""
      if (text.length === 0) {
        continue
      }
      result.push({ ...part, text })
      continue
    }

    result.push({ ...part })
  }
  return result
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item))
  }

  if (!value || typeof value !== "object") {
    return value
  }

  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortJsonValue((value as Record<string, unknown>)[key])
  }
  return sorted
}
