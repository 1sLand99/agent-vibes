import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "node:crypto"
import { solveChatGptWebProofOfWork } from "./chatgpt-web-pow"

/**
 * Session state for chatgpt.com's web chat surface.
 *
 * Two things gate `/backend-api/conversation` beyond the bearer token:
 *
 *   1. Cloudflare cookies. A plain request with no cookie jar is rejected as
 *      "Unusual activity has been detected from your device". Fetching the app
 *      shell once seeds `__cf_bm` (and friends), after which the API accepts
 *      the same connection. The shell also hands back `oai-did`, upstream's own
 *      device id — preferring it over a locally minted uuid keeps the device
 *      consistent with what the account has already seen.
 *
 *   2. Sentinel. `POST /backend-api/sentinel/chat-requirements` must be called
 *      with an empty body (a fabricated `p` field makes it 500) and answers
 *      with a short-lived token plus a proof-of-work challenge. It also
 *      advertises `turnstile` and `so` as required; conversation does not in
 *      fact enforce either, so only the proof-of-work is solved here.
 *
 * Cookies are cached per account for `WARM_TTL_MS`; `__cf_bm` outlives that
 * comfortably, so the refresh is opportunistic rather than load-bearing.
 */

const ORIGIN = "https://chatgpt.com"
const WARM_TTL_MS = 20 * 60 * 1_000

export interface ChatGptWebSettings {
  readonly userAgent: string
  readonly language: string
  readonly timezone: string
  readonly timezoneOffsetMinutes: number
  readonly requestTimeoutMs: number
}

interface WarmState {
  cookies: Map<string, string>
  deviceId: string
  warmedAt: number
}

export class ChatGptWebSessionError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "ChatGptWebSessionError"
  }
}

@Injectable()
export class ChatGptWebSessionStore {
  private readonly logger = new Logger(ChatGptWebSessionStore.name)
  private readonly warm = new Map<string, WarmState>()
  readonly settings: ChatGptWebSettings

  constructor(private readonly configService: ConfigService) {
    this.settings = loadChatGptWebSettings(configService)
  }

  /** Browser-shaped headers every chatgpt.com request carries. */
  private browserHeaders(): Record<string, string> {
    return {
      "accept-language": "en-US,en;q=0.9",
      "sec-ch-ua":
        '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      priority: "u=1, i",
      "user-agent": this.settings.userAgent,
    }
  }

