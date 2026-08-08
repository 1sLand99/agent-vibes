import {
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf"
import * as zlib from "zlib"

import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  CancelActionSchema,
  ConversationActionSchema,
  ConversationHistoryMessageSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  InterruptedPendingToolCallResolutionSchema,
  InterruptedPendingToolCallResolutionsSchema,
  ShellCommandSchema,
  ShellOutputSchema,
  type AgentClientMessage,
  type AgentRunRequest,
  type ConversationHistory,
  type ConversationHistoryMessage,
  type ConversationStateStructure,
  type ConversationStep,
  type ExecClientMessage,
  type InterruptedPendingToolCallResolution,
  type InterruptedPendingToolCallResolutions,
  type ToolCall,
  UserMessageActionSchema,
  UserMessageSchema,
} from "../../../gen/agent/v1_pb"

const GZIP_MAGIC = [0x1f, 0x8b] as const

export type CursorFrameCompression = "none" | "gzip"

/**
 * Exact wire bytes are kept separately from the typed protobuf value.  The
 * bridge must never reconstruct state from a flattened text transcript: the
 * frame is the recovery/audit source and the typed message is its projection.
 */
export interface CursorAgentClientFrame {
  compression: CursorFrameCompression
  /** Bytes exactly as received from the transport, including gzip when used. */
  receivedBytes: Uint8Array
  /** Protobuf payload bytes after transport decompression. */
  protobufBytes: Uint8Array
  message: AgentClientMessage
}

/** A resolver is deliberately byte based; blob identifiers are not text. */
export interface CursorProtocolReferenceResolver {
  resolveBlob(reference: Uint8Array): Uint8Array | undefined
}

export interface CursorProtocolReference {
  /** Reference bytes as they appeared in ConversationStateStructure. */
  referenceBytes: Uint8Array
  /** Bytes decoded from a known stored blob, when the reference resolved. */
  resolvedBytes: Uint8Array
  source: "inline" | "blob"
}

export type CursorConversationEntry =
  | {
      source: "conversation_state"
      kind: "user"
      turnIndex: number
      requestId?: string
      userMessage: MessageShape<typeof UserMessageSchema>
      reference: CursorProtocolReference
    }
  | {
      source: "conversation_state"
      kind: "assistant_text"
      turnIndex: number
      stepIndex: number
      requestId?: string
      text: string
      step: ConversationStep
      reference: CursorProtocolReference
    }
  | {
      source: "conversation_state"
      kind: "assistant_thinking"
      turnIndex: number
      stepIndex: number
      requestId?: string
      text: string
      durationMs: number
      step: ConversationStep
      reference: CursorProtocolReference
    }
  | {
      source: "conversation_state"
      kind: "assistant_tool_call"
      turnIndex: number
      stepIndex: number
      requestId?: string
      toolCall: ToolCall
      step: ConversationStep
      reference: CursorProtocolReference
    }
  | {
      source: "conversation_state"
      kind: "shell_command"
      turnIndex: number
      command: string
      reference: CursorProtocolReference
    }
  | {
      source: "conversation_state"
      kind: "shell_output"
      turnIndex: number
      stdout: string
      stderr: string
      exitCode: number
      reference: CursorProtocolReference
    }
  | {
      source: "conversation_state"
      kind: "opaque_state_reference"
      turnIndex: number
      reference: CursorProtocolReference
      reason: "unknown_turn" | "unknown_step" | "invalid_reference"
    }
  | {
      source: "user_message_action_history"
      kind: "history_user_text"
      messageIndex: number
      contentIndex: number
      text: string
      message: ConversationHistoryMessage
      messageBytes: Uint8Array
    }
  | {
      source: "user_message_action_history"
      kind: "history_user_image"
      messageIndex: number
      contentIndex: number
      data: string
      mimeType?: string
      message: ConversationHistoryMessage
      messageBytes: Uint8Array
    }
  | {
      source: "user_message_action_history"
      kind: "history_assistant_text"
      messageIndex: number
      contentIndex: number
      text: string
      message: ConversationHistoryMessage
      messageBytes: Uint8Array
    }
  | {
      source: "user_message_action_history"
      kind: "history_assistant_reasoning"
      messageIndex: number
      contentIndex: number
      text: string
      signature?: string
      message: ConversationHistoryMessage
      messageBytes: Uint8Array
    }
  | {
      source: "user_message_action_history"
      kind: "history_assistant_redacted_reasoning"
      messageIndex: number
      contentIndex: number
      data: string
      message: ConversationHistoryMessage
      messageBytes: Uint8Array
    }
  | {
      source: "user_message_action_history"
      kind: "history_assistant_tool_call"
      messageIndex: number
      contentIndex: number
      toolCallId: string
      toolName: string
      argsJson: string
      message: ConversationHistoryMessage
      messageBytes: Uint8Array
    }
  | {
      source: "user_message_action_history"
      kind: "history_tool_result"
      messageIndex: number
      toolCallId: string
      toolName: string
      isError?: boolean
      content: Array<
        | { kind: "text"; text: string }
        | { kind: "image"; data: string; mimeType?: string }
        | { kind: "unknown" }
      >
      hookAdditionalContexts: Array<{
        hookEventName: string
        content: string
      }>
      message: ConversationHistoryMessage
      messageBytes: Uint8Array
    }
  | {
      source: "user_message_action_history"
      kind: "opaque_history_message"
      messageIndex: number
      message: ConversationHistoryMessage
      messageBytes: Uint8Array
    }

