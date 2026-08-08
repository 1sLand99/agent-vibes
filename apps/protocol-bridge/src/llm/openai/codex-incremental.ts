import { createHash } from "crypto"
import { CONTEXT_MICROCOMPACT_CLEARED_MARKER } from "../../shared/context-compaction"
import type { CodexInputItem } from "./codex-native-types"
import { isCodexApiVisibleInputItem } from "./codex-response-items"

export interface CodexLastResponseSnapshot {
  responseId: string
  itemsAdded: CodexInputItem[]
  /** Eligibility captured from the full request that produced this response. */
  eligibility?: CodexContinuationEligibility
  /** Exact ModelClientSession that produced this response chain. */
  modelClientSessionId: string
}

export interface CodexContinuationEligibility {
  toolCatalogHash: string
  settingsHash: string
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
  baselineDetail?: CodexInputMismatchItemDetail
  requestDetail?: CodexInputMismatchItemDetail
}

export interface CodexInputMismatchItemDetail {
  type: string
  role?: string
  signature: string
  jsonLength: number
  preview?: string
}

export interface CodexContinuationState {
  lastResponse: CodexLastResponseSnapshot | undefined
  lastRequest: Record<string, unknown> | undefined
  /** Exact logical ModelClientSession identity for this continuation state. */
  modelClientSessionId: string
}

export type CodexContinuationDecision =
  | {
      mode: "full"
      reason: "no_baseline" | "explicit_full_input"
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
  | {
      mode: "full_reset"
      reason:
        | "tool_catalog_changed"
        | "settings_changed"
        | "model_client_session_changed"
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

/**
 * A response id is usable only when the exact model settings and dynamic tool
 * catalog that created it remain active. Hash these independently so callers
 * can explain why a continuation was intentionally abandoned.
 */
export function getCodexContinuationEligibility(
  request: Record<string, unknown>
): CodexContinuationEligibility {
  const toolCatalog = {
    tools: request.tools ?? [],
    tool_choice: request.tool_choice,
    parallel_tool_calls: request.parallel_tool_calls,
  }
  const settings = stripCodexRequestForIncrementalCompare(request)
  delete settings.tools
  delete settings.tool_choice
  delete settings.parallel_tool_calls
  return {
    toolCatalogHash: hashCodexContinuationPart(toolCatalog),
    settingsHash: hashCodexContinuationPart(settings),
  }
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
      !codexInputItemsEquivalentForContinuation(
        baseline[index],
        requestInput[index]
      )
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
          baselineDetail: summarizeCodexInputMismatchItem(baseline[index]),
          requestDetail: summarizeCodexInputMismatchItem(requestInput[index]),
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
  if (!lastResponse || !lastRequest) {
    return {
      mode: "full",
      reason: "no_baseline",
      request,
      nextState: buildNextContinuationState(state, request),
    }
  }

  if (lastResponse.modelClientSessionId !== state.modelClientSessionId) {
    return buildEligibilityResetDecision(
      state,
      request,
      "model_client_session_changed"
    )
  }

  const previousEligibility =
    lastResponse.eligibility ?? getCodexContinuationEligibility(lastRequest)
  const currentEligibility = getCodexContinuationEligibility(request)
  if (
    previousEligibility.toolCatalogHash !== currentEligibility.toolCatalogHash
  ) {
    return buildEligibilityResetDecision(state, request, "tool_catalog_changed")
  }
  if (previousEligibility.settingsHash !== currentEligibility.settingsHash) {
    return buildEligibilityResetDecision(state, request, "settings_changed")
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
        nextState: buildNextContinuationState(state, request),
      }
    }

    return {
      mode: "full_reset",
      reason: "input_not_extension",
      inputMismatch: result.inputMismatch,
      request,
      nextState: buildNextContinuationState(state, request),
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
      ...buildNextContinuationState(state, request),
      lastResponse,
    },
  }
}

/**
 * Build a full-input continuation candidate without consulting the previous
 * response chain. The caller still publishes `nextState` only after the
 * physical request has been accepted.
 */
export function prepareCodexFullContinuationRequest(
  request: Record<string, unknown>,
  state: CodexContinuationState
): Extract<CodexContinuationDecision, { mode: "full" }> {
  return {
    mode: "full",
    reason: "explicit_full_input",
    request,
    nextState: buildNextContinuationState(state, request),
  }
}

function buildEligibilityResetDecision(
  state: CodexContinuationState,
  request: Record<string, unknown>,
  reason:
    | "tool_catalog_changed"
    | "settings_changed"
    | "model_client_session_changed"
): Extract<CodexContinuationDecision, { reason: typeof reason }> {
  return {
    mode: "full_reset",
    reason,
    request,
    nextState: buildNextContinuationState(state, request),
  }
}

