#!/usr/bin/env node

const { createHash } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const REPO_ROOT = path.resolve(__dirname, "..", "..")
const CAPTURE_COMMAND = "node scripts/smoke/capture-trace-baseline.js capture"
const COVERAGE_SUPPORT = new Set([
  "protocol",
  "implemented",
  "projection_only",
  "unsupported",
  "protocol_guard",
  "runtime_invariant",
])
const COVERAGE_EXPOSURE = new Set([
  "protocol",
  "core",
  "deferred",
  "gated_off",
  "workflow_only",
  "not_model_callable",
  "unsupported",
  "internal",
  "runtime",
  "missing",
  "unexpected",
])
const COVERAGE_OUTCOMES = new Set([
  "pass",
  "failed",
  "unavailable",
  "not_directly_invokable",
  "not_observed",
  "not_applicable",
])
const CURSOR_CONVERSATION_ACTION_CASES = new Set([
  "userMessageAction",
  "resumeAction",
  "cancelAction",
  "summarizeAction",
  "shellCommandAction",
  "startPlanAction",
  "executePlanAction",
  "asyncAskQuestionCompletionAction",
  "cancelSubagentAction",
  "backgroundTaskCompletionAction",
  "backgroundShellAction",
  "backgroundSubagentAction",
])

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function resolveSmokeDir() {
  return path.resolve(
    process.env.AGENT_VIBES_SMOKE_DIR ||
      path.join(os.homedir(), ".agent-vibes", "smoke")
  )
}

function resolveTracePath() {
  if (process.env.CURSOR_PROTOCOL_TRACE_FILE) {
    return path.resolve(process.env.CURSOR_PROTOCOL_TRACE_FILE)
  }
  if (process.env.AGENT_VIBES_LOG_DIR) {
    return path.resolve(
      process.env.AGENT_VIBES_LOG_DIR,
      "cursor_protocol_trace.jsonl"
    )
  }
  return path.join(
    os.homedir(),
    ".agent-vibes",
    "logs",
    "cursor_protocol_trace.jsonl"
  )
}

function resolveBridgeLogPath() {
  return process.env.AGENT_VIBES_BRIDGE_LOG_FILE
    ? path.resolve(process.env.AGENT_VIBES_BRIDGE_LOG_FILE)
    : path.join(os.tmpdir(), "agent-vibes-bridge.log")
}

function isInsideRepo(target) {
  const relative = path.relative(REPO_ROOT, path.resolve(target))
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

function requireExternalSmokeDir() {
  const smokeDir = resolveSmokeDir()
  if (isInsideRepo(smokeDir)) {
    throw new Error(
      `AGENT_VIBES_SMOKE_DIR must be outside the repository: ${smokeDir}`
    )
  }
  fs.mkdirSync(smokeDir, { recursive: true })
  return smokeDir
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

function countLines(filePath) {
  const stat = safeStat(filePath)
  if (!stat) return 0
  const buffer = fs.readFileSync(filePath)
  let count = 0
  for (const byte of buffer) {
    if (byte === 0x0a) count += 1
  }
  return count
}

function fileSnapshot(filePath, includeLineCount = false) {
  const stat = safeStat(filePath)
  return {
    path: filePath,
    exists: !!stat,
    sizeBytes: stat?.size ?? 0,
    inode: stat ? String(stat.ino) : null,
    mtime: stat?.mtime.toISOString() ?? null,
    ...(includeLineCount ? { lineCount: countLines(filePath) } : {}),
  }
}

function readRange(filePath, offset = 0) {
  const stat = safeStat(filePath)
  if (!stat || stat.size <= offset) return ""
  const length = stat.size - offset
  const descriptor = fs.openSync(filePath, "r")
  try {
    const buffer = Buffer.alloc(length)
    fs.readSync(descriptor, buffer, 0, length, offset)
    return buffer.toString("utf8")
  } finally {
    fs.closeSync(descriptor)
  }
}

function readAppendOnlyDelta(snapshot, currentPath) {
  if (snapshot.path !== currentPath) {
    return { text: "", note: "runtime evidence path changed" }
  }
  const current = safeStat(currentPath)
  if (!current) return { text: "", note: "runtime evidence file disappeared" }
  if (String(current.ino) === snapshot.inode) {
    if (current.size < snapshot.sizeBytes) {
      return { text: "", note: "runtime evidence file was truncated" }
    }
    return { text: readRange(currentPath, snapshot.sizeBytes) }
  }

  const rotatedPath = `${currentPath}.1`
  const rotated = safeStat(rotatedPath)
  if (!rotated || String(rotated.ino) !== snapshot.inode) {
    return {
      text: "",
      note: "runtime evidence rotated without a matching predecessor",
    }
  }
  if (rotated.size < snapshot.sizeBytes) {
    return { text: "", note: "rotated runtime evidence was truncated" }
  }
  return {
    text: readRange(rotatedPath, snapshot.sizeBytes) + readRange(currentPath),
    note: "runtime evidence crossed one verified file rotation",
  }
}

function parseJsonLines(text) {
  const records = []
  let parseErrors = 0
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === "object" && !Array.isArray(value)) {
        records.push(value)
      } else {
        parseErrors += 1
      }
    } catch {
      parseErrors += 1
    }
  }
  return { records, parseErrors }
}

function histogram(values, limit = 25) {
  const counts = new Map()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
    )
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }))
}

function exactString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function exactId(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined
}

function isAsyncAskQuestionTerminalUpgrade(current, previous) {
  return (
    previous?.toolCase === "askQuestionToolCall" &&
    current?.toolCase === "askQuestionToolCall" &&
    previous?.toolResultCase === "async" &&
    ["success", "rejected", "error"].includes(current?.toolResultCase)
  )
}