export interface CursorConversationStateProjection {
  state: ConversationStateStructure
  /** Canonical typed encoding, retaining protobuf unknown fields. */
  stateBytes: Uint8Array
  /**
   * Exact nested bytes from the inbound AgentRunRequest when available.
   * This intentionally remains absent for state constructed outside a wire
   * frame instead of silently substituting a re-encoded value.
   */
  rawStateBytes?: Uint8Array
  entries: CursorConversationEntry[]
}

/**
 * Typed request envelope used by the session layer. It retains the full
 * protocol state and references; the durable graph is projected directly
 * from these typed records without a text-only conversation mirror.
 */
export interface CursorRequestWireState {
  frame: CursorAgentClientFrame
  clientMessage: AgentClientMessage
  /**
   * Conversation-bound blob resolver used only while projecting this inbound
   * frame. It is never serialized or copied into the session graph; durable
   * bytes remain owned by CursorWireStore.
   */
  blobResolver?: CursorProtocolReferenceResolver
  agentRunRequest?: AgentRunRequest
  /** Exact nested bytes from the inbound AgentClientMessage. */
  agentRunRequestBytes?: Uint8Array
  /** Canonical typed encoding retained for typed replay / comparison. */
  agentRunRequestCanonicalBytes?: Uint8Array
  /** Typed ExecClientMessage when this inbound frame is an exec result. */
  execClientMessage?: ExecClientMessage
  /** Exact nested ExecClientMessage bytes from the inbound frame. */
  execClientMessageBytes?: Uint8Array
  conversationState?: CursorConversationStateProjection
  userMessageActionHistory: CursorConversationEntry[]
}

/**
 * Exact wire-backed official resolution. `typed` is decoded from
 * `resolutionBytes`, while both byte fields remain untouched so callers can
 * verify the typed projection without depending on a re-encoding.
 */
export interface CursorInterruptedPendingToolCallResolutionWire {
  source: "user_message_action" | "cancel_action"
  typed: InterruptedPendingToolCallResolution
  /** Exact bytes of one repeated `resolutions` message item. */
  resolutionBytes: Uint8Array
  /** Exact bytes of the surrounding interrupted resolutions message. */
  containerBytes: Uint8Array
}

export interface CursorInterruptedPendingToolCallResolutionsWire {
  source: CursorInterruptedPendingToolCallResolutionWire["source"]
  containerBytes: Uint8Array
  resolutions: CursorInterruptedPendingToolCallResolutionWire[]
}

/**
 * A typed official resolution must always have one exact raw protobuf source.
 * Treat a missing/mismatched source as a protocol error rather than allowing
 * downstream recovery code to reinterpret it as an absent terminal record.
 */
