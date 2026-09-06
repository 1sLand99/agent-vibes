import assert from "node:assert/strict"
import { test } from "node:test"
import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import { Logger } from "@nestjs/common"
import * as S from "../src/gen/agent/v1_pb"
import { CursorConnectStreamService } from "../src/protocol/cursor/cursor-connect-stream.service"
import { CursorGrpcService } from "../src/protocol/cursor/cursor-grpc.service"
import { CursorCloudAttachmentError } from "../src/protocol/cursor/codec/cursor-attachment-reference"
import type { TurnOutbound } from "../src/protocol/cursor/bidi/bidi-outbound"
import { TurnId } from "../src/protocol/cursor/turn/turn.types"
import type {
  CursorWireFrameRef,
  ParsedCursorRequest,
} from "../src/protocol/cursor/tools/cursor-request-parser"

Logger.overrideLogger(false)

/** Real parser, input pump, FIFO, controller and outbound; no provider requests. */
function streamFixture() {
  const service = Object.create(
    CursorConnectStreamService.prototype
  ) as CursorConnectStreamService
  const persisted: Buffer[] = []
  const turnId = TurnId.of("fixture-umbrella")
  let outbound: TurnOutbound
  Object.assign(service, {
    logger: new Logger("stream-fixture"),
    grpcService: new CursorGrpcService(),
    umbrellaHandleByConversation: new Map(),
    turnSupervisor: {
      spawn(args: { outbound: TurnOutbound }) {
        outbound = args.outbound
        outbound.pushWriter(turnId)
        return {
          handle: { turnId, outbound },
          awaitTerminal: Promise.resolve(),
        }
      },
    },
    turnCleanupCoordinator: {
      cleanup(args: { outbound: TurnOutbound }) {
        args.outbound.beginSeal({ kind: "bidi-closed" })
        args.outbound.popWriter(turnId)
        args.outbound.finishSeal()
        return Promise.resolve()
      },
    },
    runWithTurnContext: (_handle: unknown, work: () => Promise<void>) => work(),
    workspacePreferences: {
      applyToRequest: (_id: string, request: ParsedCursorRequest) => request,
    },
    bindCursorRequestBlobs: (_id: string, request: ParsedCursorRequest) =>
      request,
    sanitizeParsedRequestForSession: (request: ParsedCursorRequest) => request,
    persistCursorWireFrame(frame: {
      payload: Buffer
      frameKind: string
    }): CursorWireFrameRef {
      persisted.push(frame.payload)
      return {
        seq: persisted.length - 1,
        streamEpoch: "fixture",
        direction: "inbound",
        frameKind: frame.frameKind,
      }
    },
    sessionManager: {
      getOrCreateSession() {},
      getSession: () => ({ conversationId: "fixture-conversation" }),
      touchSession() {},
      listPendingToolCallIds: () => [],
    },
    sessionStream: {
      rotateStreamId: () => "fixture-stream",
      rebindPendingToolCallsToCurrentStream: () => 0,
    },
    execDispatchSerializer: { clearStream() {} },
    shouldAbortSupersededStream: () => false,
    hasPendingStreamWork: () => true,
    attachController() {},
    detachController() {},
    abortBackendRequestsForStream() {},
    applyInterruptedPendingToolCallResolutions: () => Promise.resolve(),
    waitForDurableToolRecoveryBeforeContinuation() {
      assert.fail("record-only notification must not run continuation recovery")
    },
    handleBackgroundTaskCompletionAction() {
      assert.fail(
        "record-only notification must not enqueue a model continuation"
      )
    },
    emit(_id: string, frame: Buffer) {
      outbound.write(turnId, frame)
      return true
    },
  })
  return { service, persisted }
}

async function collect(
  service: CursorConnectStreamService,
  messages: S.AgentClientMessage[]
) {
  const frames: Buffer[] = []
  async function* input() {
    for (const message of messages) {
      yield await Promise.resolve(
        Buffer.from(toBinary(S.AgentClientMessageSchema, message))
      )
    }
  }
  for await (const frame of service.handleBidiStream(input()))
    frames.push(frame)
  return frames
}

