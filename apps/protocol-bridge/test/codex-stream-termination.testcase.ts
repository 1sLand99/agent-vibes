import assert from "node:assert/strict"
import { test } from "node:test"
import { once } from "node:events"
import { Logger } from "@nestjs/common"
import WebSocket, { WebSocketServer } from "ws"
import { CodexApiError } from "../src/llm/openai/codex-api-error"
import { readCodexResponseOutcome } from "../src/llm/openai/codex-response-outcome"
import { CodexService } from "../src/llm/openai/codex.service"
import {
  CodexWebSocketService,
  type WebSocketSession,
} from "../src/llm/openai/codex-websocket.service"
import {
  CODEX_RESPONSE_COMPLETED_EVENT,
  CODEX_RESPONSE_TERMINAL_EVENT,
  createCodexRemoteCompactionV2Collector,
} from "../src/llm/openai/codex-compact-payload"
import { CursorConnectStreamService } from "../src/protocol/cursor/cursor-connect-stream.service"
import { CursorGrpcService } from "../src/protocol/cursor/cursor-grpc.service"
import { readCodexResponseEvents } from "../src/llm/openai/codex-sse-reader"
import {
  createStreamState,
  translateCodexSseEvent,
} from "../src/llm/openai/codex-response-translator"

Logger.overrideLogger(false)

const formatter = Object.create(CodexService.prototype) as {
  formatCodexResponseCompletedEvent(
    event: Record<string, unknown>
  ): string | undefined
  formatCodexResponseTerminalEvent(
    event: Record<string, unknown>
  ): string | undefined
}
function decode(frame: string): Record<string, unknown> {
  return JSON.parse(frame.split("\ndata: ")[1]!) as Record<string, unknown>
}

const incomplete = {
  type: "response.incomplete",
  response: {
    id: "resp-fixture",
    incomplete_details: { reason: "max_output_tokens" },
    usage: {
      input_tokens: 20,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 5 },
    },
    usage_metadata: { fixture: true },
  },
}

