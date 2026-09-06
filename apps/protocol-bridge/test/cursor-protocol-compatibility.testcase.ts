import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import { Logger } from "@nestjs/common"
import type { FastifyReply, FastifyRequest } from "fastify"
import * as S from "../src/gen/agent/v1_pb"
import { CursorGrpcService } from "../src/protocol/cursor/cursor-grpc.service"
import { ConnectRPCHandler } from "../src/protocol/cursor/connect-rpc-handler"
import {
  CursorRequestParser,
  isTerminalBackgroundTaskCompletion,
  isBackgroundWorkerNotification,
  normalizeBackgroundTaskCompletions,
  type ParsedCursorRequest,
} from "../src/protocol/cursor/tools/cursor-request-parser"
import { projectCursorUserMessageAction } from "../src/protocol/cursor/session/cursor-history-projector"
import { CursorCloudAttachmentError } from "../src/protocol/cursor/codec/cursor-attachment-reference"
import {
  applyCursorSystemPromptSpec,
  decodeCursorProtocolSessionState,
  mergeCursorProtocolSessionState,
  readCursorUserMessageMetadata,
  type CursorProtocolSessionState,
} from "../src/protocol/cursor/session/cursor-protocol-state"
import { getCursorOfficialPassthroughTarget } from "../src/protocol/cursor/cursor-official-passthrough"
import { getDefaultAgentToolNames } from "../src/protocol/cursor/tools/cursor-tool-mapper"
import { CURSOR_TOOL_CALL_CAPABILITIES } from "../src/protocol/cursor/tools/cursor-protocol-capability-manifest"
import {
  SessionLifecycleService,
  type SessionRecord,
} from "../src/protocol/cursor/session/session-lifecycle.service"
import {
  SessionPersistenceService,
  type SessionRow,
} from "../src/protocol/cursor/session/session-persistence.service"
import { SESSION_TXN_TAG } from "../src/protocol/cursor/session/tool-call-ledger.service"
import { ConversationId } from "../src/protocol/cursor/turn/turn.types"
import { createCodexRootProviderIdentity } from "../src/llm/openai/codex-provider-identity"
import type { PersistenceService } from "../src/persistence"
import { buildCursorProtocolInventory } from "../../../scripts/smoke/cursor-protocol-inventory"

Logger.overrideLogger(false)
const parser = new CursorRequestParser()
const grpc = new CursorGrpcService()
const wireFrameRef = {
  streamEpoch: "fixture-stream",
  seq: 0,
  direction: "inbound" as const,
  frameKind: "conversationAction",
}
const imageData = Uint8Array.from([137, 80, 78, 71])
function action(uploadRef = false, text = "fixture prompt") {
  return create(S.UserMessageActionSchema, {
    userMessage: {
      text,
      messageId: "fixture-message",
      turnSteer: true,
      startedAtMs: 9007199254740993n,
      completedAtMs: 9007199254740994n,
      selectedContext: {
        selectedImages: [
          {
            uuid: "fixture-image",
            mimeType: "image/png",
            dataOrBlobId: uploadRef
              ? {
                  case: "promptUploadRef",
                  value: { uploadId: "fixture-upload" },
                }
              : { case: "data", value: imageData },
          },
        ],
      },
    },
  })
}
function parseAction(value: S.UserMessageAction) {
  return parser.parseRequest(
    Buffer.from(
      toBinary(
        S.AgentClientMessageSchema,
        create(S.AgentClientMessageSchema, {
          message: {
            case: "conversationAction",
            value: { action: { case: "userMessageAction", value } },
          },
        })
      )
    )
  )
}
function parseRun(value: S.AgentRunRequest) {
  return parser.parseRequest(
    Buffer.from(
      toBinary(
        S.AgentClientMessageSchema,
        create(S.AgentClientMessageSchema, {
          message: { case: "runRequest", value },
        })
      )
    )
  )
}
function decodeServer(frame: Buffer) {
  assert.equal(frame.readUInt32BE(1), frame.length - 5)
  return fromBinary(S.AgentServerMessageSchema, frame.subarray(5))
}

