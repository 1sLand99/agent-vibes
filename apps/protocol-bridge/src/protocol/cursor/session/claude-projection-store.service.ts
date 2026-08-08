import { Injectable } from "@nestjs/common"
import { createHash } from "node:crypto"
import type { StatementSync } from "node:sqlite"
import {
  requireExactDurableIdentifier,
  requireOptionalExactDurableIdentifier,
} from "../../../context/durable-identifier"
import {
  isMessageRecord,
  isSnipBoundaryRecord,
} from "../../../context/context-transcript-events"
import type {
  ClaudeProjectionRecipe,
  ContextToolResultReplacementState,
  ContextTranscriptRecord,
  ProjectionExclusionReason,
  ProjectionManifest,
} from "../../../context/types"
import { PersistenceService } from "../../../persistence"
import {
  ClaudeProjectionMutationLog,
  type PersistedClaudeProjectionMutation,
  type PreparedClaudeProjectionMutationTail,
} from "./claude-projection-mutation-log.service"
import {
  INITIAL_PROVIDER_PROJECTION_REVISION,
  ProviderActiveHeadStore,
  ProviderProjectionHeadRevisionConflictError,
  type ProviderActiveHead,
} from "./provider-active-head.store"
import {
  assertProviderProjectionRef,
  providerProjectionStorageKey,
  type ProviderProjectionRef,
} from "./projection-owner"
import {
  SnipBoundaryStore,
  type AppendSessionSnipBoundary,
} from "./snip-boundary-store.service"
import { SubagentBranchStore } from "./subagent-branch-store.service"

export interface ClaudeProjectionRecord {
  ref: ProviderProjectionRef
  generation: number
  seq: number
  recordId: string
  recordKind: string
  sourceMessageUuid?: string
  /** Exact projection bytes. Tool-result mutation state never lives here. */
  payload: Buffer
  createdAt: number
}

interface AppendClaudeProjectionRecord {
  ref: ProviderProjectionRef
  generation: number
  recordId: string
  recordKind: string
  sourceMessageUuid?: string
  payload: Buffer
  createdAt?: number
}

/**
 * Immutable mutation tail paired with the exact provider-head revision that
 * observed its base watermark. It is prepared before any hot state changes
 * and is the only way a Claude head may advance its mutation watermark.
 */
export interface PreparedClaudeProjectionMutationDrain extends PreparedClaudeProjectionMutationTail {
  readonly expectedHeadRevision: number
}

export interface SyncClaudeProjectionInput {
  ref: ProviderProjectionRef
  /** Required provider-head CAS revision; 0 means no installed layout. */
  expectedHeadRevision: number
  generation: number
  /** Provider-owned records such as compact boundaries and summary messages. */
  syntheticRecords: readonly ContextTranscriptRecord[]
  /**
   * Exact active replay layout. Provider-filtered system markers remain in
   * this order with manifest reason `internal_marker`; message ids reference
   * the durable graph and synthetic ids reference immutable records here.
   */
  orderedRecordIds: readonly string[]
  recipe?: ClaudeProjectionRecipe
  /**
   * Prepared from the same head revision. A mutable replacement-state
   * snapshot is intentionally not accepted by this API.
   */
  mutationDrain: PreparedClaudeProjectionMutationDrain
  /** Exact Claude projection manifest for this layout generation. */
  manifest: ProjectionManifest
  /** Last durable owner-graph record observed when this layout was installed. */
  graphWatermarkUuid: string
  /**
   * Optional provider-neutral event installed in the same SQLite transaction
   * as this Claude active head. It is intentionally not a Claude synthetic
   * record; the layout only references its stable id.
   */
  appendSnipBoundary?: AppendSessionSnipBoundary
  updatedAt?: number
}

export interface ClaudeProjectionLayout {
  recordId: string
  orderedRecordIds: string[]
}

export interface RestoredClaudeProjection {
  ref: ProviderProjectionRef
  providerHeadRevision: number
  generation: number
  syntheticRecords: ContextTranscriptRecord[]
  layout: ClaudeProjectionLayout
  recipe?: ClaudeProjectionRecipe
  /** State materialized exactly through `mutationWatermarkSeq`. */
  replacementState: ContextToolResultReplacementState
  mutationWatermarkSeq: number
  manifest: ProjectionManifest
  graphWatermarkUuid: string
}

type ClaudeProjectionPayload =
  | { kind: "synthetic_record"; record: ContextTranscriptRecord }
  | { kind: "compaction_recipe"; recipe: ClaudeProjectionRecipe }
  | { kind: "projection_layout"; orderedRecordIds: string[] }
  | { kind: "projection_manifest"; manifest: ProjectionManifest }

interface ClaudeHeadMetadata {
  compactEpoch: number
  recipeId?: string
  layoutId: string
  manifestId: string
  graphWatermarkUuid: string
  mutationWatermarkSeq: number
}

const PROJECTION_EXCLUSION_REASONS: ReadonlySet<ProjectionExclusionReason> =
  new Set([
    "checkpoint_excluded",
    "snipped",
    "provider_exclusion",
    "incomplete_tool_use",
    "orphan_tool_result",
    "duplicate_tool_use",
    "provider_capability",
    "internal_marker",
    "ui_only",
  ])

function emptyReplacementState(): ContextToolResultReplacementState {
  return {
    seenToolUseIds: [],
    replacementByToolUseId: {},
    storedByToolUseId: {},
    records: [],
  }
}

/**
 * Storage for Claude-specific projection transforms. The immutable record
 * stream owns layouts, recipes, manifests and provider-created transcript
 * records. Tool-result replacement facts have a separate append-only log,
 * consumed only by the durable active-head watermark.
 */
@Injectable()
export class ClaudeProjectionStore {
  private stmtNextSeq?: StatementSync
  private stmtInsert?: StatementSync
  private stmtFindRecord?: StatementSync
  private stmtHasGraphRecord?: StatementSync
  private stmtHasSnipBoundary?: StatementSync

  constructor(
    private readonly persistence: PersistenceService,
    private readonly activeHeads: ProviderActiveHeadStore,
    private readonly snipBoundaryStore: SnipBoundaryStore,
    private readonly subagentBranches: SubagentBranchStore,
    private readonly mutationLog: ClaudeProjectionMutationLog
  ) {}

