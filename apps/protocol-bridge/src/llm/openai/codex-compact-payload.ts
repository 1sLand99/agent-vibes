import { CodexApiError } from "./codex-api-error"
import type { CodexInputItem } from "./codex-native-types"
import { requireExactDurableIdentifier } from "../../context/durable-identifier"

/** Internal stream event carrying a raw Responses output item. */
export const CODEX_RESPONSE_ITEM_EVENT = "codex_response_item"
/** Internal stream event emitted only after an upstream response.completed. */
export const CODEX_RESPONSE_COMPLETED_EVENT = "codex_response_completed"
/** Internal terminal fact for ordinary agent turns. Unlike the completed-only
 * compaction event, this preserves failed and incomplete Responses outcomes. */
export const CODEX_RESPONSE_TERMINAL_EVENT = "codex_response_terminal"

export type CodexJsonValue =
  | null
  | boolean
  | number
  | string
  | CodexJsonObject
  | CodexJsonValue[]

export interface CodexJsonObject {
  [key: string]: CodexJsonValue
}

export type CodexRemoteCompactionOutputItem = Readonly<
  CodexJsonObject & { type: "compaction" }
>

/**
 * The only accepted Remote Compaction V2 terminal result. The three input
 * snapshots are immutable JSON facts for exact rollout audit/replay:
 * `preTriggerInput` is the native prompt, `requestInput` appends the V2
 * trigger, and `wireInput` is the prepared transport payload input.
 */
export interface CodexRemoteCompactionV2Result {
  preTriggerInput: readonly CodexInputItem[]
  requestInput: readonly CodexInputItem[]
  wireInput: readonly CodexInputItem[]
  compactionOutput: CodexRemoteCompactionOutputItem
  responseId: string
  usage?: Readonly<CodexJsonObject>
}

/**
 * Mirrors current Codex Remote Compaction V2 request construction: the
 * caller provides the full provider-native prompt input, then exactly one
 * terminal compaction_trigger is appended to an ordinary Responses request.
 */
export function buildCodexRemoteCompactionV2Input(
  preTriggerInput: readonly CodexInputItem[]
): CodexInputItem[] {
  if (!Array.isArray(preTriggerInput) || preTriggerInput.length === 0) {
    throw new CodexApiError(
      500,
      "Codex Remote Compaction V2 requires non-empty native prompt input."
    )
  }

  const input = cloneCodexInputItems(preTriggerInput)
  const triggerCount = input.filter(
    (item) => item.type === "compaction_trigger"
  ).length
  if (triggerCount !== 0) {
    throw new CodexApiError(
      500,
      "Codex Remote Compaction V2 native input must not already contain a compaction_trigger."
    )
  }

  input.push({ type: "compaction_trigger" })
  return input
}

/** Validates the final logical Responses input captured for the rollout audit. */
export function assertCodexRemoteCompactionV2WireInput(
  wireInput: readonly CodexInputItem[]
): void {
  if (!Array.isArray(wireInput) || wireInput.length === 0) {
    throw new CodexApiError(
      500,
      "Codex Remote Compaction V2 wire input must be a non-empty array."
    )
  }
  const items = wireInput as readonly CodexInputItem[]
  const triggerIndexes = items.flatMap((item, index) =>
    item.type === "compaction_trigger" ? [index] : []
  )
  if (triggerIndexes.length !== 1 || triggerIndexes[0] !== items.length - 1) {
    throw new CodexApiError(
      500,
      "Codex Remote Compaction V2 wire input must end with exactly one compaction_trigger."
    )
  }
}

/**
 * Validates the V2 semantic request input before its transport-specific
 * preparation. It must be the exact pre-trigger native prompt plus one final
 * trigger, without any rewritten or synthesized history items.
 */
export function assertCodexRemoteCompactionV2RequestInput(
  preTriggerInput: readonly CodexInputItem[],
  requestInput: readonly CodexInputItem[]
): void {
  assertCodexRemoteCompactionV2WireInput(requestInput)
  if (requestInput.length !== preTriggerInput.length + 1) {
    throw new CodexApiError(
      500,
      "Codex Remote Compaction V2 request input must contain the complete pre-trigger input plus one trigger."
    )
  }
  for (let index = 0; index < preTriggerInput.length; index++) {
    if (
      JSON.stringify(requestInput[index]) !==
      JSON.stringify(preTriggerInput[index])
    ) {
      throw new CodexApiError(
        500,
        `Codex Remote Compaction V2 request input changed native item ${index}.`
      )
    }
  }
}

/** Creates a strict collector for the ordinary Responses streaming path. */
export function createCodexRemoteCompactionV2Collector(): CodexRemoteCompactionV2Collector {
  return new CodexRemoteCompactionV2Collector()
}

/**
 * Equivalent to Codex's collect_compaction_output(): completion is required,
 * and there must be exactly one type=compaction output item. Other output
 * item types are intentionally tolerated just as upstream does.
 */
export class CodexRemoteCompactionV2Collector {
  private compactionCount = 0
  private compactionOutput: CodexRemoteCompactionOutputItem | undefined
  private completionCount = 0
  private responseId = ""
  private usage: Readonly<CodexJsonObject> | undefined