void test("inventory covers new cases without advertising cloud tools", () => {
  const inventory = buildCursorProtocolInventory()
  assert.equal(inventory.counts.execPairs, 41)
  assert.equal(inventory.counts.interactionUpdates, 24)
  assert(inventory.interactionUpdates.includes("routedModel"))
  const names = [
    "adoptToolCall",
    "getAgentStatusToolCall",
    "sendToAgentToolCall",
    "readAgentTranscriptToolCall",
    "createAgentToolCall",
    "stopAgentToolCall",
    "getPrCodeTourToolCall",
  ]
  for (const caseId of names) {
    const capability = CURSOR_TOOL_CALL_CAPABILITIES.find(
      (entry) => entry.caseId === caseId
    )!
    assert.equal(capability.support, "unsupported")
    assert.equal(capability.exposurePolicy, "unsupported")
    for (const name of capability.modelToolNames)
      assert(!getDefaultAgentToolNames().includes(name))
  }
})

void test("sandbox accepts current values and rejects removed custom boundary", () => {
  const service = grpc as unknown as {
    normalizeSandboxReadBoundary(value: unknown): number
  }
  for (const value of [0, 1, 2])
    assert.equal(service.normalizeSandboxReadBoundary(value), value)
  assert.equal(service.normalizeSandboxReadBoundary("workspace"), 2)
  assert.equal(service.normalizeSandboxReadBoundary("system"), 1)
  assert.throws(
    () => service.normalizeSandboxReadBoundary("custom"),
    /no longer supports/
  )
  assert.throws(() => service.normalizeSandboxReadBoundary(3), /Unsupported/)
})

void test("all 41 exec results map descriptor names and retain exact nested bytes", () => {
  for (const field of S.ExecClientMessageSchema.fields.filter(
    (field) => field.oneof?.name === "message"
  )) {
    assert.equal(field.fieldKind, "message")
    if (field.fieldKind !== "message") continue
    const exec = create(S.ExecClientMessageSchema, {
      id: 42,
      execId: "fixture-exec",
      message: {
        case: field.localName,
        value: create(field.message),
      } as S.ExecClientMessage["message"],
    })
    const frame = create(S.AgentClientMessageSchema, {
      message: { case: "execClientMessage", value: exec },
    })
    const parsed = parser.parseRequest(
      Buffer.from(toBinary(S.AgentClientMessageSchema, frame))
    )!
    assert.equal(parsed.toolResults![0]!.resultCase, field.name)
    assert.deepEqual(
      parsed.toolResults![0]!.resultData,
      Buffer.from(toBinary(S.ExecClientMessageSchema, exec))
    )
  }
})

void test("existing inline and conversation-scoped blob images still project", () => {
  assert.equal(parseAction(action(false, ""))!.attachedImages!.length, 1)
  const value = action(false, "")
  value.userMessage!.selectedContext!.selectedImages[0]!.dataOrBlobId = {
    case: "blobId",
    value: new Uint8Array([1, 2]),
  }
  const resolved = parser.resolveConversationReferences(parseAction(value)!, {
    resolveBlob: () => imageData,
  })
  assert.equal(
    resolved.attachedImages![0]!.data,
    Buffer.from(imageData).toString("base64")
  )
  const projection = projectCursorUserMessageAction({
    action: value,
    wireFrameRef,
    resolver: { resolveBlob: () => imageData },
  })
  assert.equal(projection.messages[0]!.content[0]!.type, "image")
})

void test("cloud image references return a typed error instead of disappearing", () => {
  for (const text of ["", "inspect this picture"]) {
    assert.throws(
      () => parseAction(action(true, text)),
      CursorCloudAttachmentError
    )
    assert.throws(
      () =>
        projectCursorUserMessageAction({
          action: action(true, text),
          wireFrameRef,
        }),
      CursorCloudAttachmentError
    )
  }
})

void test("cloud documents and prepended images use the same explicit boundary", () => {
  const value = action()
  value.userMessage!.selectedContext!.selectedDocuments.push(
    create(S.SelectedDocumentSchema, {
      filename: "fixture.pdf",
      dataOrBlobId: {
        case: "promptUploadRef",
        value: { uploadId: "fixture-doc" },
      },
    })
  )
  assert.throws(() => parseAction(value), CursorCloudAttachmentError)
  const prepend = action()
  prepend.prependUserMessages.push(action(true).userMessage!)
  assert.throws(
    () => projectCursorUserMessageAction({ action: prepend, wireFrameRef }),
    CursorCloudAttachmentError
  )
})

