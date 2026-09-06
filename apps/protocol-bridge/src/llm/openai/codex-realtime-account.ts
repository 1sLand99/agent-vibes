import * as crypto from "crypto"

export const CHATGPT_WEB_REALTIME_POOL_MODEL = "chatgpt-web-voice"

export interface CodexRealtimeAccountLease {
  readonly accountKey: string
  readonly label: string
  readonly accessToken: string
  readonly deviceId: string
  readonly proxyUrl?: string
  refreshAccessToken(reason: string): Promise<string | null>
  accept(): void
  reject(statusCode: number, detail?: string, retryAfterSeconds?: number): void
}

/**
 * ChatGPT Web expects one browser-shaped device id. Keep the fallback stable
 * per Codex slot without persisting or exposing any credential material.
 */
export function deriveChatGptWebDeviceId(slotKey: string): string {
  const bytes = crypto
    .createHash("sha256")
    .update(`agent-vibes:chatgpt-web:${slotKey}`)
    .digest()
    .subarray(0, 16)

  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = bytes.toString("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-")
}

export function resolveChatGptWebDeviceId(
  configuredDeviceId: string | undefined,
  slotKey: string
): string {
  const normalized = configuredDeviceId?.trim() || ""
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalized
  )
    ? normalized
    : deriveChatGptWebDeviceId(slotKey)
}