export class CursorInterruptedPendingToolCallResolutionCodecError extends Error {
  constructor(message: string) {
    super(
      `Cursor interrupted pending tool call resolution codec error: ${message}`
    )
  }
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes)
}

interface ProtobufVarint {
  value: number
  nextOffset: number
}

/**
 * Read a protobuf varint without decoding any surrounding message. This is
 * deliberately small and byte-oriented: its only job is to locate nested
 * length-delimited payloads exactly as they appeared on the wire.
 */
function readProtobufVarint(
  bytes: Uint8Array,
  offset: number
): ProtobufVarint | undefined {
  let value = 0
  let shift = 0

  for (let index = 0; index < 10 && offset + index < bytes.length; index++) {
    const byte = bytes[offset + index]!
    const payload = byte & 0x7f
    if (shift > 49 && payload > 0x0f) return undefined
    value += payload * 2 ** shift
    if ((byte & 0x80) === 0) {
      return Number.isSafeInteger(value)
        ? { value, nextOffset: offset + index + 1 }
        : undefined
    }
    shift += 7
  }

  return undefined
}

function skipProtobufField(
  bytes: Uint8Array,
  offset: number,
  fieldNumber: number,
  wireType: number
): number | undefined {
  switch (wireType) {
    case 0: {
      return readProtobufVarint(bytes, offset)?.nextOffset
    }
    case 1:
      return offset + 8 <= bytes.length ? offset + 8 : undefined
    case 2: {
      const length = readProtobufVarint(bytes, offset)
      if (!length || length.value > bytes.length - length.nextOffset) {
        return undefined
      }
      return length.nextOffset + length.value
    }
    case 3: {
      let cursor = offset
      while (cursor < bytes.length) {
        const key = readProtobufVarint(bytes, cursor)
        if (!key) return undefined
        cursor = key.nextOffset
        const nestedFieldNumber = Math.floor(key.value / 8)
        const nestedWireType = key.value & 0x07
        if (nestedWireType === 4) {
          return nestedFieldNumber === fieldNumber ? cursor : undefined
        }
        const next = skipProtobufField(
          bytes,
          cursor,
          nestedFieldNumber,
          nestedWireType
        )
        if (next === undefined) return undefined
        cursor = next
      }
      return undefined
    }
    case 5:
      return offset + 4 <= bytes.length ? offset + 4 : undefined
    default:
      return undefined
  }
}

/**
 * Return the last length-delimited payload for a field, preserving its exact
 * byte ordering and unknown fields. Singular protobuf message fields use the
 * last occurrence, matching standard protobuf merge/overwrite semantics.
 */
function findLengthDelimitedField(
  bytes: Uint8Array,
  expectedFieldNumber: number
): Uint8Array | undefined {
  const fields = findLengthDelimitedFields(bytes, expectedFieldNumber)
  return fields?.at(-1)
}

/**
 * Return every exact length-delimited payload for a repeated message field.
 * A malformed outer message returns undefined rather than a partial list.
 */
function findLengthDelimitedFields(
  bytes: Uint8Array,
  expectedFieldNumber: number
): Uint8Array[] | undefined {
  let cursor = 0
  const found: Uint8Array[] = []

  while (cursor < bytes.length) {
    const key = readProtobufVarint(bytes, cursor)
    if (!key) return undefined
    const fieldNumber = Math.floor(key.value / 8)
    const wireType = key.value & 0x07
    if (fieldNumber <= 0 || wireType === 4) return undefined

    const valueOffset = key.nextOffset
    if (fieldNumber === expectedFieldNumber && wireType === 2) {
      const length = readProtobufVarint(bytes, valueOffset)
      if (!length || length.value > bytes.length - length.nextOffset) {
        return undefined
      }
      found.push(
        cloneBytes(
          bytes.subarray(length.nextOffset, length.nextOffset + length.value)
        )
      )
      cursor = length.nextOffset + length.value
      continue
    }

    const next = skipProtobufField(bytes, valueOffset, fieldNumber, wireType)
    if (next === undefined) return undefined
    cursor = next
  }

  return found
}