  /**
   * Fetch the app shell to collect Cloudflare cookies. Upstream may answer
   * non-200 here; what matters is the `set-cookie` payload, so only a total
   * absence of cookies is treated as a failure.
   */
  private async warmUp(accountKey: string): Promise<WarmState> {
    const cached = this.warm.get(accountKey)
    if (cached && Date.now() - cached.warmedAt < WARM_TTL_MS) return cached

    const response = await fetch(`${ORIGIN}/`, {
      headers: { ...this.browserHeaders(), accept: "text/html" },
      signal: AbortSignal.timeout(this.settings.requestTimeoutMs),
    }).catch((error: unknown) => {
      throw new ChatGptWebSessionError(
        502,
        "chatgpt_web_warmup_failed",
        `Could not reach ${ORIGIN}: ${describe(error)}`
      )
    })

    const cookies = new Map<string, string>()
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";")
      const index = pair?.indexOf("=") ?? -1
      if (!pair || index <= 0) continue
      cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
    }

    if (cookies.size === 0) {
      throw new ChatGptWebSessionError(
        502,
        "chatgpt_web_warmup_empty",
        `${ORIGIN} returned ${response.status} without any cookie — ` +
          `the Cloudflare handshake did not complete`
      )
    }

    const state: WarmState = {
      cookies,
      deviceId: cookies.get("oai-did") || crypto.randomUUID(),
      warmedAt: Date.now(),
    }
    this.warm.set(accountKey, state)
    this.logger.debug(
      `ChatGPT Web session warmed for ${accountKey}: ` +
        `${cookies.size} cookie(s), device ${state.deviceId.slice(0, 8)}…`
    )
    return state
  }

  /** Base headers for any authenticated `/backend-api` call. */
  async baseHeaders(
    accountKey: string,
    accessToken: string,
    accountId: string
  ): Promise<Record<string, string>> {
    const state = await this.warmUp(accountKey)
    const cookie = [...state.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ")
    return {
      ...this.browserHeaders(),
      accept: "text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      "oai-device-id": state.deviceId,
      "oai-language": this.settings.language,
      origin: ORIGIN,
      referer: `${ORIGIN}/`,
      "content-type": "application/json",
      cookie,
    }
  }

  /**
   * Sentinel token plus a solved proof-of-work.
   *
   * The token is single-use: replaying one that already carried a
   * conversation request earns a 403, so this is fetched fresh every turn
   * rather than cached against the `expire_after` upstream advertises (that
   * window bounds how long an *unused* token stays valid). The extra
   * round-trip is one small POST; the proof-of-work itself is sub-millisecond.
   */
  async sentinelHeaders(
    accountKey: string,
    baseHeaders: Record<string, string>
  ): Promise<Record<string, string>> {
    const response = await fetch(
      `${ORIGIN}/backend-api/sentinel/chat-requirements`,
      {
        method: "POST",
        headers: baseHeaders,
        // Must be empty: sending a synthetic `p` field makes upstream 500.
        body: "{}",
        signal: AbortSignal.timeout(this.settings.requestTimeoutMs),
      }
    ).catch((error: unknown) => {
      throw new ChatGptWebSessionError(
        502,
        "chatgpt_web_sentinel_unreachable",
        `Sentinel request failed: ${describe(error)}`
      )
    })

    if (!response.ok) {
      this.warm.delete(accountKey)
      throw new ChatGptWebSessionError(
        response.status === 401 || response.status === 403 ? 401 : 502,
        "chatgpt_web_sentinel_rejected",
        `Sentinel returned ${response.status}: ` +
          `${(await response.text().catch(() => "")).slice(0, 300)}`
      )
    }

    const payload = (await response.json()) as {
      token?: string
      expire_after?: number
      proofofwork?: { seed?: string; difficulty?: string }
    }
    if (!payload.token) {
      throw new ChatGptWebSessionError(
        502,
        "chatgpt_web_sentinel_malformed",
        "Sentinel response carried no token"
      )
    }

    const proofToken = solveChatGptWebProofOfWork({
      seed: payload.proofofwork?.seed || "",
      difficulty: payload.proofofwork?.difficulty || "",
      userAgent: this.settings.userAgent,
    })
    return {
      "openai-sentinel-chat-requirements-token": payload.token,
      "openai-sentinel-proof-token": proofToken,
    }
  }

  /** Drop the cookie jar so the next call re-handshakes from scratch. */
  invalidate(accountKey: string): void {
    this.warm.delete(accountKey)
  }
}

export function loadChatGptWebSettings(
  configService: ConfigService
): ChatGptWebSettings {
  const read = (key: string) => configService.get<string>(key, "").trim()
  const offset = Number.parseInt(
    read("CHATGPT_WEB_TIMEZONE_OFFSET_MINUTES"),
    10
  )
  const timeout = Number.parseInt(read("CHATGPT_WEB_TIMEOUT_MS"), 10)
  return {
    userAgent:
      read("CHATGPT_WEB_USER_AGENT") ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    language: read("CHATGPT_WEB_LANGUAGE") || "en-US",
    timezone: read("CHATGPT_WEB_TIMEZONE") || "Asia/Shanghai",
    timezoneOffsetMinutes: Number.isSafeInteger(offset) ? offset : -480,
    requestTimeoutMs: Number.isSafeInteger(timeout) ? timeout : 120_000,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
