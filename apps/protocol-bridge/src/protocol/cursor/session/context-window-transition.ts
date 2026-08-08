export type ContextTokenLimitSource = "requested" | "conversation_state"

export interface SessionContextWindowState {
  model: string
  contextTokenLimit?: number
  contextTokenLimitSource?: ContextTokenLimitSource
  contextMaxMode?: boolean
}

export interface IncomingContextWindowState {
  model?: string
  contextTokenLimit?: number
  contextTokenLimitSource?: ContextTokenLimitSource
  contextMaxMode?: boolean
}

export interface SessionContextWindowTransitionInput {
  current: SessionContextWindowState
  incoming: IncomingContextWindowState
  canRefreshProvidedFields: boolean
  canClearRequestScopedFields: boolean
}

export interface SessionContextWindowTransitionResult extends SessionContextWindowState {
  modelChanged: boolean
}

export function assertContextTokenLimitProvenance(input: {
  contextTokenLimit?: number
  contextTokenLimitSource?: ContextTokenLimitSource
}): void {
  const hasLimit = input.contextTokenLimit !== undefined
  const hasSource = input.contextTokenLimitSource !== undefined
  if (hasLimit !== hasSource) {
    throw new Error(
      "A context token limit and its protocol source must be provided together"
    )
  }
}

function normalizeModel(model: string | undefined): string | undefined {
  const normalized = model?.trim()
  return normalized || undefined
}

export function resolveSessionContextWindowTransition(
  input: SessionContextWindowTransitionInput
): SessionContextWindowTransitionResult {
  if (!input.canRefreshProvidedFields) {
    return {
      model: input.current.model,
      modelChanged: false,
      contextTokenLimit: input.current.contextTokenLimit,
      contextTokenLimitSource: input.current.contextTokenLimitSource,
      contextMaxMode: input.current.contextMaxMode,
    }
  }

  assertContextTokenLimitProvenance(input.incoming)

  const model = normalizeModel(input.incoming.model) ?? input.current.model
  const modelChanged = model !== input.current.model
  const incomingLimitBelongsToModel =
    !modelChanged || input.incoming.contextTokenLimitSource === "requested"
  const incomingLimit = incomingLimitBelongsToModel
    ? input.incoming.contextTokenLimit
    : undefined

  if (input.canClearRequestScopedFields) {
    return {
      model,
      modelChanged,
      contextTokenLimit: incomingLimit,
      contextTokenLimitSource: incomingLimit
        ? input.incoming.contextTokenLimitSource
        : undefined,
      contextMaxMode: input.incoming.contextMaxMode,
    }
  }

  const contextTokenLimit = modelChanged
    ? incomingLimit
    : (incomingLimit ?? input.current.contextTokenLimit)

  return {
    model,
    modelChanged,
    contextTokenLimit,
    contextTokenLimitSource: contextTokenLimit
      ? incomingLimit !== undefined
        ? input.incoming.contextTokenLimitSource
        : input.current.contextTokenLimitSource
      : undefined,
    contextMaxMode: modelChanged
      ? (input.incoming.contextMaxMode ?? false)
      : (input.incoming.contextMaxMode ?? input.current.contextMaxMode),
  }
}
