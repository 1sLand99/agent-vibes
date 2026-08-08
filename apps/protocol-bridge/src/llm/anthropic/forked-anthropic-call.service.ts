import { Injectable } from "@nestjs/common"
import * as crypto from "crypto"
import { requireExactDurableIdentifier } from "../../context/durable-identifier"
import { AnthropicApiService } from "./anthropic-api.service"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicForwardHeaders } from "./anthropic-api.service"
import type { AnthropicResponse } from "../../shared/anthropic"
import { adaptAnthropicMessageToCodexExecutionRequest } from "../../protocol/anthropic/codex-request-adapter"
import { KiroService } from "../aws/kiro.service"
import { GoogleService } from "../google/google.service"
import { CodexService } from "../openai/codex.service"
import { OpenaiCompatService } from "../openai/openai-compat.service"
import {
  ModelRouterService,
  type BackendType,
} from "../shared/model-router.service"
import { runProviderPhysicalDispatch } from "../shared/provider-physical-dispatch"

/**
 * Cache-safe params copied verbatim from the parent request. Kept in a
 * dedicated shape so callers cannot accidentally pass mutated fields:
 * the cache prefix the upstream sees on the fork must be byte-identical
 * to what the parent saw, otherwise prompt cache is invalidated.
 *
 * Mirror of cc's `runForkedAgent` cacheSafeParams contract:
 * claude-code/src/services/AgentSummary/agentSummary.ts.
 */
export interface ForkCacheSafeParams {
  model: string
  /** System prompt (string or array form). Cache_control already applied. */
  system: CreateMessageDto["system"]
  /** Tools schema array. Cache_control already applied. */
  tools?: CreateMessageDto["tools"]
  /** Sorted/deduped beta tokens captured at parent send time. */
  betas?: string[]
  /** Thinking config; preserved verbatim because it is part of the cache key. */
  thinking?: CreateMessageDto["thinking"]
  /** Output config (effort etc.); preserved verbatim. */
  output_config?: CreateMessageDto["output_config"]
  /** Service tier hint; preserved verbatim. */
  service_tier?: string
}

export interface ForkedCallParams {
  /**
   * Cache-safe parent snapshot. Required because the bridge does not
   * memoize a "last outbound shape" per SessionRecord — caller passes
   * what it just sent (or is about to send) to the parent.
   */
  cacheSafeParams: ForkCacheSafeParams
  /**
   * Messages to put on the wire. Typically: parent's projected message
   * prefix followed by a single new user prompt. Caller is responsible
   * for keeping the prefix identical to the parent's last outbound
   * messages so the upstream prompt cache hits.
   */
  promptMessages: CreateMessageDto["messages"]
  /** Exact parent SessionRecord.conversationId used for dispatch ownership. */
  parentSessionId: string
  /** Linked to the parent's AbortController so user cancellation propagates. */
  abortSignal?: AbortSignal
  /**
   * Hard ceiling on output tokens. Required by the Anthropic API; the
   * cache_key impact is documented in cc agentSummary.ts — keeping this
   * value fixed across forked calls is the caller's responsibility.
   */
  maxOutputTokens: number
  /**
   * Forwarded headers for the upstream request. Defaults to no extra
   * headers; usually fine because account-level headers carry auth.
   */
  forwardHeaders?: AnthropicForwardHeaders
  /** Optional override for the small-fast-model variant (haiku-class). */
  smallFastModel?: string
  /**
   * Backend that served the parent turn. The fork is
   * dispatched to the same backend so users who only have one Claude-
   * serving backend configured (e.g. Kiro-only, no Anthropic API key)
   * still get a usable inherited route.
   *
   * Backends that cannot serve Claude haiku (`codex`, `openai-compat`)
   * cause the small-fast variant to short-circuit to `null` rather than
   * silently misroute to Claude API and fail when no Claude account is
   * configured.
   */
  parentBackend: BackendType
}

export interface ForkedCallResult {
  /** Concatenated text from all assistant text blocks. */
  text: string
  /** Raw upstream response for callers that need block-level access. */
  raw: AnthropicResponse
}

