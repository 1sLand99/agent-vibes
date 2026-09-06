import {
  parseChatGptWebRealtimeCallRequest,
  parseRealtimeMultipartBody,
} from "./chatgpt-web-realtime"

const OFFER_SDP = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "",
].join("\r\n")

describe("ChatGPT Web Realtime request parsing", () => {
  it("accepts an application/sdp browser offer", () => {
    const result = parseChatGptWebRealtimeCallRequest(
      OFFER_SDP,
      "application/sdp"
    )

    expect(result.sdp).toBe(OFFER_SDP)
    expect(result.session).toEqual({ type: "realtime", model: "gpt-realtime" })
  })

  it("parses the standard multipart sdp and session fields", () => {
    const boundary = "agent-vibes-boundary"
    const body = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="sdp"',
        "",
        OFFER_SDP,
        `--${boundary}`,
        'Content-Disposition: form-data; name="session"',
        "",
        JSON.stringify({
          type: "realtime",
          model: "gpt-realtime",
          voice: "marin",
        }),
        `--${boundary}--`,
        "",
      ].join("\r\n")
    )

    const result = parseRealtimeMultipartBody(
      body,
      `multipart/form-data; boundary=${boundary}`
    )

    expect(result.sdp).toBe(OFFER_SDP)
    expect(result.session.voice).toBe("marin")
  })

  it("rejects signaling offers without the Realtime data channel", () => {
    expect(() =>
      parseChatGptWebRealtimeCallRequest(
        "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
        "application/sdp"
      )
    ).toThrow("data channel")
  })
})