  /**
   * Capture the exact currently-unconsumed mutation tail. The caller must
   * install it with `sync` or commit it with `commitPreparedMutationDrain`;
   * no head API accepts a free-form watermark.
   */
  prepareMutationDrain(
    ref: ProviderProjectionRef
  ): PreparedClaudeProjectionMutationDrain {
    this.assertClaudeRef(ref, "prepareMutationDrain")
    const head = this.activeHeads.get(ref)
    const expectedHeadRevision =
      head?.revision ?? INITIAL_PROVIDER_PROJECTION_REVISION
    const baseMutationWatermarkSeq = head
      ? this.requireHeadMetadata(head, ref).mutationWatermarkSeq
      : 0
    const tail = this.mutationLog.prepareTail(ref, baseMutationWatermarkSeq)
    return this.freezeDrain({
      expectedHeadRevision,
      ...tail,
    })
  }

  /**
   * Build a detached replacement-state candidate from an exact immutable
   * drain. Callers never read the mutation log directly: this validates the
   * captured ref, head revision, base/target watermarks and byte-for-byte
   * tail before materializing all mutations through the target watermark.
   *
   * `sync` or `commitPreparedMutationDrain` must still consume this same
   * receipt before the caller publishes the candidate to hot state.
   */
  materializePreparedMutationDrain(
    drain: PreparedClaudeProjectionMutationDrain
  ): ContextToolResultReplacementState {
    const normalized = this.normalizeDrain(drain)
    const currentHead = this.activeHeads.get(normalized.ref)
    const currentMutationWatermark = this.requireCurrentHeadForSync(
      normalized.ref,
      normalized.expectedHeadRevision,
      currentHead
    )
    if (currentMutationWatermark !== normalized.baseMutationWatermarkSeq) {
      throw new ProviderProjectionHeadRevisionConflictError(
        normalized.ref,
        normalized.expectedHeadRevision
      )
    }
    this.mutationLog.assertPreparedTailCurrent(normalized)
    return (
      this.mutationLog.materializeThrough(
        normalized.ref,
        normalized.targetMutationWatermarkSeq
      ) ?? emptyReplacementState()
    )
  }

  /**
   * Persist one complete Claude read model and its prepared mutation tail in
   * a single writer transaction. The mutable hot state is never written.
   */
  sync(input: SyncClaudeProjectionInput): void {
    const normalized = this.normalizeSyncInput(input)
    this.persistence.runInImmediateTransaction(() => {
      const currentHead = this.activeHeads.get(normalized.ref)
      const currentMutationWatermark = this.requireCurrentHeadForSync(
        normalized.ref,
        normalized.expectedHeadRevision,
        currentHead
      )
      if (
        currentMutationWatermark !==
        normalized.mutationDrain.baseMutationWatermarkSeq
      ) {
        throw new ProviderProjectionHeadRevisionConflictError(
          normalized.ref,
          normalized.expectedHeadRevision
        )
      }
      this.mutationLog.assertPreparedTailCurrent(normalized.mutationDrain)

      if (normalized.appendSnipBoundary) {
        this.snipBoundaryStore.appendImmutable(normalized.appendSnipBoundary)
      }
      this.assertDurableLayoutSources(
        normalized.ref,
        normalized.orderedRecordIds,
        new Set(normalized.syntheticRecords.map((record) => record.id))
      )
      this.assertDurableGraphRecord(
        normalized.ref,
        normalized.graphWatermarkUuid,
        "graph watermark"
      )
      const activeLeafUuid = normalized.manifest.activeLeafUuid
      if (activeLeafUuid) {
        this.assertDurableGraphRecord(
          normalized.ref,
          activeLeafUuid,
          "active leaf"
        )
      }

      for (const record of normalized.syntheticRecords) {
        this.appendImmutable({
          ref: normalized.ref,
          generation: normalized.generation,
          recordId: `synthetic:${record.id}`,
          recordKind: "synthetic_record",
          sourceMessageUuid: record.id,
          payload: this.encodePayload({ kind: "synthetic_record", record }),
          createdAt: record.createdAt,
        })
      }

      const layoutBytes = this.encodePayload({
        kind: "projection_layout",
        orderedRecordIds: normalized.orderedRecordIds,
      })
      const layoutRecordId = `layout:${createHash("sha256")
        .update(layoutBytes)
        .digest("hex")}`
      this.appendImmutable({
        ref: normalized.ref,
        generation: normalized.generation,
        recordId: layoutRecordId,
        recordKind: "projection_layout",
        payload: layoutBytes,
        createdAt: normalized.updatedAt,
      })

      if (normalized.recipe) {
        this.appendImmutable({
          ref: normalized.ref,
          generation: normalized.generation,
          recordId: `recipe:${normalized.recipe.id}`,
          recordKind: "compaction_recipe",
          payload: this.encodePayload({
            kind: "compaction_recipe",
            recipe: normalized.recipe,
          }),
          createdAt: normalized.recipe.createdAt,
        })
      }

      const manifestPayload = this.encodePayload({
        kind: "projection_manifest",
        manifest: normalized.manifest,
      })
      const manifestRecordId = `manifest:${createHash("sha256")
        .update(manifestPayload)
        .digest("hex")}`
      this.appendImmutable({
        ref: normalized.ref,
        generation: normalized.generation,
        recordId: manifestRecordId,
        recordKind: "projection_manifest",
        payload: manifestPayload,
        createdAt: normalized.updatedAt,
      })

      this.activeHeads.installIfRevision(
        {
          ref: normalized.ref,
          revision: normalized.expectedHeadRevision + 1,
          headKind: normalized.recipe
            ? "compacted_projection"
            : "live_projection",
          headId: normalized.manifest.generation,
          metadata: {
            compactEpoch: normalized.generation,
            ...(normalized.recipe ? { recipeId: normalized.recipe.id } : {}),
            layoutId: layoutRecordId,
            manifestId: manifestRecordId,
            graphWatermarkUuid: normalized.graphWatermarkUuid,
            mutationWatermarkSeq:
              normalized.mutationDrain.targetMutationWatermarkSeq,
          },
          updatedAt: normalized.updatedAt,
        },
        normalized.expectedHeadRevision
      )
    })
  }