/**
 * Helper that derives a one-shot Anthropic call from a parent request's
 * cache-safe shape. Used by ToolUseSummaryService and AgentSummaryService
 * to issue secondary LLM calls (short labels, periodic progress updates,
 * structured agent summaries) without busting the parent's prompt cache.
 *
 * Design parity:
 *   - cc `runForkedAgent` (claude-code/src/services/AgentSummary/agentSummary.ts):
 *     same cache-safe contract — system / tools / betas / thinking are
 *     copied verbatim from the parent, only `messages` and a fixed
 *     `max_tokens` differ.
 *   - cc `runQueryHaiku` (claude-code/src/services/api/queryHaiku.ts):
 *     same small-fast-model selection pattern; we expose it via
 *     `runForkedSmallFastCall`.
 *
 * Bridge-specific concerns:
 *   - Each fork is submitted through the shared physical-dispatch runner
 *     with one allowed attempt. Provider-specific OAuth, rate-limit,
 *     account-selection, and prompt-caching behavior remain inside that
 *     single physical dispatch; a best-effort helper call must not create
 *     a hidden retry chain alongside its parent turn.
 *   - PromptCacheBreakDetection tracking is intentionally NOT propagated
 *     into the fork: forked calls have their own cache lifetime and
 *     would otherwise inject false-positive break events into the
 *     parent's tracking key.
 *   - Failures are surfaced as thrown errors. ToolUseSummary /
 *     AgentSummary callers wrap in try/catch and downgrade to null /
 *     legacy fallback so a fork failure never breaks the parent turn.
 */
@Injectable()
export class ForkedAnthropicCallService {
  constructor(
    private readonly anthropicApi: AnthropicApiService,
    private readonly kiro: KiroService,
    private readonly google: GoogleService,
    private readonly codex: CodexService,
    private readonly openaiCompat: OpenaiCompatService,
    private readonly modelRouter: ModelRouterService
  ) {}

  /**
   * Run a one-shot Claude call using the parent's exact cache-safe
   * params.  The upstream prompt cache should hit on the system + tools
   * prefix as long as the caller passes the parent's projected message
   * history before the new prompt unchanged.
   *
   * Routes to the exact backend that served the parent turn.
   *
   * Returns `null` when the parent backend cannot serve a Claude fork
   * (`codex` / `openai-compat`).  Callers are best-effort and should
   * treat null the same as a thrown error: skip the secondary call,
   * keep the parent turn going.
   */
  async runForkedCall(
    params: ForkedCallParams
  ): Promise<ForkedCallResult | null> {
    const parentCanDispatchClaudeFork = this.assertExactParentOwnership(params)
    if (!parentCanDispatchClaudeFork) {
      return null
    }
    const dto = this.buildForkedDto(params.cacheSafeParams.model, params)
    const response = await this.dispatchClaudeFork(dto, params)
    return { text: this.extractText(response), raw: response }
  }

  /**
   * Same as `runForkedCall` but for the helper / "small-fast" slot.
   *
   * The model selection follows Cursor's `subagent_model_overrides`
   * three-state semantics:
   *
   *   - `smallFastModel` set:        a concrete pin from the
   *     subagent override map. Routed through ModelRouterService so
   *     non-Claude models (GPT-5.5, Gemini 3.x, Sonnet, ...) all
   *     dispatch to the right backend regardless of what served the
   *     parent.
   *   - `smallFastModel` undefined:  inherit-from-parent. The fork
   *     reuses the parent model verbatim and lands on the parent
   *     backend so the upstream prompt cache hits. This replaces the
   *     legacy hard-coded `claude-haiku-4-5` fallback that ignored the
   *     user's parent model selection.
   *
   * Returns `null` only when the inherit branch has no compatible parent
   * backend (e.g. a Codex parent with an Anthropic-shaped DTO). An explicit
   * model pin must resolve and dispatch or fail; callers such as
   * `ToolUseSummaryService` decide whether that optional presentation failure
   * should suppress the label.
   */
  async runForkedSmallFastCall(
    params: ForkedCallParams
  ): Promise<ForkedCallResult | null> {
    const parentCanDispatchClaudeFork = this.assertExactParentOwnership(params)
    // Concrete pin path (user selected a specific model in the
    // settings UI). Route via ModelRouterService so we honour their
    // pick across families.
    if (params.smallFastModel !== undefined) {
      const targetModel = requireExactDurableIdentifier(
        params.smallFastModel,
        "Forked call smallFastModel"
      )
      const route = this.modelRouter.resolveModel(targetModel)
      const dto = this.buildForkedDto(route.model, params)
      const response = await this.dispatchByBackend(route.backend, dto, params)
      return { text: this.extractText(response), raw: response }
    }

    // Inherit-from-parent path: reuse parent model + parent backend.
    // Yields a true cache hit because the DTO model field, system
    // prefix, and tools all stay identical to the parent's last
    // outbound shape.
    if (!parentCanDispatchClaudeFork) {
      // Parent ran on codex / openai-compat (GPT family). The fork
      // shape is Anthropic-DTO-shaped and the cache-safe params come
      // from a Claude prefix, so we have no compatible inherit target.
      // Returning null lets the caller omit this optional UI label.
      return null
    }
    const targetModel = params.cacheSafeParams.model
    const dto = this.buildForkedDto(targetModel, params)
    const response = await this.dispatchClaudeFork(dto, params)
    return { text: this.extractText(response), raw: response }
  }