function correlateEvents(records, definition) {
  const active = new Map()
  const seenStarts = new Set()
  const seenCompletions = new Set()
  const latestCompletion = new Map()
  const pairs = []
  const duplicateStarts = []
  const duplicateCompletions = []
  const unmatchedCompletions = []
  let startCount = 0
  let completionCount = 0

  records.forEach((record, index) => {
    const kind = definition.kind(record)
    if (!kind) return
    const key = definition.key(record)
    if (!key) return
    const event = { index, key, record }
    if (kind === "start") {
      startCount += 1
      if (seenStarts.has(key)) duplicateStarts.push(key)
      seenStarts.add(key)
      if (active.has(key)) return
      active.set(key, event)
      return
    }
    completionCount += 1
    const previousCompletion = latestCompletion.get(key)
    if (seenCompletions.has(key)) {
      if (
        definition.allowRepeatedCompletion?.(record, previousCompletion?.record)
      ) {
        latestCompletion.set(key, event)
        return
      }
      duplicateCompletions.push(key)
    }
    seenCompletions.add(key)
    latestCompletion.set(key, event)
    const start = active.get(key)
    if (!start) {
      unmatchedCompletions.push(event)
      return
    }
    active.delete(key)
    pairs.push({
      key,
      startIndex: start.index,
      completionIndex: index,
      startCase: start.record.nestedCase,
      completionCase: record.nestedCase,
    })
  })

  const unmatchedStarts = [...active.values()]
  const firstStartIndex = Math.min(
    ...records.map((record, index) =>
      definition.kind(record) === "start" ? index : Number.POSITIVE_INFINITY
    )
  )
  const lastCompletionIndex = Math.max(
    ...records.map((record, index) =>
      definition.kind(record) === "completion"
        ? index
        : Number.NEGATIVE_INFINITY
    )
  )
  const leftBoundaryOpen = unmatchedCompletions
    .filter((event) => event.index < firstStartIndex)
    .map((event) => event.key)
  const rightBoundaryOpen = unmatchedStarts
    .filter((event) => event.index > lastCompletionIndex)
    .map((event) => event.key)
  const completionWithoutStart = unmatchedCompletions
    .filter((event) => !leftBoundaryOpen.includes(event.key))
    .map((event) => event.key)
  const startedWithoutCompletion = unmatchedStarts
    .filter((event) => !rightBoundaryOpen.includes(event.key))
    .map((event) => event.key)

  return {
    starts: startCount,
    completions: completionCount,
    pairs,
    startedWithoutCompletion,
    completionWithoutStart,
    duplicateStarts: [...new Set(duplicateStarts)],
    duplicateCompletions: [...new Set(duplicateCompletions)],
    boundary: {
      leftCompletionWithoutStart: [...new Set(leftBoundaryOpen)],
      rightStartWithoutCompletion: [...new Set(rightBoundaryOpen)],
    },
  }
}

function summarizeTrace(text, scope) {
  const parsed = parseJsonLines(text)
  const scopedRecords = parsed.records.filter(
    (record) => record.conversationId === scope.conversationId
  )
  const excludedUnscopedOrOtherConversation =
    parsed.records.length - scopedRecords.length
  const toolCalls = correlateEvents(scopedRecords, {
    kind(record) {
      if (record.nestedCase === "toolCallStarted") return "start"
      if (record.nestedCase === "toolCallCompleted") return "completion"
      return undefined
    },
    key(record) {
      return exactString(record.toolCallId) || exactString(record.callId)
    },
    allowRepeatedCompletion(record, previousRecord) {
      return isAsyncAskQuestionTerminalUpgrade(record, previousRecord)
    },
  })
  const exec = correlateEvents(scopedRecords, {
    kind(record) {
      if (record.topCase === "execServerMessage") return "start"
      if (record.topCase === "execClientMessage") return "completion"
      return undefined
    },
    key(record) {
      const streamEpoch = exactString(record.streamEpoch)
      const id = exactId(record.id)
      return streamEpoch && id ? `${streamEpoch}:${id}` : undefined
    },
    allowRepeatedCompletion(record) {
      return record.nestedCase === "shellStream"
    },
  })
  const capabilitySnapshots = scopedRecords
    .filter(
      (record) =>
        record.messageType === "CapabilitySnapshot" &&
        record.capabilitySnapshot &&
        typeof record.capabilitySnapshot === "object"
    )
    .map((record) => ({
      ts: record.ts,
      streamEpoch: record.streamEpoch,
      ...record.capabilitySnapshot,
    }))
  const completedToolRecords = scopedRecords.filter(
    (record) =>
      record.topCase === "interactionUpdate" &&
      record.nestedCase === "toolCallCompleted" &&
      typeof record.toolCase === "string"
  )
  const toolOutcomeCounts = {}
  for (const record of completedToolRecords) {
    const outcome = exactString(record.toolOutcome) || "unknown"
    const counts = (toolOutcomeCounts[record.toolCase] ??= {})
    counts[outcome] = (counts[outcome] ?? 0) + 1
  }
  const failedToolCases = [
    ...new Set(
      completedToolRecords
        .filter((record) => record.toolOutcome === "failure")
        .map((record) => record.toolCase)
    ),
  ]
  const unknownToolCases = [
    ...new Set(
      completedToolRecords
        .filter((record) => record.toolOutcome === "unknown")
        .map((record) => record.toolCase)
    ),
  ]
  const mcpResourceCounts = completedToolRecords
    .filter(
      (record) =>
        record.toolCase === "listMcpResourcesToolCall" &&
        record.toolOutcome === "success"
    )
    .map((record) => record.nestedExtras?.resourceCount)
    .filter((value) => Number.isSafeInteger(value) && value >= 0)
  const firstTurnTerminalIndex = scopedRecords.findIndex(
    (record) =>
      record.topCase === "interactionUpdate" &&
      record.nestedCase === "turnEnded"
  )
  const lateBackgroundContinuations = []
  if (firstTurnTerminalIndex >= 0) {
    for (
      let actionIndex = firstTurnTerminalIndex + 1;
      actionIndex < scopedRecords.length;
      actionIndex += 1
    ) {
      const action = scopedRecords[actionIndex]
      if (action?.nestedCase !== "backgroundTaskCompletionAction") continue

      let terminalIndex = -1
      for (
        let candidateIndex = actionIndex + 1;
        candidateIndex < scopedRecords.length;
        candidateIndex += 1
      ) {
        const candidate = scopedRecords[candidateIndex]
        if (
          candidate?.topCase === "interactionUpdate" &&
          candidate.nestedCase === "turnEnded"
        ) {
          terminalIndex = candidateIndex
          break
        }
      }
      const continuationEnd =
        terminalIndex >= 0 ? terminalIndex : scopedRecords.length
      const toolStarts = scopedRecords
        .slice(actionIndex + 1, continuationEnd)
        .filter(
          (record) =>
            record.topCase === "interactionUpdate" &&
            record.nestedCase === "toolCallStarted"
        )
      lateBackgroundContinuations.push({
        actionIndex,
        terminalIndex: terminalIndex >= 0 ? terminalIndex : null,
        toolStarts: toolStarts.length,
        toolCases: [...new Set(toolStarts.map((record) => record.toolCase))]
          .filter((value) => typeof value === "string")
          .sort(),
      })
    }
  }
  const restartedLateBackgroundContinuations =
    lateBackgroundContinuations.filter((entry) => entry.toolStarts > 0)

  return {
    conversationId: scope.conversationId,
    baselineStreamEpoch: scope.streamEpoch,
    streamEpochs: [
      ...new Set(
        scopedRecords
          .map((record) => exactString(record.streamEpoch))
          .filter(Boolean)
      ),
    ],
    records: scopedRecords.length,
    excludedUnscopedOrOtherConversation,
    parseErrors: parsed.parseErrors,
    firstTs: scopedRecords[0]?.ts ?? null,
    lastTs: scopedRecords.at(-1)?.ts ?? null,
    directions: histogram(
      scopedRecords.map((record) => record.direction ?? "unknown"),
      5
    ),
    topCases: histogram(
      scopedRecords
        .map((record) => record.topCase)
        .filter((value) => typeof value === "string")
    ),
    nestedCases: histogram(
      scopedRecords
        .filter(
          (record) =>
            typeof record.topCase === "string" &&
            typeof record.nestedCase === "string"
        )
        .map((record) => `${record.topCase}.${record.nestedCase}`),
      Number.MAX_SAFE_INTEGER
    ),
    observed: {
      toolCases: [
        ...new Set(
          scopedRecords.map((record) => record.toolCase).filter(Boolean)
        ),
      ],
      hookRequestCases: [
        ...new Set(
          scopedRecords
            .filter((record) => record.topCase === "execServerMessage")
            .map((record) => record.hookCase)
            .filter(Boolean)
        ),
      ],
      hookResponseCases: [
        ...new Set(
          scopedRecords
            .filter((record) => record.topCase === "execClientMessage")
            .map((record) => record.hookCase)
            .filter(Boolean)
        ),
      ],
      failedToolCases,
      unknownToolCases,
      toolOutcomeCounts,
      mcpResourceCatalog: {
        observed: mcpResourceCounts.length,
        counts: mcpResourceCounts,
        allEmpty:
          mcpResourceCounts.length > 0 &&
          mcpResourceCounts.every((count) => count === 0),
      },
    },
    backgroundContinuations: {
      firstTurnTerminalIndex:
        firstTurnTerminalIndex >= 0 ? firstTurnTerminalIndex : null,
      late: lateBackgroundContinuations,
      restarted: restartedLateBackgroundContinuations,
    },
    capabilitySnapshots,
    correlation: { toolCalls, exec },
  }
}

