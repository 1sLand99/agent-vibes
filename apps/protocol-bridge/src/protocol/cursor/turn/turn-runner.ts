import type { TurnHandle } from "./turn-handle"
import type { TurnTerminalResult } from "./turn.types"

/**
 * The single contract every turn-shape implements. A runner's only
 * job is to: read inputs from its constructor, observe `handle.signal`
 * for cancellation, emit frames via `handle.outbound!.write(...)`, and
 * resolve with a terminal result.
 *
 * `run()` MUST resolve. It must NOT throw — runners that hit
 * exceptions translate them to `{ status: "failed", error }` and
 * return normally. The supervisor treats a thrown promise as a bug
 * and logs it loudly; behaviourally it is also coerced to `failed`.
 *
 * `run()` MUST NOT push or pop the writer stack itself. The
 * supervisor wraps the call in `withWriter(...)` so symmetry is
 * preserved across throws.
 */
export interface TurnRunner {
  /**
   * Diagnostic name. Shown in logs and traces. Convention:
   * `<turn-kind>:<purpose>` e.g. `user:chat`, `synthetic-compaction:summary`.
   */
  readonly displayName: string

  /**
   * Execute the turn against the supplied handle. Resolves with the proposed
   * terminal result. The lifecycle uses an explicit `handle.reportTerminal()`
   * proposal when present, then commits the final externally-visible result
   * only after required finalization completes.
   */
  run(handle: TurnHandle): Promise<TurnTerminalResult>
}