void test(
  "HTTP max-output termination preserves the event and cancels the reader",
  { timeout: 2000 },
  async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(incomplete)}\n\n`)
        )
      },
      cancel() {
        cancelled = true
      },
    })
    const events = []
    for await (const event of readCodexResponseEvents(body)) events.push(event)
    assert.deepEqual(events, [incomplete])
    assert.equal(body.locked, false)
    assert.equal(cancelled, true)
  }
)

void test("max-output translation emits max_tokens and retains usage", () => {
  const events = translateCodexSseEvent(
    `data: ${JSON.stringify(incomplete)}`,
    createStreamState(),
    new Map()
  ).map(decode)
  assert.deepEqual(events, [
    {
      type: "message_delta",
      delta: {
        stop_reason: "max_tokens",
        stop_sequence: null,
        incomplete_reason: "max_output_tokens",
      },
      usage: {
        input_tokens: 15,
        output_tokens: 50,
        cache_read_input_tokens: 5,
      },
    },
    { type: "message_stop" },
  ])
})

void test("max-output has an incomplete terminal fact, never a compaction completion", () => {
  const frame = formatter.formatCodexResponseTerminalEvent(incomplete)!
  assert.deepEqual(decode(frame), {
    type: CODEX_RESPONSE_TERMINAL_EVENT,
    status: "incomplete",
    responseId: "resp-fixture",
    incompleteReason: "max_output_tokens",
    usage: incomplete.response.usage,
    usageMetadata: incomplete.response.usage_metadata,
  })
  assert.equal(
    formatter.formatCodexResponseCompletedEvent(incomplete),
    undefined
  )
  const collector = createCodexRemoteCompactionV2Collector()
  collector.acceptSseEvent(frame)
  assert.throws(
    () =>
      collector.finish({
        preTriggerInput: [],
        requestInput: [],
        wireInput: [],
      }),
    /completed/
  )
  assert.throws(
    () => readCodexResponseOutcome(incomplete),
    (error: unknown) =>
      error instanceof CodexApiError &&
      error.providerCode === "response_incomplete"
  )
})

void test("completed responses keep their completion event and end_turn semantics", () => {
  for (const endTurn of [true, false]) {
    const event = {
      type: "response.completed",
      response: { id: "resp-fixture", end_turn: endTurn },
    }
    assert.deepEqual(
      decode(formatter.formatCodexResponseCompletedEvent(event)!),
      {
        type: CODEX_RESPONSE_COMPLETED_EVENT,
        responseId: "resp-fixture",
        endTurn,
      }
    )
    assert.equal(
      decode(formatter.formatCodexResponseTerminalEvent(event)!).status,
      "completed"
    )
    const translated = translateCodexSseEvent(
      `data: ${JSON.stringify(event)}`,
      createStreamState(),
      new Map()
    ).map(decode)
    assert.deepEqual(translated[0]!.delta, {
      stop_reason: endTurn ? "end_turn" : "continue",
      stop_sequence: null,
    })
  }
})

void test("non-recoverable incomplete, failed and malformed terminal responses still fail", async () => {
  const events = [
    ...["content_filter", "unknown", undefined].map((reason) => ({
      ...incomplete,
      response: { ...incomplete.response, incomplete_details: { reason } },
    })),
    {
      type: "response.failed",
      response: {
        id: "resp-fixture",
        error: { code: "server_error", message: "fixture failure" },
      },
    },
    ...["", " resp-fixture", undefined].map((id) => ({
      ...incomplete,
      response: { ...incomplete.response, id },
    })),
    { ...incomplete, response: { ...incomplete.response, end_turn: "false" } },
  ]
  for (const event of events) {
    const body = new Response(`data: ${JSON.stringify(event)}\n\n`).body!
    await assert.rejects(async () => {
      for await (const _event of readCodexResponseEvents(body))
        assert.fail("invalid terminal was emitted")
    }, CodexApiError)
    assert.throws(
      () => formatter.formatCodexResponseTerminalEvent(event),
      CodexApiError
    )
    assert.throws(
      () =>
        translateCodexSseEvent(
          `data: ${JSON.stringify(event)}`,
          createStreamState(),
          new Map()
        ),
      CodexApiError
    )
  }
})

void test("HTTP EOF without a terminal response remains a stream failure", async () => {
  const body = new Response(
    'data: {"type":"response.created"}\n\ndata: [DONE]\n\n'
  ).body!
  await assert.rejects(
    async () => {
      for await (const _event of readCodexResponseEvents(body)) {
        /* consume */
      }
    },
    (error: unknown) =>
      error instanceof CodexApiError && error.providerCode === "stream_closed"
  )
  assert.equal(body.locked, false)
})

for (const blockType of ["text", "thinking"] as const) {
  void test(`max-output closes an unfinished ${blockType} block exactly once`, () => {
    const state = createStreamState()
    const start =
      blockType === "text"
        ? { type: "response.content_part.added", content_index: 0 }
        : { type: "response.reasoning_summary_part.added" }
    translateCodexSseEvent(`data: ${JSON.stringify(start)}`, state, new Map())
    const events = translateCodexSseEvent(
      `data: ${JSON.stringify(incomplete)}`,
      state,
      new Map()
    ).map(decode)
    assert.deepEqual(
      events.map((event) => event.type),
      ["content_block_stop", "message_delta", "message_stop"]
    )
    assert.equal(state.textBlockOpen, false)
    assert.equal(state.thinkingBlockOpen, false)
  })
}

async function websocketFixture(
  sessionScoped: boolean,
  terminal: Record<string, unknown> = incomplete
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await once(server, "listening")
  server.on("connection", (socket) => {
    socket.on("message", () => socket.send(JSON.stringify(terminal)))
  })
  const address = server.address()
  assert(address && typeof address === "object")
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`)
  await once(ws, "open")
  const service = new CodexWebSocketService({} as never)
  let session: WebSocketSession | undefined
  if (sessionScoped) {
    session = service.getOrCreateSession("fixture-session")
    session.conn = ws
    ;(
      service as unknown as {
        attachSessionLifecycle(session: WebSocketSession, ws: WebSocket): void
      }
    ).attachSessionLifecycle(session, ws)
  }
  return {
    service,
    ws,
    session,
    async close() {
      service.onModuleDestroy()
      ws.terminate()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    },
  }
}

for (const sessionScoped of [false, true]) {
  void test(
    `WebSocket max-output ends ${sessionScoped ? "session" : "standalone"} streaming without waiting for close`,
    { timeout: 3000 },
    async () => {
      const f = await websocketFixture(sessionScoped)
      try {
        const events = []
        for await (const event of f.service.streamViaWebSocket(f.ws, {}))
          events.push(event)
        assert.deepEqual(events, [incomplete])
        if (f.session) {
          assert.equal(f.session.activeStream, null)
          // Incomplete responses must not become reusable continuation baselines.
          assert.equal(f.session.conn, null)
        } else {
          assert.equal(f.ws.listenerCount("message"), 0)
        }
      } finally {
        await f.close()
      }
    }
  )
}

