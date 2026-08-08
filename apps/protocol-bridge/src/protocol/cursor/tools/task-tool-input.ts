/**
 * Canonical model-facing input contract for Cursor's `task` tool.
 *
 * This boundary intentionally accepts only the published task fields. It
 * neither accepts historical aliases nor coerces truthy values, because task
 * delegation changes execution ownership and must not be guessed from a
 * loosely-shaped provider payload.
 */

export interface CanonicalTaskToolInput {
  description: string
  prompt: string
  subagent_type?: string
  model?: string
  run_in_background?: boolean
}

export type TaskToolInputParseErrorCode =
  | "input_not_object"
  | "unsupported_field"
  | "missing_required_field"
  | "invalid_string_field"
  | "invalid_boolean_field"

export type TaskToolInputParseResult =
  | {
      kind: "valid"
      value: CanonicalTaskToolInput
    }
  | {
      kind: "invalid"
      code: TaskToolInputParseErrorCode
      field?: string
      message: string
    }

const TASK_TOOL_INPUT_FIELDS = new Set<string>([
  "description",
  "prompt",
  "subagent_type",
  "model",
  "run_in_background",
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalid(
  code: TaskToolInputParseErrorCode,
  message: string,
  field?: string
): Extract<TaskToolInputParseResult, { kind: "invalid" }> {
  return { kind: "invalid", code, ...(field ? { field } : {}), message }
}

function hasOwn(source: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, field)
}

function readRequiredNonEmptyString(
  source: Record<string, unknown>,
  field: "description" | "prompt"
):
  | { kind: "valid"; value: string }
  | Extract<TaskToolInputParseResult, { kind: "invalid" }> {
  if (!hasOwn(source, field)) {
    return invalid(
      "missing_required_field",
      `Task tool input requires a non-empty \`${field}\` string.`,
      field
    )
  }
  const value = source[field]
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(
      "invalid_string_field",
      `Task tool input field \`${field}\` must be a non-empty string.`,
      field
    )
  }
  return { kind: "valid", value }
}

function readOptionalNonEmptyString(
  source: Record<string, unknown>,
  field: "subagent_type" | "model"
):
  | { kind: "absent" }
  | { kind: "valid"; value: string }
  | Extract<TaskToolInputParseResult, { kind: "invalid" }> {
  if (!hasOwn(source, field)) return { kind: "absent" }
  const value = source[field]
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(
      "invalid_string_field",
      `Task tool input field \`${field}\` must be a non-empty string when provided.`,
      field
    )
  }
  return { kind: "valid", value }
}

function readOptionalBoolean(
  source: Record<string, unknown>,
  field: "run_in_background"
):
  | { kind: "absent" }
  | { kind: "valid"; value: boolean }
  | Extract<TaskToolInputParseResult, { kind: "invalid" }> {
  if (!hasOwn(source, field)) return { kind: "absent" }
  const value = source[field]
  if (typeof value !== "boolean") {
    return invalid(
      "invalid_boolean_field",
      "Task tool input field `run_in_background` must be a boolean when provided.",
      field
    )
  }
  return { kind: "valid", value }
}

/**
 * Parse a task invocation without aliases, defaulting, or coercion.
 *
 * String values are preserved exactly after validation. In particular,
 * `subagent_type` is not trimmed or normalized before the caller checks it
 * against the exact available sub-agent definition.
 */
export function parseCanonicalTaskToolInput(
  input: unknown
): TaskToolInputParseResult {
  if (!isPlainRecord(input)) {
    return invalid(
      "input_not_object",
      "Task tool input must be a plain object with canonical task fields."
    )
  }

  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !TASK_TOOL_INPUT_FIELDS.has(key)) {
      const field = typeof key === "string" ? key : String(key)
      return invalid(
        "unsupported_field",
        `Unsupported task tool input field \`${field}\`. Use only canonical task fields.`,
        field
      )
    }
  }

  const description = readRequiredNonEmptyString(input, "description")
  if (description.kind === "invalid") return description

  const prompt = readRequiredNonEmptyString(input, "prompt")
  if (prompt.kind === "invalid") return prompt

  const subagentType = readOptionalNonEmptyString(input, "subagent_type")
  if (subagentType.kind === "invalid") return subagentType

  const model = readOptionalNonEmptyString(input, "model")
  if (model.kind === "invalid") return model

  const runInBackground = readOptionalBoolean(input, "run_in_background")
  if (runInBackground.kind === "invalid") return runInBackground

  return {
    kind: "valid",
    value: {
      description: description.value,
      prompt: prompt.value,
      ...(subagentType.kind === "valid"
        ? { subagent_type: subagentType.value }
        : {}),
      ...(model.kind === "valid" ? { model: model.value } : {}),
      ...(runInBackground.kind === "valid"
        ? { run_in_background: runInBackground.value }
        : {}),
    },
  }
}