function getMessageFieldNumber(
  schema: DescMessage,
  localName: string
): number | undefined {
  const field = schema.field[localName]
  return field?.number
}

function getRawConversationActionBytes(
  frame: CursorAgentClientFrame
): Uint8Array | undefined {
  if (frame.message.message.case === "conversationAction") {
    const fieldNumber = getMessageFieldNumber(
      AgentClientMessageSchema,
      "conversationAction"
    )
    return fieldNumber === undefined
      ? undefined
      : findLengthDelimitedField(frame.protobufBytes, fieldNumber)
  }

  if (frame.message.message.case !== "runRequest") return undefined
  const runFieldNumber = getMessageFieldNumber(
    AgentClientMessageSchema,
    "runRequest"
  )
  const runBytes =
    runFieldNumber === undefined
      ? undefined
      : findLengthDelimitedField(frame.protobufBytes, runFieldNumber)
  const actionFieldNumber = getMessageFieldNumber(
    AgentRunRequestSchema,
    "action"
  )
  return runBytes && actionFieldNumber !== undefined
    ? findLengthDelimitedField(runBytes, actionFieldNumber)
    : undefined
}

function getTypedInterruptedPendingToolCallResolutions(
  frame: CursorAgentClientFrame
):
  | {
      source: CursorInterruptedPendingToolCallResolutionWire["source"]
      container: InterruptedPendingToolCallResolutions
    }
  | undefined {
  const conversationAction =
    frame.message.message.case === "conversationAction"
      ? frame.message.message.value
      : frame.message.message.case === "runRequest"
        ? frame.message.message.value.action
        : undefined
  const action = conversationAction?.action
  if (action?.case === "userMessageAction") {
    return action.value.interruptedPendingToolCallResolutions
      ? {
          source: "user_message_action",
          container: action.value.interruptedPendingToolCallResolutions,
        }
      : undefined
  }
  if (action?.case === "cancelAction") {
    return action.value.interruptedPendingToolCallResolutions
      ? {
          source: "cancel_action",
          container: action.value.interruptedPendingToolCallResolutions,
        }
      : undefined
  }
  return undefined
}

/**
 * Extract `interrupted_pending_tool_call_resolutions` from a raw Cursor
 * envelope. The selector follows protobuf oneof last-field semantics for the
 * outer action, but never re-encodes a resolution: each returned item keeps
 * the exact repeated message bytes received from the IDE.
 */
