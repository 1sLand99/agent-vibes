import { fromBinary } from "@bufbuild/protobuf"
import { Injectable } from "@nestjs/common"
import {
  ExecClientMessageSchema,
  type ExecuteHookResult,
} from "../../../gen/agent/v1_pb"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import {
  assertCursorHookResponseMatchesRequest,
  type CursorAgentHookStep,
  type CursorExecuteHookResponse,
} from "./cursor-hook-contract"

type PendingCursorHook = {
  readonly step: CursorAgentHookStep
  readonly resolve: (response: CursorExecuteHookResponse) => void
  readonly reject: (error: Error) => void
  readonly signal: AbortSignal
  readonly onAbort: () => void
}

/**
 * Correlates ExecuteHook ExecServerMessage requests with their exact
 * ExecClientMessage.executeHookResult terminal. It deliberately owns no
 * timeout or fallback: Cursor hook execution is blocking, and cancellation is
 * inherited only from the turn that issued the lifecycle event.
 */
@Injectable()
export class CursorHookLifecycleService {
  private readonly pending = new Map<string, PendingCursorHook>()

  waitForResponse(
    protocolExecId: string,
    step: CursorAgentHookStep,
    signal: AbortSignal
  ): Promise<CursorExecuteHookResponse> {
    const id = requireExactDurableIdentifier(
      protocolExecId,
      "Cursor hook protocol exec id"
    )
    if (this.pending.has(id)) {
      throw new Error(`Cursor hook request is already pending: ${id}`)
    }

    return new Promise<CursorExecuteHookResponse>((resolve, reject) => {
      const onAbort = () => {
        const current = this.pending.get(id)
        if (!current) return
        this.pending.delete(id)
        reject(
          new Error(`Cursor ${step} hook was cancelled by its owning turn`)
        )
      }
      const pending: PendingCursorHook = {
        step,
        resolve,
        reject,
        signal,
        onAbort,
      }
      this.pending.set(id, pending)
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }

  hasPending(protocolExecId: string): boolean {
    return this.pending.has(protocolExecId)
  }

  resolveFromExecClientMessage(
    protocolExecId: string,
    bytes: Uint8Array
  ): boolean {
    const pending = this.pending.get(protocolExecId)
    if (!pending) return false

    let result: ExecuteHookResult
    try {
      const message = fromBinary(ExecClientMessageSchema, bytes, {
        readUnknownFields: true,
      })
      if (message.message.case !== "executeHookResult") {
        throw new Error(
          `Cursor hook exec returned ${message.message.case || "an empty result"}`
        )
      }
      result = message.message.value
      const response = result.response?.response
      if (!response) {
        throw new Error(`Cursor ${pending.step} hook returned no response`)
      }
      assertCursorHookResponseMatchesRequest(pending.step, response)
      this.pending.delete(protocolExecId)
      pending.signal.removeEventListener("abort", pending.onAbort)
      pending.resolve(response)
      return true
    } catch (error) {
      this.pending.delete(protocolExecId)
      pending.signal.removeEventListener("abort", pending.onAbort)
      pending.reject(error instanceof Error ? error : new Error(String(error)))
      return true
    }
  }

  reject(protocolExecId: string, error: Error): boolean {
    const pending = this.pending.get(protocolExecId)
    if (!pending) return false
    this.pending.delete(protocolExecId)
    pending.signal.removeEventListener("abort", pending.onAbort)
    pending.reject(error)
    return true
  }
}
