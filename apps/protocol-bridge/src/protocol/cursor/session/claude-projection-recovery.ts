import type {
  ContextTranscriptRecord,
  ProjectionExclusionReason,
  ProjectionManifest,
} from "../../../context/types"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import { isMessageRecord } from "../../../context/context-transcript-events"
import type { RestoredClaudeProjection } from "./claude-projection-store.service"
import { mergeSnipBoundariesIntoProjection } from "./snip-boundary-projection"

/**
 * Raised when provider-owned Claude projection state cannot be reconciled
 * exactly with the durable graph. Recovery deliberately stops instead of
 * widening the prompt to archived content or guessing order from timestamps.
 */
export class ClaudeProjectionRecoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClaudeProjectionRecoveryError"
  }
}

/**
 * Rebuild the active Claude read model from three typed durable facts:
 *
 * - the persisted active layout is the complete provider window at sync;
 * - the manifest identifies every source examined at that sync;
 * - only graph records appended strictly after the persisted graph watermark can
 *   be a post-sync continuation.
 *
 * Nothing outside that boundary is reintroduced. In particular, graph rows
 * intentionally excluded by a provider revision, and rows considered by the
 * synced manifest but omitted from its active layout, remain absent.
 */
export function rebuildClaudeProjectionRecords(input: {
  graphRecords: readonly ContextTranscriptRecord[]
  /** Provider-neutral Snip events materialized from their append-only store. */
  snipBoundaryRecords: readonly ContextTranscriptRecord[]
  restored: RestoredClaudeProjection
}): ContextTranscriptRecord[] {
  const byId = new Map<string, ContextTranscriptRecord>()
  for (const record of input.graphRecords) {
    assertUniqueRecord(byId, record, "durable graph")
  }
  for (const record of input.restored.syntheticRecords) {
    if (!record.kind || record.kind === "message") {
      throw new ClaudeProjectionRecoveryError(
        `Claude projection recovery received message-shaped synthetic record ${record.id}`
      )
    }
    assertUniqueRecord(byId, record, "Claude synthetic projection")
  }
  for (const record of input.snipBoundaryRecords) {
    if (record.kind !== "snip_boundary") {
      throw new ClaudeProjectionRecoveryError(
        `Claude projection recovery received non-Snip external record ${record.id}`
      )
    }
    assertUniqueRecord(byId, record, "durable Snip projection")
  }

  const manifestEntries = indexManifest(input.restored.manifest)
  const snippedRecordIds = collectSnippedRecordIds(
    input.graphRecords,
    input.snipBoundaryRecords
  )
  const layoutIds = requireExactIdSequence(
    input.restored.layout.orderedRecordIds,
    "active layout"
  )
  const layout = layoutIds.map((recordId) => {
    const entry = manifestEntries.get(recordId)
    if (!isActiveLayoutEntry(entry)) {
      throw new ClaudeProjectionRecoveryError(
        `Claude projection recovery layout record ${recordId} is neither provider-visible nor an internal marker`
      )
    }
    return requireRecord(byId, recordId, "active layout")
  })
  assertManifestIncludedSourcesMatchLayout(manifestEntries, layoutIds)
  const visibleLayout = layout.filter(
    (record) =>
      !isMessageRecord(record) || record.excludedFromProviderProjection !== true
  )
  const visibleLayoutIds = new Set(visibleLayout.map((record) => record.id))

  validateActiveLeaf({
    manifest: input.restored.manifest,
    manifestEntries,
    graphRecords: input.graphRecords,
    visibleLayoutIds,
  })

  if (input.restored.recipe) {
    validateRecipe(
      input.restored.recipe,
      byId,
      visibleLayoutIds,
      snippedRecordIds
    )
  }

  const graphWatermarkUuid = requireRecoveryIdentifier(
    input.restored.graphWatermarkUuid,
    "graph watermark"
  )
  const watermarkIndex = input.graphRecords.findIndex(
    (record) => record.id === graphWatermarkUuid
  )
  if (watermarkIndex < 0) {
    throw new ClaudeProjectionRecoveryError(
      `Claude projection recovery cannot resolve graph watermark ${graphWatermarkUuid}`
    )
  }
  const watermark = input.graphRecords[watermarkIndex]!
  if (!isMessageRecord(watermark)) {
    throw new ClaudeProjectionRecoveryError(
      `Claude projection recovery watermark ${graphWatermarkUuid} is not a graph message`
    )
  }

  const continuation = input.graphRecords
    .slice(watermarkIndex + 1)
    .filter(
      (record) =>
        !manifestEntries.has(record.id) &&
        record.excludedFromProviderProjection !== true
    )

  return mergeSnipBoundariesIntoProjection({
    graphRecords: input.graphRecords,
    projectionRecords: [...visibleLayout, ...continuation],
    boundaryRecords: input.snipBoundaryRecords,
  })
}