void test("attachment error reaches a failed_precondition Connect end-stream frame", async () => {
  const frames: Buffer[] = []
  let ended = false
  const reply = {
    raw: {
      setHeader() {},
      write(frame: Buffer) {
        frames.push(frame)
      },
      end() {
        ended = true
      },
    },
    hijack() {},
  } as unknown as FastifyReply
  await new ConnectRPCHandler().handleBidiStream(
    { headers: {} } as FastifyRequest,
    reply,
    () =>
      Promise.resolve().then(() => {
        parseAction(action(true))
      })
  )
  assert.equal(ended, true)
  assert.equal(frames.length, 1)
  assert.equal(frames[0]![0], 2)
  const end = JSON.parse(frames[0]!.subarray(5).toString()) as {
    error: { code: string; message: string }
  }
  assert.equal(end.error.code, "failed_precondition")
  assert.equal(end.error.message, new CursorCloudAttachmentError().message)
})

void test("steer and uint64 timing survive graph metadata and re-encoding", () => {
  const value = action()
  // Cursor creates an agent turn for a steer; the flag is not bridge task ownership.
  assert.equal(parseAction(value)!.chatTurnExecutionIntent, "new_top_level")
  const metadata = JSON.parse(
    JSON.stringify(
      projectCursorUserMessageAction({ action: value, wireFrameRef })
        .messages[0]!.metadata
    )
  ) as Record<string, unknown>
  const rebuilt = create(
    S.UserMessageSchema,
    readCursorUserMessageMetadata(metadata)
  )
  assert.equal(rebuilt.turnSteer, true)
  assert.equal(rebuilt.startedAtMs, value.userMessage!.startedAtMs)
  assert.equal(rebuilt.completedAtMs, value.userMessage!.completedAtMs)
  assert.equal(
    readCursorUserMessageMetadata({ startedAtMs: "18446744073709551616" })
      .startedAtMs,
    undefined
  )
})

void test("recordOnly and timestamp survive normalization without triggering completion", () => {
  const raw = create(S.BackgroundTaskCompletionSchema, {
    taskId: "fixture-task",
    recordOnly: true,
    completedAtMs: 9007199254740993n,
    reason: S.BackgroundTaskCompletionReason.TASK_FINISHED,
    status: S.BackgroundTaskStatus.SUCCESS,
  })
  const [completion] = normalizeBackgroundTaskCompletions([raw])
  assert.equal(completion!.recordOnly, true)
  assert.equal(completion!.completedAtMs, "9007199254740993")
  assert.doesNotThrow(() => JSON.stringify(completion))
  assert.equal(isTerminalBackgroundTaskCompletion(completion!), false)
  assert.equal(isBackgroundWorkerNotification(completion!), false)
})

void test("worker notifications never claim terminal delivery; old completion behavior remains", () => {
  for (const reason of [
    S.BackgroundTaskCompletionReason.WORKER_MESSAGE,
    S.BackgroundTaskCompletionReason.WORKER_REPARENTED,
    S.BackgroundTaskCompletionReason.WORKER_NEEDS_ATTENTION,
  ]) {
    const completion = {
      taskId: "fixture-worker",
      status: S.BackgroundTaskStatus.SUCCESS,
      reason,
    }
    assert.equal(isTerminalBackgroundTaskCompletion(completion), false)
    assert.equal(isBackgroundWorkerNotification(completion), true)
  }
  assert.equal(
    isTerminalBackgroundTaskCompletion({
      taskId: "t",
      reason: S.BackgroundTaskCompletionReason.TASK_PROGRESS,
      status: S.BackgroundTaskStatus.SUCCESS,
    }),
    false
  )
  assert.equal(
    isTerminalBackgroundTaskCompletion({
      taskId: "t",
      reason: S.BackgroundTaskCompletionReason.TASK_FINISHED,
    }),
    true
  )
  assert.equal(
    isTerminalBackgroundTaskCompletion({
      taskId: "t",
      status: S.BackgroundTaskStatus.SUCCESS,
    }),
    true
  )
  assert.equal(
    isTerminalBackgroundTaskCompletion({
      taskId: "t",
      reason: 123,
      status: S.BackgroundTaskStatus.SUCCESS,
    }),
    false
  )
})

const protocolState: CursorProtocolSessionState = {
  clientSupportsRoutedModelUpdate: true,
  systemPrompt: { mode: "replace", content: "fixture system" },
  conversation: {
    completedAskQuestionToolCallIds: ["ask-1"],
    durableSkillBlocks: ["fixture skill"],
    durableCustomModeId: "fixture-mode",
    messageCountAtLastCompaction: 12,
  },
}
function stateRun() {
  return create(S.AgentRunRequestSchema, {
    conversationId: "fixture-conversation",
    requestedModel: { modelId: "gpt-5.4" },
    clientSupportsRoutedModelUpdate: true,
    systemPromptSpec: { spec: { case: "replace", value: "fixture system" } },
    conversationState: protocolState.conversation,
    action: { action: { case: "userMessageAction", value: action() } },
  })
}

