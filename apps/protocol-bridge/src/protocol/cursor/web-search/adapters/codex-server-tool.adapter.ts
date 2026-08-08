import { Logger } from "@nestjs/common"

import { CodexService } from "../../../../llm/openai/codex.service"
import {
  applyDomainFilters,
  WebSearchEmptyResultError,
  type WebSearchAdapter,
  type WebSearchAdapterName,
  type WebSearchOptions,
  type WebSearchResult,
  throwIfAborted,
} from "../types"

/**
 * OpenAI Codex standalone web-search adapter.
 *
 * Mirrors codex-rs standalone web search: one typed `alpha/search` request
 * returns structured result DTOs out-of-band from the model-facing output.
 *
 * Selected for official `codex` backend sessions by default. OpenAI-
 * compatible / reverse endpoints default to Exa MCP instead because they
 * frequently degrade native web_search into slow text-only summaries without
 * parseable sources. Available iff `CodexService` reports configured account
 * credentials.
 */
export class CodexServerToolAdapter implements WebSearchAdapter {
  private readonly logger = new Logger(CodexServerToolAdapter.name)
  readonly name: WebSearchAdapterName = "codex-server-tool"

  constructor(private readonly codex: CodexService) {}

  isAvailable(): boolean {
    return this.codex.isAvailable()
  }

  async search(
    query: string,
    options: WebSearchOptions
  ): Promise<WebSearchResult[]> {
    throwIfAborted(options.signal)
    options.onProgress?.({ type: "query_update", query })

    const grounded = await this.codex.executeWebSearch({
      query,
      model: options.model,
      conversationId: options.conversationId,
      signal: options.signal,
      allowedDomains: options.allowedDomains,
      blockedDomains: options.blockedDomains,
      searchType: options.searchType,
    })

    throwIfAborted(options.signal)

    const raw: WebSearchResult[] = grounded.references.map((ref) => ({
      title: ref.title || ref.url,
      url: ref.url,
      snippet: ref.chunk || undefined,
      chunk: ref.chunk || undefined,
    }))

    const filtered = applyDomainFilters(raw, options)
    const limit = options.numResults ?? 8
    const trimmed =
      Number.isFinite(limit) && limit > 0 ? filtered.slice(0, limit) : filtered

    options.onProgress?.({
      type: "search_results_received",
      query,
      resultCount: trimmed.length,
    })

    const summaryText = grounded.text.trim()

    if (trimmed.length === 0) {
      this.logger.warn(
        `[codex-server-tool] no parseable sources ` +
          `(summary=${summaryText.length > 0 ? "present" : "empty"}, ` +
          `query="${query.slice(0, 80)}")`
      )
      throw new WebSearchEmptyResultError(
        this.name,
        query,
        summaryText.length > 0
          ? "codex-server-tool returned output without structured search results"
          : "codex-server-tool returned no structured search results"
      )
    }

    return trimmed
  }
}
