export type ContextTokenLimitSource = "requested" | "conversation_state"

export interface SessionContextWindowState {
  model: string
  contextTokenLimit?: number
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
      contextMaxMode: input.current.contextMaxMode,
    }
  }

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
      contextMaxMode: input.incoming.contextMaxMode,
    }
  }

  return {
    model,
    modelChanged,
    contextTokenLimit: modelChanged
      ? incomingLimit
      : (incomingLimit ?? input.current.contextTokenLimit),
    contextMaxMode: modelChanged
      ? (input.incoming.contextMaxMode ?? false)
      : (input.incoming.contextMaxMode ?? input.current.contextMaxMode),
  }
}