export function extractCursorInterruptedPendingToolCallResolutions(
  frame: CursorAgentClientFrame
): CursorInterruptedPendingToolCallResolutionsWire | undefined {
  const typedCarrier = getTypedInterruptedPendingToolCallResolutions(frame)
  if (!typedCarrier) return undefined

  const conversationActionBytes = getRawConversationActionBytes(frame)
  if (!conversationActionBytes) {
    throw new CursorInterruptedPendingToolCallResolutionCodecError(
      "typed resolution field has no exact ConversationAction bytes"
    )
  }

  try {
    const conversationAction = fromBinary(
      ConversationActionSchema,
      conversationActionBytes,
      { readUnknownFields: true }
    )
    const actionCase = conversationAction.action.case
    if (actionCase !== "userMessageAction" && actionCase !== "cancelAction") {
      throw new CursorInterruptedPendingToolCallResolutionCodecError(
        `typed resolution source ${typedCarrier.source} disagrees with raw action ${actionCase ?? "unset"}`
      )
    }

    const actionFieldNumber = getMessageFieldNumber(
      ConversationActionSchema,
      actionCase
    )
    const actionPayloads =
      actionFieldNumber === undefined
        ? undefined
        : findLengthDelimitedFields(conversationActionBytes, actionFieldNumber)
    if (!actionPayloads || actionPayloads.length !== 1) {
      throw new CursorInterruptedPendingToolCallResolutionCodecError(
        `raw ${actionCase} action must have exactly one payload`
      )
    }
    const actionBytes = actionPayloads[0]!

    const source =
      actionCase === "userMessageAction"
        ? ("user_message_action" as const)
        : ("cancel_action" as const)
    if (source !== typedCarrier.source) {
      throw new CursorInterruptedPendingToolCallResolutionCodecError(
        `typed resolution source ${typedCarrier.source} disagrees with raw source ${source}`
      )
    }
    const actionSchema =
      actionCase === "userMessageAction"
        ? UserMessageActionSchema
        : CancelActionSchema
    const action = fromBinary(actionSchema, actionBytes, {
      readUnknownFields: true,
    })
    const typedContainer = action.interruptedPendingToolCallResolutions
    if (!typedContainer) {
      throw new CursorInterruptedPendingToolCallResolutionCodecError(
        `raw ${actionCase} action lost its typed resolution container`
      )
    }

    const containerFieldNumber = getMessageFieldNumber(
      actionSchema,
      "interruptedPendingToolCallResolutions"
    )
    const containerPayloads =
      containerFieldNumber === undefined
        ? undefined
        : findLengthDelimitedFields(actionBytes, containerFieldNumber)
    if (!containerPayloads || containerPayloads.length !== 1) {
      throw new CursorInterruptedPendingToolCallResolutionCodecError(
        `raw ${actionCase} resolution container must occur exactly once`
      )
    }
    const containerBytes = containerPayloads[0]!

    const container = fromBinary(
      InterruptedPendingToolCallResolutionsSchema,
      containerBytes,
      { readUnknownFields: true }
    )
    const resolutionFieldNumber = getMessageFieldNumber(
      InterruptedPendingToolCallResolutionsSchema,
      "resolutions"
    )
    const rawResolutionBytes =
      resolutionFieldNumber === undefined
        ? undefined
        : findLengthDelimitedFields(containerBytes, resolutionFieldNumber)
    if (
      !rawResolutionBytes ||
      rawResolutionBytes.length !== container.resolutions.length
    ) {
      throw new CursorInterruptedPendingToolCallResolutionCodecError(
        "raw resolution item count does not match its typed container"
      )
    }
    if (
      container.resolutions.length !== typedCarrier.container.resolutions.length
    ) {
      throw new CursorInterruptedPendingToolCallResolutionCodecError(
        "raw resolution container count does not match the enclosing typed action"
      )
    }

    const resolutions = rawResolutionBytes.map((resolutionBytes) => ({
      source,
      typed: fromBinary(
        InterruptedPendingToolCallResolutionSchema,
        resolutionBytes,
        { readUnknownFields: true }
      ),
      resolutionBytes,
      containerBytes: cloneBytes(containerBytes),
    }))

    return {
      source,
      containerBytes: cloneBytes(containerBytes),
      resolutions,
    }
  } catch (error) {
    if (error instanceof CursorInterruptedPendingToolCallResolutionCodecError) {
      throw error
    }
    throw new CursorInterruptedPendingToolCallResolutionCodecError(
      error instanceof Error ? error.message : String(error)
    )
  }
}

function isGzip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 &&
    bytes[0] === GZIP_MAGIC[0] &&
    bytes[1] === GZIP_MAGIC[1]
  )
}

/** Decode a transport frame without discarding protobuf unknown fields. */
export function decodeCursorAgentClientFrame(
  receivedBytes: Uint8Array
): CursorAgentClientFrame {
  const received = cloneBytes(receivedBytes)
  const compression: CursorFrameCompression = isGzip(received) ? "gzip" : "none"
  const protobufBytes =
    compression === "gzip"
      ? Uint8Array.from(zlib.gunzipSync(received))
      : cloneBytes(received)
  const message = fromBinary(AgentClientMessageSchema, protobufBytes, {
    readUnknownFields: true,
  })

  return {
    compression,
    receivedBytes: received,
    protobufBytes,
    message,
  }
}

/**
 * Serialize a message through Buf with unknown fields enabled.  This helper
 * is used by tests and persistence code to guarantee schema additions survive
 * an inspect/re-emit cycle.
 */
export function roundTripCursorBinary<Schema extends DescMessage>(
  schema: Schema,
  bytes: Uint8Array
): Uint8Array {
  const decoded = fromBinary(schema, bytes, { readUnknownFields: true })
  return toBinary(schema, decoded, { writeUnknownFields: true })
}

