/**
 * Cursor has several IDs in play for every client-executed tool.  They are
 * intentionally represented as separate optional fields: equal values are a
 * runtime fact recorded by a dispatcher, never an inference made by parsing.
 */
export interface CursorExecIdMapping {
  /** Connection/stream generation that owns the dispatch. */
  streamEpoch?: string
  /** ExecServerMessage.id <-> ExecClientMessage.id. */
  numericId: number
  /**
   * ExecServerMessage.exec_id when the client echoed it. Cursor always pairs
   * an ExecClientMessage to its server envelope through `numericId`; current
   * clients omit exec_id on some result variants (including pi_ls_result).
   */
  execId?: string
  /** Cursor ToolCall / tool args identifier when the dispatch recorded one. */
  toolCallId?: string
  /** Provider function-call identifier when applicable. */
  callId?: string
  /** Provider model response item identifier when applicable. */
  modelCallId?: string
}

export interface CursorExecDispatchRecord extends CursorExecIdMapping {
  direction: "server_dispatch"
  execId: string
  toolFamily: string
  issuedAtMs: number
}

export interface CursorExecResultRecord extends CursorExecIdMapping {
  direction: "client_result"
  resultCase: string
  receivedAtMs: number
}

export type CursorExecIdentityValidation =
  | { ok: true }
  | { ok: false; reason: "invalid_exec_id" | "invalid_numeric_id" }

export function validateCursorExecResultIdentity(
  identity: Pick<CursorExecIdMapping, "numericId" | "execId">
): CursorExecIdentityValidation {
  if (
    identity.execId !== undefined &&
    (identity.execId.length === 0 ||
      identity.execId !== identity.execId.trim() ||
      identity.execId.includes("\u0000"))
  ) {
    return { ok: false, reason: "invalid_exec_id" }
  }
  if (!Number.isSafeInteger(identity.numericId) || identity.numericId <= 0) {
    return { ok: false, reason: "invalid_numeric_id" }
  }
  return { ok: true }
}

/**
 * Build a client-result record without fabricating a Cursor ToolCall or model
 * ID. The session dispatch ledger is the only component allowed to attach
 * those extra IDs after a real dispatch lookup.
 */
export function createCursorExecResultRecord(input: {
  numericId: number
  execId?: string
  resultCase: string
  receivedAtMs?: number
}): CursorExecResultRecord {
  return {
    direction: "client_result",
    numericId: input.numericId,
    ...(input.execId ? { execId: input.execId } : {}),
    resultCase: input.resultCase,
    receivedAtMs: input.receivedAtMs ?? Date.now(),
  }
}

export function createCursorExecDispatchRecord(input: {
  streamEpoch?: string
  numericId: number
  execId: string
  toolCallId?: string
  callId?: string
  modelCallId?: string
  toolFamily: string
  issuedAtMs?: number
}): CursorExecDispatchRecord {
  return {
    direction: "server_dispatch",
    streamEpoch: input.streamEpoch,
    numericId: input.numericId,
    execId: input.execId,
    toolCallId: input.toolCallId,
    callId: input.callId,
    modelCallId: input.modelCallId,
    toolFamily: input.toolFamily,
    issuedAtMs: input.issuedAtMs ?? Date.now(),
  }
}
