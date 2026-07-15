import { getTokenizer } from "@anthropic-ai/tokenizer"
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"
import { encoding_for_model } from "tiktoken"
import type { Tiktoken } from "tiktoken/lite"
import type { ContextTokenizer } from "./context-model-profile"
import {
  ContentBlock,
  isCacheEditsBlock,
  UnifiedMessage,
  isImageBlock,
  isTextBlock,
  isThinkingBlock,
  isToolResultBlock,
  isToolUseBlock,
  normalizeContent,
} from "./types"

/**
 * Token Counter Service
 *
 * Provides accurate token counting for unified messages.
 * Uses tiktoken cl100k_base encoding with Claude correction factor.
 *
 * Key features:
 * - Accurate token counting using tiktoken
 * - Handles both string and array content formats
 * - Handles JSON string content (Cursor client sends content as JSON strings)
 * - Counts tool_use, tool_result, and tool_calls properly
 * - Image token estimation
 *
 * Lifecycle:
 * - `onModuleInit` lazily loads the WASM-backed tokenizer.
 * - `onModuleDestroy` releases the native handle so Nest reloads don't
 *   leak heap.  Without this, repeated module init/destroy cycles (tests,
 *   hot-reload, dynamic module rebuilds) accumulate WASM memory because
 *   `@anthropic-ai/tokenizer.getTokenizer()` allocates fresh native state
 *   on every call.
 */
/**
 * Per-message token cache entry.
 *
 * Stored on a WeakMap<UnifiedMessage, MessageTokenCacheEntry>.  Validity is
 * checked by reference equality on the four fields that contribute to the
 * raw token count: `content`, `tool_calls`, `tool_call_id`, and `role`.  If
 * any of those references differ from what was cached, the cache misses and
 * we recompute (this is what makes the cache safe under in-place mutation:
 * mutators that replace `content` invalidate; mutators that mutate the
 * existing array/string in place would silently desync, but the bridge
 * codebase consistently replaces these fields rather than mutating them in
 * place — `applySendTimeSanitize` builds fresh `project()` output,
 * `addMessage`/`appendToolResultWithIntegrity` create new objects).
 */
interface MessageTokenCacheEntry {
  contentRef: unknown
  toolCallsRef: UnifiedMessage["tool_calls"]
  toolCallIdRef: UnifiedMessage["tool_call_id"] | undefined
  roleRef: UnifiedMessage["role"]
  rawTokensByTokenizer: Partial<Record<ContextTokenizer, number>>
}

