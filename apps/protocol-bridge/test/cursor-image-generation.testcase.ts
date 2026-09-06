import assert from "node:assert/strict"
import { test } from "node:test"
import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import { Logger } from "@nestjs/common"
import type { FastifyReply, FastifyRequest } from "fastify"
import {
  RunGenerateImageRequestSchema,
  RunGenerateImageResponseSchema,
} from "../src/gen/aiserver/v1_pb"
import { AiserverMockController } from "../src/protocol/cursor/controllers/aiserver-mock.controller"
import { ImageGenerationService } from "../src/llm/image-generation/image-generation.service"
import { normalizeImageAspectRatio } from "../src/llm/image-generation/image-aspect-ratio"
import { GoogleService } from "../src/llm/google/google.service"
import type { CodexService } from "../src/llm/openai/codex.service"

Logger.overrideLogger(false)
function fixture(failGoogle = false) {
  const payloads: Array<Record<string, unknown>> = []
  let codexCalls = 0
  const google = Object.create(GoogleService.prototype) as GoogleService
  Object.assign(google, {
    logger: new Logger("fixture"),
    resolveImageGenerationModel: () => Promise.resolve("fixture-gemini-image"),
    createWorkerConversationIdentity: () => ({
      requestId: "fixture-request",
      workerConversationKey: "fixture-conversation",
    }),
    processPool: {
      isConfigured: () => true,
      generate: (payload: Record<string, unknown>) =>
        Promise.resolve().then(() => {
          payloads.push(payload)
          if (failGoogle) throw new Error("fixture provider unavailable")
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: "image/png",
                        data: "fixture-image-base64",
                      },
                    },
                  ],
                },
              },
            ],
          }
        }),
      markContextWorkerModelSuccess() {},
    },
  })
  const codex = {
    generateImage: () => {
      codexCalls++
      return Promise.resolve({ imageData: "fixture-codex-image" })
    },
  } as unknown as CodexService
  const service = new ImageGenerationService(codex, google)
  const controller = Object.create(
    AiserverMockController.prototype
  ) as AiserverMockController
  Object.assign(controller, { imageGenerationService: service })
  return { service, controller, payloads, codexCalls: () => codexCalls }
}
async function request(
  controller: AiserverMockController,
  aspectRatio?: string
) {
  let body: Buffer | undefined
  const reply = {
    header() {
      return this
    },
    status() {
      return this
    },
    send(value: Buffer) {
      body = value
      return this
    },
  } as unknown as FastifyReply
  const input = create(RunGenerateImageRequestSchema, {
    description: "fixture image",
    aspectRatio,
  })
  await controller.runGenerateImage(
    {
      body: Buffer.from(toBinary(RunGenerateImageRequestSchema, input)),
    } as FastifyRequest,
    reply
  )
  assert(body)
  return fromBinary(RunGenerateImageResponseSchema, body)
}

void test("Cursor aspect_ratio reaches Gemini ImageConfig through the real controller and services", async () => {
  const f = fixture()
  const result = await request(f.controller, "16:9")
  assert.equal(result.result.case, "success")
  assert.equal(f.codexCalls(), 0)
  assert.equal(f.payloads.length, 1)
  const payload = f.payloads[0] as {
    request: { generationConfig: { imageConfig: { aspectRatio: string } } }
  }
  assert.equal(payload.request.generationConfig.imageConfig.aspectRatio, "16:9")
})

void test("invalid aspect ratios return a protocol error before provider dispatch", async () => {
  const f = fixture()
  const result = await request(f.controller, "not-a-ratio")
  assert.equal(result.result.case, "error")
  if (result.result.case === "error")
    assert.match(result.result.value.error, /Unsupported image aspect ratio/)
  assert.equal(f.payloads.length, 0)
  assert.equal(f.codexCalls(), 0)
})

void test("requests without aspect_ratio preserve existing provider selection", async () => {
  const f = fixture()
  assert.equal((await request(f.controller)).result.case, "success")
  assert.equal(f.codexCalls(), 1)
  assert.equal(f.payloads.length, 0)
})

void test("provider failure never drops a requested aspect ratio during fallback", async () => {
  const f = fixture(true)
  await assert.rejects(
    () =>
      f.service.generateImage({ prompt: "fixture image", aspectRatio: "3:4" }),
    /Image generation failed/
  )
  assert.equal(f.codexCalls(), 0)
})

void test("valid optional aspect ratios normalize without altering the requested proportions", () => {
  for (const ratio of ["1:1", "16:9", "9:16", "8:1", "1:8", "21:9"])
    assert.equal(normalizeImageAspectRatio(` ${ratio} `), ratio)
  assert.equal(normalizeImageAspectRatio(""), undefined)
  assert.equal(normalizeImageAspectRatio(), undefined)
  assert.throws(() => normalizeImageAspectRatio("0:0"))
})
