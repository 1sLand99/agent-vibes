export interface CursorAskQuestionOption {
  id: string
  label: string
}

export interface CursorAskQuestionQuestion {
  id: string
  prompt: string
  options: CursorAskQuestionOption[]
  allowMultiple: boolean
}

export interface CursorAskQuestionArgs {
  title: string
  questions: CursorAskQuestionQuestion[]
  runAsync: boolean
  asyncOriginalToolCallId: string
}

/**
 * Cursor has two distinct ask-question execution surfaces:
 *
 * - synchronous questions use `InteractionQuery.askQuestionInteractionQuery`
 *   and wait for the IDE's `InteractionResponse`;
 * - asynchronous questions are projected directly as an
 *   `AskQuestionToolCall` completed with `AskQuestionResult.async`.
 *
 * The IDE's InteractionQuery handler is deliberately synchronous and does not
 * branch on `AskQuestionArgs.run_async`. Treating the flag as an
 * InteractionQuery option therefore blocks instead of creating a queued
 * question.
 */
export type CursorAskQuestionExecution =
  | "blocking_interaction_query"
  | "queued_tool_lifecycle"

function firstString(
  source: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function booleanFlag(value: unknown, defaultValue = false): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") {
    return Number.isFinite(value) ? value !== 0 : defaultValue
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false
  }
  return defaultValue
}

function optionId(value: unknown, fallback: string): string {
  const normalized =
    typeof value === "string"
      ? value
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
      : ""
  return normalized || fallback
}

function normalizeOptions(
  value: unknown,
  questionIndex: number
): CursorAskQuestionOption[] {
  if (!Array.isArray(value)) return []

  const options: CursorAskQuestionOption[] = []
  const seenIds = new Set<string>()
  for (const [optionIndex, entry] of value.entries()) {
    let id = ""
    let label = ""
    if (typeof entry === "string") {
      label = entry.trim()
    } else if (entry && typeof entry === "object") {
      const candidate = entry as Record<string, unknown>
      id =
        firstString(candidate, ["id", "optionId", "option_id", "value"]) || ""
      label =
        firstString(candidate, ["label", "text", "title", "name", "value"]) ||
        ""
    }

    if (!id && !label) continue
    if (!id) {
      id = optionId(label, `opt_${questionIndex}_${optionIndex + 1}`)
    }
    if (!label) label = id
    if (seenIds.has(id)) continue
    seenIds.add(id)
    options.push({ id, label })
  }
  return options
}

export function normalizeCursorAskQuestionArgs(
  input: Record<string, unknown>
): CursorAskQuestionArgs {
  const explicitTitle =
    firstString(input, ["title", "question", "prompt"]) || ""
  const runAsync = booleanFlag(input.run_async ?? input.runAsync)
  const explicitAsyncOriginalToolCallId =
    firstString(input, [
      "asyncOriginalToolCallId",
      "async_original_tool_call_id",
    ]) || ""

  const questions: CursorAskQuestionQuestion[] = []
  const candidates = Array.isArray(input.questions) ? input.questions : []
  for (const [index, entry] of candidates.entries()) {
    if (!entry || typeof entry !== "object") continue
    const question = entry as Record<string, unknown>
    const prompt =
      firstString(question, ["prompt", "question", "title", "label"]) ||
      explicitTitle ||
      `Question ${index + 1}`
    const id =
      firstString(question, ["id", "questionId", "question_id"]) ||
      `q${index + 1}`
    questions.push({
      id,
      prompt,
      options: normalizeOptions(
        Array.isArray(question.options)
          ? question.options
          : Array.isArray(question.choices)
            ? question.choices
            : [],
        index + 1
      ),
      allowMultiple: booleanFlag(
        question.allowMultiple ?? question.allow_multiple
      ),
    })
  }

  if (questions.length === 0) {
    questions.push({
      id: "q1",
      prompt: explicitTitle || "Follow-up",
      options: normalizeOptions(
        Array.isArray(input.options)
          ? input.options
          : Array.isArray(input.choices)
            ? input.choices
            : [],
        1
      ),
      allowMultiple: booleanFlag(input.allowMultiple ?? input.allow_multiple),
    })
  }

  return {
    title: explicitTitle || questions[0]?.prompt || "Follow-up",
    questions,
    runAsync,
    // Cursor uses this field when a later, resolved ask-question projection
    // links back to an earlier async call. The initial async call has no
    // predecessor and must not point at itself.
    asyncOriginalToolCallId: explicitAsyncOriginalToolCallId,
  }
}

export function resolveCursorAskQuestionExecution(
  input: Record<string, unknown>
): CursorAskQuestionExecution {
  return normalizeCursorAskQuestionArgs(input).runAsync
    ? "queued_tool_lifecycle"
    : "blocking_interaction_query"
}

export function normalizeCursorRequestUserInputArgs(
  input: Record<string, unknown>
): CursorAskQuestionArgs {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : []
  const questions: CursorAskQuestionQuestion[] = []

  for (const [index, entry] of rawQuestions.entries()) {
    if (!entry || typeof entry !== "object") continue
    const question = entry as Record<string, unknown>
    questions.push({
      id:
        firstString(question, ["id", "questionId", "question_id"]) ||
        `q${index + 1}`,
      prompt:
        firstString(question, ["question", "prompt", "header", "title"]) ||
        `Question ${index + 1}`,
      options: normalizeOptions(question.options, index + 1),
      allowMultiple: false,
    })
  }

  if (questions.length === 0) {
    const normalized = normalizeCursorAskQuestionArgs(input)
    return {
      ...normalized,
      runAsync: false,
      asyncOriginalToolCallId: "",
    }
  }

  return {
    title:
      firstString(input, ["title", "prompt"]) ||
      questions[0]?.prompt ||
      "User input required",
    questions,
    runAsync: false,
    asyncOriginalToolCallId: "",
  }
}
