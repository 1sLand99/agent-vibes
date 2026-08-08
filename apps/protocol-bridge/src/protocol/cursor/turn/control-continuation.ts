import type {
  CursorTurnPhase,
  CursorTurnTransitionReason,
} from "../session/conversation-context-runtime.service"
import { isCursorTurnTerminalPhase } from "../session/conversation-context-runtime.service"

export type CursorControlContinuationKind =
  | "async_user_response"
  | "background_task_notification"
  | "goal_continuation"

export interface CursorControlContinuationEnvelope {
  readonly content: string
  readonly isMeta: boolean
  readonly executionPolicy: "resume_active_task" | "terminal_reconciliation"
  readonly metadata: {
    readonly source: "cursor_control_continuation"
    readonly origin:
      | "async_user_response"
      | "background_task_notification"
      | "goal_continuation"
    readonly controlAction:
      | "asyncAskQuestionCompletionAction"
      | "backgroundTaskCompletionAction"
      | "goalContinuationAction"
    readonly executionPolicy: "resume_active_task" | "terminal_reconciliation"
    readonly priorTurnPhase?: CursorTurnPhase
    readonly priorTurnReason?: CursorTurnTransitionReason
  }
}

interface CursorControlContinuationInput {
  readonly kind: CursorControlContinuationKind
  readonly payload: string
  readonly priorTurn?: {
    readonly phase: CursorTurnPhase
    readonly reason: CursorTurnTransitionReason
  }
}

/**
 * Project a Cursor ConversationAction into the provider-visible continuation
 * that belongs to the already active user request.
 *
 * Cursor's background completion and async-question completion actions are
 * control-plane events, not UserMessageAction roots. The provider still needs
 * a user-role message for Anthropic/OpenAI conversation alternation, but the
 * message must retain its non-root origin and state what may be resumed. This
 * mirrors Claude Code's task-notification origin rather than pretending the
 * event was typed by the user.
 */
export function buildCursorControlContinuationEnvelope(
  input: CursorControlContinuationInput
): CursorControlContinuationEnvelope {
  const payload = input.payload.trim()
  if (!payload) {
    throw new Error("Cursor control continuation payload must be non-empty")
  }

  if (input.kind === "async_user_response") {
    return {
      content:
        "The user answered a pending asynchronous question for the current " +
        "request. This continues the existing request; it is not a new task. " +
        "Resume from the pending question without restarting completed work.\n\n" +
        payload,
      isMeta: false,
      executionPolicy: "resume_active_task",
      metadata: {
        source: "cursor_control_continuation",
        origin: "async_user_response",
        controlAction: "asyncAskQuestionCompletionAction",
        executionPolicy: "resume_active_task",
        ...(input.priorTurn
          ? {
              priorTurnPhase: input.priorTurn.phase,
              priorTurnReason: input.priorTurn.reason,
            }
          : {}),
      },
    }
  }

  if (input.kind === "goal_continuation") {
    return {
      content:
        "Cursor requested a goal continuation for the active durable goal. " +
        "This continues the existing goal; it is not a new user request. " +
        "Keep working toward the stated objective without restarting completed work.\n\n" +
        payload,
      isMeta: true,
      executionPolicy: "resume_active_task",
      metadata: {
        source: "cursor_control_continuation",
        origin: "goal_continuation",
        controlAction: "goalContinuationAction",
        executionPolicy: "resume_active_task",
        ...(input.priorTurn
          ? {
              priorTurnPhase: input.priorTurn.phase,
              priorTurnReason: input.priorTurn.reason,
            }
          : {}),
      },
    }
  }

  const priorTurnIsTerminal =
    input.priorTurn !== undefined &&
    isCursorTurnTerminalPhase(input.priorTurn.phase)
  const priorTurnCompleted = input.priorTurn?.phase === "completed"
  const terminalContent = priorTurnCompleted
    ? "A background task completed after the current user request had " +
      "already reached its final response. This is a task notification, " +
      "not a new user request. Reconcile only this terminal result. Do not " +
      "restart the task, repeat the prior report, reread the original task " +
      "instructions, or rerun completed checks. If this result materially " +
      "changes the prior response, provide only a concise correction; " +
      "otherwise provide only a concise terminal-status update.\n\n"
    : "A background task completion arrived after the current user request " +
      `had already ended with status ${input.priorTurn?.phase ?? "terminal"}. ` +
      "This is a terminal task notification, not a new user request. " +
      "Report only the resulting terminal status. Do not resume or restart " +
      "the failed or aborted request, reread its original instructions, " +
      "repeat its work, or call tools.\n\n"
  return {
    content: priorTurnIsTerminal
      ? terminalContent + payload
      : "A background task completed while the current user request is still " +
        "active. This is a task notification, not a new user request. " +
        "Continue the existing task from its current state without restarting " +
        "completed work.\n\n" +
        payload,
    isMeta: true,
    executionPolicy: priorTurnIsTerminal
      ? "terminal_reconciliation"
      : "resume_active_task",
    metadata: {
      source: "cursor_control_continuation",
      origin: "background_task_notification",
      controlAction: "backgroundTaskCompletionAction",
      executionPolicy: priorTurnIsTerminal
        ? "terminal_reconciliation"
        : "resume_active_task",
      ...(input.priorTurn
        ? {
            priorTurnPhase: input.priorTurn.phase,
            priorTurnReason: input.priorTurn.reason,
          }
        : {}),
    },
  }
}