function parseStructuredLogEvent(line) {
  const start = line.indexOf('{"event":')
  if (start < 0) return undefined
  try {
    const value = JSON.parse(line.slice(start))
    return value && typeof value === "object" ? value : undefined
  } catch {
    return undefined
  }
}

function parseEditApplyWarning(line) {
  if (!line.includes("Edit apply warning")) return undefined
  const callId = line.match(/Edit apply warning for ([^:]+):/u)?.[1]
  const fields = {}
  for (const match of line.matchAll(/(?:^|[\s|])([a-z_]+)=([^|]*)/gu)) {
    fields[match[1]] = match[2].trim()
  }
  if (!fields.failure_reason || !fields.path) return undefined
  return {
    callId,
    failureReason: fields.failure_reason,
    path: fields.path,
    searchPreview: fields.search_preview,
  }
}

function summarizeBridgeLog(text, scope) {
  const lines = text.split("\n").filter(Boolean)
  const structuredEvents = lines.map(parseStructuredLogEvent).filter(Boolean)
  const editApplyWarnings = lines.map(parseEditApplyWarning).filter(Boolean)
  const compactions = structuredEvents.filter(
    (event) =>
      event.event === "compaction.remote_v2_applied" &&
      event.conversationId === scope.conversationId
  )
  const controlContinuations = structuredEvents.filter(
    (event) =>
      event.event === "cursor.control_continuation_planned" &&
      event.conversationId === scope.conversationId
  )
  const projectedBudgetFailures = structuredEvents.filter(
    (event) =>
      event.event === "compaction.projection_budget_failed" &&
      event.conversationId === scope.conversationId
  ).length
  const sharedProjectedBudgetFailures = lines.filter((line) =>
    /Projected context is \d+ tokens, exceeding request budget \d+\./u.test(
      line
    )
  ).length
  const processErrors = lines.filter(
    (line) => /\bERROR\b/u.test(line) || /Exception/u.test(line)
  ).length
  return {
    conversationId: scope.conversationId,
    structuredCompactions: compactions,
    controlContinuations,
    projectedBudgetFailures,
    sharedProjectedBudgetFailures,
    sharedProcessErrors: processErrors,
    editApplyWarnings,
  }
}

function baselinePath() {
  return path.join(requireExternalSmokeDir(), ".trace-baseline.json")
}

function resolveCaptureScope(tracePath, capturedAt) {
  const parsed = parseJsonLines(readRange(tracePath))
  if (parsed.parseErrors > 0) {
    throw new Error(
      `Cannot bind smoke scope: trace contains ${parsed.parseErrors} malformed record(s)`
    )
  }
  const expectedCommandHash = sha256(CAPTURE_COMMAND)
  const earliest = capturedAt.getTime() - 30_000
  const candidates = parsed.records.filter((record) => {
    const ts = Date.parse(record.ts)
    return (
      Number.isFinite(ts) &&
      ts >= earliest &&
      record.direction === "outbound" &&
      record.topCase === "execServerMessage" &&
      (record.nestedCase === "shellArgs" ||
        record.nestedCase === "shellStreamArgs") &&
      record.nestedExtras?.commandSha256 === expectedCommandHash &&
      exactString(record.conversationId) &&
      exactString(record.streamEpoch)
    )
  })
  const conversations = new Set(
    candidates.map((record) => record.conversationId)
  )
  if (candidates.length === 0) {
    throw new Error(
      `Cannot bind smoke scope: invoke capture with the exact standalone command: ${CAPTURE_COMMAND}`
    )
  }
  if (conversations.size !== 1) {
    throw new Error(
      `Cannot bind smoke scope: exact capture command was dispatched by ${conversations.size} conversations in the binding window`
    )
  }
  const source = candidates.at(-1)
  const sourceTimestamp = Date.parse(source.ts)
  const capabilitySnapshot = parsed.records
    .filter(
      (record) =>
        record.messageType === "CapabilitySnapshot" &&
        record.conversationId === source.conversationId &&
        record.streamEpoch === source.streamEpoch &&
        record.capabilitySnapshot &&
        Date.parse(record.ts) <= sourceTimestamp
    )
    .at(-1)
  if (!capabilitySnapshot) {
    throw new Error(
      "Cannot bind smoke capabilities: no provider tool snapshot precedes the capture command"
    )
  }
  return {
    conversationId: source.conversationId,
    streamEpoch: source.streamEpoch,
    source: {
      ts: source.ts,
      id: source.id,
      commandSha256: expectedCommandHash,
    },
    capabilitySnapshot: {
      ts: capabilitySnapshot.ts,
      streamEpoch: capabilitySnapshot.streamEpoch,
      ...capabilitySnapshot.capabilitySnapshot,
    },
  }
}

