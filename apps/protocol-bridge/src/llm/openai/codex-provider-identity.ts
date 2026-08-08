import { v7 as uuidv7 } from "uuid"

/**
 * The Responses API treats a root session and its execution thread as one
 * native identity. Keep both fields explicit even though a newly-created
 * root starts with the same UUID in each field: child threads inherit the
 * session id while receiving a different thread id.
 */
export interface CodexRootProviderIdentity {
  sessionId: string
  threadId: string
  threadSource: "user"
}

/**
 * Codex uses `ThreadSpawn` for an independently executing delegated agent.
 * These values are the exact projections emitted by the native runtime's
 * `subagent_header_value` and `subagent_metadata_kind` helpers.
 */
export const CODEX_THREAD_SPAWN_SUBAGENT_HEADER = "collab_spawn" as const
export const CODEX_THREAD_SPAWN_SUBAGENT_KIND = "thread_spawn" as const

export interface CodexSubagentProviderIdentity {
  /** Shared root Codex session; never a bridge conversation or projection key. */
  sessionId: string
  /** Stable child Codex thread, generated exactly once for the durable run. */
  threadId: string
  /** The root Codex thread that spawned this child. */
  parentThreadId: string
  subagentHeader: typeof CODEX_THREAD_SPAWN_SUBAGENT_HEADER
  subagentKind: typeof CODEX_THREAD_SPAWN_SUBAGENT_KIND
  threadSource: "subagent"
}

export type CodexProviderIdentity =
  | CodexRootProviderIdentity
  | CodexSubagentProviderIdentity

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Generate the native UUIDv7 thread ids accepted by Codex's ThreadId
 * constructor. The generator injection keeps the boundary testable while
 * production always delegates UUID construction to the maintained uuid v11
 * implementation.
 */
export function createCodexUuidV7(generate: () => string = uuidv7): string {
  const id = generate()
  assertCodexUuidV7(id, "Generated Codex thread id")
  return id
}

export function createCodexRootProviderIdentity(): CodexRootProviderIdentity {
  const rootThreadId = createCodexUuidV7()
  return {
    sessionId: rootThreadId,
    threadId: rootThreadId,
    threadSource: "user",
  }
}

export function createCodexSubagentProviderIdentity(
  root: CodexRootProviderIdentity
): CodexSubagentProviderIdentity {
  assertCodexRootProviderIdentity(root)
  return {
    sessionId: root.sessionId,
    threadId: createCodexUuidV7(),
    parentThreadId: root.threadId,
    subagentHeader: CODEX_THREAD_SPAWN_SUBAGENT_HEADER,
    subagentKind: CODEX_THREAD_SPAWN_SUBAGENT_KIND,
    threadSource: "subagent",
  }
}

export function assertCodexRootProviderIdentity(
  value: unknown
): asserts value is CodexRootProviderIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex root provider identity must be an object")
  }
  assertExactIdentityFields(
    value,
    ["sessionId", "threadId", "threadSource"],
    "Codex root provider identity"
  )
  const identity = value as Partial<CodexRootProviderIdentity>
  assertCodexUuidV7(identity.sessionId, "Codex root sessionId")
  assertCodexUuidV7(identity.threadId, "Codex root threadId")
  if (identity.sessionId !== identity.threadId) {
    throw new Error(
      "Codex root provider identity must use its root thread as sessionId"
    )
  }
  if (identity.threadSource !== "user") {
    throw new Error("Codex root provider identity must have threadSource=user")
  }
}

export function assertCodexSubagentProviderIdentity(
  value: unknown
): asserts value is CodexSubagentProviderIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex subagent provider identity must be an object")
  }
  assertExactIdentityFields(
    value,
    [
      "sessionId",
      "threadId",
      "parentThreadId",
      "subagentHeader",
      "subagentKind",
      "threadSource",
    ],
    "Codex subagent provider identity"
  )
  const identity = value as Partial<CodexSubagentProviderIdentity>
  assertCodexUuidV7(identity.sessionId, "Codex subagent sessionId")
  assertCodexUuidV7(identity.threadId, "Codex subagent threadId")
  assertCodexUuidV7(identity.parentThreadId, "Codex subagent parentThreadId")
  if (identity.threadId === identity.parentThreadId) {
    throw new Error(
      "Codex subagent threadId must differ from its parentThreadId"
    )
  }
  if (identity.sessionId !== identity.parentThreadId) {
    throw new Error(
      "Codex subagent sessionId must equal its root parentThreadId"
    )
  }
  if (identity.subagentHeader !== CODEX_THREAD_SPAWN_SUBAGENT_HEADER) {
    throw new Error(
      `Codex subagentHeader must be ${CODEX_THREAD_SPAWN_SUBAGENT_HEADER}`
    )
  }
  if (identity.subagentKind !== CODEX_THREAD_SPAWN_SUBAGENT_KIND) {
    throw new Error(
      `Codex subagentKind must be ${CODEX_THREAD_SPAWN_SUBAGENT_KIND}`
    )
  }
  if (identity.threadSource !== "subagent") {
    throw new Error("Codex subagent identity must have threadSource=subagent")
  }
}

export function assertCodexProviderIdentity(
  value: unknown
): asserts value is CodexProviderIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex provider identity must be an object")
  }
  const threadSource = (value as { threadSource?: unknown }).threadSource
  if (threadSource === "user") {
    assertCodexRootProviderIdentity(value)
    return
  }
  if (threadSource === "subagent") {
    assertCodexSubagentProviderIdentity(value)
    return
  }
  throw new Error("Codex provider identity has an unsupported threadSource")
}

export function isCodexUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_PATTERN.test(value)
}

function assertCodexUuidV7(
  value: unknown,
  label: string
): asserts value is string {
  if (!isCodexUuidV7(value)) {
    throw new Error(`${label} must be a UUIDv7`)
  }
}

function assertExactIdentityFields(
  value: object,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((field, index) => field !== wanted[index])
  ) {
    throw new Error(`${label} has an invalid field shape`)
  }
}
