import { Injectable } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { spawn } from "node:child_process"
import * as path from "node:path"

export interface ChatGptWebVoicePostInput {
  readonly endpoint: string
  readonly offerSdp: string
  readonly sessionJson: string
  readonly headers: Readonly<Record<string, string>>
  readonly proxyUrl?: string
}

export interface ChatGptWebVoicePostResult {
  readonly status: number
  readonly text: string
  readonly contentType: string
}

export interface ChatGptWebVoiceSettings {
  readonly endpoint: string
  readonly userAgent: string
  readonly clientVersion: string
  readonly clientBuildNumber: string
  readonly language: string
  readonly timezone: string
  readonly timezoneOffsetMinutes: number
  readonly transport: "auto" | "curl_cffi" | "fetch"
  readonly pythonExecutable: string
  readonly helperPath: string
  readonly impersonate: string
  readonly skipSslVerify: boolean
  readonly requestTimeoutMs: number
}

@Injectable()
export class ChatGptWebVoiceTransport {
  readonly settings: ChatGptWebVoiceSettings

  constructor(private readonly configService: ConfigService) {
    this.settings = loadChatGptWebVoiceSettings(configService)
  }

  async post(
    input: ChatGptWebVoicePostInput
  ): Promise<ChatGptWebVoicePostResult> {
    if (this.settings.transport === "fetch") {
      return this.postWithFetch(input)
    }
    if (this.settings.transport === "curl_cffi") {
      return this.postWithCurlCffi(input)
    }
    if (input.proxyUrl) {
      return this.postWithCurlCffi(input)
    }

    try {
      const response = await this.postWithFetch(input)
      if (response.status !== 403) return response
    } catch {
      // Hosts rejected by Web TLS policy retry with a browser TLS profile.
    }
    return this.postWithCurlCffi(input)
  }

  private async postWithFetch(
    input: ChatGptWebVoicePostInput
  ): Promise<ChatGptWebVoicePostResult> {
    if (input.proxyUrl) {
      throw new Error(
        "CHATGPT_WEB_VOICE_TRANSPORT=fetch does not support an account proxy"
      )
    }

    const form = new FormData()
    form.set("sdp", input.offerSdp)
    form.set("session", input.sessionJson)
    const response = await fetch(input.endpoint, {
      method: "POST",
      headers: input.headers,
      body: form,
      signal: AbortSignal.timeout(this.settings.requestTimeoutMs),
    })
    return {
      status: response.status,
      text: await response.text(),
      contentType: response.headers.get("content-type") || "",
    }
  }

