import {
  createSnipBoundaryRecord,
  isMessageRecord,
  isSnipBoundaryRecord,
} from "../../../context/context-transcript-events"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import type { ContextTranscriptRecord } from "../../../context/types"
import type { SessionSnipBoundaryEvent } from "./snip-boundary-store.service"

/** Raised when an append-only Snip event cannot be reconciled with the graph. */
export class SnipBoundaryProjectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SnipBoundaryProjectionError"
  }
}

/**
 * Materialize typed Snip events into transcript records. Every target and the
 * anchor must identify an immutable main-graph message; accepting any other
 * shape would make a restart depend on provider-local layout details.
 */
export function materializeSnipBoundaryRecords(input: {
  graphRecords: readonly ContextTranscriptRecord[]
  events: readonly SessionSnipBoundaryEvent[]
}): ContextTranscriptRecord[] {
  const graphById = new Map<string, ContextTranscriptRecord>()
  for (const record of input.graphRecords) {
    const recordId = requireSnipIdentifier(record.id, "graph record id")
    if (!isMessageRecord(record)) {
      throw new SnipBoundaryProjectionError(
        `Snip graph source contains non-message record ${record.id}`
      )
    }
    if (graphById.has(recordId)) {
      throw new SnipBoundaryProjectionError(
        `Snip graph source contains duplicate record ${record.id}`
      )
    }
    graphById.set(recordId, record)
  }

  let previousSeq = 0
  const seenBoundaryIds = new Set<string>()
  return input.events.map((event) => {
    const eventId = requireSnipIdentifier(event.id, "boundary id")
    const afterGraphUuid = requireSnipIdentifier(
      event.afterGraphUuid,
      "boundary graph anchor"
    )
    const removedRecordIds = event.removedRecordIds.map((recordId, index) =>
      requireSnipIdentifier(recordId, `boundary removed record id ${index}`)
    )
    if (!Number.isInteger(event.seq) || event.seq <= previousSeq) {
      throw new SnipBoundaryProjectionError(
        `Snip boundary ${event.id} has an invalid event sequence`
      )
    }
    previousSeq = event.seq
    if (seenBoundaryIds.has(eventId) || graphById.has(eventId)) {
      throw new SnipBoundaryProjectionError(
        `Snip boundary ${event.id} has a duplicate record id`
      )
    }
    seenBoundaryIds.add(eventId)
    if (!graphById.has(afterGraphUuid)) {
      throw new SnipBoundaryProjectionError(
        `Snip boundary ${event.id} anchors missing graph record ${event.afterGraphUuid}`
      )
    }
    for (const removedId of removedRecordIds) {
      const target = graphById.get(removedId)
      if (!target || !isMessageRecord(target)) {
        throw new SnipBoundaryProjectionError(
          `Snip boundary ${event.id} targets non-graph record ${removedId}`
        )
      }
    }
    return createSnipBoundaryRecord({
      id: eventId,
      afterGraphUuid,
      removedRecordIds,
      createdAt: event.createdAt,
    })
  })
}

/**
 * Replays events into the raw graph order. Boundaries are placed immediately
 * after their graph anchor; ties are resolved by the durable event sequence.
 */
export function mergeSnipBoundariesIntoGraph(input: {
  graphRecords: readonly ContextTranscriptRecord[]
  boundaryRecords: readonly ContextTranscriptRecord[]
}): ContextTranscriptRecord[] {
  const boundariesByAnchor = indexBoundaryRecords(
    input.graphRecords,
    input.boundaryRecords
  )
  const result: ContextTranscriptRecord[] = []
  for (const graphRecord of input.graphRecords) {
    const graphRecordId = requireSnipIdentifier(
      graphRecord.id,
      "graph record id"
    )
    result.push(graphRecord)
    result.push(...(boundariesByAnchor.get(graphRecordId) || []))
  }
  return result
}

/**
 * Merges durable Snip events into an active provider layout without relying
 * on the layout's timestamps or compact recipe. A boundary whose anchor is no
 * longer visible is inserted immediately before the first later visible graph
 * record; if no later graph record survives, it is appended. This is the
 * exact graph-sequence rule used by cold recovery.
 */