function indexManifest(
  manifest: ProjectionManifest
): Map<string, { included: boolean; reason?: ProjectionExclusionReason }> {
  if (manifest.provider !== "claude") {
    throw new ClaudeProjectionRecoveryError(
      `Claude projection recovery received a ${manifest.provider} manifest`
    )
  }
  const entries = new Map<
    string,
    { included: boolean; reason?: ProjectionExclusionReason }
  >()
  for (const entry of manifest.sourceEntries) {
    const sourceUuid = requireRecoveryIdentifier(
      entry.sourceUuid,
      "manifest source UUID"
    )
    if (entries.has(sourceUuid)) {
      throw new ClaudeProjectionRecoveryError(
        "Claude projection recovery manifest has invalid source UUIDs"
      )
    }
    entries.set(sourceUuid, {
      included: entry.included === true,
      reason: entry.reason,
    })
  }
  return entries
}

function assertManifestIncludedSourcesMatchLayout(
  manifestEntries: ReadonlyMap<
    string,
    { included: boolean; reason?: ProjectionExclusionReason }
  >,
  layoutIds: readonly string[]
): void {
  const layoutIdSet = new Set(layoutIds)
  for (const [sourceUuid, entry] of manifestEntries) {
    if (entry.included && !layoutIdSet.has(sourceUuid)) {
      throw new ClaudeProjectionRecoveryError(
        `Claude projection recovery manifest includes source ${sourceUuid} outside the active layout`
      )
    }
    if (entry.reason === "internal_marker" && !layoutIdSet.has(sourceUuid)) {
      throw new ClaudeProjectionRecoveryError(
        `Claude projection recovery internal marker ${sourceUuid} is outside the active layout`
      )
    }
  }
  for (const recordId of layoutIds) {
    if (!isActiveLayoutEntry(manifestEntries.get(recordId))) {
      throw new ClaudeProjectionRecoveryError(
        `Claude projection recovery active layout record ${recordId} has no active manifest entry`
      )
    }
  }
}

function isActiveLayoutEntry(
  entry: { included: boolean; reason?: ProjectionExclusionReason } | undefined
): boolean {
  return Boolean(
    entry && (entry.included || entry.reason === "internal_marker")
  )
}

function validateActiveLeaf(input: {
  manifest: ProjectionManifest
  manifestEntries: ReadonlyMap<
    string,
    { included: boolean; reason?: ProjectionExclusionReason }
  >
  graphRecords: readonly ContextTranscriptRecord[]
  visibleLayoutIds: ReadonlySet<string>
}): void {
  if (input.manifest.activeLeafUuid === undefined) return
  const activeLeafUuid = requireRecoveryIdentifier(
    input.manifest.activeLeafUuid,
    "active leaf"
  )
  const activeLeaf = input.graphRecords.find(
    (record) => record.id === activeLeafUuid
  )
  if (!activeLeaf || !isMessageRecord(activeLeaf)) {
    throw new ClaudeProjectionRecoveryError(
      `Claude projection recovery active leaf ${activeLeafUuid} is not a durable graph message`
    )
  }
  if (input.manifestEntries.get(activeLeafUuid)?.included !== true) {
    throw new ClaudeProjectionRecoveryError(
      `Claude projection recovery active leaf ${activeLeafUuid} is not included by the active manifest`
    )
  }
  if (!input.visibleLayoutIds.has(activeLeafUuid)) {
    throw new ClaudeProjectionRecoveryError(
      `Claude projection recovery active leaf ${activeLeafUuid} is outside the visible active layout`
    )
  }
}