  /**
   * Advance only an already-installed Claude head through a prepared
   * mutation tail. Layout, manifest, recipe and graph-watermark coordinates
   * are copied byte-for-byte from the current durable head.
   */
  commitPreparedMutationDrain(
    drain: PreparedClaudeProjectionMutationDrain,
    updatedAt: number = Date.now()
  ): number {
    const normalized = this.normalizeDrain(drain)
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) {
      throw new Error(
        "ClaudeProjectionStore.commitPreparedMutationDrain: updatedAt must be a positive safe integer"
      )
    }
    return this.persistence.runInImmediateTransaction(() => {
      const head = this.activeHeads.get(normalized.ref)
      if (!head || normalized.expectedHeadRevision === 0) {
        throw new Error(
          "ClaudeProjectionStore.commitPreparedMutationDrain: an installed Claude head is required"
        )
      }
      if (head.revision !== normalized.expectedHeadRevision) {
        throw new ProviderProjectionHeadRevisionConflictError(
          normalized.ref,
          normalized.expectedHeadRevision
        )
      }
      const metadata = this.requireHeadMetadata(head, normalized.ref)
      if (
        metadata.mutationWatermarkSeq !== normalized.baseMutationWatermarkSeq
      ) {
        throw new ProviderProjectionHeadRevisionConflictError(
          normalized.ref,
          normalized.expectedHeadRevision
        )
      }
      this.mutationLog.assertPreparedTailCurrent(normalized)
      if (
        normalized.targetMutationWatermarkSeq ===
        normalized.baseMutationWatermarkSeq
      ) {
        return head.revision
      }

      const preservedMetadata = {
        ...(head.metadata ?? {}),
        compactEpoch: metadata.compactEpoch,
        ...(metadata.recipeId ? { recipeId: metadata.recipeId } : {}),
        layoutId: metadata.layoutId,
        manifestId: metadata.manifestId,
        graphWatermarkUuid: metadata.graphWatermarkUuid,
        mutationWatermarkSeq: normalized.targetMutationWatermarkSeq,
      }
      this.activeHeads.installIfRevision(
        {
          ref: normalized.ref,
          revision: head.revision + 1,
          headKind: head.headKind,
          headId: head.headId,
          metadata: preservedMetadata,
          updatedAt,
        },
        head.revision
      )
      return head.revision + 1
    })
  }

  restore(ref: ProviderProjectionRef): RestoredClaudeProjection | undefined {
    this.assertClaudeRef(ref, "restore")
    const head = this.activeHeads.get(ref)
    if (!head) return undefined
    const metadata = this.requireHeadMetadata(head, ref)

    const syntheticById = new Map<string, ContextTranscriptRecord>()
    const layoutsByRecordId = new Map<string, ClaudeProjectionLayout>()
    const recipesById = new Map<string, ClaudeProjectionRecipe>()
    const manifestsByRecordId = new Map<string, ProjectionManifest>()

    for (const record of this.list(ref)) {
      if (record.generation > metadata.compactEpoch) continue
      const payload = this.decodePayload(record)
      switch (payload.kind) {
        case "synthetic_record": {
          this.assertSyntheticRecordIdentifiers(
            payload.record,
            "stored synthetic record"
          )
          if (syntheticById.has(payload.record.id)) {
            throw new Error(
              `ClaudeProjectionStore.restore: duplicate synthetic record ${payload.record.id}`
            )
          }
          syntheticById.set(payload.record.id, structuredClone(payload.record))
          break
        }
        case "compaction_recipe":
          this.assertRecipeIdentifiers(payload.recipe, "stored recipe")
          if (recipesById.has(payload.recipe.id)) {
            throw new Error(
              `ClaudeProjectionStore.restore: duplicate recipe ${payload.recipe.id}`
            )
          }
          recipesById.set(payload.recipe.id, structuredClone(payload.recipe))
          break
        case "projection_layout":
          if (layoutsByRecordId.has(record.recordId)) {
            throw new Error(
              `ClaudeProjectionStore.restore: duplicate layout ${record.recordId}`
            )
          }
          layoutsByRecordId.set(record.recordId, {
            recordId: record.recordId,
            orderedRecordIds: this.requireOrderedRecordIds(
              payload.orderedRecordIds
            ),
          })
          break
        case "projection_manifest":
          this.assertManifestIdentifiers(payload.manifest, "stored manifest")
          if (manifestsByRecordId.has(record.recordId)) {
            throw new Error(
              `ClaudeProjectionStore.restore: duplicate manifest ${record.recordId}`
            )
          }
          manifestsByRecordId.set(
            record.recordId,
            structuredClone(payload.manifest)
          )
          break
      }
    }

    const recipe = metadata.recipeId
      ? recipesById.get(metadata.recipeId)
      : undefined
    if (metadata.recipeId && !recipe) {
      throw new Error(
        `ClaudeProjectionStore.restore: active recipe ${metadata.recipeId} is missing for ${providerProjectionStorageKey(ref)}`
      )
    }
    const layout = layoutsByRecordId.get(metadata.layoutId)
    if (!layout) {
      throw new Error(
        `ClaudeProjectionStore.restore: active layout ${metadata.layoutId} is missing for ${providerProjectionStorageKey(ref)}`
      )
    }
    const manifest = manifestsByRecordId.get(metadata.manifestId)
    if (!manifest) {
      throw new Error(
        `ClaudeProjectionStore.restore: active manifest ${metadata.manifestId} is missing for ${providerProjectionStorageKey(ref)}`
      )
    }
    if (manifest.provider !== "claude") {
      throw new Error(
        `ClaudeProjectionStore.restore: active manifest provider is not claude for ${providerProjectionStorageKey(ref)}`
      )
    }
    if (head.headId !== manifest.generation) {
      throw new Error(
        `ClaudeProjectionStore.restore: active head id does not match manifest generation for ${providerProjectionStorageKey(ref)}`
      )
    }
    for (const recordId of layout.orderedRecordIds) {
      const synthetic = syntheticById.has(recordId)
      const graph = this.hasOwnedGraphRecord(ref, recordId)
      const snip = this.hasOwnedSnipBoundary(ref, recordId)
      if (Number(synthetic) + Number(graph) + Number(snip) !== 1) {
        throw new Error(
          `ClaudeProjectionStore.restore: layout source ${recordId} is not uniquely durable for ${providerProjectionStorageKey(ref)}`
        )
      }
    }
    this.assertDurableGraphRecord(
      ref,
      metadata.graphWatermarkUuid,
      "graph watermark"
    )

    return {
      ref,
      providerHeadRevision: head.revision,
      generation: metadata.compactEpoch,
      syntheticRecords: layout.orderedRecordIds.flatMap((recordId) => {
        const record = syntheticById.get(recordId)
        return record ? [structuredClone(record)] : []
      }),
      layout: {
        recordId: layout.recordId,
        orderedRecordIds: [...layout.orderedRecordIds],
      },
      ...(recipe ? { recipe: structuredClone(recipe) } : {}),
      replacementState:
        this.mutationLog.materializeThrough(
          ref,
          metadata.mutationWatermarkSeq
        ) ?? emptyReplacementState(),
      mutationWatermarkSeq: metadata.mutationWatermarkSeq,
      manifest: structuredClone(manifest),
      graphWatermarkUuid: metadata.graphWatermarkUuid,
    }
  }

  list(
    ref: ProviderProjectionRef,
    generation?: number
  ): ClaudeProjectionRecord[] {
    this.assertClaudeRef(ref, "list")
    if (
      generation !== undefined &&
      (!Number.isSafeInteger(generation) || generation < 0)
    ) {
      throw new Error(
        "ClaudeProjectionStore.list: generation must be non-negative"
      )
    }
    const sql =
      generation === undefined
        ? `SELECT generation, seq, record_id, record_kind, source_message_uuid,
                  payload, created_at
             FROM session_claude_projection_records
            WHERE conversation_id = ? AND owner_key = ? AND local_key = ?
            ORDER BY generation ASC, seq ASC`
        : `SELECT generation, seq, record_id, record_kind, source_message_uuid,
                  payload, created_at
             FROM session_claude_projection_records
            WHERE conversation_id = ?
              AND owner_key = ?
              AND local_key = ?
              AND generation = ?
            ORDER BY seq ASC`
    const rows = (generation === undefined
      ? this.persistence
          .prepare(sql)
          .all(ref.owner.conversationId, ref.owner.ownerKey, ref.localKey)
      : this.persistence
          .prepare(sql)
          .all(
            ref.owner.conversationId,
            ref.owner.ownerKey,
            ref.localKey,
            generation
          )) as unknown as Array<{
      generation: number
      seq: number
      record_id: string
      record_kind: string
      source_message_uuid: string | null
      payload: Buffer | Uint8Array
      created_at: number
    }>
    let previousGeneration = -1
    let previousSeq = 0
    return rows.map((row) => {
      if (
        !Number.isSafeInteger(row.generation) ||
        row.generation < 0 ||
        !Number.isSafeInteger(row.seq) ||
        row.seq < 1 ||
        !Number.isSafeInteger(row.created_at) ||
        row.created_at < 1
      ) {
        throw new Error(
          `ClaudeProjectionStore.restore: invalid stored record sequence for ${providerProjectionStorageKey(ref)}`
        )
      }
      if (row.generation < previousGeneration) {
        throw new Error(
          `ClaudeProjectionStore.restore: stored generations are out of order for ${providerProjectionStorageKey(ref)}`
        )
      }
      if (row.generation !== previousGeneration) {
        previousGeneration = row.generation
        previousSeq = 0
      }
      if (row.seq <= previousSeq) {
        throw new Error(
          `ClaudeProjectionStore.restore: stored record sequence is not strictly ordered for ${providerProjectionStorageKey(ref)}`
        )
      }
      previousSeq = row.seq
      return {
        ref,
        generation: row.generation,
        seq: row.seq,
        recordId: requireExactDurableIdentifier(
          row.record_id,
          "ClaudeProjectionStore stored record id"
        ),
        recordKind: requireExactDurableIdentifier(
          row.record_kind,
          "ClaudeProjectionStore stored record kind"
        ),
        sourceMessageUuid: requireOptionalExactDurableIdentifier(
          row.source_message_uuid ?? undefined,
          "ClaudeProjectionStore stored source message UUID"
        ),
        payload: Buffer.from(row.payload),
        createdAt: row.created_at,
      }
    })
  }

  private normalizeSyncInput(input: SyncClaudeProjectionInput): {
    ref: ProviderProjectionRef
    expectedHeadRevision: number
    generation: number
    syntheticRecords: ContextTranscriptRecord[]
    orderedRecordIds: string[]
    recipe?: ClaudeProjectionRecipe
    mutationDrain: PreparedClaudeProjectionMutationDrain
    manifest: ProjectionManifest
    graphWatermarkUuid: string
    appendSnipBoundary?: AppendSessionSnipBoundary
    updatedAt: number
  } {
    this.assertClaudeRef(input.ref, "sync")
    if (
      !Number.isInteger(input.expectedHeadRevision) ||
      input.expectedHeadRevision < INITIAL_PROVIDER_PROJECTION_REVISION
    ) {
      throw new Error(
        "ClaudeProjectionStore.sync: expected provider head revision must be non-negative"
      )
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
      throw new Error(
        "ClaudeProjectionStore.sync: generation must be non-negative"
      )
    }
    const orderedRecordIds = this.requireOrderedRecordIds(
      input.orderedRecordIds
    )
    const syntheticRecords = this.requireSyntheticRecords(
      input.syntheticRecords,
      orderedRecordIds
    )
    const graphWatermarkUuid = requireExactDurableIdentifier(
      input.graphWatermarkUuid,
      "ClaudeProjectionStore.sync graph watermark UUID"
    )
    if (!input.manifest || input.manifest.provider !== "claude") {
      throw new Error(
        "ClaudeProjectionStore.sync: manifest provider must be claude"
      )
    }
    const manifest = structuredClone(input.manifest)
    this.assertManifestIdentifiers(manifest, "sync manifest")
    const manifestEntries = new Map<
      string,
      { included: boolean; reason?: ProjectionExclusionReason }
    >()
    for (const entry of manifest.sourceEntries) {
      const sourceUuid = requireExactDurableIdentifier(
        entry.sourceUuid,
        "ClaudeProjectionStore.sync manifest source UUID"
      )
      if (manifestEntries.has(sourceUuid)) {
        throw new Error(
          "ClaudeProjectionStore.sync: manifest source entries must have unique UUIDs"
        )
      }
      manifestEntries.set(sourceUuid, {
        included: entry.included,
        ...(entry.reason ? { reason: entry.reason } : {}),
      })
    }
    for (const recordId of orderedRecordIds) {
      const entry = manifestEntries.get(recordId)
      if (!entry || (!entry.included && entry.reason !== "internal_marker")) {
        throw new Error(
          `ClaudeProjectionStore.sync: active layout record ${recordId} is neither provider-visible nor an internal marker`
        )
      }
    }
    const activeLeafUuid = requireOptionalExactDurableIdentifier(
      manifest.activeLeafUuid,
      "ClaudeProjectionStore.sync active leaf UUID"
    )
    if (activeLeafUuid) {
      if (
        !orderedRecordIds.includes(activeLeafUuid) ||
        manifestEntries.get(activeLeafUuid)?.included !== true
      ) {
        throw new Error(
          `ClaudeProjectionStore.sync: active leaf ${activeLeafUuid} is outside the active layout`
        )
      }
      if (syntheticRecords.some((record) => record.id === activeLeafUuid)) {
        throw new Error(
          `ClaudeProjectionStore.sync: active leaf ${activeLeafUuid} is not a graph message`
        )
      }
    }
    const recipe = input.recipe ? structuredClone(input.recipe) : undefined
    if (recipe) this.assertRecipeIdentifiers(recipe, "sync recipe")
    const appendSnipBoundary = input.appendSnipBoundary
      ? this.normalizeSnipBoundary(
          input.appendSnipBoundary,
          input.ref,
          orderedRecordIds,
          manifestEntries
        )
      : undefined
    const updatedAt = input.updatedAt ?? Date.now()
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) {
      throw new Error(
        "ClaudeProjectionStore.sync: updatedAt must be a positive safe integer"
      )
    }
    const mutationDrain = this.normalizeDrain(input.mutationDrain)
    if (
      providerProjectionStorageKey(mutationDrain.ref) !==
      providerProjectionStorageKey(input.ref)
    ) {
      throw new Error(
        "ClaudeProjectionStore.sync: mutation drain belongs to a different projection"
      )
    }
    if (mutationDrain.expectedHeadRevision !== input.expectedHeadRevision) {
      throw new Error(
        "ClaudeProjectionStore.sync: mutation drain was prepared from a different provider-head revision"
      )
    }
    return {
      ref: input.ref,
      expectedHeadRevision: input.expectedHeadRevision,
      generation: input.generation,
      syntheticRecords,
      orderedRecordIds,
      ...(recipe ? { recipe } : {}),
      mutationDrain,
      manifest,
      graphWatermarkUuid,
      ...(appendSnipBoundary ? { appendSnipBoundary } : {}),
      updatedAt,
    }
  }

  private normalizeDrain(
    drain: PreparedClaudeProjectionMutationDrain
  ): PreparedClaudeProjectionMutationDrain {
    if (!drain || typeof drain !== "object" || Array.isArray(drain)) {
      throw new Error("ClaudeProjectionStore: mutation drain must be an object")
    }
    this.assertClaudeRef(drain.ref, "mutation drain")
    if (
      !Number.isSafeInteger(drain.expectedHeadRevision) ||
      drain.expectedHeadRevision < INITIAL_PROVIDER_PROJECTION_REVISION
    ) {
      throw new Error(
        "ClaudeProjectionStore: mutation drain expected head revision must be non-negative"
      )
    }
    for (const [name, value] of [
      ["base", drain.baseMutationWatermarkSeq],
      ["target", drain.targetMutationWatermarkSeq],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          `ClaudeProjectionStore: mutation drain ${name} watermark must be a non-negative safe integer`
        )
      }
    }
    if (drain.targetMutationWatermarkSeq < drain.baseMutationWatermarkSeq) {
      throw new Error(
        "ClaudeProjectionStore: mutation drain target watermark precedes its base"
      )
    }
    if (!Array.isArray(drain.mutations)) {
      throw new Error(
        "ClaudeProjectionStore: mutation drain mutations must be an array"
      )
    }
    return this.freezeDrain({
      ref: drain.ref,
      expectedHeadRevision: drain.expectedHeadRevision,
      baseMutationWatermarkSeq: drain.baseMutationWatermarkSeq,
      targetMutationWatermarkSeq: drain.targetMutationWatermarkSeq,
      mutations: (
        drain.mutations as readonly PersistedClaudeProjectionMutation[]
      ).map((mutation) =>
        structuredClone<PersistedClaudeProjectionMutation>(mutation)
      ),
    })
  }

  private freezeDrain(input: {
    ref: ProviderProjectionRef
    expectedHeadRevision: number
    baseMutationWatermarkSeq: number
    targetMutationWatermarkSeq: number
    mutations: readonly PersistedClaudeProjectionMutation[]
  }): PreparedClaudeProjectionMutationDrain {
    const owner =
      input.ref.owner.kind === "main"
        ? Object.freeze({ ...input.ref.owner })
        : Object.freeze({
            ...input.ref.owner,
            forkLineage: Object.freeze([...input.ref.owner.forkLineage]),
          })
    const ref = Object.freeze({ ...input.ref, owner })
    return Object.freeze({
      ref,
      expectedHeadRevision: input.expectedHeadRevision,
      baseMutationWatermarkSeq: input.baseMutationWatermarkSeq,
      targetMutationWatermarkSeq: input.targetMutationWatermarkSeq,
      mutations: Object.freeze(
        input.mutations.map((mutation) =>
          Object.freeze(structuredClone(mutation))
        )
      ),
    })
  }

  private normalizeSnipBoundary(
    boundary: AppendSessionSnipBoundary,
    ref: ProviderProjectionRef,
    orderedRecordIds: readonly string[],
    manifestEntries: ReadonlyMap<
      string,
      { included: boolean; reason?: ProjectionExclusionReason }
    >
  ): AppendSessionSnipBoundary {
    if (ref.owner.kind !== "main") {
      throw new Error(
        "ClaudeProjectionStore.sync: child projection cannot append a main-owned Snip boundary"
      )
    }
    if (boundary.conversationId !== ref.owner.conversationId) {
      throw new Error(
        "ClaudeProjectionStore.sync: Snip boundary conversation does not match the active projection"
      )
    }
    const id = requireExactDurableIdentifier(
      boundary.id,
      "ClaudeProjectionStore.sync Snip boundary id"
    )
    if (!orderedRecordIds.includes(id)) {
      throw new Error(
        "ClaudeProjectionStore.sync: appended Snip boundary is absent from the active layout"
      )
    }
    const manifestEntry = manifestEntries.get(id)
    if (
      !manifestEntry ||
      manifestEntry.included ||
      manifestEntry.reason !== "internal_marker"
    ) {
      throw new Error(
        "ClaudeProjectionStore.sync: appended Snip boundary must be a provider-filtered internal marker"
      )
    }
    return {
      conversationId: boundary.conversationId,
      id,
      afterGraphUuid: requireExactDurableIdentifier(
        boundary.afterGraphUuid,
        "ClaudeProjectionStore.sync Snip after graph UUID"
      ),
      removedRecordIds: boundary.removedRecordIds.map((recordId) =>
        requireExactDurableIdentifier(
          recordId,
          "ClaudeProjectionStore.sync Snip removed record id"
        )
      ),
      trigger: boundary.trigger,
      ...(boundary.reason !== undefined ? { reason: boundary.reason } : {}),
      createdAt: boundary.createdAt,
    }
  }

  private requireCurrentHeadForSync(
    ref: ProviderProjectionRef,
    expectedRevision: number,
    currentHead: ProviderActiveHead | undefined
  ): number {
    if (expectedRevision === INITIAL_PROVIDER_PROJECTION_REVISION) {
      if (currentHead) {
        throw new ProviderProjectionHeadRevisionConflictError(
          ref,
          expectedRevision
        )
      }
      return 0
    }
    if (!currentHead || currentHead.revision !== expectedRevision) {
      throw new ProviderProjectionHeadRevisionConflictError(
        ref,
        expectedRevision
      )
    }
    return this.requireHeadMetadata(currentHead, ref).mutationWatermarkSeq
  }

  private requireHeadMetadata(
    head: ProviderActiveHead,
    ref: ProviderProjectionRef
  ): ClaudeHeadMetadata {
    if (
      head.headKind !== "live_projection" &&
      head.headKind !== "compacted_projection"
    ) {
      throw new Error(
        `ClaudeProjectionStore.restore: invalid active head kind for ${providerProjectionStorageKey(ref)}`
      )
    }
    const metadata = head.metadata
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error(
        `ClaudeProjectionStore.restore: active head has no metadata for ${providerProjectionStorageKey(ref)}`
      )
    }
    const compactEpoch = metadata.compactEpoch
    if (
      typeof compactEpoch !== "number" ||
      !Number.isSafeInteger(compactEpoch) ||
      compactEpoch < 0
    ) {
      throw new Error(
        `ClaudeProjectionStore.restore: active head has no compact epoch for ${providerProjectionStorageKey(ref)}`
      )
    }
    const mutationWatermarkSeq = metadata.mutationWatermarkSeq
    if (
      typeof mutationWatermarkSeq !== "number" ||
      !Number.isSafeInteger(mutationWatermarkSeq) ||
      mutationWatermarkSeq < 0
    ) {
      throw new Error(
        `ClaudeProjectionStore.restore: active head has no mutation watermark for ${providerProjectionStorageKey(ref)}`
      )
    }
    const layoutId = requireExactDurableIdentifier(
      metadata.layoutId,
      "ClaudeProjectionStore.restore active layout id"
    )
    const manifestId = requireExactDurableIdentifier(
      metadata.manifestId,
      "ClaudeProjectionStore.restore active manifest id"
    )
    const graphWatermarkUuid = requireExactDurableIdentifier(
      metadata.graphWatermarkUuid,
      "ClaudeProjectionStore.restore graph watermark UUID"
    )
    const recipeId = requireOptionalExactDurableIdentifier(
      metadata.recipeId,
      "ClaudeProjectionStore.restore active recipe id"
    )
    if (head.headKind === "compacted_projection" && !recipeId) {
      throw new Error(
        `ClaudeProjectionStore.restore: compacted active head has no recipe for ${providerProjectionStorageKey(ref)}`
      )
    }
    if (head.headKind === "live_projection" && recipeId !== undefined) {
      throw new Error(
        `ClaudeProjectionStore.restore: live active head unexpectedly has a recipe for ${providerProjectionStorageKey(ref)}`
      )
    }
    return {
      compactEpoch,
      ...(recipeId ? { recipeId } : {}),
      layoutId,
      manifestId,
      graphWatermarkUuid,
      mutationWatermarkSeq,
    }
  }

  private nextSeq(ref: ProviderProjectionRef, generation: number): number {
    const row = (this.stmtNextSeq ??= this.persistence.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM session_claude_projection_records
        WHERE conversation_id = ?
          AND owner_key = ?
          AND local_key = ?
          AND generation = ?`
    )).get(
      ref.owner.conversationId,
      ref.owner.ownerKey,
      ref.localKey,
      generation
    ) as { next_seq?: number } | undefined
    const next = row?.next_seq
    if (!Number.isSafeInteger(next) || !next || next < 1) {
      throw new Error(
        `ClaudeProjectionStore: cannot allocate record sequence for ${providerProjectionStorageKey(ref)}`
      )
    }
    return next
  }

  private appendImmutable(
    record: AppendClaudeProjectionRecord
  ): ClaudeProjectionRecord {
    this.assertRecord(record)
    const existing = (this.stmtFindRecord ??= this.persistence.prepare(
      `SELECT generation, seq, record_kind, source_message_uuid, payload,
              created_at
         FROM session_claude_projection_records
        WHERE conversation_id = ?
          AND owner_key = ?
          AND local_key = ?
          AND record_id = ?
        LIMIT 1`
    )).get(
      record.ref.owner.conversationId,
      record.ref.owner.ownerKey,
      record.ref.localKey,
      record.recordId
    ) as
      | {
          generation: number
          seq: number
          record_kind: string
          source_message_uuid: string | null
          payload: Buffer | Uint8Array
          created_at: number
        }
      | undefined
    if (!existing) return this.insertImmutable(record)

    if (
      !Number.isSafeInteger(existing.generation) ||
      existing.generation < 0 ||
      !Number.isSafeInteger(existing.seq) ||
      existing.seq < 1 ||
      !Number.isSafeInteger(existing.created_at) ||
      existing.created_at < 1
    ) {
      throw new Error(
        `ClaudeProjectionStore: immutable record ${record.recordId} has invalid stored metadata`
      )
    }
    const existingRecordKind = requireExactDurableIdentifier(
      existing.record_kind,
      "ClaudeProjectionStore stored immutable record kind"
    )
    const existingSourceMessageUuid = requireOptionalExactDurableIdentifier(
      existing.source_message_uuid ?? undefined,
      "ClaudeProjectionStore stored immutable source message UUID"
    )
    const existingPayload = Buffer.from(existing.payload)
    if (
      existingRecordKind !== record.recordKind ||
      existingSourceMessageUuid !== record.sourceMessageUuid ||
      !existingPayload.equals(Buffer.from(record.payload))
    ) {
      throw new Error(
        `ClaudeProjectionStore: immutable record collision ${providerProjectionStorageKey(record.ref)}/${record.recordId}`
      )
    }
    return {
      ref: record.ref,
      generation: existing.generation,
      seq: existing.seq,
      recordId: record.recordId,
      recordKind: existingRecordKind,
      ...(existingSourceMessageUuid
        ? { sourceMessageUuid: existingSourceMessageUuid }
        : {}),
      payload: existingPayload,
      createdAt: existing.created_at,
    }
  }

  private insertImmutable(
    record: AppendClaudeProjectionRecord
  ): ClaudeProjectionRecord {
    const seq = this.nextSeq(record.ref, record.generation)
    const createdAt = record.createdAt ?? Date.now()
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
      throw new Error(
        "ClaudeProjectionStore.append: createdAt must be a positive safe integer"
      )
    }
    ;(this.stmtInsert ??= this.persistence.prepare(
      `INSERT INTO session_claude_projection_records (
         conversation_id, owner_key, local_key, generation, seq, record_id,
         record_kind, source_message_uuid, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )).run(
      record.ref.owner.conversationId,
      record.ref.owner.ownerKey,
      record.ref.localKey,
      record.generation,
      seq,
      record.recordId,
      record.recordKind,
      record.sourceMessageUuid ?? null,
      Buffer.from(record.payload),
      createdAt
    )
    return {
      ref: record.ref,
      generation: record.generation,
      seq,
      recordId: record.recordId,
      recordKind: record.recordKind,
      ...(record.sourceMessageUuid
        ? { sourceMessageUuid: record.sourceMessageUuid }
        : {}),
      payload: Buffer.from(record.payload),
      createdAt,
    }
  }

  private encodePayload(payload: ClaudeProjectionPayload): Buffer {
    return Buffer.from(JSON.stringify(payload), "utf8")
  }

  private decodePayload(
    record: ClaudeProjectionRecord
  ): ClaudeProjectionPayload {
    let parsed: unknown
    try {
      parsed = JSON.parse(record.payload.toString("utf8"))
    } catch (error) {
      throw new Error(
        `ClaudeProjectionStore: invalid payload ${record.recordId}: ${(error as Error).message}`
      )
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `ClaudeProjectionStore: invalid payload shape ${record.recordId}`
      )
    }
    const kind = (parsed as { kind?: unknown }).kind
    if (
      kind !== "synthetic_record" &&
      kind !== "compaction_recipe" &&
      kind !== "projection_layout" &&
      kind !== "projection_manifest"
    ) {
      throw new Error(
        `ClaudeProjectionStore: unknown payload kind ${String(kind)} for ${record.recordId}`
      )
    }
    return parsed as ClaudeProjectionPayload
  }

  private assertManifestIdentifiers(
    manifest: ProjectionManifest,
    label: string
  ): void {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(`ClaudeProjectionStore: ${label} must be an object`)
    }
    if (manifest.provider !== "claude") {
      throw new Error(`ClaudeProjectionStore: ${label} provider must be claude`)
    }
    requireExactDurableIdentifier(
      manifest.generation,
      `ClaudeProjectionStore ${label} generation`
    )
    requireExactDurableIdentifier(
      manifest.toolCatalogHash,
      `ClaudeProjectionStore ${label} tool catalog hash`
    )
    requireExactDurableIdentifier(
      manifest.capabilityHash,
      `ClaudeProjectionStore ${label} capability hash`
    )
    if (!Array.isArray(manifest.sourceEntries)) {
      throw new Error(
        `ClaudeProjectionStore: ${label} source entries must be an array`
      )
    }
    const sourceIds = new Set<string>()
    for (const [index, entry] of manifest.sourceEntries.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `ClaudeProjectionStore: ${label} source entry ${index} must be an object`
        )
      }
      const sourceUuid = requireExactDurableIdentifier(
        entry.sourceUuid,
        `ClaudeProjectionStore ${label} source entry ${index} UUID`
      )
      if (sourceIds.has(sourceUuid)) {
        throw new Error(
          `ClaudeProjectionStore: ${label} repeats source UUID ${sourceUuid}`
        )
      }
      sourceIds.add(sourceUuid)
      if (typeof entry.included !== "boolean") {
        throw new Error(
          `ClaudeProjectionStore: ${label} source entry ${index} included must be boolean`
        )
      }
      if (
        entry.reason !== undefined &&
        !PROJECTION_EXCLUSION_REASONS.has(entry.reason)
      ) {
        throw new Error(
          `ClaudeProjectionStore: ${label} source entry ${index} reason is invalid`
        )
      }
    }
    requireOptionalExactDurableIdentifier(
      manifest.activeLeafUuid,
      `ClaudeProjectionStore ${label} active leaf UUID`
    )
  }

  private assertRecipeIdentifiers(
    recipe: ClaudeProjectionRecipe,
    label: string
  ): void {
    if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
      throw new Error(`ClaudeProjectionStore: ${label} must be an object`)
    }
    requireExactDurableIdentifier(
      recipe.id,
      `ClaudeProjectionStore ${label} id`
    )
    if (!Number.isSafeInteger(recipe.createdAt) || recipe.createdAt <= 0) {
      throw new Error(
        `ClaudeProjectionStore: ${label} createdAt must be positive`
      )
    }
    requireExactDurableIdentifier(
      recipe.boundaryRecordId,
      `ClaudeProjectionStore ${label} boundary record id`
    )
    requireExactDurableIdentifier(
      recipe.summaryRecordId,
      `ClaudeProjectionStore ${label} summary record id`
    )
    this.requireIdentifierArray(
      recipe.orderedRecordIds,
      `ClaudeProjectionStore ${label} ordered record ids`
    )
    this.requireIdentifierArray(
      recipe.attachmentRecordIds,
      `ClaudeProjectionStore ${label} attachment record ids`
    )
    this.requireIdentifierArray(
      recipe.hookResultRecordIds,
      `ClaudeProjectionStore ${label} hook-result record ids`
    )
    this.requireIdentifierArray(
      recipe.excludedRecordIds,
      `ClaudeProjectionStore ${label} excluded record ids`
    )
    if (recipe.preservedSegment) {
      requireExactDurableIdentifier(
        recipe.preservedSegment.headUuid,
        `ClaudeProjectionStore ${label} preserved head UUID`
      )
      requireExactDurableIdentifier(
        recipe.preservedSegment.anchorUuid,
        `ClaudeProjectionStore ${label} preserved anchor UUID`
      )
      requireExactDurableIdentifier(
        recipe.preservedSegment.tailUuid,
        `ClaudeProjectionStore ${label} preserved tail UUID`
      )
    }
  }

  private assertSyntheticRecordIdentifiers(
    record: ContextTranscriptRecord,
    label: string
  ): void {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`ClaudeProjectionStore: ${label} must be an object`)
    }
    requireExactDurableIdentifier(
      record.id,
      `ClaudeProjectionStore ${label} id`
    )
  }

  private requireIdentifierArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) {
      throw new Error(`ClaudeProjectionStore: ${label} must be an array`)
    }
    return value.map((entry, index) =>
      requireExactDurableIdentifier(entry, `${label}[${index}]`)
    )
  }

  private assertRecord(record: AppendClaudeProjectionRecord): void {
    this.assertClaudeRef(record.ref, "append")
    if (!Number.isSafeInteger(record.generation) || record.generation < 0) {
      throw new Error(
        "ClaudeProjectionStore.append: generation must be non-negative"
      )
    }
    requireExactDurableIdentifier(
      record.recordId,
      "ClaudeProjectionStore.append record id"
    )
    requireExactDurableIdentifier(
      record.recordKind,
      "ClaudeProjectionStore.append record kind"
    )
    requireOptionalExactDurableIdentifier(
      record.sourceMessageUuid,
      "ClaudeProjectionStore.append source message UUID"
    )
    if (!Buffer.isBuffer(record.payload)) {
      throw new Error("ClaudeProjectionStore.append: payload must be a Buffer")
    }
  }

  private requireSyntheticRecords(
    records: readonly ContextTranscriptRecord[],
    orderedRecordIds: readonly string[]
  ): ContextTranscriptRecord[] {
    if (!Array.isArray(records)) {
      throw new Error(
        "ClaudeProjectionStore.sync: synthetic records must be an array"
      )
    }
    const typedRecords = records as readonly ContextTranscriptRecord[]
    const exactRecords: ContextTranscriptRecord[] = []
    const seen = new Set<string>()
    for (const record of typedRecords) {
      const clone = structuredClone<ContextTranscriptRecord>(record)
      const recordId = requireOptionalExactDurableIdentifier(
        clone.id,
        "ClaudeProjectionStore.sync synthetic record id"
      )
      if (!recordId || isMessageRecord(clone) || isSnipBoundaryRecord(clone)) {
        throw new Error(
          "ClaudeProjectionStore.sync: synthetic records must be non-message provider-owned records with an id"
        )
      }
      if (seen.has(recordId)) {
        throw new Error(
          `ClaudeProjectionStore.sync: duplicate synthetic record ${recordId}`
        )
      }
      if (!orderedRecordIds.includes(recordId)) {
        throw new Error(
          `ClaudeProjectionStore.sync: synthetic record ${recordId} is absent from the active layout`
        )
      }
      seen.add(recordId)
      exactRecords.push(clone)
    }
    return exactRecords
  }

  /**
   * Layout ids are not opaque strings: each must resolve to exactly one
   * durable source. Synthetic ids are owned by this immutable Claude layout;
   * every other id must already be the current owner's graph row or a main
   * Snip event.
   */
  private assertDurableLayoutSources(
    ref: ProviderProjectionRef,
    orderedRecordIds: readonly string[],
    syntheticRecordIds: ReadonlySet<string>
  ): void {
    for (const recordId of orderedRecordIds) {
      const synthetic = syntheticRecordIds.has(recordId)
      const graph = this.hasOwnedGraphRecord(ref, recordId)
      const snip = this.hasOwnedSnipBoundary(ref, recordId)
      if (Number(synthetic) + Number(graph) + Number(snip) !== 1) {
        throw new Error(
          `ClaudeProjectionStore.sync: layout source ${recordId} is not uniquely durable for ${providerProjectionStorageKey(ref)}`
        )
      }
    }
  }

  private assertDurableGraphRecord(
    ref: ProviderProjectionRef,
    recordId: string,
    label: string
  ): void {
    if (!this.hasOwnedGraphRecord(ref, recordId)) {
      throw new Error(
        `ClaudeProjectionStore.sync: ${label} ${recordId} is absent from the durable graph for ${providerProjectionStorageKey(ref)}`
      )
    }
  }

  private hasOwnedGraphRecord(
    ref: ProviderProjectionRef,
    recordId: string
  ): boolean {
    const exists = Boolean(
      (this.stmtHasGraphRecord ??= this.persistence.prepare(
        `SELECT 1
           FROM session_messages
          WHERE conversation_id = ? AND uuid = ?
          LIMIT 1`
      )).get(ref.owner.conversationId, recordId)
    )
    if (!exists) return false
    this.subagentBranches.verifyProjectionGraphRecord(ref.owner, recordId)
    return true
  }

  private hasOwnedSnipBoundary(
    ref: ProviderProjectionRef,
    recordId: string
  ): boolean {
    const exists = Boolean(
      (this.stmtHasSnipBoundary ??= this.persistence.prepare(
        `SELECT 1
           FROM session_snip_boundaries
          WHERE conversation_id = ? AND boundary_id = ?
          LIMIT 1`
      )).get(ref.owner.conversationId, recordId)
    )
    if (exists && ref.owner.kind !== "main") {
      throw new Error(
        `ClaudeProjectionStore: child projection cannot consume main-owned Snip boundary ${recordId}`
      )
    }
    return exists
  }

  private assertClaudeRef(ref: ProviderProjectionRef, operation: string): void {
    assertProviderProjectionRef(ref, `ClaudeProjectionStore.${operation}`)
    if (ref.provider !== "claude") {
      throw new Error(
        `ClaudeProjectionStore.${operation}: ref provider must be claude`
      )
    }
    this.subagentBranches.verifyProjectionOwner(ref.owner)
  }

  private requireOrderedRecordIds(ids: readonly string[]): string[] {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error(
        "ClaudeProjectionStore.sync: active projection layout must not be empty"
      )
    }
    const exactIds = ids.map((id) =>
      requireExactDurableIdentifier(
        id,
        "ClaudeProjectionStore.sync active projection layout record id"
      )
    )
    if (new Set(exactIds).size !== exactIds.length) {
      throw new Error(
        "ClaudeProjectionStore.sync: active projection layout contains duplicate record ids"
      )
    }
    return exactIds
  }
}