  private postWithCurlCffi(
    input: ChatGptWebVoicePostInput
  ): Promise<ChatGptWebVoicePostResult> {
    const payload = JSON.stringify({
      endpoint: input.endpoint,
      offer_sdp: input.offerSdp,
      session_json: input.sessionJson,
      headers: input.headers,
      proxy_url: input.proxyUrl || "",
      impersonate: this.settings.impersonate,
      verify_ssl: !this.settings.skipSslVerify,
      timeout_seconds: Math.max(
        1,
        Math.ceil(this.settings.requestTimeoutMs / 1_000)
      ),
    })

    return new Promise((resolve, reject) => {
      const child = spawn(
        this.settings.pythonExecutable,
        [this.settings.helperPath],
        { stdio: ["pipe", "pipe", "pipe"] }
      )
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      const finish = (
        error?: Error,
        result?: ChatGptWebVoicePostResult
      ): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(result!)
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        finish(new Error("ChatGPT Web voice transport timed out"))
      }, this.settings.requestTimeoutMs + 2_000)
      timer.unref()

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > 1_500_000) {
          child.kill("SIGKILL")
          finish(
            new Error("ChatGPT Web voice transport returned too much data")
          )
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= 8_000) return
        stderrBytes += chunk.length
        stderr.push(chunk)
      })
      child.once("error", (error) => finish(error))
      child.once("close", (code) => {
        if (settled) return
        const raw = Buffer.concat(stdout).toString("utf8")
        if (code !== 0) {
          const detail = Buffer.concat(stderr)
            .toString("utf8")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 500)
          finish(
            new Error(
              `ChatGPT Web voice transport exited with ${code}${detail ? `: ${detail}` : ""}`
            )
          )
          return
        }
        try {
          const value = JSON.parse(raw) as Record<string, unknown>
          if (
            typeof value.status !== "number" ||
            typeof value.text !== "string"
          ) {
            throw new Error("invalid helper response")
          }
          finish(undefined, {
            status: value.status,
            text: value.text,
            contentType:
              typeof value.content_type === "string" ? value.content_type : "",
          })
        } catch (error) {
          finish(
            new Error(
              `ChatGPT Web voice transport returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
            )
          )
        }
      })
      child.stdin.on("error", (error) => finish(error))
      child.stdin.end(payload)
    })
  }
}

export function loadChatGptWebVoiceSettings(
  configService: ConfigService
): ChatGptWebVoiceSettings {
  const nodeEnv = configService.get<string>("NODE_ENV", "")
  return {
    endpoint:
      readString(configService, "CHATGPT_WEB_VOICE_ENDPOINT") ||
      "https://chatgpt.com/realtime/wm?dcid=0",
    userAgent:
      readString(configService, "CHATGPT_WEB_VOICE_USER_AGENT") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
    clientVersion:
      readString(configService, "CHATGPT_WEB_VOICE_CLIENT_VERSION") ||
      "prod-fb4a8a2a751dfec391053cfd7b01c52699ccf78c",
    clientBuildNumber:
      readString(configService, "CHATGPT_WEB_VOICE_CLIENT_BUILD_NUMBER") ||
      "8370486",
    language:
      readString(configService, "CHATGPT_WEB_VOICE_LANGUAGE") || "zh-CN",
    timezone:
      readString(configService, "CHATGPT_WEB_VOICE_TIMEZONE") || "Etc/GMT-8",
    timezoneOffsetMinutes: readInteger(
      configService,
      "CHATGPT_WEB_VOICE_TIMEZONE_OFFSET_MINUTES",
      -480
    ),
    transport: readTransport(configService),
    pythonExecutable:
      readString(configService, "CHATGPT_WEB_VOICE_PYTHON") ||
      (nodeEnv === "production"
        ? "/opt/protocol-bridge/.venv-chatgpt-web/bin/python"
        : "python3"),
    helperPath:
      readString(configService, "CHATGPT_WEB_VOICE_HELPER") ||
      path.resolve(__dirname, "../../../python/chatgpt_web_voice.py"),
    impersonate:
      readString(configService, "CHATGPT_WEB_VOICE_IMPERSONATE") || "chrome136",
    skipSslVerify: readBoolean(
      configService,
      "CHATGPT_WEB_VOICE_SKIP_SSL_VERIFY",
      false
    ),
    requestTimeoutMs: readInteger(
      configService,
      "CHATGPT_WEB_VOICE_TIMEOUT_MS",
      20_000
    ),
  }
}

function readString(config: ConfigService, key: string): string {
  return config.get<string>(key, "").trim()
}

function readInteger(
  config: ConfigService,
  key: string,
  fallback: number
): number {
  const value = Number.parseInt(readString(config, key), 10)
  return Number.isSafeInteger(value) ? value : fallback
}

function readBoolean(
  config: ConfigService,
  key: string,
  fallback: boolean
): boolean {
  const value = readString(config, key).toLowerCase()
  if (!value) return fallback
  return ["1", "true", "yes", "on"].includes(value)
}

function readTransport(
  config: ConfigService
): ChatGptWebVoiceSettings["transport"] {
  const value = readString(config, "CHATGPT_WEB_VOICE_TRANSPORT")
  return value === "fetch" || value === "curl_cffi" ? value : "auto"
}