void test("run state survives parsing and checkpoint serialization", () => {
  const parsed = parseRun(stateRun())!
  assert.deepEqual(parsed.cursorProtocolState, protocolState)
  const decoded = decodeServer(
    grpc.createConversationCheckpointResponse(
      "fixture-conversation",
      "gpt-5.4",
      { cursorProtocolState: parsed.cursorProtocolState }
    )
  )
  assert.equal(decoded.message.case, "conversationCheckpointUpdate")
  if (decoded.message.case !== "conversationCheckpointUpdate") return
  const state = decoded.message.value
  assert.deepEqual(state.completedAskQuestionToolCallIds, ["ask-1"])
  assert.deepEqual(state.durableSkillBlocks, ["fixture skill"])
  assert.equal(state.durableCustomModeId, "fixture-mode")
  assert.equal(state.messageCountAtLastCompaction, 12)
})

void test("prompt replace, append, clear, and context override stay distinct", () => {
  assert.equal(
    applyCursorSystemPromptSpec("base", { mode: "replace", content: "" }),
    ""
  )
  assert.equal(
    applyCursorSystemPromptSpec("base", { mode: "append", content: "extra" }),
    "base\n\nextra"
  )
  assert.equal(applyCursorSystemPromptSpec("base", null), "base")
  const value = action()
  value.requestContext = create(S.RequestContextSchema, {
    systemPromptOverride: {
      spec: { case: "append", value: "context instruction" },
    },
  })
  assert.deepEqual(parseAction(value)!.cursorProtocolState!.systemPrompt, {
    mode: "append",
    content: "context instruction",
  })
  const run = stateRun()
  run.systemPromptSpec = undefined
  run.action!.action = { case: "userMessageAction", value }
  assert.deepEqual(parseRun(run)!.cursorProtocolState!.systemPrompt, {
    mode: "append",
    content: "context instruction",
  })
  const updated = mergeCursorProtocolSessionState(protocolState, {
    systemPrompt: null,
  })!
  assert.equal(updated.systemPrompt, null)
  assert.deepEqual(updated.conversation, protocolState.conversation)
  updated.conversation!.durableSkillBlocks.push("new")
  assert.deepEqual(protocolState.conversation!.durableSkillBlocks, [
    "fixture skill",
  ])
})

void test("omitted prompt fields preserve replace and append overrides after parsing", () => {
  const run = stateRun()
  run.systemPromptSpec = undefined
  const incoming = parseRun(run)!.cursorProtocolState!
  assert.equal(Object.hasOwn(incoming, "systemPrompt"), false)
  for (const mode of ["replace", "append"] as const) {
    const previous = { systemPrompt: { mode, content: "retained instruction" } }
    const merged = mergeCursorProtocolSessionState(previous, incoming)!
    assert.deepEqual(merged.systemPrompt, previous.systemPrompt)
    assert.equal(
      applyCursorSystemPromptSpec("base", merged.systemPrompt),
      mode === "replace"
        ? "retained instruction"
        : "base\n\nretained instruction"
    )
  }
})

void test("explicit prompt presence controls clearing, precedence and empty overrides", () => {
  const run = stateRun()
  const value = action()
  value.requestContext = create(S.RequestContextSchema, {
    systemPromptOverride: {
      spec: { case: "append", value: "context instruction" },
    },
  })
  run.action!.action = { case: "userMessageAction", value }
  assert.deepEqual(
    parseRun(run)!.cursorProtocolState!.systemPrompt,
    protocolState.systemPrompt
  )

  // A present empty spec clears the override, including a context fallback.
  run.systemPromptSpec = create(S.SystemPromptSpecSchema)
  const cleared = parseRun(run)!.cursorProtocolState!
  assert.equal(cleared.systemPrompt, null)
  assert.equal(
    applyCursorSystemPromptSpec(
      "base",
      mergeCursorProtocolSessionState(protocolState, cleared)!.systemPrompt
    ),
    "base"
  )

  run.systemPromptSpec = undefined
  value.requestContext.systemPromptOverride = create(S.SystemPromptSpecSchema)
  assert.equal(parseRun(run)!.cursorProtocolState!.systemPrompt, null)
  assert.equal(parseAction(value)!.cursorProtocolState!.systemPrompt, null)

  for (const mode of ["replace", "append"] as const) {
    run.systemPromptSpec = create(S.SystemPromptSpecSchema, {
      spec: { case: mode, value: "" },
    })
    const empty = parseRun(run)!.cursorProtocolState!.systemPrompt
    assert.deepEqual(empty, { mode, content: "" })
    assert.equal(
      applyCursorSystemPromptSpec("base", empty),
      mode === "replace" ? "" : "base"
    )
  }
})