function validateRecipe(
  recipe: NonNullable<RestoredClaudeProjection["recipe"]>,
  byId: ReadonlyMap<string, ContextTranscriptRecord>,
  visibleLayoutIds: ReadonlySet<string>,
  snippedRecordIds: ReadonlySet<string>
): void {
  requireRecoveryIdentifier(recipe.id, "recipe id")
  const orderedIds = requireExactIdSequence(
    recipe.orderedRecordIds,
    `recipe ${recipe.id} ordered records`
  )
  const orderedSet = new Set(orderedIds)
  const excludedIds = requireExactIdSequence(
    recipe.excludedRecordIds,
    `recipe ${recipe.id} excluded records`,
    { allowEmpty: true }
  )
  const excludedSet = new Set(excludedIds)
  for (const recordId of orderedIds) {
    if (excludedSet.has(recordId)) {
      throw new ClaudeProjectionRecoveryError(
        `Claude recipe ${recipe.id} both includes and excludes ${recordId}`
      )
    }
    const record = requireRecord(byId, recordId, `recipe ${recipe.id}`)
    // A later durable Snip may remove a preserved graph fragment after this
    // recipe was written. The recipe remains an immutable compaction fact;
    // recovery accepts this one explicit global transform, but no other
    // omitted ordered record.
    if (
      !visibleLayoutIds.has(recordId) &&
      (!snippedRecordIds.has(recordId) || !isMessageRecord(record))
    ) {
      throw new ClaudeProjectionRecoveryError(
        `Claude recipe ${recipe.id} record ${recordId} is outside the active layout`
      )
    }
  }

  const requiredOrderedIds = [
    requireRecoveryIdentifier(recipe.boundaryRecordId, "recipe boundary id"),
    requireRecoveryIdentifier(recipe.summaryRecordId, "recipe summary id"),
    ...requireExactIdSequence(
      recipe.attachmentRecordIds,
      `recipe ${recipe.id} attachment records`,
      { allowEmpty: true }
    ),
    ...requireExactIdSequence(
      recipe.hookResultRecordIds,
      `recipe ${recipe.id} hook-result records`,
      { allowEmpty: true }
    ),
    ...(recipe.preservedSegment
      ? [
          requireRecoveryIdentifier(
            recipe.preservedSegment.headUuid,
            "recipe preserved head UUID"
          ),
          requireRecoveryIdentifier(
            recipe.preservedSegment.anchorUuid,
            "recipe preserved anchor UUID"
          ),
          requireRecoveryIdentifier(
            recipe.preservedSegment.tailUuid,
            "recipe preserved tail UUID"
          ),
        ]
      : []),
  ]
  for (const recordId of requiredOrderedIds) {
    if (!orderedSet.has(recordId)) {
      throw new ClaudeProjectionRecoveryError(
        `Claude recipe ${recipe.id} references ${recordId} outside its ordered record set`
      )
    }
  }

  // Provider-owned infrastructure is not a Snip target. Its absence is
  // always corruption, even when a preserved graph segment was legitimately
  // removed by a later durable Snip event.
  const requiredInfrastructureIds = [
    requireRecoveryIdentifier(recipe.boundaryRecordId, "recipe boundary id"),
    requireRecoveryIdentifier(recipe.summaryRecordId, "recipe summary id"),
    ...requireExactIdSequence(
      recipe.attachmentRecordIds,
      `recipe ${recipe.id} attachment records`,
      { allowEmpty: true }
    ),
    ...requireExactIdSequence(
      recipe.hookResultRecordIds,
      `recipe ${recipe.id} hook-result records`,
      { allowEmpty: true }
    ),
  ]
  for (const recordId of requiredInfrastructureIds) {
    if (!visibleLayoutIds.has(recordId)) {
      throw new ClaudeProjectionRecoveryError(
        `Claude recipe ${recipe.id} required infrastructure ${recordId} is outside the active layout`
      )
    }
  }
}

function collectSnippedRecordIds(
  graphRecords: readonly ContextTranscriptRecord[],
  boundaryRecords: readonly ContextTranscriptRecord[]
): Set<string> {
  const graphById = new Map(graphRecords.map((record) => [record.id, record]))
  const snipped = new Set<string>()
  for (const boundary of boundaryRecords) {
    if (boundary.kind !== "snip_boundary") {
      throw new ClaudeProjectionRecoveryError(
        `Claude projection recovery received non-Snip external record ${boundary.id}`
      )
    }
    for (const recordId of boundary.snipMetadata?.removedRecordIds || []) {
      requireRecoveryIdentifier(recordId, "Snip removed record id")
      const record = graphById.get(recordId)
      if (!record || !isMessageRecord(record)) {
        throw new ClaudeProjectionRecoveryError(
          `Claude projection recovery Snip boundary ${boundary.id} targets non-graph record ${recordId}`
        )
      }
      snipped.add(recordId)
    }
  }
  return snipped
}

function assertUniqueRecord(
  byId: Map<string, ContextTranscriptRecord>,
  record: ContextTranscriptRecord,
  source: string
): void {
  requireRecoveryIdentifier(record.id, `${source} record id`)
  if (byId.has(record.id)) {
    throw new ClaudeProjectionRecoveryError(
      `Claude projection recovery found duplicate record ${record.id} in ${source}`
    )
  }
  byId.set(record.id, record)
}

function requireExactIdSequence(
  ids: readonly string[],
  label: string,
  options?: { allowEmpty?: boolean }
): string[] {
  if (ids.length === 0 && !options?.allowEmpty) {
    throw new ClaudeProjectionRecoveryError(
      `Claude projection recovery requires non-empty ${label}`
    )
  }
  const exactIds = ids.map((id, index) =>
    requireRecoveryIdentifier(id, `${label}[${index}]`)
  )
  if (new Set(exactIds).size !== exactIds.length) {
    throw new ClaudeProjectionRecoveryError(
      `Claude projection recovery found duplicate ids in ${label}`
    )
  }
  return exactIds
}

function requireRecoveryIdentifier(value: unknown, label: string): string {
  try {
    return requireExactDurableIdentifier(value, label)
  } catch (error) {
    throw new ClaudeProjectionRecoveryError(
      `Claude projection recovery ${label} is invalid: ${(error as Error).message}`
    )
  }
}

function requireRecord(
  byId: ReadonlyMap<string, ContextTranscriptRecord>,
  recordId: string,
  owner: string
): ContextTranscriptRecord {
  const record = byId.get(recordId)
  if (!record) {
    throw new ClaudeProjectionRecoveryError(
      `Claude projection recovery cannot resolve ${owner} record ${recordId}`
    )
  }
  return record
}
