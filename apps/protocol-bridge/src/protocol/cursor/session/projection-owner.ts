import type { ConversationId, TurnId } from "../turn/turn.types"
import type { SubagentGraphIdentity } from "./subagent-graph"

export const MAIN_PROJECTION_OWNER_KEY = "main" as const

export interface MainProjectionOwner {
  readonly kind: "main"
  readonly conversationId: ConversationId
  readonly ownerKey: typeof MAIN_PROJECTION_OWNER_KEY
}

export interface SubagentProjectionOwner {
  readonly kind: "subagent"
  readonly conversationId: ConversationId
  readonly ownerKey: `subagent:${string}`
  readonly agentId: string
  readonly threadId: string
  readonly branchId: string
  readonly forkSourceUuid: string
  readonly forkLineage: readonly string[]
}

export type ProjectionOwner = MainProjectionOwner | SubagentProjectionOwner

/**
 * Read receipt for a mounted child projection.  The static owner identifies
 * the branch; this snapshot proves which durable tail and execution lease the
 * in-memory projection was derived from.
 */
export interface SubagentProjectionBranchSnapshot {
  readonly headUuid: string
  readonly headRevision: number
  readonly executionTurnId: TurnId
}

export type ProjectionProvider = "claude" | "codex"

/**
 * Claude has one durable conversation-layout namespace per graph owner. The
 * value is a local storage coordinate, never an upstream Claude session id.
 */
export const CLAUDE_CONVERSATION_PROJECTION_LOCAL_KEY = "conversation" as const

export interface ProviderProjectionRef {
  readonly owner: ProjectionOwner
  readonly provider: ProjectionProvider
  readonly localKey: string
}

function requireIdentity(value: string, label: string): string {
  if (!value || value.trim() !== value || value.includes("\u0000")) {
    throw new Error(
      `${label} must be a canonical non-empty identity without surrounding whitespace or NUL bytes`
    )
  }
  return value
}

export function createMainProjectionOwner(
  conversationId: ConversationId
): MainProjectionOwner {
  requireConversationId(conversationId)
  return {
    kind: "main",
    conversationId,
    ownerKey: MAIN_PROJECTION_OWNER_KEY,
  }
}

export function createSubagentProjectionOwner(input: {
  conversationId: ConversationId
  agentId: string
  threadId: string
  branchId: string
  forkSourceUuid: string
  forkLineage: readonly string[]
}): SubagentProjectionOwner {
  const conversationId = requireConversationId(input.conversationId)
  const agentId = requireIdentity(input.agentId, "agentId")
  const threadId = requireIdentity(input.threadId, "threadId")
  const branchId = requireIdentity(input.branchId, "branchId")
  const forkSourceUuid = requireIdentity(input.forkSourceUuid, "forkSourceUuid")
  const forkLineage = input.forkLineage.map((entry, index) =>
    requireIdentity(entry, `forkLineage[${index}]`)
  )
  if (forkLineage.at(-1) !== forkSourceUuid) {
    throw new Error(
      "Subagent projection owner fork lineage must end at forkSourceUuid"
    )
  }
  return {
    kind: "subagent",
    conversationId,
    ownerKey: encodeSubagentOwnerKey({
      agentId,
      threadId,
      branchId,
      forkSourceUuid,
      forkLineage,
    }),
    agentId,
    threadId,
    branchId,
    forkSourceUuid,
    forkLineage,
  }
}

/**
 * Construct the owner from a branch identity already accepted by the durable
 * subagent graph authority. Callers that only have arbitrary strings must not
 * recreate this tuple themselves.
 */
export function createSubagentProjectionOwnerFromBranch(
  branch: SubagentGraphIdentity
): SubagentProjectionOwner {
  return createSubagentProjectionOwner({
    conversationId: branch.conversationId,
    agentId: branch.agentId,
    threadId: branch.threadId,
    branchId: branch.branchId,
    forkSourceUuid: branch.forkSourceUuid,
    forkLineage: branch.forkLineage,
  })
}

export function createProviderProjectionRef(input: {
  owner: ProjectionOwner
  provider: ProjectionProvider
  localKey: string
}): ProviderProjectionRef {
  assertProjectionOwner(input.owner, "createProviderProjectionRef")
  if (input.provider !== "claude" && input.provider !== "codex") {
    throw new Error("provider must be claude or codex")
  }
  return {
    owner: input.owner,
    provider: input.provider,
    localKey: requireIdentity(input.localKey, "provider localKey"),
  }
}

/**
 * Reconstruct the only valid Claude projection reference from a durable graph
 * source. `session_messages.provider` stores the logical provider that
 * accepted the assistant tool_use; transport backend/account selection never
 * participates in this identity.
 */
