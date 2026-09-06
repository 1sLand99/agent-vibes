import { Logger, Module } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { NestFactory } from "@nestjs/core"
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify"
import { ChatGptWebRealtimeService } from "../../llm/openai/chatgpt-web-realtime.service"
import { registerContentTypeParsers } from "../../shared/content-type-parsers"
import { RequiredApiKeyGuard } from "../../shared/required-api-key.guard"
import { RealtimeController } from "./realtime.controller"

const OFFER_SDP = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "",
].join("\r\n")

const realtimeService = {
  createCall: jest.fn(() =>
    Promise.resolve({
      callId: "web_123",
      sdp: "v=0\r\nanswer",
      transport: "chatgpt-web-voice" as const,
    })
  ),
}

@Module({
  controllers: [RealtimeController],
  providers: [
    RequiredApiKeyGuard,
    {
      provide: ConfigService,
      useValue: new ConfigService({ PROXY_API_KEY: "secret" }),
    },
    { provide: ChatGptWebRealtimeService, useValue: realtimeService },
  ],
})
class RealtimeApiTestModule {}

describe("RealtimeController API contract", () => {
  let app: NestFastifyApplication
  let baseUrl: string

  beforeAll(async () => {
    const adapter = new FastifyAdapter({ logger: false })
    registerContentTypeParsers(adapter.getInstance(), new Logger("test"))
    app = await NestFactory.create<NestFastifyApplication>(
      RealtimeApiTestModule,
      adapter,
      { logger: false }
    )
    await app.listen(0, "127.0.0.1")
    const address = app.getHttpServer().address()
    if (!address || typeof address === "string") {
      throw new Error("Realtime API test server did not expose a TCP address")
    }
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await app.close()
  })

  it("requires the bridge API key", async () => {
    const response = await fetch(`${baseUrl}/v1/realtime/calls`, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: OFFER_SDP,
    })

    expect(response.status).toBe(401)
    expect(realtimeService.createCall).not.toHaveBeenCalled()
  })

  it("returns the SDP answer and local call location", async () => {
    const response = await fetch(`${baseUrl}/v1/realtime/calls`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/sdp",
      },
      body: OFFER_SDP,
    })

    expect(response.status).toBe(201)
    expect(response.headers.get("content-type")).toContain("application/sdp")
    expect(response.headers.get("location")).toBe("/v1/realtime/calls/web_123")
    expect(await response.text()).toBe("v=0\r\nanswer")
  })

  it("keeps invalid SDP errors in the OpenAI envelope", async () => {
    const response = await fetch(`${baseUrl}/v1/realtime/calls`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/sdp",
      },
      body: "not-sdp",
    })

    expect(response.status).toBe(400)
    const payload = (await response.json()) as {
      error: { type: string; param: string }
    }
    expect(payload.error.type).toBe("invalid_request_error")
    expect(payload.error.param).toBe("sdp")
  })
})