  acceptSseEvent(event: string): void {
    const frame = parseInternalSseFrame(event)
    if (!frame) return

    if (frame.type === CODEX_RESPONSE_ITEM_EVENT) {
      const item = frame.data.item
      if (!isJsonObject(item)) {
        throw new CodexApiError(
          502,
          "Codex Remote Compaction V2 output-item event did not include an object item."
        )
      }
      if (item.type !== "compaction") {
        return
      }
      this.compactionCount++
      if (!this.compactionOutput) {
        this.compactionOutput = freezeJsonObject(
          item
        ) as CodexRemoteCompactionOutputItem
      }
      return
    }

    if (frame.type !== CODEX_RESPONSE_COMPLETED_EVENT) {
      return
    }

    this.completionCount++
    let responseId: string
    try {
      responseId = requireExactDurableIdentifier(
        frame.data.responseId,
        "Codex Remote Compaction V2 response id"
      )
    } catch {
      throw new CodexApiError(
        502,
        "Codex Remote Compaction V2 response.completed did not include an exact response id."
      )
    }
    this.responseId = responseId

    if (frame.data.usage !== undefined) {
      if (!isJsonObject(frame.data.usage)) {
        throw new CodexApiError(
          502,
          "Codex Remote Compaction V2 response.completed usage must be an object."
        )
      }
      this.usage = freezeJsonObject(frame.data.usage)
    }
  }

  finish(input: {
    preTriggerInput: readonly CodexInputItem[]
    requestInput: readonly CodexInputItem[]
    wireInput: readonly CodexInputItem[]
  }): CodexRemoteCompactionV2Result {
    if (this.completionCount !== 1) {
      throw new CodexApiError(
        502,
        `Codex Remote Compaction V2 stream expected exactly one response.completed event, got ${this.completionCount}.`
      )
    }
    if (this.compactionCount !== 1 || !this.compactionOutput) {
      throw new CodexApiError(
        502,
        `Codex Remote Compaction V2 stream expected exactly one compaction output item, got ${this.compactionCount}.`
      )
    }

    return {
      preTriggerInput: freezeCodexInputItems(input.preTriggerInput),
      requestInput: freezeCodexInputItems(input.requestInput),
      wireInput: freezeCodexInputItems(input.wireInput),
      compactionOutput: this.compactionOutput,
      responseId: this.responseId,
      ...(this.usage ? { usage: this.usage } : {}),
    }
  }
}

/**
 * Retains the final transport-ready input for one Remote Compaction V2
 * request. A WebSocket ModelClientSession may replace the full logical input
 * with an incremental suffix, so each dispatch supersedes the previous
 * snapshot and only the final attempt is retained for audit.
 */
export class CodexRemoteCompactionV2WireInputCapture {
  private latest: CodexInputItem[] | undefined

  record(input: unknown): void {
    if (!Array.isArray(input)) {
      throw new CodexApiError(
        500,
        "Codex Remote Compaction V2 prepared wire request did not include input."
      )
    }

    this.latest = input.map((value, index) => {
      if (
        !isJsonObject(value) ||
        typeof value.type !== "string" ||
        !value.type.trim()
      ) {
        throw new CodexApiError(
          500,
          `Codex Remote Compaction V2 prepared wire input item ${index} must be a typed object.`
        )
      }
      return cloneCodexInputItem(value as CodexInputItem, index)
    })
  }

  take(): CodexInputItem[] {
    if (!this.latest) {
      throw new CodexApiError(
        500,
        "Codex Remote Compaction V2 stream completed without a captured wire input."
      )
    }
    return cloneCodexInputItems(this.latest)
  }
}

function parseInternalSseFrame(
  event: string
): { type: string; data: CodexJsonObject } | undefined {
  let type = ""
  const dataLines: string[] = []
  for (const line of event.split("\n")) {
    if (line.startsWith("event:")) {
      type = line.slice("event:".length).trim()
      continue
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart())
    }
  }

  if (
    type !== CODEX_RESPONSE_ITEM_EVENT &&
    type !== CODEX_RESPONSE_COMPLETED_EVENT
  ) {
    return undefined
  }
  if (dataLines.length === 0) {
    throw new CodexApiError(
      502,
      `Codex Remote Compaction V2 ${type} event did not include data.`
    )
  }

  let data: unknown
  try {
    data = JSON.parse(dataLines.join("\n"))
  } catch {
    throw new CodexApiError(
      502,
      `Codex Remote Compaction V2 ${type} event included invalid JSON.`
    )
  }
  if (!isJsonObject(data)) {
    throw new CodexApiError(
      502,
      `Codex Remote Compaction V2 ${type} event data must be an object.`
    )
  }
  return { type, data }
}

function cloneCodexInputItems(
  input: readonly CodexInputItem[]
): CodexInputItem[] {
  return input.map((item, index) => cloneCodexInputItem(item, index))
}

function freezeCodexInputItems(
  input: readonly CodexInputItem[]
): readonly CodexInputItem[] {
  return Object.freeze(
    input.map((item, index) =>
      freezeJsonObject(
        cloneCodexInputItem(item, index) as unknown as CodexJsonObject
      )
    )
  ) as readonly CodexInputItem[]
}

function cloneCodexInputItem(
  item: CodexInputItem,
  index: number
): CodexInputItem {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new CodexApiError(
      500,
      `Codex Remote Compaction V2 native input item ${index} must be an object.`
    )
  }
  try {
    const cloned = JSON.parse(JSON.stringify(item)) as unknown
    if (!isJsonObject(cloned)) {
      throw new Error("serialized value was not an object")
    }
    return cloned as CodexInputItem
  } catch (error) {
    throw new CodexApiError(
      500,
      `Codex Remote Compaction V2 native input item ${index} is not JSON-serializable: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

function isJsonObject(value: unknown): value is CodexJsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function freezeJsonObject(value: CodexJsonObject): Readonly<CodexJsonObject> {
  const cloned = cloneJsonValue(value)
  return deepFreeze(cloned) as Readonly<CodexJsonObject>
}

function cloneJsonValue(value: CodexJsonValue): CodexJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        cloneJsonValue(nested),
      ])
    )
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}