export function createClaudeProjectionRefFromGraphProvider(
  owner: ProjectionOwner,
  provider: string | undefined
): ProviderProjectionRef {
  if (provider !== "claude") {
    throw new Error(
      `Claude projection source provider must be claude, received ${provider ?? "missing"}`
    )
  }
  return createProviderProjectionRef({
    owner,
    provider: "claude",
    localKey: CLAUDE_CONVERSATION_PROJECTION_LOCAL_KEY,
  })
}

export function assertProjectionOwner(
  owner: ProjectionOwner,
  operation: string
): void {
  const conversationId = requireConversationId(owner.conversationId)
  if (owner.kind === "main") {
    const ownerKey: string = owner.ownerKey
    if (ownerKey !== MAIN_PROJECTION_OWNER_KEY) {
      throw new Error(
        `${operation}: main projection owner must use ${MAIN_PROJECTION_OWNER_KEY}`
      )
    }
    return
  }
  const agentId = requireIdentity(owner.agentId, "agentId")
  const threadId = requireIdentity(owner.threadId, "threadId")
  const branchId = requireIdentity(owner.branchId, "branchId")
  const forkSourceUuid = requireIdentity(owner.forkSourceUuid, "forkSourceUuid")
  const forkLineage = owner.forkLineage.map((entry, index) =>
    requireIdentity(entry, `forkLineage[${index}]`)
  )
  if (forkLineage.at(-1) !== forkSourceUuid) {
    throw new Error(
      `${operation}: subagent projection owner fork lineage must end at forkSourceUuid`
    )
  }
  const expectedOwnerKey = encodeSubagentOwnerKey({
    agentId,
    threadId,
    branchId,
    forkSourceUuid,
    forkLineage,
  })
  if (owner.ownerKey !== expectedOwnerKey) {
    throw new Error(
      `${operation}: subagent projection owner key does not match its branch identity`
    )
  }
  if (owner.conversationId !== conversationId) {
    throw new Error(
      `${operation}: projection owner has an invalid conversation`
    )
  }
}

export function assertProviderProjectionRef(
  ref: ProviderProjectionRef,
  operation: string
): void {
  assertProjectionOwner(ref.owner, operation)
  if (ref.provider !== "claude" && ref.provider !== "codex") {
    throw new Error(`${operation}: invalid projection provider`)
  }
  requireIdentity(ref.localKey, "provider localKey")
}

export function projectionOwnerStorageKey(owner: ProjectionOwner): string {
  assertProjectionOwner(owner, "projectionOwnerStorageKey")
  return `${owner.conversationId}\u0000${owner.ownerKey}`
}

export function providerProjectionStorageKey(
  ref: ProviderProjectionRef
): string {
  assertProviderProjectionRef(ref, "providerProjectionStorageKey")
  return `${projectionOwnerStorageKey(ref.owner)}\u0000${ref.provider}\u0000${ref.localKey}`
}

export function assertSameProjectionOwner(
  expected: ProjectionOwner,
  actual: ProjectionOwner,
  operation: string
): void {
  assertProjectionOwner(expected, operation)
  assertProjectionOwner(actual, operation)
  if (
    expected.conversationId !== actual.conversationId ||
    expected.ownerKey !== actual.ownerKey ||
    expected.kind !== actual.kind
  ) {
    throw new Error(
      `${operation}: projection owner mismatch expected=${expected.conversationId}/${expected.ownerKey} ` +
        `actual=${actual.conversationId}/${actual.ownerKey}`
    )
  }
  if (expected.kind === "subagent" && actual.kind === "subagent") {
    if (
      expected.agentId !== actual.agentId ||
      expected.threadId !== actual.threadId ||
      expected.branchId !== actual.branchId ||
      expected.forkSourceUuid !== actual.forkSourceUuid ||
      expected.forkLineage.length !== actual.forkLineage.length ||
      expected.forkLineage.some(
        (entry, index) => entry !== actual.forkLineage[index]
      )
    ) {
      throw new Error(
        `${operation}: subagent projection branch identity mismatch`
      )
    }
  }
}

function requireConversationId(conversationId: ConversationId): ConversationId {
  requireIdentity(String(conversationId), "conversationId")
  return conversationId
}

function encodeSubagentOwnerKey(input: {
  agentId: string
  threadId: string
  branchId: string
  forkSourceUuid: string
  forkLineage: readonly string[]
}): `subagent:${string}` {
  const encoded = Buffer.from(
    JSON.stringify([
      input.agentId,
      input.threadId,
      input.branchId,
      input.forkSourceUuid,
      input.forkLineage,
    ]),
    "utf8"
  ).toString("base64url")
  return `subagent:${encoded}`
}
