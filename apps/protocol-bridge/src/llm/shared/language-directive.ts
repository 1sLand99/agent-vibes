/**
 * Forced language directive.
 *
 * The bridge sits between the Cursor IDE (and other Anthropic-format clients)
 * and every LLM backend. Reasoning models — especially in interleaved thinking
 * blocks — tend to drift to English even when the user is clearly writing in
 * another language. To keep the thinking/response language anchored to the
 * user we inject an explicit directive into the system prompt of every backend.
 *
 * Detection strategy (deliberately narrow):
 *   - Language detection is delegated to `tinyld` (a pure-JS n-gram detector
 *     with inlined model data, so it bundles cleanly into the SEA binary).
 *   - We only NAME a language in the directive when it is on a small allowlist
 *     (currently Chinese). Naming a language emits a hard "you MUST respond in
 *     X" instruction that pins the thinking block — this is what fixes the
 *     English-drift problem for Chinese users.
 *   - Every other detection result (English, Japanese, anything tinyld returns,
 *     or no confident result) falls back to the GENERIC directive ("follow the
 *     user's language"). The model handles those languages on its own.
 *
 * Why the allowlist instead of naming whatever tinyld returns: naming the WRONG
 * language is strictly worse than not naming one — it overrides the model's own
 * (usually correct) judgement with a false hard instruction. Restricting named
 * anchoring to Chinese means a rare misdetection only ever degrades to the
 * generic directive, never to "respond in Japanese".
 *
 * English is intentionally NOT on the allowlist: it is the model's default
 * drift target anyway, so the generic directive already produces English for
 * English input, and omitting it removes the risk of a misdetected Chinese
 * message being forced into English.
 *
 * All public functions accept `messages: unknown` so call sites can pass their
 * backend-native message arrays (Anthropic DTO messages, Codex messages, the
 * raw cloned payload's messages) without type friction; non-array / malformed
 * input degrades gracefully to the generic directive.
 */

import { detect } from "tinyld"

export interface DetectedLanguage {
  /** Short language code, e.g. "zh". Used for logging / tests. */
  code: string
  /** English display name used in the directive text, e.g. "Chinese". */
  englishName: string
}

interface LooseMessage {
  role?: unknown
  content?: unknown
}

/**
 * Content-block types that never carry human-authored prose and therefore must
 * be ignored when sampling the user's language (tool plumbing, images, model
 * reasoning echoed back into the transcript).
 */
const NON_PROSE_BLOCK_TYPES = new Set([
  "tool_result",
  "tool_use",
  "image",
  "thinking",
  "redacted_thinking",
])

/**
 * Languages we explicitly NAME (and therefore hard-anchor) in the directive.
 * Keyed by the ISO-639-1 code tinyld returns. Anything not in this map falls
 * back to the generic directive. See the module header for the rationale.
 */
const NAMED_LANGUAGES: Readonly<Record<string, string>> = {
  zh: "Chinese",
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return ""
  }
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block)
      continue
    }
    if (block && typeof block === "object") {
      const record = block as Record<string, unknown>
      const type = typeof record.type === "string" ? record.type : ""
      if (NON_PROSE_BLOCK_TYPES.has(type)) {
        continue
      }
      if (typeof record.text === "string") {
        parts.push(record.text)
      }
    }
  }
  return parts.join(" ")
}

/**
 * Returns the prose of the most recent genuine user turn. Tool-result-only
 * user turns (agentic mid-loop) are skipped so the detected language stays
 * stable across tool calls instead of flipping to "" between turns.
 */
export function extractLatestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return ""
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as LooseMessage | undefined
    if (!message || typeof message !== "object") {
      continue
    }
    if (message.role !== "user") {
      continue
    }
    const text = extractTextFromContent(message.content).trim()
    if (text) {
      return text
    }
  }
  return ""
}

/**
 * Detect the language of a raw text sample via tinyld, but only return a named
 * language when it is on the allowlist (currently Chinese). Returns null for
 * everything else — empty input, English, or any other language — which routes
 * the caller to the generic directive.
 */
export function detectLanguageFromText(text: string): DetectedLanguage | null {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  const code = detect(trimmed)
  const englishName = NAMED_LANGUAGES[code]
  if (!englishName) {
    return null
  }
  return { code, englishName }
}

/** Detect the user's language from a backend-native message array. */
export function detectUserLanguage(messages: unknown): DetectedLanguage | null {
  return detectLanguageFromText(extractLatestUserText(messages))
}

const GENERIC_DIRECTIVE = [
  "Language usage rules:",
  "- Always respond in the same language the user is writing in.",
  "- Your internal thinking and reasoning (think/thought blocks) must also use the user's language.",
  "- Match the user's language consistently throughout the entire conversation, including explanations, summaries, and follow-up questions.",
  "- Do not switch languages unless the user explicitly asks you to.",
  "- Exception: code comments and commit messages default to English unless the user specifies otherwise.",
].join("\n")

/**
 * Env var carrying the user's explicitly chosen response language, set by the
 * VS Code extension when the "Response Language" setting is non-empty. The
 * value is free-form text exactly as the user typed it (e.g. "中文", "English",
 * "日本語"). When present it OVERRIDES tinyld detection entirely: an explicit
 * user choice is authoritative, so there is no misdetection risk and any
 * language can be hard-anchored, not just the detection allowlist.
 */
const FORCED_LANGUAGE_ENV = "AGENT_VIBES_FORCED_LANGUAGE"

