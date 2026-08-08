import type {
  ExecuteHookRequest,
  ExecuteHookResponse,
} from "../../../gen/agent/v1_pb"

/**
 * Hook steps that are transported by agent.v1.ExecuteHookRequest.
 *
 * Cursor also exposes editor-owned lifecycle names such as sessionStart and
 * workspaceOpen in HooksConfigInfo. Those names are intentionally absent
 * here because the Agent v1 ExecuteHook oneof cannot represent them.
 */
export const CURSOR_AGENT_HOOK_STEPS = [
  "preCompact",
  "subagentStart",
  "subagentStop",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "afterAgentThought",
  "stop",
] as const

export type CursorAgentHookStep = (typeof CURSOR_AGENT_HOOK_STEPS)[number]

export const CURSOR_HOOK_ADDITIONAL_CONTEXTS_METADATA_KEY =
  "cursorHookAdditionalContexts" as const

export const CURSOR_HOOK_ADDITIONAL_CONTEXT_MAX_CHARS = 10_000

export type CursorHookAdditionalContextEvent =
  | "sessionStart"
  | "beforeSubmitPrompt"
  | "preToolUse"
  | "postToolUse"
  | "postToolUseFailure"

const CURSOR_HOOK_ADDITIONAL_CONTEXT_EVENT_SET: ReadonlySet<string> = new Set([
  "sessionStart",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
])

export function isCursorHookAdditionalContextEvent(
  value: string
): value is CursorHookAdditionalContextEvent {
  return CURSOR_HOOK_ADDITIONAL_CONTEXT_EVENT_SET.has(value)
}

export interface CursorHookAdditionalContextReceipt {
  readonly hookEventName: CursorHookAdditionalContextEvent
  readonly content: string
}

export function parseCursorHookAdditionalContextReceipts(
  contexts: readonly {
    readonly hookEventName: string
    readonly content: string
  }[]
): readonly CursorHookAdditionalContextReceipt[] {
  return Object.freeze(
    contexts.map((context) => {
      if (!isCursorHookAdditionalContextEvent(context.hookEventName)) {
        throw new Error(
          `Unsupported Cursor hook context event ${JSON.stringify(context.hookEventName)}`
        )
      }
      return Object.freeze({
        hookEventName: context.hookEventName,
        content: context.content,
      })
    })
  )
}

/**
 * Cursor treats hook additional context as an untrusted system reminder. The
 * carrier remains raw protocol data, while the model projection trims it,
 * caps it at 10k characters, and neutralizes nested reminder tags.
 */
export function renderCursorHookAdditionalContext(
  content: string
): string | undefined {
  const normalized = content.trim()
  if (
    normalized.length === 0 ||
    normalized.length > CURSOR_HOOK_ADDITIONAL_CONTEXT_MAX_CHARS
  ) {
    return undefined
  }
  const escaped = normalized.replace(
    /<(\/?)system_reminder>/giu,
    "<$1system_reminder_>"
  )
  return `<system_reminder>\n${escaped}\n</system_reminder>`
}

const CURSOR_AGENT_HOOK_STEP_SET: ReadonlySet<string> = new Set(
  CURSOR_AGENT_HOOK_STEPS
)

export function isCursorAgentHookStep(
  value: string
): value is CursorAgentHookStep {
  return CURSOR_AGENT_HOOK_STEP_SET.has(value)
}

export function selectCursorAgentHookSteps(
  configuredSteps: readonly string[] | undefined
): readonly CursorAgentHookStep[] {
  if (!configuredSteps?.length) return Object.freeze([])
  const selected = configuredSteps.filter(isCursorAgentHookStep)
  return Object.freeze([...new Set(selected)])
}

export type CursorExecuteHookRequest = ExecuteHookRequest["request"]
export type CursorExecuteHookResponse = ExecuteHookResponse["response"]

export function assertCursorHookResponseMatchesRequest(
  expected: CursorAgentHookStep,
  actual: CursorExecuteHookResponse
): void {
  if (!actual.case) {
    throw new Error(`Cursor ${expected} hook returned an empty response`)
  }
  if (actual.case !== expected) {
    throw new Error(
      `Cursor hook response mismatch: expected=${expected} actual=${actual.case}`
    )
  }
}

export function parseHookPermission(
  step: "preToolUse" | "subagentStart",
  permission: string | undefined
): "allow" | "deny" | "ask" {
  if (permission === undefined || permission === "") return "allow"
  if (permission === "allow" || permission === "deny" || permission === "ask") {
    return permission
  }
  throw new Error(
    `Cursor ${step} hook returned invalid permission ${JSON.stringify(permission)}`
  )
}

export function parseUpdatedHookInput(
  updatedInput: string | undefined
): Record<string, unknown> | undefined {
  if (updatedInput === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(updatedInput)
  } catch (error) {
    throw new Error(
      `Cursor preToolUse updated_input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Cursor preToolUse updated_input must encode a JSON object")
  }
  return parsed as Record<string, unknown>
}