function refreshSession(
  session: SessionRecord,
  request: ParsedCursorRequest
): SessionRecord {
  const lifecycle = Object.create(SessionLifecycleService.prototype) as {
    prepareSessionRequestRefresh(
      session: SessionRecord,
      context: { mainProjection: { contextState: Record<string, unknown> } },
      request: ParsedCursorRequest
    ): { session: SessionRecord }
  }
  return lifecycle.prepareSessionRequestRefresh(
    session,
    { mainProjection: { contextState: {} } },
    request
  ).session
}

void test("full, resume and control refreshes retain omitted prompts through the lifecycle", () => {
  const run = stateRun()
  run.systemPromptSpec = undefined
  for (const mode of ["replace", "append"] as const) {
    for (const scope of ["full", "partial", "control"] as const) {
      const previous = {
        model: "gpt-5.4",
        supportedTools: [],
        cursorManagedReadResources: [],
        cursorProtocolState: {
          ...protocolState,
          systemPrompt: { mode, content: "retained instruction" },
        },
      } as unknown as SessionRecord
      const parsed = parseRun(run)!
      parsed.sessionUpdateScope = scope
      const refreshed = refreshSession(previous, parsed)
      assert.deepEqual(
        refreshed.cursorProtocolState!.systemPrompt,
        previous.cursorProtocolState!.systemPrompt
      )
      assert.notEqual(
        refreshed.cursorProtocolState,
        previous.cursorProtocolState
      )
      assert.equal(
        applyCursorSystemPromptSpec(
          "base",
          refreshed.cursorProtocolState!.systemPrompt
        ),
        mode === "replace"
          ? "retained instruction"
          : "base\n\nretained instruction"
      )
    }
  }
})

void test("MCP schemas and annotations work on full and incremental requests", () => {
  const value = action()
  value.requestContext = create(S.RequestContextSchema, {
    tools: [
      {
        name: "fixture-server-tool",
        toolName: "tool",
        providerIdentifier: "fixture-server",
        inputSchemaJson: '{"type":"object"}',
        outputSchemaJson: '{"type":"object"}',
        annotationsJson: '{"readOnlyHint":true}',
      },
    ],
  })
  const run = stateRun()
  run.action!.action = { case: "userMessageAction", value }
  for (const parsed of [parseRun(run)!, parseAction(value)!]) {
    assert.deepEqual(parsed.mcpToolDefs![0]!.annotations, {
      readOnlyHint: true,
    })
    assert.deepEqual(parsed.mcpToolDefs![0]!.outputSchema, { type: "object" })
    assert(parsed.supportedTools.includes("fixture-server-tool"))
  }
  value.requestContext.tools[0]!.annotationsJson = "{invalid"
  assert.equal(parseAction(value)!.mcpToolDefs![0]!.annotations, undefined)
})

