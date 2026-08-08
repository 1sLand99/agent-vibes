import { Injectable, Logger } from "@nestjs/common"
import { AsyncLocalStorage } from "node:async_hooks"
import {
  projectionOwnerStorageKey,
  type ProjectionOwner,
} from "../protocol/cursor/session/projection-owner"

interface ContextMutationScope {
  ownerKey: string
  label: string
  /**
   * AsyncLocalStorage propagates into detached descendants.  The scope must
   * therefore expire when its queue operation releases; otherwise a late
   * callback could appear to own a mutation after another operation starts.
   */
  active: boolean
}

/**
 * Per-projection-owner mutation queue for context-state mutations
 * (compaction and provider projection installs). Ensures only one
 * mutation operates on a given conversation's `ContextConversationState`
 * at a time without holding a global lock.
 *
 * The queue itself never observes the AbortSignal — once enqueued, an
 * operation runs to completion or rejection. Cancellation is the
 * operation's responsibility: it must thread `signal` into every await
 * and short-circuit on abort. The queue does, however, refuse to
 * START a new operation whose signal is already aborted; that protects
 * the common race where a turn is superseded between the time it
 * enqueued the work and the time the queue gets around to it.
 *
 * The required `signal` parameter is the
 * load-bearing change — every caller now has to consciously pass a
 * lifecycle-bound signal, eliminating the silent "queue runs orphaned
 * work after the requester is gone" failure mode that produced the
 * 12:35 supersede bug.
 */
@Injectable()
export class ContextPipeline {
  private readonly logger = new Logger(ContextPipeline.name)
  private readonly mutationQueues = new Map<string, Promise<void>>()
  /**
   * The queue is not merely advisory. Projection writers use this scope to
   * reject a future direct write that would otherwise race a compact plan
   * waiting on its no-tools summary request.
   */
  private readonly mutationScope = new AsyncLocalStorage<ContextMutationScope>()

  async runMutation<T>(args: {
    owner: ProjectionOwner
    label: string
    signal: AbortSignal
    operation: (signal: AbortSignal) => T | Promise<T>
  }): Promise<T> {
    const { owner, label, signal, operation } = args
    const key = projectionOwnerStorageKey(owner)
    const previous = this.mutationQueues.get(key) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(
      () => current,
      () => current
    )
    this.mutationQueues.set(key, queued)

    await previous.catch((error) => {
      this.logger.warn(
        `Previous context mutation failed before ${label}: ${String(error)}`
      )
    })

    try {
      // Refuse to start work whose lifecycle has already ended. This
      // catches the critical race where a turn was superseded while
      // queued behind another mutation — without this check, the
      // operation would run, allocate a backend account, and produce
      // the duplicate-request anomaly that motivates the rewrite.
      if (signal.aborted) {
        const reason =
          signal.reason instanceof Error
            ? signal.reason
            : new Error(String(signal.reason ?? "ContextPipeline aborted"))
        throw reason
      }
      const scope: ContextMutationScope = {
        ownerKey: key,
        label,
        active: true,
      }
      try {
        return await this.mutationScope.run(scope, () => operation(signal))
      } finally {
        // AsyncLocalStorage propagates this object by reference. Marking it
        // inactive rejects detached callbacks that outlive this serialized
        // operation even though they retain its async context.
        scope.active = false
      }
    } finally {
      release()
      if (this.mutationQueues.get(key) === queued) {
        this.mutationQueues.delete(key)
      }
    }
  }

  /**
   * Require that a projection write is executing under this exact owner's
   * serialized mutation scope. Store-level transactions guard SQLite
   * atomicity; this guard owns the corresponding hot-state ordering.
   */
  assertMutationOwner(owner: ProjectionOwner, operation: string): void {
    const expectedKey = projectionOwnerStorageKey(owner)
    const current = this.mutationScope.getStore()
    if (!current || !current.active || current.ownerKey !== expectedKey) {
      throw new Error(
        `Context projection mutation ${operation} for ${owner.conversationId}/${owner.ownerKey} must run inside its ContextPipeline owner`
      )
    }
  }
}
