import { Injectable, Logger } from "@nestjs/common"

import type { BackendType } from "../../../llm/shared/model-router.service"

import { WebSearchAdapterFactory } from "./web-search.factory"
import {
  WebSearchAbortError,
  WebSearchEmptyResultError,
  type WebSearchAdapterName,
  type WebSearchOptions,
  type WebSearchResponse,
  type WebSearchResult,
} from "./types"

/**
 * Single entry point for every `web_search` invocation in the bridge.
 *
 * The connect-stream layer no longer talks to GoogleService /
 * AnthropicApiService / CodexService directly for search; it calls
 * `executeSearch(...)`, gets back a `WebSearchResponse`, and projects
 * that into the Cursor-protocol surface.
 *
 * Design contract:
 *   - exactly one adapter per call (chosen by `WebSearchAdapterFactory`);
 *   - if the adapter throws, this service propagates the error after
 *     normalising it into a stable shape;
 *   - if the caller's AbortSignal fires, this service propagates
 *     `WebSearchAbortError`;
 *   - empty results coming back from an otherwise-successful adapter
 *     are reported as a thrown error (an empty list is *never* a
 *     useful tool result for the model);
 *   - response carries `adapter` for telemetry / UI attribution and
 *     `query` for echoing back the (possibly normalised) query.
 */
@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name)

  constructor(private readonly factory: WebSearchAdapterFactory) {}

  async executeSearch(
    backend: BackendType | undefined,
    query: string,
    options: WebSearchOptions = {}
  ): Promise<WebSearchResponse> {
    const trimmed = query.trim()
    if (!trimmed) {
      throw new Error("web_search query is empty")
    }

    // Compose the caller's abortSignal (e.g. background sub-agent
    // kill_agent signal) with any pre-existing adapter signal, so a
    // killed worker stops in-flight searches without having to wait
    // for the adapter's internal timeout.
    const composedSignal = this.composeAbortSignals(
      options.signal,
      options.abortSignal
    )
    const baseOptions: WebSearchOptions = {
      ...options,
      signal: composedSignal,
      conversationId: options.conversationId,
    }

    const adapter = this.factory.selectAdapter(backend)
    let results: WebSearchResult[]
    try {
      results = await adapter.search(trimmed, baseOptions)
    } catch (err) {
      if (err instanceof WebSearchAbortError) {
        // Caller aborted; surface the abort verbatim so connect-stream
        // can short-circuit the in-flight tool call without emitting
        // a "search failed" frame.
        throw err
      }
      if (err instanceof WebSearchEmptyResultError) throw err
      const message = err instanceof Error ? err.message : String(err)
      this.logger.warn(
        `[web-search] adapter=${adapter.name} failed: ${message.slice(0, 240)}`
      )
      throw new Error(`web_search via ${adapter.name} failed: ${message}`)
    }

    if (results.length === 0) {
      throw new WebSearchEmptyResultError(
        adapter.name,
        trimmed,
        `web_search via ${adapter.name} returned no results for query "${trimmed.slice(0, 80)}"`
      )
    }

    return {
      adapter: adapter.name,
      query: trimmed,
      results,
    }
  }

  /**
   * Combine zero, one, or two `AbortSignal`s into a single signal that
   * fires as soon as any input fires. Returns undefined when no
   * signals are provided so the adapter sees the original "no
   * cancellation" semantic.
   */
  private composeAbortSignals(
    a: AbortSignal | undefined,
    b: AbortSignal | undefined
  ): AbortSignal | undefined {
    if (!a && !b) return undefined
    if (a && !b) return a
    if (!a && b) return b
    return AbortSignal.any([a as AbortSignal, b as AbortSignal])
  }

  /**
   * Pure helper: report which adapter the factory would pick for a
   * given backend right now, without running a search. Useful for
   * startup banners and the `kv_get adapter_state` debug surface.
   */
  describeRoute(backend: BackendType | undefined): WebSearchAdapterName {
    return this.factory.selectAdapter(backend).name
  }
}