void test("protocol and MCP state survive the real SQLite session repository", () => {
  const db = new DatabaseSync(":memory:")
  try {
    db.exec(
      "CREATE TABLE sessions (conversation_id TEXT PRIMARY KEY, created_at INTEGER, last_activity_at INTEGER, model TEXT, config_json TEXT)"
    )
    const persistence = {
      prepare: (sql: string) => db.prepare(sql),
    } as PersistenceService
    const repo = new SessionPersistenceService(persistence)
    const lifecycle = Object.create(SessionLifecycleService.prototype) as {
      serializeSessionConfig(session: SessionRecord): Record<string, unknown>
      readCurrentSessionConfig(row: SessionRow): {
        cursorProtocolState?: CursorProtocolSessionState
        mcpToolDefs?: Array<{ annotations?: unknown; outputSchema?: unknown }>
      }
    }
    const session = {
      codexProviderIdentity: createCodexRootProviderIdentity(),
      thinkingLevel: 0,
      thinkingDetailsRequested: false,
      isAgentic: true,
      supportedTools: [],
      useWeb: false,
      cursorManagedReadResources: [],
      cursorProtocolState: protocolState,
      mcpToolDefs: [
        {
          name: "fixture-tool",
          toolName: "tool",
          providerIdentifier: "fixture",
          description: "",
          ideRegistryKey: "fixture",
          outputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
    } as unknown as SessionRecord
    const conversationId = ConversationId.of("fixture-conversation")
    const row = {
      conversationId,
      createdAt: 1,
      lastActivityAt: 2,
      model: "gpt-5.4",
      config: lifecycle.serializeSessionConfig(session),
    }
    db.exec("BEGIN")
    repo.upsertSessionInTransaction(
      { tag: SESSION_TXN_TAG, conversationId, persistence } as never,
      row
    )
    db.exec("COMMIT")
    const reopened = new SessionPersistenceService(persistence).loadSession(
      conversationId
    )!
    const config = lifecycle.readCurrentSessionConfig(reopened)
    assert.deepEqual(config.cursorProtocolState, protocolState)
    assert.deepEqual(config.mcpToolDefs![0]!.annotations, {
      readOnlyHint: true,
    })
    assert.deepEqual(config.mcpToolDefs![0]!.outputSchema, { type: "object" })

    // Resume from durable state without re-sending the prompt, then persist again.
    const resume = stateRun()
    resume.systemPromptSpec = undefined
    const refreshed = refreshSession(
      {
        ...session,
        model: "gpt-5.4",
        cursorProtocolState: config.cursorProtocolState,
      },
      parseRun(resume)!
    )
    db.exec("BEGIN")
    repo.upsertSessionInTransaction(
      { tag: SESSION_TXN_TAG, conversationId, persistence } as never,
      { ...row, config: lifecycle.serializeSessionConfig(refreshed) }
    )
    db.exec("COMMIT")
    const resumed = lifecycle.readCurrentSessionConfig(
      repo.loadSession(conversationId)!
    )
    assert.deepEqual(
      resumed.cursorProtocolState!.systemPrompt,
      protocolState.systemPrompt
    )
    assert.equal(
      applyCursorSystemPromptSpec(
        "base",
        resumed.cursorProtocolState!.systemPrompt
      ),
      "fixture system"
    )
    delete reopened.config.cursorProtocolState
    assert.equal(
      lifecycle.readCurrentSessionConfig(reopened).cursorProtocolState,
      undefined
    )
  } finally {
    db.close()
  }
})

void test("state decoder rejects malformed enums, numbers, and unknown fields", () => {
  assert.deepEqual(
    decodeCursorProtocolSessionState(JSON.parse(JSON.stringify(protocolState))),
    protocolState
  )
  for (const invalid of [
    { unexpected: true },
    { systemPrompt: { mode: "unknown", content: "x" } },
    { clientSupportsRoutedModelUpdate: "true" },
    {
      conversation: {
        completedAskQuestionToolCallIds: [],
        durableSkillBlocks: [42],
      },
    },
    {
      conversation: {
        completedAskQuestionToolCallIds: [],
        durableSkillBlocks: [],
        messageCountAtLastCompaction: -1,
      },
    },
  ])
    assert.throws(() => decodeCursorProtocolSessionState(invalid))
})

void test("routed model has a valid wire frame; official endpoints keep ownership", () => {
  const update = decodeServer(
    grpc.createRoutedModelResponse("fixture-routed-model")
  )
  assert.equal(update.message.case, "interactionUpdate")
  if (update.message.case !== "interactionUpdate") return
  assert.equal(update.message.value.message.case, "routedModel")
  if (update.message.value.message.case === "routedModel")
    assert.equal(
      update.message.value.message.value.displayName,
      "fixture-routed-model"
    )
  assert.equal(
    getCursorOfficialPassthroughTarget("/agent.v1.AgentService/Run", "POST"),
    null
  )
  assert.equal(
    getCursorOfficialPassthroughTarget(
      "/agent.v1.AgentHostService/ListSessions",
      "POST"
    )!.family,
    "agent"
  )
  for (const method of [
    "PresignPromptUpload",
    "CompletePromptUpload",
    "AbortPromptUpload",
  ])
    assert.equal(
      getCursorOfficialPassthroughTarget(
        `/aiserver.v1.BackgroundComposerService/${method}`,
        "POST"
      )!.family,
      "api"
    )
})