void test(
  "WebSocket aggregation still rejects max-output rather than accepting partial output",
  { timeout: 3000 },
  async () => {
    const f = await websocketFixture(false)
    try {
      await assert.rejects(
        f.service.sendViaWebSocket(f.ws, {}),
        (error: unknown) =>
          error instanceof CodexApiError &&
          error.providerCode === "response_incomplete"
      )
    } finally {
      await f.close()
    }
  }
)

void test(
  "completed WebSocket responses remain reusable and aggregate normally",
  { timeout: 3000 },
  async () => {
    const completed = {
      type: "response.completed",
      response: { id: "resp-completed", end_turn: true, output: [] },
    }
    const f = await websocketFixture(true, completed)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.deepEqual(await f.service.sendViaWebSocket(f.ws, {}), completed)
        assert.equal(f.session!.conn, f.ws)
        assert.equal(f.session!.activeStream, null)
        assert.equal(f.ws.readyState, WebSocket.OPEN)
      }
    } finally {
      await f.close()
    }
  }
)

void test(
  "WebSocket non-recoverable incomplete still fails and invalidates the session",
  { timeout: 3000 },
  async () => {
    const f = await websocketFixture(true, {
      ...incomplete,
      response: {
        ...incomplete.response,
        incomplete_details: { reason: "content_filter" },
      },
    })
    try {
      await assert.rejects(async () => {
        for await (const _event of f.service.streamViaWebSocket(f.ws, {}))
          assert.fail("invalid terminal was emitted")
      }, CodexApiError)
      assert.equal(f.session!.conn, null)
      assert.equal(f.session!.activeStream, null)
    } finally {
      await f.close()
    }
  }
)

/** Real HTTP reader, terminal formatter, translator and Cursor stream classifier. */
void test("HTTP max-output reaches Cursor recovery with the partial answer intact", async () => {
  const native = [
    {
      type: "response.created",
      response: { id: "resp-fixture", model: "gpt-5.4" },
    },
    { type: "response.content_part.added", content_index: 0 },
    { type: "response.output_text.delta", delta: "partial answer" },
    incomplete,
  ]
  async function* stream() {
    const state = createStreamState()
    const body = new Response(
      native.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    ).body!
    for await (const event of readCodexResponseEvents(body)) {
      const completed = formatter.formatCodexResponseCompletedEvent(event)
      if (completed) yield completed
      const terminal = formatter.formatCodexResponseTerminalEvent(event)
      if (terminal) yield terminal
      yield* translateCodexSseEvent(
        `data: ${JSON.stringify(event)}`,
        state,
        new Map()
      )
    }
  }
  const service = Object.create(CursorConnectStreamService.prototype) as {
    processAssistantTurnStream(params: Record<string, unknown>): Promise<{
      kind: string
      accumulatedText: string
      stopReason: string
    }>
  }
  const drafts: unknown[] = []
  Object.assign(service, {
    logger: new Logger("codex-terminal-fixture"),
    grpcService: new CursorGrpcService(),
    contextState: { markAssistantBackend() {} },
    streamWithHeartbeat: async function* (source: AsyncGenerator<string>) {
      for await (const value of source) yield { type: "data", value }
    },
    markBackendStreamActive() {},
    markBackendStreamInactive() {},
    shouldAbortSupersededStream: () => false,
    emit() {},
    applyPreToolUseHooks: () => Promise.resolve(),
    prepareToolRegistrationBatch: () => [],
    commitAssistantTurnDraft(
      _id: string,
      _session: unknown,
      _route: unknown,
      blocks: unknown[]
    ) {
      drafts.push(...blocks)
      return [{ uuid: "fixture-assistant" }]
    },
  })
  const outcome = await service.processAssistantTurnStream({
    conversationId: "fixture-conversation",
    session: { model: "gpt-5.4" },
    stream: stream(),
    checkpointModel: "gpt-5.4",
    mode: "initial",
    emitTokenDeltas: false,
    resolveProviderRoute: () => ({ backend: "codex", model: "gpt-5.4" }),
    streamAbortContext: "fixture",
    messageStopAbortContext: "fixture",
  })
  assert.equal(outcome.kind, "max_output_tokens")
  assert.equal(outcome.accumulatedText, "partial answer")
  assert.equal(outcome.stopReason, "max_tokens")
  assert.deepEqual(drafts, [
    {
      block: { type: "text", text: "partial answer" },
      messageId: "resp-fixture",
      codexNativeItemId: undefined,
    },
  ])
})