function buildNextContinuationState(
  state: CodexContinuationState,
  request: Record<string, unknown>
): CodexContinuationState {
  return {
    lastRequest: request,
    lastResponse: undefined,
    modelClientSessionId: state.modelClientSessionId,
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

function hashCodexContinuationPart(value: unknown): string {
  return createHash("sha256")
    .update(stableCodexJsonStringify(value))
    .digest("hex")
    .slice(0, 24)
}

function codexInputItemsEquivalentForContinuation(
  baseline: CodexInputItem | undefined,
  request: CodexInputItem | undefined
): boolean {
  if (
    stableCodexJsonStringify(request) === stableCodexJsonStringify(baseline)
  ) {
    return true
  }
  return areMicrocompactedToolOutputsEquivalent(baseline, request)
}

function areMicrocompactedToolOutputsEquivalent(
  baseline: CodexInputItem | undefined,
  request: CodexInputItem | undefined
): boolean {
  if (!baseline || !request) return false
  const baselineRecord = baseline as Record<string, unknown>
  const requestRecord = request as Record<string, unknown>
  const baselineType =
    typeof baselineRecord.type === "string" ? baselineRecord.type : ""
  const requestType =
    typeof requestRecord.type === "string" ? requestRecord.type : ""
  if (baselineType !== requestType) return false
  if (
    baselineType !== "function_call_output" &&
    baselineType !== "custom_tool_call_output"
  ) {
    return false
  }

  const baselineCallId =
    typeof baselineRecord.call_id === "string" ? baselineRecord.call_id : ""
  const requestCallId =
    typeof requestRecord.call_id === "string" ? requestRecord.call_id : ""
  if (baselineCallId !== requestCallId) return false

  return (
    isMicrocompactClearedOutput(baselineRecord.output) ||
    isMicrocompactClearedOutput(requestRecord.output)
  )
}

function isMicrocompactClearedOutput(output: unknown): boolean {
  if (output === CONTEXT_MICROCOMPACT_CLEARED_MARKER) {
    return true
  }
  if (!Array.isArray(output)) {
    return false
  }
  return output.some((part) => {
    if (!part || typeof part !== "object") return false
    return (
      (part as Record<string, unknown>).text ===
      CONTEXT_MICROCOMPACT_CLEARED_MARKER
    )
  })
}

function getCodexInputItemType(item: CodexInputItem | undefined): string {
  const type =
    item && typeof (item as { type?: unknown }).type === "string"
      ? ((item as { type: string }).type || "").trim()
      : ""
  return type || "unknown"
}

function summarizeCodexInputMismatchItem(
  item: CodexInputItem | undefined
): CodexInputMismatchItemDetail | undefined {
  if (!item) return undefined
  const json = stableCodexJsonStringify(item)
  const detail: CodexInputMismatchItemDetail = {
    type: getCodexInputItemType(item),
    signature: createHash("sha256").update(json).digest("hex").slice(0, 16),
    jsonLength: json.length,
  }
  const role = getCodexInputItemRole(item)
  if (role) {
    detail.role = role
  }
  const preview = previewCodexInputItem(item)
  if (preview) {
    detail.preview = preview
  }
  return detail
}

function getCodexInputItemRole(item: CodexInputItem): string | undefined {
  const role = (item as Record<string, unknown>).role
  return typeof role === "string" && role.trim() ? role.trim() : undefined
}

function previewCodexInputItem(item: CodexInputItem): string | undefined {
  const type = getCodexInputItemType(item)
  if (type === "message") {
    return previewCodexTextParts(
      (item as { content?: unknown }).content,
      "message"
    )
  }
  if (type === "function_call" || type === "custom_tool_call") {
    const name = (item as { name?: unknown }).name
    const callId = (item as { call_id?: unknown }).call_id
    return truncateCodexMismatchPreview(
      [
        typeof name === "string" && name.trim() ? `name=${name.trim()}` : "",
        typeof callId === "string" && callId.trim()
          ? `call_id=${callId.trim()}`
          : "",
      ]
        .filter(Boolean)
        .join(" ")
    )
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const callId = (item as { call_id?: unknown }).call_id
    const outputPreview = previewCodexTextParts(
      (item as { output?: unknown }).output,
      "output"
    )
    return truncateCodexMismatchPreview(
      [
        typeof callId === "string" && callId.trim()
          ? `call_id=${callId.trim()}`
          : "",
        outputPreview || "",
      ]
        .filter(Boolean)
        .join(" ")
    )
  }
  return undefined
}

function previewCodexTextParts(
  value: unknown,
  label: string
): string | undefined {
  if (typeof value === "string") {
    return truncateCodexMismatchPreview(value)
  }
  if (!Array.isArray(value)) {
    return undefined
  }
  const texts: string[] = []
  for (const part of value) {
    if (!part || typeof part !== "object") {
      continue
    }
    const text = (part as Record<string, unknown>).text
    if (typeof text === "string" && text.trim()) {
      texts.push(text)
    }
  }
  const preview = truncateCodexMismatchPreview(texts.join(" "))
  return preview || `${label}_parts=${value.length}`
}

function truncateCodexMismatchPreview(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return undefined
  }
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized
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
