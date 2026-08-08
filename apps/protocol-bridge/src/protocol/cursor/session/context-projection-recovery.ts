import type {
  ContextCompactionCommit,
  ContextTranscriptRecord,
} from "../../../context/types"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import {
  deriveCompactionHistoryFromTranscript,
  getActiveCompactCommitFromTranscript,
  isMessageRecord,
} from "../../../context/context-transcript-events"
import type { RestoredContextProjection } from "./context-projection-store.service"
import { mergeSnipBoundariesIntoProjection } from "./snip-boundary-projection"

export interface RebuiltContextProjection {
  records: ContextTranscriptRecord[]
  activeCommit: ContextCompactionCommit
  generation: number
}

/**
 * Reconstruct the provider-neutral compact view from immutable graph rows,
 * immutable Snip events, and one durable projection generation. There is no
 * fallback to a mutable context blob or inferred text cutoff: every layout id
 * must resolve to one exact graph, Snip, or synthetic record.
 */
export function rebuildContextProjectionRecords(input: {
  graphRecords: readonly ContextTranscriptRecord[]
  snipBoundaryRecords: readonly ContextTranscriptRecord[]
  restored: RestoredContextProjection
}): RebuiltContextProjection {
  const graphById = indexRecords(input.graphRecords, "graph")
  const snipById = indexRecords(input.snipBoundaryRecords, "Snip")
  const syntheticById = indexRecords(
    input.restored.syntheticRecords,
    "synthetic"
  )
  const watermark = requireExactDurableIdentifier(
    input.restored.head.graphWatermarkUuid,
    "Context projection restore graph watermark UUID"
  )
  const watermarkIndex = input.graphRecords.findIndex(
    (record) => record.id === watermark
  )
  if (
    watermarkIndex < 0 ||
    !isMessageRecord(input.graphRecords[watermarkIndex]!)
  ) {
    throw new Error(
      `Context projection restore watermark ${watermark} is absent from durable graph`
    )
  }

  const records: ContextTranscriptRecord[] = []
  const seen = new Set<string>()
  for (const rawRecordId of input.restored.layout.orderedRecordIds) {
    const recordId = requireExactDurableIdentifier(
      rawRecordId,
      "Context projection restore layout record id"
    )
    const record = resolveLayoutRecord({
      recordId,
      graphById,
      snipById,
      syntheticById,
    })
    if (seen.has(record.id)) {
      throw new Error(`Context projection layout repeats record ${record.id}`)
    }
    seen.add(record.id)
    records.push(structuredClone(record))
  }
  // A full compaction deliberately omits every pre-install graph row,
  // including its watermark. The watermark is an ordering checkpoint, not a
  // required visible layout member. Reattach only the exact durable
  // continuation after it; old archived graph rows must never re-enter.
  for (const record of input.graphRecords.slice(watermarkIndex + 1)) {
    if (seen.has(record.id)) {
      throw new Error(
        `Context projection continuation duplicates installed layout record ${record.id}`
      )
    }
    seen.add(record.id)
    records.push({ ...structuredClone(record), kind: "message" })
  }

  const withSnips = mergeSnipBoundariesIntoProjection({
    graphRecords: input.graphRecords,
    projectionRecords: records,
    boundaryRecords: input.snipBoundaryRecords,
  })
  const activeCommit = getActiveCompactCommitFromTranscript(withSnips)
  if (!activeCommit) {
    throw new Error("Context projection layout has no active compact boundary")
  }
  const activeCompactionId = requireExactDurableIdentifier(
    input.restored.head.activeCompactionId,
    "Context projection restore active compaction id"
  )
  if (activeCommit.id !== activeCompactionId) {
    throw new Error(
      `Context projection active compact mismatch: head=${activeCompactionId} layout=${activeCommit.id}`
    )
  }
  if (activeCommit.epoch !== input.restored.head.generation) {
    throw new Error(
      `Context projection generation mismatch: head=${input.restored.head.generation} compact=${String(activeCommit.epoch)}`
    )
  }

  const history = deriveCompactionHistoryFromTranscript(withSnips)
  if (!history.some((commit) => commit.id === activeCommit.id)) {
    throw new Error(
      `Context projection active compact ${activeCommit.id} is not represented in layout history`
    )
  }
  return {
    records: withSnips,
    activeCommit,
    generation: input.restored.head.generation,
  }
}

function indexRecords(
  records: readonly ContextTranscriptRecord[],
  label: string
): Map<string, ContextTranscriptRecord> {
  const result = new Map<string, ContextTranscriptRecord>()
  for (const record of records) {
    const id = requireExactDurableIdentifier(
      record.id,
      `Context projection ${label} record id`
    )
    if (result.has(id)) {
      throw new Error(
        `Context projection ${label} source has duplicate/empty record id`
      )
    }
    result.set(id, record)
  }
  return result
}

function resolveLayoutRecord(input: {
  recordId: string
  graphById: ReadonlyMap<string, ContextTranscriptRecord>
  snipById: ReadonlyMap<string, ContextTranscriptRecord>
  syntheticById: ReadonlyMap<string, ContextTranscriptRecord>
}): ContextTranscriptRecord {
  const matches = [
    input.graphById.get(input.recordId),
    input.snipById.get(input.recordId),
    input.syntheticById.get(input.recordId),
  ].filter((record): record is ContextTranscriptRecord => record !== undefined)
  if (matches.length !== 1) {
    throw new Error(
      `Context projection layout id ${input.recordId} resolves to ${matches.length} records`
    )
  }
  return matches[0]!
}
