import type { UnifiedMessage } from "../../../context/types"
import type {
  SessionAssistantMessage,
  SessionMessage,
  SessionUserMessage,
} from "../session/session-lifecycle.service"
import type { TurnId } from "./turn.types"

export const TERMINAL_RECONCILIATION_SYSTEM_PROMPT =
  "Reconcile one ended Cursor agent request with the current terminal control message. " +
  "When a prior final response is present and the control message materially changes it, return only the concise correction. " +
  "Otherwise return only a concise terminal-status update. Do not restart the task, repeat prior work, " +
  "call tools, or describe internal processing."

const PRIOR_RESPONSE_OMITTED =
  "[Prior final response omitted to fit the reconciliation request.]"
const PRIOR_RESPONSE_SHORTENED =
  "\n\n[... prior final response shortened for reconciliation ...]\n\n"
const NOTIFICATION_SHORTENED =
  "\n\n[... background result shortened for reconciliation ...]\n\n"

export interface TerminalReconciliationProjection {
  readonly messages: readonly TerminalReconciliationMessage[]
  readonly priorAssistantSourceUuids: readonly string[]
  readonly notificationSourceUuid: string
  readonly priorResponseText: string
  readonly notificationText: string
  readonly priorResponseShortened: boolean
  readonly notificationShortened: boolean
}

export interface TerminalReconciliationMessage extends Omit<
  UnifiedMessage,
  "role"
> {
  readonly role: "user" | "assistant"
}

export interface TerminalReconciliationProjectionInput {
  readonly messages: readonly SessionMessage[]
  readonly controlTurnId: TurnId
}

/**
 * Select the complete visible response immediately preceding one exact
 * terminal control notification. Earlier task instructions, tool history,
 * compaction records, workspace attachments and other user turns do not cross
 * this request boundary.
 */
export function projectTerminalReconciliationContext(
  input: TerminalReconciliationProjectionInput
): TerminalReconciliationProjection {
  const terminalNotificationIndex = findTerminalControlMessageIndex(
    input.messages,
    input.controlTurnId
  )
  const controlIndex = resolveCurrentTerminalControlIndex(
    input.messages,
    terminalNotificationIndex
  )

  const notification = input.messages[controlIndex] as SessionUserMessage
  const notificationText = extractVisibleText(notification.message.content)
  if (!notificationText) {
    throw new Error(
      "Terminal reconciliation notification has no provider-visible text"
    )
  }

  const preceding = input.messages[controlIndex - 1]
  const priorTurnPhase = notification.metadata?.priorTurnPhase
  const requiresPriorFinal = priorTurnPhase === "completed"
  if (!preceding || preceding.type !== "assistant") {
    if (requiresPriorFinal) {
      throw new Error(
        "Completed terminal reconciliation requires the prior final assistant response"
      )
    }
    return freezeProjection({
      messages: buildMessages("", notificationText),
      priorAssistantSourceUuids: [],
      notificationSourceUuid: notification.uuid,
      priorResponseText: "",
      notificationText,
      priorResponseShortened: false,
      notificationShortened: false,
    })
  }

  const groupKey = resolveAssistantResponseGroupKey(preceding)
  let start = controlIndex - 1
  while (start > 0) {
    const candidate = input.messages[start - 1]
    if (
      !candidate ||
      candidate.type !== "assistant" ||
      resolveAssistantResponseGroupKey(candidate) !== groupKey
    ) {
      break
    }
    start--
  }

  const priorAssistantMessages = input.messages.slice(
    start,
    controlIndex
  ) as readonly SessionAssistantMessage[]
  const priorResponseText = priorAssistantMessages
    .map((message) => extractVisibleText(message.message.content))
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim()
  if (!priorResponseText) {
    if (requiresPriorFinal) {
      throw new Error(
        "Completed terminal reconciliation prior assistant response has no visible text"
      )
    }
    return freezeProjection({
      messages: buildMessages("", notificationText),
      priorAssistantSourceUuids: [],
      notificationSourceUuid: notification.uuid,
      priorResponseText: "",
      notificationText,
      priorResponseShortened: false,
      notificationShortened: false,
    })
  }

  return freezeProjection({
    messages: buildMessages(priorResponseText, notificationText),
    priorAssistantSourceUuids: priorAssistantMessages.map(
      (message) => message.uuid
    ),
    notificationSourceUuid: notification.uuid,
    priorResponseText,
    notificationText,
    priorResponseShortened: false,
    notificationShortened: false,
  })
}

/**
 * Fit only the two semantically required texts when an unusually large final
 * response or background result exceeds the selected model's request budget.
 * The background result is retained before the prior report because it is the
 * new fact being reconciled.
 */