void test(
  "record-only frames stay passive through the real BiDi input pump",
  { timeout: 5000 },
  async () => {
    const f = streamFixture()
    const messages = ["task-1", "task-2"].map((taskId) =>
      create(S.AgentClientMessageSchema, {
        message: {
          case: "runRequest",
          value: {
            conversationId: "fixture-conversation",
            action: {
              action: {
                case: "backgroundTaskCompletionAction",
                value: {
                  completions: [
                    {
                      taskId,
                      recordOnly: true,
                      reason: S.BackgroundTaskCompletionReason.TASK_FINISHED,
                      status: S.BackgroundTaskStatus.SUCCESS,
                    },
                  ],
                },
              },
            },
          },
        },
      })
    )
    const frames = await collect(f.service, messages)
    assert.equal(f.persisted.length, 2)
    assert.equal(frames.length, 2)
    for (const frame of frames) {
      const update = fromBinary(
        S.AgentServerMessageSchema,
        frame.subarray(5)
      ).message
      assert.equal(update.case, "interactionUpdate")
      if (update.case === "interactionUpdate")
        assert.equal(update.value.message.case, "heartbeat")
    }
  }
)

void test(
  "cloud attachment failure survives input-pump cleanup instead of a success EOF",
  { timeout: 5000 },
  async () => {
    const f = streamFixture()
    const message = create(S.AgentClientMessageSchema, {
      message: {
        case: "conversationAction",
        value: {
          action: {
            case: "userMessageAction",
            value: {
              userMessage: {
                text: "inspect",
                selectedContext: {
                  selectedImages: [
                    {
                      dataOrBlobId: {
                        case: "promptUploadRef",
                        value: { uploadId: "fixture-upload" },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    })
    await assert.rejects(
      () => collect(f.service, [message]),
      CursorCloudAttachmentError
    )
  }
)

void test("mixed worker and record-only notifications never settle a shell or subagent", async () => {
  const service = Object.create(CursorConnectStreamService.prototype) as {
    handleBackgroundTaskCompletionAction(
      id: string,
      parsed: ParsedCursorRequest
    ): Promise<boolean>
  }
  const continuations: Array<{ parsed: ParsedCursorRequest; text: string }> = []
  Object.assign(service, {
    logger: new Logger("completion-fixture"),
    sessionManager: { getSession: () => ({}) },
    subagentRunStore: { listPendingTerminalDeliveries: () => [] },
    backgroundCommandStore: new Proxy(
      {},
      {
        get() {
          assert.fail("notification must not settle a background command")
        },
      }
    ),
    continueAgentFromControlContinuation(
      _id: string,
      parsed: ParsedCursorRequest,
      text: string
    ) {
      continuations.push({ parsed, text })
      return Promise.resolve(true)
    },
  })
  const parsed = {
    agentControlBackgroundTaskCompletions: [
      {
        taskId: "record-only",
        recordOnly: true,
        kind: 1,
        reason: S.BackgroundTaskCompletionReason.TASK_FINISHED,
        status: S.BackgroundTaskStatus.SUCCESS,
      },
      {
        taskId: "worker",
        kind: 2,
        reason: S.BackgroundTaskCompletionReason.WORKER_MESSAGE,
        status: S.BackgroundTaskStatus.SUCCESS,
        detail: "worker update",
        completedAtMs: "9007199254740993",
      },
    ],
  } as ParsedCursorRequest
  assert.equal(
    await service.handleBackgroundTaskCompletionAction(
      "fixture-conversation",
      parsed
    ),
    true
  )
  assert.equal(continuations.length, 1)
  assert.match(continuations[0]!.text, /\[background_task notification\]/)
  assert.match(continuations[0]!.text, /worker update/)
  assert.match(continuations[0]!.text, /9007199254740993/)
  assert.doesNotMatch(continuations[0]!.text, /record-only/)
  assert.equal(continuations[0]!.parsed.syntheticGraphInput, undefined)
})
