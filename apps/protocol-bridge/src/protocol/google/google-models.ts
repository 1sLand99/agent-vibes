import { resolveCloudCodeModel } from "../../llm/shared/model-registry"

interface BridgeModel {
  id?: string
  object?: string
  created_at?: number
  owned_by?: string
  type?: string
  display_name?: string
  max_input_tokens?: number
}

interface BridgeModelList {
  data?: BridgeModel[]
}

export interface GoogleModel {
  name: string
  version: string
  displayName: string
  description: string
  inputTokenLimit: number
  outputTokenLimit: number
  supportedGenerationMethods: string[]
  temperature?: number
  topP?: number
  topK?: number
  maxTemperature?: number
}

export interface GoogleListModelsResponse {
  models: GoogleModel[]
  nextPageToken?: string
}

export function normalizeGoogleModelId(model: string): string {
  return model.replace(/^models\//, "").trim()
}

export function isGoogleModelsListRequest(
  googleApiKeyHeader?: string,
  queryKey?: string
): boolean {
  return Boolean(
    (typeof googleApiKeyHeader === "string" && googleApiKeyHeader.trim()) ||
    (typeof queryKey === "string" && queryKey.trim())
  )
}

function isGeminiModel(id: string): boolean {
  const resolved = resolveCloudCodeModel(id)
  return resolved?.family === "gemini" || id.startsWith("gemini-")
}

function toGoogleModel(model: BridgeModel): GoogleModel | null {
  if (!model.id || !isGeminiModel(model.id)) return null

  const resolved = resolveCloudCodeModel(model.id)
  const displayName = model.display_name || resolved?.displayName || model.id
  return {
    name: `models/${model.id}`,
    version: model.id,
    displayName,
    description: `${displayName} served by Agent Vibes`,
    inputTokenLimit: model.max_input_tokens || 1048576,
    outputTokenLimit: 65536,
    supportedGenerationMethods: ["generateContent", "countTokens"],
    temperature: 1,
    topP: 0.95,
    topK: 64,
    maxTemperature: 2,
  }
}

export function bridgeModelsToGoogleModels(
  bridgeModels: BridgeModelList
): GoogleListModelsResponse {
  const models = (bridgeModels.data || [])
    .map(toGoogleModel)
    .filter((model): model is GoogleModel => model !== null)

  return { models }
}

export function findGoogleModel(
  bridgeModels: BridgeModelList,
  requestedModel: string
): GoogleModel | null {
  const normalized = normalizeGoogleModelId(requestedModel)
  return (
    bridgeModelsToGoogleModels(bridgeModels).models.find(
      (model) => normalizeGoogleModelId(model.name) === normalized
    ) || null
  )
}