function resolveReference(
  referenceBytes: Uint8Array,
  resolver?: CursorProtocolReferenceResolver
): CursorProtocolReference {
  const original = cloneBytes(referenceBytes)
  const resolved = resolver?.resolveBlob(original)
  if (resolved) {
    return {
      referenceBytes: original,
      resolvedBytes: cloneBytes(resolved),
      source: "blob",
    }
  }
  return {
    referenceBytes: original,
    resolvedBytes: cloneBytes(original),
    source: "inline",
  }
}

function decodeKnownReference<Schema extends DescMessage>(
  schema: Schema,
  reference: CursorProtocolReference
): MessageShape<Schema> | undefined {
  if (reference.resolvedBytes.length === 0) return undefined
  try {
    return fromBinary(schema, reference.resolvedBytes, {
      readUnknownFields: true,
    })
  } catch {
    return undefined
  }
}

function decodeConversationStep(
  reference: CursorProtocolReference,
  turnIndex: number,
  stepIndex: number,
  requestId?: string
): CursorConversationEntry {
  const step = decodeKnownReference(ConversationStepSchema, reference)
  if (!step) {
    return {
      source: "conversation_state",
      kind: "opaque_state_reference",
      turnIndex,
      reference,
      reason: "invalid_reference",
    }
  }

  switch (step.message.case) {
    case "assistantMessage":
      return {
        source: "conversation_state",
        kind: "assistant_text",
        turnIndex,
        stepIndex,
        requestId,
        text: step.message.value.text,
        step,
        reference,
      }
    case "thinkingMessage":
      return {
        source: "conversation_state",
        kind: "assistant_thinking",
        turnIndex,
        stepIndex,
        requestId,
        text: step.message.value.text,
        durationMs: step.message.value.durationMs,
        step,
        reference,
      }
    case "toolCall":
      return {
        source: "conversation_state",
        kind: "assistant_tool_call",
        turnIndex,
        stepIndex,
        requestId,
        toolCall: step.message.value,
        step,
        reference,
      }
    case undefined:
      return {
        source: "conversation_state",
        kind: "opaque_state_reference",
        turnIndex,
        reference,
        reason: "unknown_step",
      }
  }
}

/**
 * Decode the typed portions of ConversationStateStructure.  Opaque state
 * stays opaque; we never attempt JSON/text heuristics over arbitrary bytes.
 */