@Injectable()
export class TokenCounterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TokenCounterService.name)
  private encoder: Tiktoken | null = null
  private openaiEncoder: Tiktoken | null = null

  // Claude tokenizer: exact match — no correction needed
  private readonly CLAUDE_CORRECTION_FACTOR = 1.0

  // Base tokens per message (role, separators, message structure)
  private readonly TOKENS_PER_MESSAGE = 4

  // Image token estimates
  private readonly TOKENS_PER_IMAGE = 128

  // Tool overhead tokens
  private readonly TOKENS_PER_TOOL_CALL = 20
  private readonly TOKENS_PER_TOOL_RESULT = 10

  /**
   * Per-message raw-token cache.  Keyed by message object identity; entries
   * carry a snapshot of the references that contribute to the count so we
   * can detect content replacement and recompute.  Entries naturally drop
   * out as messages are GC'd from session histories.
   *
   * Cache hits short-circuit the full `countMessage` walk (which calls into
   * tiktoken for every text/JSON segment).  On a 100-message history this
   * is the difference between O(n) tokenizer invocations per turn and
   * O(1) lookups for unchanged history plus O(1 new message) for the tail.
   */
  private readonly messageTokenCache: WeakMap<
    UnifiedMessage,
    MessageTokenCacheEntry
  > = new WeakMap()

  /**
   * Bounded LRU for `countText` on long strings.  System prompts (typically
   * 8–15 KB) and tool input_schema serializations are recomputed on every
   * tool-continuation by `resolveMessageBudget` → `countSystemPromptTokens`
   * / `countJsonValue`; tokenizing 10 KB through tiktoken is a non-trivial
   * fraction of `prepare_context_ms`.
   *
   * Threshold of 128 chars keeps role/name/tool_use_id strings out of the
   * cache (they're cheap to tokenize and would dominate insert churn).
   * Bound of 64 entries comfortably covers per-turn unique long strings
   * across concurrent sessions while keeping retained heap small (≤~1 MB
   * worst case).
   */
  private readonly LONG_TEXT_CACHE_THRESHOLD_CHARS = 128
  private readonly LONG_TEXT_CACHE_MAX_ENTRIES = 64
  private readonly longTextRawTokenCache: Map<string, number> = new Map()

  /**
   * Per-object JSON-token cache for `countJsonValue`.  Tool definition
   * arrays and tool input schemas pass through here and recur identically
   * across every tool-continuation in a turn (the array reference is
   * captured in a closure and reused).  Keyed by object identity, so the
   * cache is automatically invalidated when callers rebuild the tools
   * array.
   */
  private readonly jsonValueRawTokenCache: WeakMap<
    object,
    Partial<Record<ContextTokenizer, number>>
  > = new WeakMap()

  private safeJsonStringify(value: unknown): string {
    const seen = new WeakSet<object>()

    try {
      return (
        JSON.stringify(value, (_key, currentValue) => {
          if (typeof currentValue === "bigint") {
            return currentValue.toString()
          }
          if (typeof currentValue === "symbol") {
            return currentValue.toString()
          }
          if (typeof currentValue === "function") {
            return `[Function ${(currentValue as { name?: string }).name || "anonymous"}]`
          }
          if (currentValue && typeof currentValue === "object") {
            if (seen.has(currentValue as object)) {
              return "[Circular]"
            }
            seen.add(currentValue as object)
          }
          return currentValue as unknown
        }) || ""
      )
    } catch {
      return ""
    }
  }

  onModuleInit() {
    try {
      this.encoder = getTokenizer()
      this.logger.log(
        "TokenCounter initialized with Claude BPE tokenizer (@anthropic-ai/tokenizer)"
      )
    } catch (error) {
      this.logger.warn(
        `Failed to initialize Claude tokenizer: ${String(error)}. Token counts will be estimated.`
      )
    }

    try {
      this.openaiEncoder = encoding_for_model("gpt-4o")
      this.logger.log("TokenCounter initialized with OpenAI o200k tokenizer")
    } catch (error) {
      this.logger.warn(
        `Failed to initialize OpenAI tokenizer: ${String(error)}. GPT token counts will be estimated.`
      )
    }
  }

  /**
   * Release the WASM-backed tokenizer handle.  Idempotent: safe to call
   * multiple times or before init has finished.  Errors during free() are
   * swallowed because at module destruction we never want to mask the
   * shutdown reason.
   */
  onModuleDestroy() {
    for (const [name, encoder] of [
      ["Claude", this.encoder],
      ["OpenAI", this.openaiEncoder],
    ] as const) {
      if (!encoder) continue
      try {
        encoder.free()
      } catch (error) {
        this.logger.debug(
          `${name} tokenizer free() failed (likely already released): ${String(error)}`
        )
      }
    }
    this.encoder = null
    this.openaiEncoder = null
  }

  /**
   * Count tokens in a text string
   */
  countText(
    text: string,
    applyCorrection = true,
    tokenizer: ContextTokenizer = "claude"
  ): number {
    if (!text) return 0

    if (tokenizer === "conservative") {
      const count = Math.max(
        this.countText(text, false, "claude"),
        this.countText(text, false, "openai")
      )
      return applyCorrection
        ? Math.ceil(count * this.CLAUDE_CORRECTION_FACTOR)
        : count
    }

    const useCache = text.length >= this.LONG_TEXT_CACHE_THRESHOLD_CHARS
    const cacheKey = `${tokenizer}\u0000${text}`
    if (useCache) {
      const cached = this.longTextRawTokenCache.get(cacheKey)
      if (cached !== undefined) {
        this.longTextRawTokenCache.delete(cacheKey)
        this.longTextRawTokenCache.set(cacheKey, cached)
        return applyCorrection
          ? Math.ceil(cached * this.CLAUDE_CORRECTION_FACTOR)
          : cached
      }
    }

    const encoder = tokenizer === "openai" ? this.openaiEncoder : this.encoder
    let count: number

    if (encoder) {
      try {
        count = encoder.encode(text).length
      } catch (error) {
        this.logger.warn(`${tokenizer} token counting failed: ${String(error)}`)
        count = Math.ceil(text.length / 4)
      }
    } else {
      count = Math.ceil(text.length / 4)
    }

    if (useCache) {
      if (this.longTextRawTokenCache.size >= this.LONG_TEXT_CACHE_MAX_ENTRIES) {
        const oldest = this.longTextRawTokenCache.keys().next().value
        if (oldest !== undefined) {
          this.longTextRawTokenCache.delete(oldest)
        }
      }
      this.longTextRawTokenCache.set(cacheKey, count)
    }

    return applyCorrection
      ? Math.ceil(count * this.CLAUDE_CORRECTION_FACTOR)
      : count
  }

  /**
   * Count tokens in a content block
   */
  countContentBlock(
    block: ContentBlock,
    applyCorrection = true,
    tokenizer: ContextTokenizer = "claude"
  ): number {
    let tokens = 0

    if (isTextBlock(block)) {
      tokens = this.countText(block.text, false, tokenizer)
    } else if (isToolUseBlock(block)) {
      tokens = this.countText(block.name, false, tokenizer)
      tokens += this.countText(JSON.stringify(block.input), false, tokenizer)
      tokens += this.TOKENS_PER_TOOL_CALL
    } else if (isToolResultBlock(block)) {
      tokens = this.countText(block.tool_use_id, false, tokenizer)
      let resultTokens = 0
      if (typeof block.content === "string") {
        resultTokens += this.countText(block.content, false, tokenizer)
      } else if (Array.isArray(block.content)) {
        for (const innerBlock of block.content) {
          resultTokens += this.countContentBlock(innerBlock, false, tokenizer)
        }
      }
      const structuredTokens = block.structuredContent
        ? this.countJsonValue(block.structuredContent, false, tokenizer)
        : 0
      tokens += Math.max(resultTokens, structuredTokens)
      tokens += this.TOKENS_PER_TOOL_RESULT
    } else if (isImageBlock(block)) {
      tokens = this.TOKENS_PER_IMAGE
    } else if (isThinkingBlock(block)) {
      tokens = this.countText(block.thinking, false, tokenizer)
    } else if (isCacheEditsBlock(block)) {
      tokens = this.countJsonValue(block.edits, false, tokenizer)
    }

    return applyCorrection
      ? Math.ceil(tokens * this.CLAUDE_CORRECTION_FACTOR)
      : tokens
  }

  /**
   * Count tokens in message content (string or array)
   */
  countContent(
    content: string | ContentBlock[],
    applyCorrection = true,
    tokenizer: ContextTokenizer = "claude"
  ): number {
    const blocks = normalizeContent(content)

    let tokens = 0
    for (const block of blocks) {
      tokens += this.countContentBlock(block, false, tokenizer)
    }

    return applyCorrection
      ? Math.ceil(tokens * this.CLAUDE_CORRECTION_FACTOR)
      : tokens
  }

  /**
   * Count tokens in a single unified message.
   *
   * Caches the raw (pre-correction) result on a WeakMap keyed by the
   * message object.  Cache validity is determined by reference equality on
   * the fields that contribute to the count.  This makes the cache
   * transparent to in-place mutators that *replace* fields (the dominant
   * pattern in this codebase) and conservative for any mutator that
   * unexpectedly mutates a content array in place — such a mutator would
   * be a latent bug regardless, since it bypasses the persistence/projection
   * pipelines that produce fresh arrays.
   */
  countMessage(
    message: UnifiedMessage,
    applyCorrection = true,
    tokenizer: ContextTokenizer = "claude"
  ): number {
    const rawTokens =
      tokenizer === "conservative"
        ? Math.max(
            this.computeMessageRawTokensCached(message, "claude"),
            this.computeMessageRawTokensCached(message, "openai")
          )
        : this.computeMessageRawTokensCached(message, tokenizer)
    return applyCorrection
      ? Math.ceil(rawTokens * this.CLAUDE_CORRECTION_FACTOR)
      : rawTokens
  }

  private computeMessageRawTokensCached(
    message: UnifiedMessage,
    tokenizer: Exclude<ContextTokenizer, "conservative">
  ): number {
    const cached = this.messageTokenCache.get(message)
    const cacheValid =
      cached &&
      cached.contentRef === message.content &&
      cached.toolCallsRef === message.tool_calls &&
      cached.toolCallIdRef === message.tool_call_id &&
      cached.roleRef === message.role
    const cachedTokens = cacheValid
      ? cached.rawTokensByTokenizer[tokenizer]
      : undefined
    if (cachedTokens !== undefined) {
      return cachedTokens
    }

    let tokens = this.TOKENS_PER_MESSAGE
    tokens += this.countText(message.role, false, tokenizer)
    tokens += this.countContent(message.content, false, tokenizer)

    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        tokens += this.countText(toolCall.id, false, tokenizer)
        tokens += this.countText(toolCall.function.name, false, tokenizer)
        tokens += this.countText(toolCall.function.arguments, false, tokenizer)
        tokens += this.TOKENS_PER_TOOL_CALL
      }
    }

    if (message.tool_call_id) {
      tokens += this.countText(message.tool_call_id, false, tokenizer)
    }

    this.messageTokenCache.set(message, {
      contentRef: message.content,
      toolCallsRef: message.tool_calls,
      toolCallIdRef: message.tool_call_id,
      roleRef: message.role,
      rawTokensByTokenizer: {
        ...(cacheValid ? cached.rawTokensByTokenizer : {}),
        [tokenizer]: tokens,
      },
    })

    return tokens
  }

  /**
   * Count tokens in multiple messages
   */
  countMessages(
    messages: UnifiedMessage[],
    applyCorrection = true,
    tokenizer: ContextTokenizer = "claude"
  ): number {
    let tokens = 0

    for (const message of messages) {
      tokens += this.countMessage(message, false, tokenizer)
    }

    tokens += 3

    return applyCorrection
      ? Math.ceil(tokens * this.CLAUDE_CORRECTION_FACTOR)
      : tokens
  }

  /**
   * Count tokens in tool definitions
   */
  countToolDefinitions(
    tools: Array<{
      type?: string
      name?: string
      description?: string
      input_schema?: Record<string, unknown>
      function?: {
        name: string
        description?: string
        parameters?: Record<string, unknown>
      }
    }>,
    applyCorrection = true,
    tokenizer: ContextTokenizer = "claude"
  ): number {
    if (!tools || tools.length === 0) return 0

    let tokens = 0

    for (const tool of tools) {
      if (tool.name) {
        tokens += this.countText(tool.name, false, tokenizer)
        if (tool.description) {
          tokens += this.countText(tool.description, false, tokenizer)
        }
        if (tool.input_schema) {
          tokens += this.countText(
            JSON.stringify(tool.input_schema),
            false,
            tokenizer
          )
        }
        tokens += 10
      } else if (tool.function) {
        tokens += this.countText(tool.function.name, false, tokenizer)
        if (tool.function.description) {
          tokens += this.countText(tool.function.description, false, tokenizer)
        }
        if (tool.function.parameters) {
          tokens += this.countText(
            JSON.stringify(tool.function.parameters),
            false,
            tokenizer
          )
        }
        tokens += 10
      }
    }

    return applyCorrection
      ? Math.ceil(tokens * this.CLAUDE_CORRECTION_FACTOR)
      : tokens
  }

  /**
   * Estimate total request tokens
   */
  estimateRequestTokens(
    messages: UnifiedMessage[],
    tools?: Array<{
      type?: string
      name?: string
      description?: string
      input_schema?: Record<string, unknown>
      function?: {
        name: string
        description?: string
        parameters?: Record<string, unknown>
      }
    }>,
    systemPrompt?: string
  ): number {
    let total = this.countMessages(messages)

    if (tools) {
      total += this.countToolDefinitions(tools)
    }

    if (systemPrompt) {
      total += this.countText(systemPrompt)
    }

    return total
  }

  /**
   * Count tokens for a serialized JSON value.
   * Useful for tool definitions, function call args, etc.
   *
   * For object/array inputs, the raw token count is cached on a WeakMap
   * keyed by the input reference.  Tool definition arrays are the dominant
   * caller: `resolveMessageBudget` forwards the same `apiTools` array on
   * every continuation in a turn (the reference is captured in a closure
   * and reused), so a single tokenize-the-whole-tool-catalog cost is paid
   * once per array build instead of once per tool round.
   */
  countJsonValue(
    value: unknown,
    applyCorrection = true,
    tokenizer: ContextTokenizer = "claude"
  ): number {
    if (value !== null && typeof value === "object") {
      const cachedByTokenizer = this.jsonValueRawTokenCache.get(value)
      const cached = cachedByTokenizer?.[tokenizer]
      if (cached !== undefined) {
        return applyCorrection
          ? Math.ceil(cached * this.CLAUDE_CORRECTION_FACTOR)
          : cached
      }
      const json = this.safeJsonStringify(value)
      if (!json) return 0
      const raw = this.countText(json, false, tokenizer)
      this.jsonValueRawTokenCache.set(value, {
        ...cachedByTokenizer,
        [tokenizer]: raw,
      })
      return applyCorrection
        ? Math.ceil(raw * this.CLAUDE_CORRECTION_FACTOR)
        : raw
    }
    const json = this.safeJsonStringify(value)
    return json ? this.countText(json, applyCorrection, tokenizer) : 0
  }

  /**
   * Estimate token count for a complete Google Cloud Code payload.
   *
   * Traverses the final Google-format request structure:
   * - systemInstruction.parts[].text
   * - contents[].parts[] (text, functionCall, functionResponse)
   * - tools (serialized)
   *
   * This is the single source of truth for "how many tokens will this
   * request cost?" and should be called right before sending.
   */
  countGooglePayloadTokens(payload: {
    request?: {
      systemInstruction?: { parts?: Array<{ text?: string }> }
      contents?: Array<{
        role?: string
        parts?: Array<Record<string, unknown>>
      }>
      tools?: unknown
      [key: string]: unknown
    }
    [key: string]: unknown
  }): number {
    const request = payload?.request
    if (!request) return 0

    let rawTokens = 0

    // 1. systemInstruction
    const sysParts = request.systemInstruction?.parts
    if (Array.isArray(sysParts)) {
      for (const part of sysParts) {
        if (part?.text) {
          rawTokens += this.countText(part.text, false)
        }
      }
    }

    // 2. contents (conversation history)
    const contents = request.contents
    if (Array.isArray(contents)) {
      for (const msg of contents) {
        if (!msg?.parts || !Array.isArray(msg.parts)) continue
        // role overhead
        rawTokens += this.TOKENS_PER_MESSAGE

        for (const part of msg.parts) {
          if (!part || typeof part !== "object") continue

          if ("text" in part && typeof part.text === "string") {
            rawTokens += this.countText(part.text, false)
          }
          if ("functionCall" in part && part.functionCall) {
            const fc = part.functionCall as {
              name?: string
              args?: unknown
            }
            if (fc.name) rawTokens += this.countText(fc.name, false)
            if (fc.args) {
              rawTokens += this.countJsonValue(fc.args, false)
            }
            rawTokens += this.TOKENS_PER_TOOL_CALL
          }
          if ("functionResponse" in part && part.functionResponse) {
            const fr = part.functionResponse as {
              name?: string
              response?: unknown
            }
            if (fr.name) rawTokens += this.countText(fr.name, false)
            if (fr.response) {
              rawTokens += this.countJsonValue(fr.response, false)
            }
            rawTokens += this.TOKENS_PER_TOOL_RESULT
          }
          if ("inlineData" in part) {
            // Images: flat estimate
            rawTokens += this.TOKENS_PER_IMAGE
          }
        }
      }
    }

    // 3. tools (tool declarations)
    if (request.tools) {
      rawTokens += this.countJsonValue(request.tools, false)
    }

    // Claude tokenizer: exact count, no correction needed
    return rawTokens
  }

  /**
   * Check if messages exceed token limit
   */
  exceedsLimit(
    messages: UnifiedMessage[],
    maxTokens: number,
    tokenizer: ContextTokenizer = "claude"
  ): boolean {
    return this.countMessages(messages, true, tokenizer) > maxTokens
  }

  /**
   * Find the index where accumulated tokens from the end exceeds target
   * Returns the index of the first message to include to stay under target tokens
   */
  findTruncationIndex(
    messages: UnifiedMessage[],
    targetTokens: number,
    tokenizer: ContextTokenizer = "claude"
  ): number {
    let accumulatedTokens = 0

    // Iterate from the end
    for (let i = messages.length - 1; i >= 0; i--) {
      const messageTokens = this.countMessage(messages[i]!, true, tokenizer)
      accumulatedTokens += messageTokens

      if (accumulatedTokens > targetTokens) {
        // This message pushes us over the limit
        // Return the next index (exclude this message)
        return i + 1
      }
    }

    // All messages fit within target
    return 0
  }
}