function capture() {
  const capturedAt = new Date()
  const trace = fileSnapshot(resolveTracePath(), true)
  const bridgeLog = fileSnapshot(resolveBridgeLogPath())
  if (!trace.exists) throw new Error(`Protocol trace is missing: ${trace.path}`)
  const state = {
    version: 4,
    capturedAt: capturedAt.toISOString(),
    scope: resolveCaptureScope(trace.path, capturedAt),
    trace,
    bridgeLog,
    warnings: [trace.path, bridgeLog.path]
      .filter(isInsideRepo)
      .map(
        (filePath) => `runtime evidence path is inside repository: ${filePath}`
      ),
  }
  fs.writeFileSync(baselinePath(), `${JSON.stringify(state, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
}

function buildDeltaReport() {
  const statePath = baselinePath()
  if (!fs.existsSync(statePath)) {
    throw new Error(`No trace baseline found: ${statePath}`)
  }
  const baseline = JSON.parse(fs.readFileSync(statePath, "utf8"))
  if (
    baseline.version !== 4 ||
    !baseline.scope?.conversationId ||
    !baseline.scope?.capabilitySnapshot
  ) {
    throw new Error(
      "Trace baseline does not contain an exact v4 scope and capability snapshot"
    )
  }
  const tracePath = resolveTracePath()
  const bridgeLogPath = resolveBridgeLogPath()
  const traceDelta = readAppendOnlyDelta(baseline.trace, tracePath)
  const bridgeLogDelta = readAppendOnlyDelta(baseline.bridgeLog, bridgeLogPath)
  return {
    baseline,
    final: {
      trace: fileSnapshot(tracePath, true),
      bridgeLog: fileSnapshot(bridgeLogPath),
    },
    traceDelta: summarizeTrace(traceDelta.text, baseline.scope),
    bridgeLogDelta: summarizeBridgeLog(bridgeLogDelta.text, baseline.scope),
    notes: [traceDelta.note, bridgeLogDelta.note].filter(Boolean),
  }
}

function delta() {
  process.stdout.write(`${JSON.stringify(buildDeltaReport(), null, 2)}\n`)
}

function coverageEntry(
  group,
  family,
  caseId,
  support,
  exposure,
  outcome,
  evidenceRef,
  reason
) {
  return {
    group,
    family,
    caseId,
    support,
    exposure,
    outcome,
    evidenceRef,
    reason,
  }
}

function expectedCoverageIds(inventory) {
  return [
    ...inventory.agentClientMessages.map((caseId) => `A:${caseId}`),
    ...inventory.agentServerMessages.map((caseId) => `A:${caseId}`),
    ...Object.values(inventory.toolCallFamilies)
      .flat()
      .map((caseId) => `B:${caseId}`),
    ...inventory.interactionPairs.map(
      (pair) => `C:${pair.query}/${pair.response}`
    ),
    ...inventory.interactionUpdates.map((caseId) => `D:${caseId}`),
    ...inventory.conversationActions.map((caseId) => `E:${caseId}`),
    ...inventory.execPairs.map((pair) => `F:${pair.request}/${pair.result}`),
    ...inventory.execControl.server.map((caseId) => `F:${caseId}`),
    ...inventory.execControl.client.map((caseId) => `F:${caseId}`),
    ...inventory.hookPairs.map((caseId) => `G:${caseId}`),
    "H:tool_call_terminal_integrity",
    "H:exec_terminal_integrity",
    "H:turn_continuity",
    "H:compaction_continuity",
    "H:background_terminal_integrity",
  ]
}

function protocolObservation(observed, evidenceRef) {
  return observed
    ? { outcome: "pass", evidenceRef, reason: "observed in scoped trace" }
    : {
        outcome: "not_observed",
        evidenceRef: "traceDelta.observed",
        reason: "not emitted by this run",
      }
}

function buildCoverageResults(inventory, report, runId) {
  const trace = report.traceDelta
  const topCases = new Set(trace.topCases.map((entry) => entry.key))
  const nestedCases = new Set(trace.nestedCases.map((entry) => entry.key))
  const hasNested = (topCase, nestedCase) =>
    nestedCases.has(`${topCase}.${nestedCase}`)
  const toolCases = new Set(trace.observed.toolCases)
  const failedToolCases = new Set(trace.observed.failedToolCases || [])
  const unknownToolCases = new Set(trace.observed.unknownToolCases || [])
  const toolOutcomeCounts = trace.observed.toolOutcomeCounts || {}
  const emptyMcpResourceCatalog =
    trace.observed.mcpResourceCatalog?.allEmpty === true
  const backgroundContinuations = trace.backgroundContinuations || {
    late: [],
    restarted: [],
  }
  const hookRequests = new Set(trace.observed.hookRequestCases)
  const hookResponses = new Set(trace.observed.hookResponseCases)
  const capabilitySnapshots = [
    report.baseline?.scope?.capabilitySnapshot,
    ...(trace.capabilitySnapshots || []),
  ].filter(Boolean)
  if (capabilitySnapshots.length === 0) {
    throw new Error(
      "coverage evaluation requires a scoped provider capability snapshot"
    )
  }
  const coreTools = new Set(
    capabilitySnapshots.flatMap((snapshot) => snapshot.providerCoreTools || [])
  )
  const deferredTools = new Set(
    capabilitySnapshots.flatMap(
      (snapshot) => snapshot.providerDeferredTools || []
    )
  )
  const mcpTools = new Set(
    capabilitySnapshots.flatMap((snapshot) => snapshot.providerMcpTools || [])
  )
  const entries = []

  const pushProtocolCase = (group, family, caseId, observed, evidenceRef) => {
    const result = protocolObservation(observed, evidenceRef)
    entries.push(
      coverageEntry(
        group,
        family,
        caseId,
        "protocol",
        "protocol",
        result.outcome,
        result.evidenceRef,
        result.reason
      )
    )
  }

  const expectedNegativeToolFailureSatisfied = (caseId) => {
    if (caseId !== "editToolCall") return false
    const counts = toolOutcomeCounts[caseId] || {}
    const failureCount = counts.failure || 0
    if (failureCount === 0 || (counts.success || 0) === 0) return false
    const smokePathMarker = `/smoke/${runId}/`
    const normalizePath = (filePath) => filePath.replace(/\\/gu, "/")
    const warnings = (report.bridgeLogDelta.editApplyWarnings || []).filter(
      (warning) =>
        typeof warning.path === "string" &&
        normalizePath(warning.path).includes(smokePathMarker)
    )
    const expectedFixtureNames = new Set([
      `conflict-${runId}.txt`,
      `missing-${runId}.txt`,
    ])
    return (
      warnings.length === failureCount &&
      warnings.every((warning) => {
        const normalizedPath = normalizePath(warning.path)
        return (
          warning.failureReason === "target_not_found" &&
          expectedFixtureNames.has(path.posix.basename(normalizedPath))
        )
      })
    )
  }

  for (const caseId of inventory.agentClientMessages) {
    const observed = topCases.has(caseId)
    if (caseId === "prewarmRequest" && !observed) {
      entries.push(
        coverageEntry(
          "A",
          "agent_client",
          caseId,
          "protocol",
          "not_model_callable",
          "not_directly_invokable",
          `traceDelta.topCases.${caseId}`,
          "Cursor client-originated optimization frame has no agent-callable entry point"
        )
      )
      continue
    }
    pushProtocolCase(
      "A",
      "agent_client",
      caseId,
      observed,
      `traceDelta.topCases.${caseId}`
    )
  }
  for (const caseId of inventory.agentServerMessages) {
    pushProtocolCase(
      "A",
      "agent_server",
      caseId,
      topCases.has(caseId),
      `traceDelta.topCases.${caseId}`
    )
  }

  const prerequisiteGatedToolCases = new Map([
    ["mcpAuthToolCall", "requires a real MCP authentication requirement"],
    ["prManagementToolCall", "requires real pull-request context"],
    [
      "connectScmToolCall",
      "requires explicit user authorization and real GitHub repository context",
    ],
  ])
  for (const capability of inventory.toolCallCapabilities) {
    const candidateNames = new Set(capability.modelToolNames)
    if (capability.caseId === "mcpToolCall") {
      for (const toolName of mcpTools) candidateNames.add(toolName)
    }
    const isCore = [...candidateNames].some((name) => coreTools.has(name))
    const isDeferred = [...candidateNames].some((name) =>
      deferredTools.has(name)
    )
    let exposure
    if ((isCore || isDeferred) && capability.support !== "implemented") {
      exposure = "unexpected"
    } else if (isCore) exposure = "core"
    else if (isDeferred) exposure = "deferred"
    else if (capability.support === "unsupported") exposure = "unsupported"
    else if (capability.support === "projection_only")
      exposure = "not_model_callable"
    else if (capability.support === "protocol_guard") exposure = "internal"
    else if (capability.exposurePolicy === "workflow_only")
      exposure = "workflow_only"
    else if (capability.exposurePolicy === "capability_gated")
      exposure = "gated_off"
    else exposure = "missing"

    const observed = toolCases.has(capability.caseId)
    const prerequisiteUnavailableReason = observed
      ? undefined
      : prerequisiteGatedToolCases.get(capability.caseId)
    const notApplicableReason =
      !observed &&
      capability.caseId === "readMcpResourceToolCall" &&
      emptyMcpResourceCatalog
        ? "mounted MCP servers advertised no resources"
        : undefined
    if (prerequisiteUnavailableReason || notApplicableReason) {
      exposure = "workflow_only"
    }
    const expectedNegativeFailure =
      failedToolCases.has(capability.caseId) &&
      expectedNegativeToolFailureSatisfied(capability.caseId)
    let outcome
    let reason
    let evidenceRef
    if (prerequisiteUnavailableReason) {
      outcome = "unavailable"
      reason = prerequisiteUnavailableReason
      evidenceRef = "baseline.scope.capabilitySnapshot"
    } else if (notApplicableReason) {
      outcome = "not_applicable"
      reason = notApplicableReason
      evidenceRef = "traceDelta.observed.mcpResourceCatalog"
    } else if (exposure === "unexpected") {
      outcome = "failed"
      reason =
        "a non-model-callable protocol case entered the provider tool surface"
      evidenceRef = "baseline.scope.capabilitySnapshot"
    } else if (capability.support === "unsupported" && observed) {
      outcome = "failed"
      reason = "an unsupported ToolCall case was emitted"
      evidenceRef = `traceDelta.observed.toolCases.${capability.caseId}`
    } else if (
      failedToolCases.has(capability.caseId) &&
      !expectedNegativeFailure
    ) {
      outcome = "failed"
      reason = "the observed ToolCall completed with a failure result"
      evidenceRef = `traceDelta.observed.failedToolCases.${capability.caseId}`
    } else if (unknownToolCases.has(capability.caseId)) {
      outcome = "failed"
      reason = "the observed ToolCall completion has no classified result case"
      evidenceRef = `traceDelta.observed.unknownToolCases.${capability.caseId}`
    } else if (observed) {
      outcome = "pass"
      reason = expectedNegativeFailure
        ? "ToolCall success observed and expected negative edit fixtures failed explicitly"
        : "ToolCall was observed with a unique non-failure terminal"
      evidenceRef = expectedNegativeFailure
        ? "bridgeLogDelta.editApplyWarnings"
        : `traceDelta.observed.toolCases.${capability.caseId}`
    } else if (exposure === "core" || exposure === "deferred") {
      outcome = "not_observed"
      reason = `tool was ${exposure === "core" ? "directly" : "deferred-catalog"} exposed but not called by this run`
      evidenceRef = "baseline.scope.capabilitySnapshot"
    } else if (exposure === "missing") {
      outcome = "failed"
      reason =
        "a default implemented capability is absent from the provider tool surface"
      evidenceRef = "baseline.scope.capabilitySnapshot"
    } else {
      outcome = "not_applicable"
      reason = capability.reason
      evidenceRef = "protocolInventory.toolCallCapabilities"
    }
    entries.push(
      coverageEntry(
        "B",
        capability.family,
        capability.caseId,
        capability.support,
        exposure,
        outcome,
        evidenceRef,
        reason
      )
    )
  }

  const prerequisiteGatedInteractionPairs = new Map([
    [
      "prManagementRequestQuery/prManagementResult",
      "requires real pull-request context",
    ],
    [
      "mcpAuthRequestQuery/mcpAuthRequestResponse",
      "requires an upstream authentication-required toolCallId",
    ],
    [
      "connectScmRequestQuery/connectScmRequestResponse",
      "requires explicit user authorization and real GitHub repository context",
    ],
  ])
  for (const pair of inventory.interactionPairs) {
    const caseId = `${pair.query}/${pair.response}`
    const query = hasNested("interactionQuery", pair.query)
    const response = hasNested("interactionResponse", pair.response)
    const unavailableReason = prerequisiteGatedInteractionPairs.get(caseId)
    const outcome =
      query && response
        ? "pass"
        : query || response
          ? "failed"
          : unavailableReason
            ? "unavailable"
            : "not_observed"
    entries.push(
      coverageEntry(
        "C",
        "interaction_pair",
        caseId,
        "protocol",
        unavailableReason && !query && !response ? "workflow_only" : "protocol",
        outcome,
        "traceDelta.nestedCases",
        outcome === "pass"
          ? "query and response observed"
          : outcome === "failed"
            ? "only one side of the pair was observed"
            : outcome === "unavailable"
              ? unavailableReason
              : "pair was not emitted by this run"
      )
    )
  }
  const unavailableServerUiUpdates = new Map([
    ["promptSuggestion", "bridge has no next-prompt producer"],
    ["postRequestPrompt", "bridge has no post-request card producer"],
    ["activeBranchChange", "bridge has no branch-change event producer"],
    ["feedbackRequest", "bridge has no feedback-request producer"],
  ])
  for (const caseId of inventory.interactionUpdates) {
    const observed = hasNested("interactionUpdate", caseId)
    const unavailableReason = unavailableServerUiUpdates.get(caseId)
    if (unavailableReason) {
      entries.push(
        coverageEntry(
          "D",
          "interaction_update",
          caseId,
          "projection_only",
          "not_model_callable",
          observed ? "pass" : "unavailable",
          `traceDelta.nestedCases.interactionUpdate.${caseId}`,
          observed ? "server UI update observed" : unavailableReason
        )
      )
      continue
    }
    pushProtocolCase(
      "D",
      "interaction_update",
      caseId,
      observed,
      `traceDelta.nestedCases.interactionUpdate.${caseId}`
    )
  }
  for (const caseId of inventory.conversationActions) {
    pushProtocolCase(
      "E",
      "conversation_action",
      caseId,
      hasNested("conversationAction", caseId),
      `traceDelta.nestedCases.conversationAction.${caseId}`
    )
  }
  for (const pair of inventory.execPairs) {
    const request = hasNested("execServerMessage", pair.request)
    const resultObserved = hasNested("execClientMessage", pair.result)
    const outcome =
      request && resultObserved
        ? "pass"
        : request || resultObserved
          ? "failed"
          : "not_observed"
    entries.push(
      coverageEntry(
        "F",
        "exec_pair",
        `${pair.request}/${pair.result}`,
        "protocol",
        "protocol",
        outcome,
        "traceDelta.correlation.exec",
        outcome === "pass"
          ? "request and result observed"
          : outcome === "failed"
            ? "only one side of the exec pair was observed"
            : "pair was not emitted by this run"
      )
    )
  }
  for (const caseId of inventory.execControl.server) {
    pushProtocolCase(
      "F",
      "exec_server_control",
      caseId,
      hasNested("execServerControlMessage", caseId),
      `traceDelta.nestedCases.execServerControlMessage.${caseId}`
    )
  }
  for (const caseId of inventory.execControl.client) {
    pushProtocolCase(
      "F",
      "exec_client_control",
      caseId,
      hasNested("execClientControlMessage", caseId),
      `traceDelta.nestedCases.execClientControlMessage.${caseId}`
    )
  }
  for (const caseId of inventory.hookPairs) {
    const request = hookRequests.has(caseId)
    const response = hookResponses.has(caseId)
    const outcome =
      request && response
        ? "pass"
        : request || response
          ? "failed"
          : "not_observed"
    entries.push(
      coverageEntry(
        "G",
        "hook_pair",
        caseId,
        "protocol",
        "protocol",
        outcome,
        "traceDelta.observed.hookCases",
        outcome === "pass"
          ? "hook request and response observed"
          : outcome === "failed"
            ? "only one side of the hook pair was observed"
            : "hook was not emitted by this run"
      )
    )
  }

  const toolCorrelation = trace.correlation.toolCalls
  const execCorrelation = trace.correlation.exec
  const toolIntegrityFailed =
    toolCorrelation.startedWithoutCompletion.length > 0 ||
    toolCorrelation.completionWithoutStart.length > 0 ||
    toolCorrelation.duplicateStarts.length > 0 ||
    toolCorrelation.duplicateCompletions.length > 0
  const execIntegrityFailed =
    execCorrelation.startedWithoutCompletion.length > 0 ||
    execCorrelation.completionWithoutStart.length > 0 ||
    execCorrelation.duplicateStarts.length > 0 ||
    execCorrelation.duplicateCompletions.length > 0
  entries.push(
    coverageEntry(
      "H",
      "runtime_integrity",
      "tool_call_terminal_integrity",
      "runtime_invariant",
      "runtime",
      toolIntegrityFailed ? "failed" : "pass",
      "traceDelta.correlation.toolCalls",
      toolIntegrityFailed
        ? "non-boundary correlation defect"
        : "all non-boundary tool calls correlate"
    ),
    coverageEntry(
      "H",
      "runtime_integrity",
      "exec_terminal_integrity",
      "runtime_invariant",
      "runtime",
      execIntegrityFailed ? "failed" : "pass",
      "traceDelta.correlation.exec",
      execIntegrityFailed
        ? "non-boundary correlation defect"
        : "all non-boundary exec messages correlate"
    ),
    coverageEntry(
      "H",
      "runtime_integrity",
      "turn_continuity",
      "runtime_invariant",
      "runtime",
      hasNested("interactionUpdate", "turnEnded") ? "pass" : "not_observed",
      "traceDelta.nestedCases.interactionUpdate.turnEnded",
      hasNested("interactionUpdate", "turnEnded")
        ? "terminal turn update observed"
        : "terminal turn update not observed"
    ),
    coverageEntry(
      "H",
      "runtime_integrity",
      "compaction_continuity",
      "runtime_invariant",
      "runtime",
      report.bridgeLogDelta.projectedBudgetFailures > 0
        ? "failed"
        : report.bridgeLogDelta.structuredCompactions.length > 0
          ? "pass"
          : "not_observed",
      "bridgeLogDelta.structuredCompactions",
      report.bridgeLogDelta.projectedBudgetFailures > 0
        ? "provider candidate exceeded the request budget"
        : report.bridgeLogDelta.structuredCompactions.length > 0
          ? "scoped durable compaction commit observed"
          : "no scoped compaction event was emitted"
    ),
    coverageEntry(
      "H",
      "runtime_integrity",
      "background_terminal_integrity",
      "runtime_invariant",
      "runtime",
      backgroundContinuations.restarted.length > 0
        ? "failed"
        : backgroundContinuations.late.length > 0 ||
            hasNested("conversationAction", "backgroundTaskCompletionAction") ||
            hasNested("runRequest", "backgroundTaskCompletionAction")
          ? "pass"
          : "not_observed",
      "traceDelta.backgroundContinuations",
      backgroundContinuations.restarted.length > 0
        ? "late background completion restarted tool execution after a terminal response"
        : backgroundContinuations.late.length > 0
          ? "late background completion remained a scoped terminal continuation"
          : hasNested("conversationAction", "backgroundTaskCompletionAction") ||
              hasNested("runRequest", "backgroundTaskCompletionAction")
            ? "background terminal action observed before the first terminal response"
            : "background terminal action not observed"
    )
  )

  return {
    schemaVersion: 3,
    runId,
    conversationId: report.baseline.scope.conversationId,
    evidenceSeal: buildEvidenceSeal(report),
    inventoryCounts: inventory.counts,
    generatedAt: new Date().toISOString(),
    capabilitySnapshots,
    entries,
    outcomeCounts: Object.fromEntries(
      [...COVERAGE_OUTCOMES].map((outcome) => [
        outcome,
        entries.filter((entry) => entry.outcome === outcome).length,
      ])
    ),
    supportCounts: Object.fromEntries(
      [...COVERAGE_SUPPORT].map((support) => [
        support,
        entries.filter((entry) => entry.support === support).length,
      ])
    ),
    exposureCounts: Object.fromEntries(
      [...COVERAGE_EXPOSURE].map((exposure) => [
        exposure,
        entries.filter((entry) => entry.exposure === exposure).length,
      ])
    ),
  }
}

function buildEvidenceSeal(report) {
  const conversationId = exactString(report?.baseline?.scope?.conversationId)
  const trace = report?.final?.trace
  const bridgeLog = report?.final?.bridgeLog
  if (!conversationId || !trace?.path || !bridgeLog?.path) {
    throw new Error(
      "trace delta does not contain a complete final evidence seal"
    )
  }
  return {
    conversationId,
    trace: { ...trace },
    bridgeLog: { ...bridgeLog },
    scopedTraceRecords: report.traceDelta?.records ?? null,
    scopedTraceLastTs: report.traceDelta?.lastTs ?? null,
  }
}

function inspectEvidenceFreshness(report, options = {}) {
  const seal = buildEvidenceSeal(report)
  const tracePath = options.tracePath || resolveTracePath()
  const bridgeLogPath = options.bridgeLogPath || resolveBridgeLogPath()
  const traceDelta = readAppendOnlyDelta(seal.trace, tracePath)
  const bridgeLogDelta = readAppendOnlyDelta(seal.bridgeLog, bridgeLogPath)
  const parsed = parseJsonLines(traceDelta.text)
  const scopedRecords = parsed.records.filter(
    (record) => record.conversationId === seal.conversationId
  )
  const toolStarts = scopedRecords.filter(
    (record) =>
      record.topCase === "interactionUpdate" &&
      record.nestedCase === "toolCallStarted"
  )
  const nonEvidenceToolStarts = toolStarts.filter(
    (record) => record.toolCase !== "shellToolCall"
  )
  const turnTerminals = scopedRecords.filter(
    (record) =>
      record.topCase === "interactionUpdate" &&
      record.nestedCase === "turnEnded"
  )
  const newConversationActions = scopedRecords.filter(
    (record) =>
      record.topCase === "conversationAction" ||
      (record.topCase === "runRequest" &&
        CURSOR_CONVERSATION_ACTION_CASES.has(record.nestedCase))
  )
  const structuredBridgeEvents = bridgeLogDelta.text
    .split("\n")
    .map(parseStructuredLogEvent)
    .filter(Boolean)
    .filter((event) => event.conversationId === seal.conversationId)
  const postSealCompactions = structuredBridgeEvents.filter(
    (event) =>
      event.event === "compaction.remote_v2_applied" ||
      event.event === "compaction.projection_budget_failed"
  )
  const violations = []
  if (parsed.parseErrors > 0) {
    violations.push(`${parsed.parseErrors} malformed post-seal trace record(s)`)
  }
  if (traceDelta.note && !traceDelta.note.includes("crossed one verified")) {
    violations.push(traceDelta.note)
  }
  if (
    bridgeLogDelta.note &&
    !bridgeLogDelta.note.includes("crossed one verified")
  ) {
    violations.push(bridgeLogDelta.note)
  }
  if (newConversationActions.length > 0) {
    violations.push(
      `${newConversationActions.length} new conversation action(s) after the evidence seal`
    )
  }
  if (turnTerminals.length > 0) {
    violations.push(
      `${turnTerminals.length} turn terminal(s) after the evidence seal`
    )
  }
  if (nonEvidenceToolStarts.length > 0) {
    violations.push(
      `non-report tool activity after the evidence seal: ${[
        ...new Set(nonEvidenceToolStarts.map((record) => record.toolCase)),
      ].join(", ")}`
    )
  }
  // `delta` owns the seal. Only the subsequent `evaluate` and current
  // `validate` shell calls may legitimately begin before validation reads it.
  if (toolStarts.length > 2) {
    violations.push(
      `${toolStarts.length} report tool calls started after the evidence seal; expected at most evaluate and validate`
    )
  }
  if (postSealCompactions.length > 0) {
    violations.push(
      `${postSealCompactions.length} scoped compaction event(s) occurred after the evidence seal`
    )
  }
  return {
    fresh: violations.length === 0,
    violations,
    scopedPostSealTraceRecords: scopedRecords.length,
    postSealToolStarts: toolStarts.length,
    postSealCompactions: postSealCompactions.length,
  }
}

function loadJson(filePath, label) {
  if (!fs.existsSync(filePath))
    throw new Error(`${label} is missing: ${filePath}`)
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function evaluate() {
  const smokeDir = requireExternalSmokeDir()
  const inventory = loadJson(
    path.join(smokeDir, "protocol-inventory.json"),
    "protocol inventory"
  )
  const report = loadJson(
    path.join(smokeDir, "trace-delta.json"),
    "trace delta"
  )
  const runId = process.env.SMOKE_RUN_ID?.trim()
  if (!runId)
    throw new Error("SMOKE_RUN_ID is required for coverage evaluation")
  process.stdout.write(
    `${JSON.stringify(buildCoverageResults(inventory, report, runId), null, 2)}\n`
  )
}

function validateCoverage(filePath) {
  const resolvedPath = path.resolve(filePath)
  const result = loadJson(resolvedPath, "coverage results")
  const inventory = loadJson(
    path.join(path.dirname(resolvedPath), "protocol-inventory.json"),
    "protocol inventory"
  )
  const traceDeltaReport = loadJson(
    path.join(path.dirname(resolvedPath), "trace-delta.json"),
    "trace delta"
  )
  if (result.schemaVersion !== 3) {
    throw new Error("coverage results must use schemaVersion 3")
  }
  const expectedEvidenceSeal = buildEvidenceSeal(traceDeltaReport)
  if (
    JSON.stringify(result.evidenceSeal) !== JSON.stringify(expectedEvidenceSeal)
  ) {
    throw new Error(
      "coverage results were not generated from the current trace-delta evidence seal"
    )
  }
  const freshness = inspectEvidenceFreshness(traceDeltaReport)
  if (!freshness.fresh) {
    throw new Error(
      `runtime evidence became stale: ${freshness.violations.join("; ")}`
    )
  }
  if (
    !Array.isArray(result.capabilitySnapshots) ||
    result.capabilitySnapshots.length === 0
  ) {
    throw new Error("coverage results contain no scoped capability snapshot")
  }
  if (!Array.isArray(result.entries) || result.entries.length === 0) {
    throw new Error("coverage results contain no entries")
  }
  const ids = result.entries.map((entry) => `${entry.group}:${entry.caseId}`)
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (duplicates.length > 0) {
    throw new Error(
      `coverage results contain duplicate cases: ${[...new Set(duplicates)].join(", ")}`
    )
  }
  const expectedIds = expectedCoverageIds(inventory)
  const expectedSet = new Set(expectedIds)
  const actualSet = new Set(ids)
  const missing = expectedIds.filter((id) => !actualSet.has(id))
  const unexpected = ids.filter((id) => !expectedSet.has(id))
  if (
    expectedSet.size !== expectedIds.length ||
    missing.length > 0 ||
    unexpected.length > 0
  ) {
    throw new Error(
      `coverage inventory mismatch: missing=[${missing.join(", ")}], ` +
        `unexpected=[${unexpected.join(", ")}]`
    )
  }
  if (
    JSON.stringify(result.inventoryCounts) !== JSON.stringify(inventory.counts)
  ) {
    throw new Error("coverage inventoryCounts do not match protocol inventory")
  }
  for (const entry of result.entries) {
    if (!COVERAGE_SUPPORT.has(entry.support)) {
      throw new Error(
        `coverage case ${entry.caseId} has invalid support ${entry.support}`
      )
    }
    if (!COVERAGE_EXPOSURE.has(entry.exposure)) {
      throw new Error(
        `coverage case ${entry.caseId} has invalid exposure ${entry.exposure}`
      )
    }
    if (!COVERAGE_OUTCOMES.has(entry.outcome)) {
      throw new Error(
        `coverage case ${entry.caseId} has invalid outcome ${entry.outcome}`
      )
    }
    for (const field of [
      "group",
      "family",
      "caseId",
      "evidenceRef",
      "reason",
    ]) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new Error(
          `coverage case ${entry.caseId ?? "unknown"} has invalid ${field}`
        )
      }
    }
    if (entry.exposure === "missing" && entry.outcome !== "failed") {
      throw new Error(
        `coverage case ${entry.caseId} hides a missing default capability`
      )
    }
  }
  const countBy = (values, field) =>
    Object.fromEntries(
      [...values].map((value) => [
        value,
        result.entries.filter((entry) => entry[field] === value).length,
      ])
    )
  const calculatedOutcomes = countBy(COVERAGE_OUTCOMES, "outcome")
  const calculatedSupport = countBy(COVERAGE_SUPPORT, "support")
  const calculatedExposure = countBy(COVERAGE_EXPOSURE, "exposure")
  if (
    JSON.stringify(calculatedOutcomes) !== JSON.stringify(result.outcomeCounts)
  ) {
    throw new Error("coverage outcomeCounts do not match entries")
  }
  if (
    JSON.stringify(calculatedSupport) !== JSON.stringify(result.supportCounts)
  ) {
    throw new Error("coverage supportCounts do not match entries")
  }
  if (
    JSON.stringify(calculatedExposure) !== JSON.stringify(result.exposureCounts)
  ) {
    throw new Error("coverage exposureCounts do not match entries")
  }
  process.stdout.write(
    `Coverage validation passed: ${result.entries.length} unique cases\n`
  )
}

function resetSmoke() {
  const smokeDir = requireExternalSmokeDir()
  const fixtures = {
    "a.txt": "alpha",
    "b.txt": "beta",
    "delete_me.txt": "delete",
    "todo-seed.md": "todo line 1\ntodo line 2\ntodo line 3\n",
    "subdir/nested.txt": "nested alpha beta",
    "env.txt": "PLACEHOLDER_ENV=old",
  }
  for (const [relativePath, content] of Object.entries(fixtures)) {
    const target = path.join(smokeDir, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, "utf8")
  }
  process.stdout.write(
    `${JSON.stringify({ smokeDir, fixtures: Object.keys(fixtures) }, null, 2)}\n`
  )
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0]
  if (command === "capture") capture()
  else if (command === "delta") delta()
  else if (command === "evaluate") evaluate()
  else if (command === "validate") {
    if (!argv[1])
      throw new Error("validate requires a coverage-results.json path")
    validateCoverage(argv[1])
  } else if (command === "reset-smoke") resetSmoke()
  else {
    throw new Error(
      "usage: capture-trace-baseline.js <capture|delta|evaluate|validate|reset-smoke>"
    )
  }
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(
      `[capture-trace-baseline] ${error instanceof Error ? error.stack : String(error)}\n`
    )
    process.exitCode = 1
  }
}

module.exports = {
  CAPTURE_COMMAND,
  buildCoverageResults,
  correlateEvents,
  inspectEvidenceFreshness,
  parseJsonLines,
  summarizeBridgeLog,
  summarizeTrace,
  validateCoverage,
}