  /**
   * Whether `parentBackend` can serve a
   * Claude-shaped fork at all.  Used by the inherit-from-parent path
   * of `runForkedSmallFastCall` and by `runForkedCall` (which always
   * sticks to the parent backend, since its purpose is reusing the
   * parent prompt cache).
   *
   * `codex` and `openai-compat` are excluded because their parents
   * speak GPT-family / generic OpenAI-compatible protocols.  Trying
   * to inherit a Claude DTO into them would synthesize a response
   * shape mismatch.
   */
  private canDispatchClaudeFork(backend: BackendType): boolean {
    switch (backend) {
      case "claude-api":
      case "kiro":
      case "google-claude":
      case "google":
        return true
      case "codex":
      case "openai-compat":
        return false
      default: {
        // Exhaustiveness check: future BackendType additions force a
        // compile error here. At runtime, fail closed rather than silently
        // dropping a helper call for an unknown persisted backend value.
        const _exhaustive: never = backend
        throw new Error(
          `Unknown parent backend for fork dispatch: ${String(_exhaustive)}`
        )
      }
    }
  }

  /**
   * A fork is owned by the exact already-accepted parent session and route.
   * Validate both before any branch can decide to omit the optional helper;
   * otherwise malformed persisted state could masquerade as a benign
   * unsupported-backend no-op.
   */
  private assertExactParentOwnership(params: ForkedCallParams): boolean {
    requireExactDurableIdentifier(
      params.parentSessionId,
      "Forked call parentSessionId"
    )
    return this.canDispatchClaudeFork(params.parentBackend)
  }

  private buildForkedDto(
    model: string,
    params: ForkedCallParams
  ): CreateMessageDto {
    return {
      model,
      messages: params.promptMessages,
      max_tokens: params.maxOutputTokens,
      system: params.cacheSafeParams.system,
      tools: params.cacheSafeParams.tools,
      thinking: params.cacheSafeParams.thinking,
      output_config: params.cacheSafeParams.output_config,
      service_tier: params.cacheSafeParams.service_tier,
      stream: false,
      betas: params.cacheSafeParams.betas,
    }
  }

  /**
   * Inherit-from-parent dispatch path. `parentBackend` is the source
   * of truth.
   *
   * The physical scope records local parent ownership, but forks do not pass
   * that session into provider cache telemetry. Their cache-read drops must
   * not be attributed to the parent's PromptCacheBreakDetection key.
   */
  private async dispatchClaudeFork(
    dto: CreateMessageDto,
    params: ForkedCallParams
  ): Promise<AnthropicResponse> {
    const backend = params.parentBackend
    switch (backend) {
      case "kiro":
        return runProviderPhysicalDispatch({
          plan: {
            scope: this.createForkDispatchScope("kiro", params),
            backend: "kiro",
            model: dto.model,
            request: dto,
          },
          signal: params.abortSignal,
          maxAttempts: 1,
          execute: (dispatch) => this.kiro.sendClaudeMessage(dispatch),
        })
      case "google":
      case "google-claude":
        return runProviderPhysicalDispatch({
          plan: {
            scope: this.createForkDispatchScope(backend, params),
            backend,
            model: dto.model,
            request: dto,
          },
          signal: params.abortSignal,
          maxAttempts: 1,
          execute: (dispatch) => this.google.sendClaudeMessage(dispatch),
        })
      case "claude-api":
        return runProviderPhysicalDispatch({
          plan: {
            scope: this.createForkDispatchScope("claude-api", params),
            backend: "claude-api",
            model: dto.model,
            request: dto,
          },
          signal: params.abortSignal,
          maxAttempts: 1,
          execute: (dispatch) =>
            this.anthropicApi.sendClaudeMessage(dispatch, {
              clientMode: "generic",
              forwardHeaders: params.forwardHeaders,
              abortSignal: params.abortSignal,
            }),
        })
      case "codex":
      case "openai-compat":
        // canDispatchClaudeFork() guards against this — both
        // runForkedCall and runForkedSmallFastCall short-circuit before
        // reaching the dispatcher.  Throwing keeps the contract
        // explicit instead of silently fanning out to Claude API.
        throw new Error(`Backend ${backend} cannot serve Claude fork calls`)
      default: {
        const _exhaustive: never = backend
        void _exhaustive
        throw new Error(
          `Unknown parent backend for fork dispatch: ${String(backend)}`
        )
      }
    }
  }

