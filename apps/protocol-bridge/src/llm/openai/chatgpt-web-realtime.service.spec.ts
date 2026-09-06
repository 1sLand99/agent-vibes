import type { CodexRealtimeAccountLease } from "./codex-realtime-account"
import { CodexService } from "./codex.service"
import { ChatGptWebRealtimeService } from "./chatgpt-web-realtime.service"
import {
  type ChatGptWebVoiceSettings,
  ChatGptWebVoiceTransport,
} from "./chatgpt-web-transport"

const OFFER_SDP = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "",
].join("\r\n")

const SETTINGS: ChatGptWebVoiceSettings = {
  endpoint: "https://chatgpt.com/realtime/wm?dcid=0",
  userAgent: "browser-agent",
  clientVersion: "prod-test",
  clientBuildNumber: "123",
  language: "zh-CN",
  timezone: "Etc/GMT-8",
  timezoneOffsetMinutes: -480,
  transport: "fetch",
  pythonExecutable: "python3",
  helperPath: "/tmp/chatgpt_web_voice.py",
  impersonate: "chrome136",
  skipSslVerify: false,
  requestTimeoutMs: 20_000,
}

describe("ChatGptWebRealtimeService", () => {
  it("uses the linked Codex OAuth account for the tested Web Live protocol", async () => {
    const lease = createLease()
    const codex = createCodexPool([lease])
    const post = createPostMock()
    post.mockResolvedValue({
      status: 201,
      text: "v=0\r\nweb-answer",
      contentType: "application/sdp",
    })
    const service = createService(codex, post)

    const result = await service.createCall({
      sdp: OFFER_SDP,
      session: { type: "realtime", model: "gpt-realtime", voice: "marin" },
    })

    expect(result.transport).toBe("chatgpt-web-voice")
    expect(result.callId).toMatch(/^web_[0-9a-f]{32}$/)
    expect(lease.accept).toHaveBeenCalledTimes(1)
    expect(lease.reject).not.toHaveBeenCalled()

    const request = post.mock.calls[0]?.[0]
    if (!request)
      throw new Error("Web Live transport did not receive a request")
    expect(request.endpoint).toBe("https://chatgpt.com/realtime/wm?dcid=0")
    expect(request.headers.authorization).toBe("Bearer access-token-1")
    expect(request.headers["oai-device-id"]).toBe(lease.deviceId)
    expect(request.headers.origin).toBe("https://chatgpt.com")
    const session = JSON.parse(request.sessionJson) as Record<string, unknown>
    expect(session.voice).toBe("cove")
    expect(session.voice_mode).toBe("wingman")
    expect(session.enable_message_streaming).toBe(true)
  })

  it("refreshes a rejected access token once before accepting the call", async () => {
    const lease = createLease({
      refreshAccessToken: jest.fn().mockResolvedValue("access-token-2"),
    })
    const post = createPostMock()
    post
      .mockResolvedValueOnce({ status: 401, text: "expired", contentType: "" })
      .mockResolvedValueOnce({
        status: 201,
        text: "v=0\r\nweb-answer",
        contentType: "application/sdp",
      })
    const service = createService(createCodexPool([lease]), post)

    await service.createCall({ sdp: OFFER_SDP, session: {} })

    expect(lease.refreshAccessToken).toHaveBeenCalledTimes(1)
    const retryRequest = post.mock.calls[1]?.[0]
    expect(retryRequest?.headers.authorization).toBe("Bearer access-token-2")
    expect(lease.accept).toHaveBeenCalledTimes(1)
    expect(lease.reject).not.toHaveBeenCalled()
  })

  it("moves to the next Codex account after an upstream failure", async () => {
    const first = createLease({ accountKey: "account-1", label: "first" })
    const second = createLease({ accountKey: "account-2", label: "second" })
    const post = createPostMock()
    post
      .mockResolvedValueOnce({
        status: 500,
        text: "temporary failure",
        contentType: "application/json",
      })
      .mockResolvedValueOnce({
        status: 201,
        text: "v=0\r\nweb-answer",
        contentType: "application/sdp",
      })
    const service = createService(createCodexPool([first, second]), post)

    const result = await service.createCall({ sdp: OFFER_SDP, session: {} })

    expect(result.sdp).toContain("web-answer")
    expect(first.reject).toHaveBeenCalledWith(500, "temporary failure")
    expect(second.accept).toHaveBeenCalledTimes(1)
  })
})

function createLease(
  overrides: Partial<CodexRealtimeAccountLease> = {}
): CodexRealtimeAccountLease {
  return {
    accountKey: "account-1",
    label: "primary",
    accessToken: "access-token-1",
    deviceId: "58c4f084-baa7-43ed-897e-92497a1d26f0",
    proxyUrl: "http://proxy.test:7890",
    refreshAccessToken: jest.fn().mockResolvedValue(null),
    accept: jest.fn(),
    reject: jest.fn(),
    ...overrides,
  }
}

function createCodexPool(leases: CodexRealtimeAccountLease[]): CodexService {
  let index = 0
  return {
    getChatGptWebRealtimeAccountCount: () => leases.length,
    acquireChatGptWebRealtimeAccount: jest.fn(() =>
      Promise.resolve(leases[index++] || null)
    ),
  } as unknown as CodexService
}

function createService(
  codex: CodexService,
  post: jest.MockedFunction<ChatGptWebVoiceTransport["post"]>
): ChatGptWebRealtimeService {
  const transport = {
    settings: SETTINGS,
    post,
  } as unknown as ChatGptWebVoiceTransport
  return new ChatGptWebRealtimeService(codex, transport)
}

function createPostMock(): jest.MockedFunction<
  ChatGptWebVoiceTransport["post"]
> {
  return jest.fn() as jest.MockedFunction<ChatGptWebVoiceTransport["post"]>
}
