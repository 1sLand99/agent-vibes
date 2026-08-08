import type { CodexProviderIdentity } from "./codex-provider-identity"

export interface CodexStandaloneSearchRequest {
  readonly model: string
  readonly localProjectionKey: string
  readonly upstreamIdentity: CodexProviderIdentity
  readonly search: {
    readonly id: string
    readonly model: string
    readonly input: readonly [
      {
        readonly type: "message"
        readonly role: "user"
        readonly content: readonly [
          { readonly type: "input_text"; readonly text: string },
        ]
      },
    ]
    readonly commands: {
      readonly search_query: readonly [{ readonly q: string }]
      readonly response_length: "short"
    }
    readonly settings: {
      readonly search_context_size: "low" | "medium" | "high"
      readonly filters?: {
        readonly allowed_domains?: readonly string[]
        readonly blocked_domains?: readonly string[]
      }
      readonly allowed_callers: readonly ["direct"]
      readonly external_web_access: true
    }
  }
}

export interface CodexStandaloneSearchResult {
  readonly text: string
  readonly references: Array<{
    title: string
    url: string
    chunk: string
  }>
}

export function buildCodexStandaloneSearchRequest(input: {
  readonly query: string
  readonly model: string
  readonly conversationId: string
  readonly upstreamIdentity: CodexProviderIdentity
  readonly allowedDomains?: readonly string[]
  readonly blockedDomains?: readonly string[]
  readonly searchType?: "auto" | "fast" | "deep"
}): CodexStandaloneSearchRequest {
  const allowedDomains = canonicalDomains(input.allowedDomains)
  const blockedDomains = canonicalDomains(input.blockedDomains)
  const filters =
    allowedDomains.length > 0 || blockedDomains.length > 0
      ? {
          ...(allowedDomains.length > 0
            ? { allowed_domains: allowedDomains }
            : {}),
          ...(blockedDomains.length > 0
            ? { blocked_domains: blockedDomains }
            : {}),
        }
      : undefined

  return {
    model: input.model,
    localProjectionKey: input.conversationId,
    upstreamIdentity: input.upstreamIdentity,
    search: {
      id: input.conversationId,
      model: input.model,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: input.query }],
        },
      ],
      commands: {
        search_query: [{ q: input.query }],
        response_length: "short",
      },
      settings: {
        search_context_size:
          input.searchType === "fast"
            ? "low"
            : input.searchType === "deep"
              ? "high"
              : "medium",
        ...(filters ? { filters } : {}),
        allowed_callers: ["direct"],
        external_web_access: true,
      },
    },
  }
}

export function decodeCodexStandaloneSearchResponse(
  value: unknown
): CodexStandaloneSearchResult {
  const response = requireRecord(value, "Codex standalone search response")
  if (typeof response.output !== "string") {
    throw new Error("Codex standalone search response.output must be text")
  }
  if (response.results !== undefined && !Array.isArray(response.results)) {
    throw new Error("Codex standalone search response.results must be an array")
  }

  const references: CodexStandaloneSearchResult["references"] = []
  const seenUrls = new Set<string>()
  for (const [index, value] of (response.results ?? []).entries()) {
    const result = requireRecord(
      value,
      `Codex standalone search response.results[${index}]`
    )
    if (result.type !== "text_result") continue

    const url = requireHttpUrl(
      result.url,
      `Codex standalone search response.results[${index}].url`
    )
    if (seenUrls.has(url)) continue
    seenUrls.add(url)
    const title = optionalText(result.title) || url
    const snippet = optionalText(result.snippet)
    references.push({ title, url, chunk: snippet })
  }

  return { text: response.output.trim(), references }
}

function canonicalDomains(values: readonly string[] | undefined): string[] {
  if (!values) return []
  return Array.from(
    new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))
  )
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function requireHttpUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty URL`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute URL`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`)
  }
  return parsed.toString()
}