function buildForcedDirective(name: string): string {
  return [
    `The user has explicitly set their preferred language to ${name}. You MUST respond in ${name}.`,
    "",
    "Language usage rules:",
    `- Respond in ${name} regardless of the language the user happens to type in.`,
    `- Your internal thinking and reasoning (think/thought blocks) MUST also be written in ${name}, never English.`,
    `- Keep ${name} consistent across the entire turn: thinking, explanations, summaries, and follow-up questions.`,
    "- Exception: code, code comments, identifiers, and commit messages follow their normal conventions (usually English) unless the user specifies otherwise.",
  ].join("\n")
}

function buildNamedDirective(name: string): string {
  return [
    `The user is currently writing in ${name}. You MUST respond in ${name}.`,
    "",
    "Language usage rules:",
    `- Respond in ${name} — the language the user is currently writing in.`,
    `- Your internal thinking and reasoning (think/thought blocks) MUST also be written in ${name}, never English.`,
    `- Keep ${name} consistent across the entire turn: thinking, explanations, summaries, and follow-up questions.`,
    "- Do not switch to another language unless the user explicitly asks you to.",
    "- Exception: code, code comments, identifiers, and commit messages follow their normal conventions (usually English) unless the user specifies otherwise.",
  ].join("\n")
}

/**
 * Build the language directive for a request. Names the detected language
 * explicitly when it is on the allowlist; otherwise returns the generic
 * directive.
 *
 * When `skip` is true (the request comes from the Claude Code frontend) this
 * returns an empty string — CC follows the user's language on its own and the
 * injected directive only pollutes its thinking blocks.
 */
export function buildLanguageDirective(
  messages: unknown,
  options: { skip?: boolean } = {}
): string {
  if (options.skip) {
    return ""
  }
  const forced = (process.env[FORCED_LANGUAGE_ENV] ?? "").trim()
  if (forced) {
    return buildForcedDirective(forced)
  }
  const detected = detectUserLanguage(messages)
  return detected
    ? buildNamedDirective(detected.englishName)
    : GENERIC_DIRECTIVE
}

export function buildStableLanguageDirective(
  options: { skip?: boolean } = {}
): string {
  if (options.skip) {
    return ""
  }
  const forced = (process.env[FORCED_LANGUAGE_ENV] ?? "").trim()
  return forced ? buildForcedDirective(forced) : GENERIC_DIRECTIVE
}

/**
 * A terse, last-position language anchor for backends that fold the system
 * prompt into user content (Kiro): there the full directive ends up buried
 * before the user's latest message, so it loses recency over long sessions
 * and the visible output can briefly drift (e.g. to Japanese) even though the
 * directive is present. Placing a short reminder at the very END of the
 * outbound user content uses recency to counter that drift.
 *
 * Strictly config-/detection-driven — it NEVER hardcodes a language:
 *   - forced language (the user's configured Response Language) takes priority,
 *   - otherwise the allowlist-detected user language,
 *   - otherwise "" (no anchor — the model keeps auto-detecting).
 */
export function buildTerseLanguageAnchor(
  messages: unknown,
  options: { skip?: boolean } = {}
): string {
  if (options.skip) {
    return ""
  }
  const forced = (process.env[FORCED_LANGUAGE_ENV] ?? "").trim()
  if (forced) {
    return `[Reminder: write your reply AND your thinking in ${forced}.]`
  }
  const detected = detectUserLanguage(messages)
  return detected
    ? `[Reminder: write your reply AND your thinking in ${detected.englishName}.]`
    : ""
}

/**
 * Append the language directive to a plain-string system prompt (Codex
 * instructions, Kiro/Bedrock embedded system prompt). Safe on empty input.
 */
export function appendLanguageDirectiveToText(
  base: string | null | undefined,
  messages: unknown,
  options: { skip?: boolean } = {}
): string {
  const directive = buildLanguageDirective(messages, options)
  const trimmed = (base ?? "").trim()
  if (!directive) {
    return trimmed
  }
  return trimmed ? `${trimmed}\n\n${directive}` : directive
}

/**
 * Append the language directive to an Anthropic `system` value, which may be a
 * plain string or an array of content blocks. Returns the same broad shape so
 * the caller can assign it straight back onto the request payload.
 */
export function appendLanguageDirectiveToAnthropicSystem(
  system: unknown,
  messages: unknown,
  options: { skip?: boolean } = {}
): string | Array<Record<string, unknown>> {
  const directive = buildLanguageDirective(messages, options)
  return appendDirectiveToAnthropicSystem(system, directive)
}

/**
 * Append a request-stable language directive to an Anthropic `system` value.
 * This variant is used by continuation-capable adapters whose static
 * instructions must not change merely because a later user turn switches
 * language.
 */
export function appendStableLanguageDirectiveToAnthropicSystem(
  system: unknown,
  options: { skip?: boolean } = {}
): string | Array<Record<string, unknown>> {
  const directive = buildStableLanguageDirective(options)
  return appendDirectiveToAnthropicSystem(system, directive)
}

function appendDirectiveToAnthropicSystem(
  system: unknown,
  directive: string
): string | Array<Record<string, unknown>> {
  if (!directive) {
    return (system ?? "") as string | Array<Record<string, unknown>>
  }
  if (Array.isArray(system)) {
    return [
      ...(system as Array<Record<string, unknown>>),
      { type: "text", text: directive },
    ]
  }
  const base = typeof system === "string" ? system.trim() : ""
  return base ? `${base}\n\n${directive}` : directive
}