  /**
   * Pinned-model dispatch path. Used when the user's
   * `subagent_model_overrides` entry specifies a concrete model (which
   * may be from any family — Claude, GPT, Gemini). The backend is
   * decided by ModelRouterService rather than by the parent's
   * lastAssistantBackend.
   *
   * Every declared BackendType has one exact dispatch implementation.
   */
  private async dispatchByBackend(
    backend: BackendType,
    dto: CreateMessageDto,
    params: ForkedCallParams
  ): Promise<AnthropicResponse> {
    switch (backend) {
      case "kiro":
        return runProviderPhysicalDispatch({
          plan: {
            scope: this.createForkDispatchScope("kiro", params),
            backend: "kiro",
            model: dto.model,
            request: dto,
          },
          signal: params.abortSignal,
          maxAttempts: 1,
          execute: (dispatch) => this.kiro.sendClaudeMessage(dispatch),
        })
      case "google":
      case "google-claude":
        return runProviderPhysicalDispatch({
          plan: {
            scope: this.createForkDispatchScope(backend, params),
            backend,
            model: dto.model,
            request: dto,
          },
          signal: params.abortSignal,
          maxAttempts: 1,
          execute: (dispatch) => this.google.sendClaudeMessage(dispatch),
        })
      case "claude-api":
        return runProviderPhysicalDispatch({
          plan: {
            scope: this.createForkDispatchScope("claude-api", params),
            backend: "claude-api",
            model: dto.model,
            request: dto,
          },
          signal: params.abortSignal,
          maxAttempts: 1,
          execute: (dispatch) =>
            this.anthropicApi.sendClaudeMessage(dispatch, {
              clientMode: "generic",
              forwardHeaders: params.forwardHeaders,
              abortSignal: params.abortSignal,
            }),
        })
      case "codex": {
        const request = this.codex.prepareBridgeNativeExecutionRequest(
          adaptAnthropicMessageToCodexExecutionRequest(dto)
        )
        return runProviderPhysicalDispatch({
          plan: {
            scope: this.createForkDispatchScope("codex", params),
            backend: "codex",
            model: dto.model,
            request,
          },
          signal: params.abortSignal,
          maxAttempts: 1,
          execute: (dispatch) => this.codex.sendMessage(dispatch),
        })
      }
      case "openai-compat":
        return runProviderPhysicalDispatch({
          plan: {
            scope: this.createForkDispatchScope("openai-compat", params),
            backend: "openai-compat",
            model: dto.model,
            request: dto,
          },
          signal: params.abortSignal,
          maxAttempts: 1,
          execute: (dispatch) => this.openaiCompat.sendClaudeMessage(dispatch),
        })
      default: {
        const _exhaustive: never = backend
        throw new Error(`Unknown fork backend: ${String(_exhaustive)}`)
      }
    }
  }

  private createForkDispatchScope(
    backend: BackendType,
    params: ForkedCallParams
  ): string {
    return `forked:${backend}:${params.parentSessionId}:${crypto.randomUUID()}`
  }

  private extractText(response: AnthropicResponse): string {
    const blocks = response?.content ?? []
    const out: string[] = []
    for (const block of blocks) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        out.push((block as { text: string }).text)
      }
    }
    return out.join("").trim()
  }
}