export function fitTerminalReconciliationProjection(input: {
  readonly projection: TerminalReconciliationProjection
  readonly maxTokens: number
  readonly measure: (
    messages: readonly TerminalReconciliationMessage[]
  ) => number
}): TerminalReconciliationProjection {
  if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0) {
    throw new Error(
      "Terminal reconciliation requires a positive integer token budget"
    )
  }
  if (input.measure(input.projection.messages) <= input.maxTokens) {
    return input.projection
  }

  const fittedPrior = fitTextToBudget({
    text: input.projection.priorResponseText,
    marker: PRIOR_RESPONSE_SHORTENED,
    minimum: PRIOR_RESPONSE_OMITTED,
    fits: (candidate) =>
      input.measure(
        buildMessages(candidate, input.projection.notificationText)
      ) <= input.maxTokens,
  })
  if (fittedPrior !== undefined) {
    return freezeProjection({
      ...input.projection,
      messages: buildMessages(fittedPrior, input.projection.notificationText),
      priorResponseText: fittedPrior,
      priorResponseShortened:
        fittedPrior !== input.projection.priorResponseText,
    })
  }

  const fittedNotification = fitTextToBudget({
    text: input.projection.notificationText,
    marker: NOTIFICATION_SHORTENED,
    minimum: "[Background result omitted to fit the reconciliation request.]",
    fits: (candidate) =>
      input.measure(buildMessages(PRIOR_RESPONSE_OMITTED, candidate)) <=
      input.maxTokens,
  })
  if (fittedNotification === undefined) {
    throw new Error(
      "Terminal reconciliation identity and minimum content exceed the request budget"
    )
  }

  return freezeProjection({
    ...input.projection,
    messages: buildMessages(PRIOR_RESPONSE_OMITTED, fittedNotification),
    priorResponseText: PRIOR_RESPONSE_OMITTED,
    notificationText: fittedNotification,
    priorResponseShortened: true,
    notificationShortened:
      fittedNotification !== input.projection.notificationText,
  })
}

export function assertTerminalReconciliationProjectionCurrent(
  expected: TerminalReconciliationProjection,
  current: TerminalReconciliationProjection
): void {
  if (
    expected.notificationSourceUuid !== current.notificationSourceUuid ||
    !sameStrings(
      expected.priorAssistantSourceUuids,
      current.priorAssistantSourceUuids
    ) ||
    expected.priorResponseText !== current.priorResponseText ||
    expected.notificationText !== current.notificationText
  ) {
    throw new Error(
      "Terminal reconciliation graph sources changed before provider acceptance"
    )
  }
}

function findTerminalControlMessageIndex(
  messages: readonly SessionMessage[],
  controlTurnId: TurnId
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (
      message?.type === "user" &&
      message.turnId === controlTurnId &&
      message.metadata?.source === "cursor_control_continuation" &&
      message.metadata?.origin === "background_task_notification" &&
      message.metadata?.controlAction === "backgroundTaskCompletionAction" &&
      message.metadata?.executionPolicy === "terminal_reconciliation"
    ) {
      return index
    }
  }
  throw new Error(
    "Terminal reconciliation graph has no exact background completion notification"
  )
}

function resolveCurrentTerminalControlIndex(
  messages: readonly SessionMessage[],
  terminalNotificationIndex: number
): number {
  const tailIndex = messages.length - 1
  if (tailIndex === terminalNotificationIndex) return tailIndex

  const tail = messages[tailIndex]
  if (
    tailIndex > terminalNotificationIndex &&
    tail?.type === "user" &&
    tail.isMeta === true &&
    tail.metadata?.source === "cursor_hook" &&
    tail.metadata?.hookEventName === "stop" &&
    Number.isSafeInteger(tail.metadata?.loopCount) &&
    Number(tail.metadata?.loopCount) > 0
  ) {
    return tailIndex
  }

  throw new Error(
    "Terminal reconciliation requires the terminal notification or its exact stop-hook follow-up at the graph tail"
  )
}

function resolveAssistantResponseGroupKey(
  message: SessionAssistantMessage
): string {
  if (message.message.id) return `message:${message.message.id}`
  if (message.providerMessageId) {
    return `provider:${message.providerMessageId}`
  }
  if (message.turnId) return `turn:${message.turnId}`
  return `fragment:${message.uuid}`
}

function extractVisibleText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return [(block as { text: string }).text]
      }
      return []
    })
    .join("")
    .trim()
}

function buildMessages(
  priorResponseText: string,
  notificationText: string
): readonly TerminalReconciliationMessage[] {
  const prior = priorResponseText.trim()
  return Object.freeze([
    ...(prior
      ? [
          Object.freeze({
            role: "assistant" as const,
            content: prior,
          }),
        ]
      : []),
    Object.freeze({
      role: "user" as const,
      content: notificationText,
    }),
  ])
}

function fitTextToBudget(input: {
  readonly text: string
  readonly marker: string
  readonly minimum: string
  readonly fits: (candidate: string) => boolean
}): string | undefined {
  if (input.fits(input.text)) return input.text
  if (!input.fits(input.minimum)) return undefined

  let low = 0
  let high = input.text.length
  let best = input.minimum
  while (low <= high) {
    const retained = Math.floor((low + high) / 2)
    const candidate = shortenText(input.text, retained, input.marker)
    if (input.fits(candidate)) {
      best = candidate
      low = retained + 1
    } else {
      high = retained - 1
    }
  }
  return best
}

function shortenText(text: string, retained: number, marker: string): string {
  if (retained >= text.length) return text
  if (retained <= 0) return marker.trim()
  const headLength = Math.ceil(retained * 0.67)
  const tailLength = Math.max(0, retained - headLength)
  return `${text.slice(0, headLength).trimEnd()}${marker}${
    tailLength > 0 ? text.slice(-tailLength).trimStart() : ""
  }`.trim()
}

function sameStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function freezeProjection(
  projection: TerminalReconciliationProjection
): TerminalReconciliationProjection {
  return Object.freeze({
    ...projection,
    messages: Object.freeze(
      projection.messages.map((message) => Object.freeze({ ...message }))
    ),
    priorAssistantSourceUuids: Object.freeze([
      ...projection.priorAssistantSourceUuids,
    ]),
  })
}
