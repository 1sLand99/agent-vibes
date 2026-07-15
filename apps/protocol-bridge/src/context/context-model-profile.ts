export type ContextModelFamily = "claude" | "gpt" | "gemini" | "unknown"

export type ContextTokenizer = "claude" | "openai" | "conservative"

export interface ContextModelProfileInput {
  backend: string
  model?: string
  family: ContextModelFamily
  maxTokens: number
}

export interface ContextModelProfile {
  key: string
  backend: string
  model: string
  family: ContextModelFamily
  tokenizer: ContextTokenizer
  maxTokens: number
}

export interface ContextProjectionBudgetSignatureInput {
  maxTokens: number
  systemPromptTokens: number
  autoCompactTokenLimit?: number
  predictiveCompactTokenLimit?: number
  contextProfile: ContextModelProfile
}

function normalizeProfilePart(value: string | undefined): string {
  return value?.trim().toLowerCase() || "unknown"
}

export function resolveContextTokenizer(
  family: ContextModelFamily
): ContextTokenizer {
  if (family === "gpt") return "openai"
  if (family === "claude") return "claude"
  return "conservative"
}

export function resolveContextModelProfile(
  input: ContextModelProfileInput
): ContextModelProfile {
  const backend = normalizeProfilePart(input.backend)
  const model = normalizeProfilePart(input.model)
  const maxTokens = Math.max(1, Math.floor(input.maxTokens))
  const tokenizer = resolveContextTokenizer(input.family)

  return {
    key: [backend, model, input.family, tokenizer, maxTokens].join(":"),
    backend,
    model,
    family: input.family,
    tokenizer,
    maxTokens,
  }
}

export function buildContextProjectionBudgetSignature(
  input: ContextProjectionBudgetSignatureInput
): string {
  return [
    input.contextProfile.key,
    input.maxTokens,
    input.systemPromptTokens,
    input.autoCompactTokenLimit ?? "",
    input.predictiveCompactTokenLimit ?? "",
  ].join("|")
}

export function isContextAccountingProfileCompatible(
  storedProfileKey: string | undefined,
  currentProfileKey: string
): boolean {
  return storedProfileKey === currentProfileKey
}