export function decodeCursorConversationState(
  state: ConversationStateStructure,
  resolver?: CursorProtocolReferenceResolver,
  rawStateBytes?: Uint8Array
): CursorConversationStateProjection {
  const entries: CursorConversationEntry[] = []

  for (const [turnIndex, turnBytes] of state.turns.entries()) {
    const turnReference = resolveReference(turnBytes, resolver)
    const turn = decodeKnownReference(
      ConversationTurnStructureSchema,
      turnReference
    )
    if (!turn) {
      entries.push({
        source: "conversation_state",
        kind: "opaque_state_reference",
        turnIndex,
        reference: turnReference,
        reason: "invalid_reference",
      })
      continue
    }

    if (turn.turn.case === "agentConversationTurn") {
      const agentTurn = turn.turn.value
      const userReference = resolveReference(agentTurn.userMessage, resolver)
      const userMessage = decodeKnownReference(UserMessageSchema, userReference)
      if (userMessage) {
        entries.push({
          source: "conversation_state",
          kind: "user",
          turnIndex,
          requestId: agentTurn.requestId,
          userMessage,
          reference: userReference,
        })
      } else if (userReference.referenceBytes.length > 0) {
        entries.push({
          source: "conversation_state",
          kind: "opaque_state_reference",
          turnIndex,
          reference: userReference,
          reason: "invalid_reference",
        })
      }

      for (const [stepIndex, stepBytes] of agentTurn.steps.entries()) {
        entries.push(
          decodeConversationStep(
            resolveReference(stepBytes, resolver),
            turnIndex,
            stepIndex,
            agentTurn.requestId
          )
        )
      }
      continue
    }

    if (turn.turn.case === "shellConversationTurn") {
      const shellTurn = turn.turn.value
      const commandReference = resolveReference(
        shellTurn.shellCommand,
        resolver
      )
      const command = decodeKnownReference(ShellCommandSchema, commandReference)
      if (command) {
        entries.push({
          source: "conversation_state",
          kind: "shell_command",
          turnIndex,
          command: command.command,
          reference: commandReference,
        })
      } else if (commandReference.referenceBytes.length > 0) {
        entries.push({
          source: "conversation_state",
          kind: "opaque_state_reference",
          turnIndex,
          reference: commandReference,
          reason: "invalid_reference",
        })
      }

      const outputReference = resolveReference(shellTurn.shellOutput, resolver)
      const output = decodeKnownReference(ShellOutputSchema, outputReference)
      if (output) {
        entries.push({
          source: "conversation_state",
          kind: "shell_output",
          turnIndex,
          stdout: output.stdout,
          stderr: output.stderr,
          exitCode: output.exitCode,
          reference: outputReference,
        })
      } else if (outputReference.referenceBytes.length > 0) {
        entries.push({
          source: "conversation_state",
          kind: "opaque_state_reference",
          turnIndex,
          reference: outputReference,
          reason: "invalid_reference",
        })
      }
      continue
    }

    entries.push({
      source: "conversation_state",
      kind: "opaque_state_reference",
      turnIndex,
      reference: turnReference,
      reason: "unknown_turn",
    })
  }

  return {
    state,
    stateBytes: toBinary(ConversationStateStructureSchema, state, {
      writeUnknownFields: true,
    }),
    rawStateBytes: rawStateBytes ? cloneBytes(rawStateBytes) : undefined,
    entries,
  }
}

/** Parse generic ConversationHistory without collapsing content blocks. */
export function decodeCursorConversationHistory(
  history?: ConversationHistory
): CursorConversationEntry[] {
  if (!history) return []

  const entries: CursorConversationEntry[] = []
  for (const [messageIndex, message] of history.messages.entries()) {
    const messageBytes = toBinary(ConversationHistoryMessageSchema, message, {
      writeUnknownFields: true,
    })
    const common = { messageIndex, message, messageBytes } as const

    if (message.message.case === "user") {
      let emitted = false
      for (const [
        contentIndex,
        content,
      ] of message.message.value.content.entries()) {
        if (content.content.case === "text") {
          emitted = true
          entries.push({
            source: "user_message_action_history",
            kind: "history_user_text",
            ...common,
            contentIndex,
            text: content.content.value.text,
          })
          continue
        }
        if (content.content.case === "image") {
          emitted = true
          entries.push({
            source: "user_message_action_history",
            kind: "history_user_image",
            ...common,
            contentIndex,
            data: content.content.value.data,
            mimeType: content.content.value.mimeType,
          })
          continue
        }
        emitted = true
        entries.push({
          source: "user_message_action_history",
          kind: "opaque_history_message",
          ...common,
        })
      }
      if (!emitted) {
        entries.push({
          source: "user_message_action_history",
          kind: "opaque_history_message",
          ...common,
        })
      }
      continue
    }

    if (message.message.case === "assistant") {
      let emitted = false
      for (const [
        contentIndex,
        content,
      ] of message.message.value.content.entries()) {
        if (content.content.case === "text") {
          emitted = true
          entries.push({
            source: "user_message_action_history",
            kind: "history_assistant_text",
            ...common,
            contentIndex,
            text: content.content.value.text,
          })
          continue
        }
        if (content.content.case === "reasoning") {
          emitted = true
          entries.push({
            source: "user_message_action_history",
            kind: "history_assistant_reasoning",
            ...common,
            contentIndex,
            text: content.content.value.text,
            signature: content.content.value.signature,
          })
          continue
        }
        if (content.content.case === "redactedReasoning") {
          emitted = true
          entries.push({
            source: "user_message_action_history",
            kind: "history_assistant_redacted_reasoning",
            ...common,
            contentIndex,
            data: content.content.value.data,
          })
          continue
        }
        if (content.content.case === "toolCall") {
          emitted = true
          entries.push({
            source: "user_message_action_history",
            kind: "history_assistant_tool_call",
            ...common,
            contentIndex,
            toolCallId: content.content.value.toolCallId,
            toolName: content.content.value.toolName,
            argsJson: content.content.value.argsJson,
          })
          continue
        }
        emitted = true
        entries.push({
          source: "user_message_action_history",
          kind: "opaque_history_message",
          ...common,
        })
      }
      if (!emitted) {
        entries.push({
          source: "user_message_action_history",
          kind: "opaque_history_message",
          ...common,
        })
      }
      continue
    }

    if (message.message.case === "tool") {
      const tool = message.message.value
      entries.push({
        source: "user_message_action_history",
        kind: "history_tool_result",
        ...common,
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        isError: tool.isError,
        content: tool.content.map((content) => {
          if (content.content.case === "text") {
            return { kind: "text" as const, text: content.content.value.text }
          }
          if (content.content.case === "image") {
            return {
              kind: "image" as const,
              data: content.content.value.data,
              mimeType: content.content.value.mimeType,
            }
          }
          return { kind: "unknown" as const }
        }),
        hookAdditionalContexts: tool.hookAdditionalContexts.map((context) => ({
          hookEventName: context.hookEventName,
          content: context.content,
        })),
      })
      continue
    }

    entries.push({
      source: "user_message_action_history",
      kind: "opaque_history_message",
      ...common,
    })
  }

  return entries
}

