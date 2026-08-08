import { Injectable } from "@nestjs/common"
import { SessionLifecycleService } from "./session-lifecycle.service"
import type {
  ToolExecutionRecoveryReason,
  ToolExecutionStatus,
} from "./tool-execution-types"

@Injectable()
export class ToolExecutionCoordinatorService {
  constructor(private readonly sessionManager: SessionLifecycleService) {}

  registerPendingTool(conversationId: string, toolCallId: string): void {
    const session = this.sessionManager.getSession(conversationId)
    const pending = session
      ? this.sessionManager.getPendingToolCall(
          session.conversationId,
          toolCallId
        )
      : undefined
    if (!session || !pending) return

    this.sessionManager.updatePendingToolExecution(conversationId, toolCallId, {
      executionOwner: pending.executionOwner || "client",
      executionStatus: pending.executionStatus || "pending",
    })
  }

  markRunning(conversationId: string, toolCallId: string): void {
    this.updateStatus(conversationId, toolCallId, "running")
  }

  markCompleted(conversationId: string, toolCallId: string): void {
    this.updateStatus(conversationId, toolCallId, "completed")
  }

  markDiscarded(
    conversationId: string,
    toolCallIds: readonly string[],
    reason: ToolExecutionRecoveryReason
  ): void {
    for (const toolCallId of toolCallIds) {
      this.sessionManager.updatePendingToolExecution(
        conversationId,
        toolCallId,
        {
          executionStatus: "discarded",
          executionRecoveryReason: reason,
        }
      )
    }
  }

  private updateStatus(
    conversationId: string,
    toolCallId: string,
    status: ToolExecutionStatus
  ): void {
    this.sessionManager.updatePendingToolExecution(conversationId, toolCallId, {
      executionStatus: status,
    })
  }
}