export function mergeSnipBoundariesIntoProjection(input: {
  graphRecords: readonly ContextTranscriptRecord[]
  projectionRecords: readonly ContextTranscriptRecord[]
  boundaryRecords: readonly ContextTranscriptRecord[]
}): ContextTranscriptRecord[] {
  const graphIndex = new Map<string, number>()
  for (const [index, record] of input.graphRecords.entries()) {
    const recordId = requireSnipIdentifier(record.id, "graph record id")
    if (!isMessageRecord(record)) {
      throw new SnipBoundaryProjectionError(
        `Snip graph source contains non-message record ${record.id}`
      )
    }
    if (graphIndex.has(recordId)) {
      throw new SnipBoundaryProjectionError(
        `Snip graph source contains duplicate record ${record.id}`
      )
    }
    graphIndex.set(recordId, index)
  }
  const boundariesByAnchor = indexBoundaryRecords(
    input.graphRecords,
    input.boundaryRecords
  )
  const result = [...input.projectionRecords]
  const presentById = new Map<string, ContextTranscriptRecord>()
  const durableById = new Map(
    input.boundaryRecords.map((record) => [
      requireSnipIdentifier(record.id, "durable boundary record id"),
      record,
    ])
  )
  for (const record of result) {
    const recordId = requireSnipIdentifier(
      record.id,
      "active projection record id"
    )
    if (presentById.has(recordId)) {
      throw new SnipBoundaryProjectionError(
        `Snip active projection contains duplicate record ${record.id}`
      )
    }
    presentById.set(recordId, record)
    if (isSnipBoundaryRecord(record) && !durableById.has(recordId)) {
      throw new SnipBoundaryProjectionError(
        `Snip active projection contains boundary ${record.id} absent from the durable event store`
      )
    }
  }

  for (const graphRecord of input.graphRecords) {
    const graphRecordId = requireSnipIdentifier(
      graphRecord.id,
      "graph record id"
    )
    const boundaries = boundariesByAnchor.get(graphRecordId) || []
    for (const boundary of boundaries) {
      const boundaryId = requireSnipIdentifier(
        boundary.id,
        "boundary record id"
      )
      const present = presentById.get(boundaryId)
      if (present) {
        assertSameBoundary(boundary, present)
        continue
      }
      const anchorIndex = graphIndex.get(graphRecordId)!
      const successorIndex = result.findIndex((record) => {
        const index = graphIndex.get(
          requireSnipIdentifier(record.id, "active projection record id")
        )
        return index !== undefined && index > anchorIndex
      })
      const insertAt = successorIndex >= 0 ? successorIndex : result.length
      result.splice(insertAt, 0, boundary)
      presentById.set(boundaryId, boundary)
    }
  }
  return result
}

function assertSameBoundary(
  durable: ContextTranscriptRecord,
  projected: ContextTranscriptRecord
): void {
  if (
    !isSnipBoundaryRecord(projected) ||
    projected.role !== durable.role ||
    projected.createdAt !== durable.createdAt ||
    projected.content !== durable.content ||
    projected.snipMetadata?.afterGraphUuid !==
      durable.snipMetadata?.afterGraphUuid ||
    !sameStringArray(
      projected.snipMetadata?.removedRecordIds,
      durable.snipMetadata?.removedRecordIds
    )
  ) {
    throw new SnipBoundaryProjectionError(
      `Snip active projection boundary ${durable.id} does not match its durable event`
    )
  }
}

function sameStringArray(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function indexBoundaryRecords(
  graphRecords: readonly ContextTranscriptRecord[],
  boundaryRecords: readonly ContextTranscriptRecord[]
): Map<string, ContextTranscriptRecord[]> {
  const graphById = new Map<string, ContextTranscriptRecord>()
  for (const graphRecord of graphRecords) {
    const graphRecordId = requireSnipIdentifier(
      graphRecord.id,
      "graph record id"
    )
    if (graphById.has(graphRecordId)) {
      throw new SnipBoundaryProjectionError(
        `Snip graph source contains duplicate record ${graphRecordId}`
      )
    }
    graphById.set(graphRecordId, graphRecord)
  }
  const byAnchor = new Map<string, ContextTranscriptRecord[]>()
  const seenBoundaryIds = new Set<string>()
  for (const record of boundaryRecords) {
    const boundaryId = requireSnipIdentifier(record.id, "boundary record id")
    if (!isSnipBoundaryRecord(record)) {
      throw new SnipBoundaryProjectionError(
        `Snip event source contains non-Snip record ${record.id}`
      )
    }
    if (seenBoundaryIds.has(boundaryId) || graphById.has(boundaryId)) {
      throw new SnipBoundaryProjectionError(
        `Snip event source contains duplicate record ${record.id}`
      )
    }
    seenBoundaryIds.add(boundaryId)
    const anchor = requireSnipIdentifier(
      record.snipMetadata?.afterGraphUuid,
      "boundary graph anchor"
    )
    if (!graphById.has(anchor)) {
      throw new SnipBoundaryProjectionError(
        `Snip boundary ${record.id} anchors missing graph record ${anchor || "(empty)"}`
      )
    }
    const removedRecordIds = record.snipMetadata?.removedRecordIds
    if (!Array.isArray(removedRecordIds) || removedRecordIds.length === 0) {
      throw new SnipBoundaryProjectionError(
        `Snip boundary ${boundaryId} has no removed graph records`
      )
    }
    const seenRemovedIds = new Set<string>()
    for (const [index, rawRemovedId] of removedRecordIds.entries()) {
      const removedId = requireSnipIdentifier(
        rawRemovedId,
        `boundary removed record id ${index}`
      )
      if (seenRemovedIds.has(removedId)) {
        throw new SnipBoundaryProjectionError(
          `Snip boundary ${boundaryId} repeats removed graph record ${removedId}`
        )
      }
      seenRemovedIds.add(removedId)
      const target = graphById.get(removedId)
      if (!target || !isMessageRecord(target)) {
        throw new SnipBoundaryProjectionError(
          `Snip boundary ${record.id} targets non-graph record ${removedId}`
        )
      }
    }
    const list = byAnchor.get(anchor)
    if (list) {
      list.push(record)
    } else {
      byAnchor.set(anchor, [record])
    }
  }
  return byAnchor
}

function requireSnipIdentifier(value: unknown, label: string): string {
  try {
    return requireExactDurableIdentifier(value, `Snip ${label}`)
  } catch (error) {
    throw new SnipBoundaryProjectionError(
      `Snip ${label} is invalid: ${(error as Error).message}`
    )
  }
}
