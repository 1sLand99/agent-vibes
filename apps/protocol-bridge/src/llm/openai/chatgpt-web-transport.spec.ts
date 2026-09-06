import { ConfigService } from "@nestjs/config"
import { ChatGptWebVoiceTransport } from "./chatgpt-web-transport"

describe("ChatGptWebVoiceTransport", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it("uses native multipart fetch first in automatic mode", async () => {
    const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue(
      new Response("v=0\r\nanswer", {
        status: 201,
        headers: { "content-type": "application/sdp" },
      })
    )
    global.fetch = fetchMock
    const transport = new ChatGptWebVoiceTransport(
      new ConfigService({
        NODE_ENV: "test",
        CHATGPT_WEB_VOICE_TRANSPORT: "auto",
      })
    )

    const result = await transport.post({
      endpoint: "https://chatgpt.com/realtime/wm?dcid=0",
      offerSdp: "v=0\r\noffer\r\n",
      sessionJson: '{"voice":"cove"}',
      headers: { authorization: "Bearer token" },
    })

    expect(result).toEqual({
      status: 201,
      text: "v=0\r\nanswer",
      contentType: "application/sdp",
    })
    const init = fetchMock.mock.calls[0]?.[1]
    const headers = init?.headers as Record<string, string> | undefined
    expect(headers?.authorization).toBe("Bearer token")
    const body = init?.body
    expect(body).toBeInstanceOf(FormData)
    if (!(body instanceof FormData)) {
      throw new Error("Web Live fetch body was not multipart form data")
    }
    expect(body.get("sdp")).toBe("v=0\r\noffer\r\n")
    expect(body.get("session")).toBe('{"voice":"cove"}')
  })
})