export function createCursorRequestWireState(
  frame: CursorAgentClientFrame,
  resolver?: CursorProtocolReferenceResolver
): CursorRequestWireState {
  const runRequest =
    frame.message.message.case === "runRequest"
      ? frame.message.message.value
      : undefined
  const execClientMessage =
    frame.message.message.case === "execClientMessage"
      ? frame.message.message.value
      : undefined
  const runRequestFieldNumber = getMessageFieldNumber(
    AgentClientMessageSchema,
    "runRequest"
  )
  const agentRunRequestBytes =
    runRequest && runRequestFieldNumber !== undefined
      ? findLengthDelimitedField(frame.protobufBytes, runRequestFieldNumber)
      : undefined
  const execClientMessageFieldNumber = getMessageFieldNumber(
    AgentClientMessageSchema,
    "execClientMessage"
  )
  const execClientMessageBytes =
    execClientMessage && execClientMessageFieldNumber !== undefined
      ? findLengthDelimitedField(
          frame.protobufBytes,
          execClientMessageFieldNumber
        )
      : undefined
  const conversationStateFieldNumber = getMessageFieldNumber(
    AgentRunRequestSchema,
    "conversationState"
  )
  const rawConversationStateBytes =
    agentRunRequestBytes && conversationStateFieldNumber !== undefined
      ? findLengthDelimitedField(
          agentRunRequestBytes,
          conversationStateFieldNumber
        )
      : undefined
  const userMessageAction = (() => {
    if (frame.message.message.case !== "conversationAction") return undefined
    const action = frame.message.message.value.action
    return action.case === "userMessageAction" ? action.value : undefined
  })()
  const runUserMessageAction =
    runRequest?.action?.action.case === "userMessageAction"
      ? runRequest.action.action.value
      : undefined
  const conversationState = runRequest?.conversationState

  return {
    frame,
    clientMessage: frame.message,
    ...(resolver ? { blobResolver: resolver } : {}),
    agentRunRequest: runRequest,
    agentRunRequestBytes,
    agentRunRequestCanonicalBytes: runRequest
      ? toBinary(AgentRunRequestSchema, runRequest, {
          writeUnknownFields: true,
        })
      : undefined,
    execClientMessage,
    execClientMessageBytes,
    conversationState: conversationState
      ? decodeCursorConversationState(
          conversationState,
          resolver,
          rawConversationStateBytes
        )
      : undefined,
    userMessageActionHistory: decodeCursorConversationHistory(
      userMessageAction?.conversationHistory ??
        runUserMessageAction?.conversationHistory
    ),
  }
}
