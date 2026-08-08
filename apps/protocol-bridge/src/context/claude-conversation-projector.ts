import { createHash, randomUUID } from "node:crypto"
import {
  ClaudeProjectionCapabilitySnapshot,
  ClaudeProjectionRecipe,
  ContentBlock,
  ContextMessageSource,
  ContextToolResultReplacementState,
  ContextTranscriptRecord,
  LooseMessageContent,
  ProjectedContextMessage,
  ProjectionExclusionReason,
  ProjectionManifest,
  ProjectionManifestEntry,
  isToolResultBlock,
  isToolUseBlock,
} from "./types"
import {
  isCompactBoundaryRecord,
  isMessageRecord,
  isMicrocompactBoundaryRecord,
  isSnipBoundaryRecord,
} from "./context-transcript-events"

export class ClaudeCheckpointCorruptError extends Error {
  constructor(
    readonly checkpointId: string,
    readonly missingRecordIds: readonly string[]
  ) {
    super(
      `Claude checkpoint ${checkpointId} references missing records: ${missingRecordIds.join(", ")}`
    )
    this.name = "ClaudeCheckpointCorruptError"
  }
}

/**
 * The bridge graph is the canonical Claude history.  A broken tool pair is a
 * graph invariant failure, not something a request-time projection may
 * reinterpret or repair.
 */
export class ClaudeToolPairIntegrityError extends Error {
  constructor(readonly detail: string) {
    super(`Invalid Claude tool projection: ${detail}`)
    this.name = "ClaudeToolPairIntegrityError"
  }
}

export interface ClaudeMicrocompactProjection {
  mode: "cached" | "time_based"
  clearedToolUseIds?: readonly string[]
  cacheEdits?: readonly Record<string, unknown>[]
}

export interface ClaudeConversationProjectionOptions {
  capability: ClaudeProjectionCapabilitySnapshot
  recipe?: ClaudeProjectionRecipe
  replacementState?: ContextToolResultReplacementState
  microcompact?: ClaudeMicrocompactProjection
}

export interface ClaudeConversationProjection {
  messages: ProjectedContextMessage[]
  manifest: ProjectionManifest
  pendingCacheEdits: readonly Record<string, unknown>[]
  activeLeafUuid?: string
}

/**
 * Claude-specific read model over the durable transcript graph. The projector
 * never mutates source records and never infers checkpoint membership from a
 * linear cutoff.
 */
export class ClaudeConversationProjector {
  project(
    records: readonly ContextTranscriptRecord[],
    options: ClaudeConversationProjectionOptions
  ): ClaudeConversationProjection {
    const byId = this.indexRecords(records)
    const excluded = new Map<string, ProjectionExclusionReason>()
    // Snip is a provider-neutral projection transform. It applies before a
    // Claude compact recipe selects its base/continuation window, otherwise a
    // recipe can silently resurrect graph records removed by a later Snip.
    const snipped = this.collectSnippedIds(records)
    const ordered = options.recipe
      ? this.resolveRecipe(records, byId, options.recipe, excluded, snipped)
      : this.resolveUncompacted(records, excluded, snipped)
    const replacementByToolUseId =
      options.replacementState?.replacementByToolUseId || {}
    const timeCleared = new Set(
      options.microcompact?.mode === "time_based"
        ? options.microcompact.clearedToolUseIds || []
        : []
    )

    const projected = ordered.flatMap((record) => {
      const message = this.projectRecord(
        record,
        options.capability,
        replacementByToolUseId,
        timeCleared
      )
      if (!message) {
        excluded.set(record.id, "internal_marker")
        return []
      }
      if (Array.isArray(message.content) && message.content.length === 0) {
        excluded.set(record.id, "provider_capability")
        return []
      }
      return [message]
    })
    this.assertToolPairs(projected)
    const includedIds = new Set(
      projected.flatMap((message) =>
        message.sourceUuid ? [message.sourceUuid] : []
      )
    )
    const manifestEntries: ProjectionManifestEntry[] = records.map(
      (record) => ({
        sourceUuid: record.id,
        included: includedIds.has(record.id),
        ...(excluded.has(record.id) ? { reason: excluded.get(record.id) } : {}),
      })
    )
    const capabilityHash = this.hashJson(options.capability)
    const generation =
      options.recipe?.id ||
      this.hashJson({
        records: projected.map((message) => message.sourceUuid),
      })
    const activeLeafUuid = this.resolveActiveLeaf(projected, byId)

    return {
      messages: projected,
      manifest: {
        provider: "claude",
        generation,
        sourceEntries: manifestEntries,
        toolCatalogHash: options.capability.toolCatalogHash,
        capabilityHash,
        ...(activeLeafUuid ? { activeLeafUuid } : {}),
      },
      pendingCacheEdits:
        options.microcompact?.mode === "cached"
          ? [...(options.microcompact.cacheEdits || [])]
          : [],
      activeLeafUuid,
    }
  }

  buildRecipe(input: {
    commitId: string
    createdAt?: number
    boundaryRecordId: string
    summaryRecordId: string
    orderedRecords: readonly ContextTranscriptRecord[]
    archivedRecords: readonly ContextTranscriptRecord[]
    attachmentRecordIds?: readonly string[]
    hookResultRecordIds?: readonly string[]
    capability: ClaudeProjectionCapabilitySnapshot
  }): ClaudeProjectionRecipe {
    const preserved = input.orderedRecords.filter(isMessageRecord)
    return {
      id: input.commitId || randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
      boundaryRecordId: input.boundaryRecordId,
      summaryRecordId: input.summaryRecordId,
      orderedRecordIds: input.orderedRecords.map((record) => record.id),
      attachmentRecordIds: [...(input.attachmentRecordIds || [])],
      hookResultRecordIds: [...(input.hookResultRecordIds || [])],
      excludedRecordIds: input.archivedRecords.map((record) => record.id),
      ...(preserved.length > 0
        ? {
            preservedSegment: {
              headUuid: preserved[0]!.id,
              anchorUuid:
                preserved.find((record) => record.logicalParentUuid)?.id ||
                preserved[0]!.id,
              tailUuid: preserved[preserved.length - 1]!.id,
            },
          }
        : {}),
      capability: {
        ...input.capability,
        betaFlags: [...input.capability.betaFlags],
      },
    }
  }

  private indexRecords(
    records: readonly ContextTranscriptRecord[]
  ): Map<string, ContextTranscriptRecord> {
    const byId = new Map<string, ContextTranscriptRecord>()
    for (const record of records) {
      if (byId.has(record.id)) {
        throw new Error(`Duplicate transcript UUID: ${record.id}`)
      }
      byId.set(record.id, record)
    }
    return byId
  }

  private resolveRecipe(
    records: readonly ContextTranscriptRecord[],
    byId: ReadonlyMap<string, ContextTranscriptRecord>,
    recipe: ClaudeProjectionRecipe,
    excluded: Map<string, ProjectionExclusionReason>,
    snipped: ReadonlySet<string>
  ): ContextTranscriptRecord[] {
    const orderedIds = this.normalizeRecipeIds(
      recipe.id,
      recipe.orderedRecordIds,
      "orderedRecordIds",
      false
    )
    const orderedSet = new Set(orderedIds)
    const excludedIds = this.normalizeRecipeIds(
      recipe.id,
      recipe.excludedRecordIds,
      "excludedRecordIds",
      true
    )
    const excludedSet = new Set(excludedIds)
    for (const id of orderedIds) {
      if (excludedSet.has(id)) {
        throw new Error(
          `Claude checkpoint ${recipe.id} both includes and excludes ${id}`
        )
      }
    }
    const required = new Set([
      recipe.boundaryRecordId,
      recipe.summaryRecordId,
      ...recipe.attachmentRecordIds,
      ...recipe.hookResultRecordIds,
      ...(recipe.preservedSegment
        ? [
            recipe.preservedSegment.headUuid,
            recipe.preservedSegment.anchorUuid,
            recipe.preservedSegment.tailUuid,
          ]
        : []),
    ])
    for (const id of required) {
      if (!orderedSet.has(id)) {
        throw new Error(
          `Claude checkpoint ${recipe.id} references ${id} outside orderedRecordIds`
        )
      }
    }
    const missing = [...required].filter(
      (id) => !byId.has(id) && !snipped.has(id)
    )
    if (missing.length > 0) {
      throw new ClaudeCheckpointCorruptError(recipe.id, missing)
    }
    const missingOrdered = orderedIds.filter(
      (id) => !byId.has(id) && !snipped.has(id)
    )
    if (missingOrdered.length > 0) {
      throw new ClaudeCheckpointCorruptError(recipe.id, missingOrdered)
    }
    const providerExcludedRequired = [...required].filter(
      (id) =>
        !snipped.has(id) &&
        byId.get(id)?.excludedFromProviderProjection === true
    )
    if (providerExcludedRequired.length > 0) {
      throw new Error(
        `Claude checkpoint ${recipe.id} references provider-excluded records: ` +
          providerExcludedRequired.join(", ")
      )
    }
    for (const id of excludedIds) {
      excluded.set(id, "checkpoint_excluded")
    }
    // A later Snip may remove a preserved graph row from the mounted read
    // model. The compact recipe stays immutable; only that explicitly
    // snipped source is absent from its base window.
    const base = orderedIds.flatMap((id) => {
      const record = byId.get(id)
      return record ? [record] : []
    })
    // The compact recipe owns only the explicit base window. A later graph
    // fragment is a continuation exactly when it belongs to neither the
    // ordered base nor the archived/excluded set. This set-difference rule is
    // stable across restart and does not infer chronology from timestamps,
    // content markers, or empty-message sentinels.
    const continuation = records.filter(
      (record) =>
        !orderedSet.has(record.id) &&
        (!excludedSet.has(record.id) || isSnipBoundaryRecord(record))
    )
    return [...base, ...continuation].filter((record) => {
      if (snipped.has(record.id)) {
        excluded.set(record.id, "snipped")
        return false
      }
      if (!record.excludedFromProviderProjection) return true
      excluded.set(record.id, "provider_exclusion")
      return false
    })
  }

  private normalizeRecipeIds(
    recipeId: string,
    ids: readonly string[],
    field: string,
    allowEmpty: boolean
  ): string[] {
    if (ids.length === 0 && !allowEmpty) {
      throw new Error(`Claude checkpoint ${recipeId} has no ${field}`)
    }
    const normalized = ids.map((id) => id.trim())
    if (normalized.some((id) => !id)) {
      throw new Error(`Claude checkpoint ${recipeId} has an empty ${field} id`)
    }
    if (new Set(normalized).size !== normalized.length) {
      throw new Error(
        `Claude checkpoint ${recipeId} has duplicate ${field} ids`
      )
    }
    return normalized
  }

  private resolveUncompacted(
    records: readonly ContextTranscriptRecord[],
    excluded: Map<string, ProjectionExclusionReason>,
    snipped: ReadonlySet<string>
  ): ContextTranscriptRecord[] {
    return records.filter((record) => {
      if (snipped.has(record.id)) {
        excluded.set(record.id, "snipped")
        return false
      }
      if (record.excludedFromProviderProjection) {
        excluded.set(record.id, "provider_exclusion")
        return false
      }
      return !snipped.has(record.id)
    })
  }

  private collectSnippedIds(
    records: readonly ContextTranscriptRecord[]
  ): Set<string> {
    const snipped = new Set<string>()
    for (const record of records) {
      if (!isSnipBoundaryRecord(record)) continue
      for (const id of record.snipMetadata?.removedRecordIds || []) {
        snipped.add(id)
      }
    }
    return snipped
  }

  private projectRecord(
    record: ContextTranscriptRecord,
    capability: ClaudeProjectionCapabilitySnapshot,
    replacementByToolUseId: Readonly<Record<string, string>>,
    timeCleared: ReadonlySet<string>
  ): ProjectedContextMessage | undefined {
    if (
      isCompactBoundaryRecord(record) ||
      isSnipBoundaryRecord(record) ||
      isMicrocompactBoundaryRecord(record)
    ) {
      return undefined
    }
    const content = this.cloneContent(record.content)
    const projectedContent: LooseMessageContent = Array.isArray(content)
      ? (content as ContentBlock[]).reduce<ContentBlock[]>((blocks, block) => {
          if (block.type === "thinking" && !capability.supportsThinking) {
            return blocks
          }
          if (block.type !== "tool_result") {
            blocks.push(block)
            return blocks
          }
          const replacement = replacementByToolUseId[block.tool_use_id]
          if (replacement !== undefined) {
            blocks.push({ ...block, content: replacement })
            return blocks
          }
          if (timeCleared.has(block.tool_use_id)) {
            blocks.push({
              ...block,
              content: "[Tool result cleared by time-based microcompact]",
            })
            return blocks
          }
          blocks.push(block)
          return blocks
        }, [])
      : content

    return {
      role: record.role,
      content: projectedContent,
      source: this.sourceForRecord(record),
      recordId: record.id,
      sourceUuid: record.id,
      ...(record.messageId || record.providerMessageId
        ? { messageId: record.messageId || record.providerMessageId }
        : {}),
      ...(record.isMeta ||
      (record.kind !== undefined && record.kind !== "message")
        ? { isMeta: true }
        : {}),
      ...(record.attachmentMetadata
        ? { attachmentKind: record.attachmentMetadata.kind }
        : {}),
    }
  }

  /**
   * Claude has no valid prompt representation for a missing, duplicate, or
   * orphaned tool result.  Keep this as an assertion over the immutable
   * projection: the durable graph must be repaired at its write boundary,
   * never by fabricating or deleting provider input here.
   */
  private assertToolPairs(messages: readonly ProjectedContextMessage[]): void {
    const calls = new Map<string, { source: string }>()
    const results = new Set<string>()

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const message = messages[messageIndex]!
      const source =
        message.sourceUuid || message.recordId || `message:${messageIndex}`

      if (message.role === "assistant") {
        const unresolved = [...calls.keys()].filter((id) => !results.has(id))
        if (unresolved.length > 0) {
          throw new ClaudeToolPairIntegrityError(
            `assistant ${source} follows unresolved tool_use ids: ${unresolved.join(", ")}`
          )
        }
      }

      if (!Array.isArray(message.content)) continue
      for (const block of message.content as ContentBlock[]) {
        if (isToolUseBlock(block)) {
          if (message.role !== "assistant") {
            throw new ClaudeToolPairIntegrityError(
              `tool_use ${block.id || "<empty>"} belongs to non-assistant ${source}`
            )
          }
          const rawToolUseId = typeof block.id === "string" ? block.id : ""
          const toolUseId =
            rawToolUseId && rawToolUseId === rawToolUseId.trim()
              ? rawToolUseId
              : ""
          if (!toolUseId) {
            throw new ClaudeToolPairIntegrityError(
              `assistant ${source} has a tool_use without an id`
            )
          }
          if (calls.has(toolUseId)) {
            const prior = calls.get(toolUseId)!
            throw new ClaudeToolPairIntegrityError(
              `duplicate tool_use ${toolUseId} in ${source}; first seen in ${prior.source}`
            )
          }
          calls.set(toolUseId, { source })
          continue
        }

        if (!isToolResultBlock(block)) continue
        if (message.role !== "user") {
          throw new ClaudeToolPairIntegrityError(
            `tool_result ${block.tool_use_id || "<empty>"} belongs to non-user ${source}`
          )
        }
        const rawToolUseId =
          typeof block.tool_use_id === "string" ? block.tool_use_id : ""
        const toolUseId =
          rawToolUseId && rawToolUseId === rawToolUseId.trim()
            ? rawToolUseId
            : ""
        if (!toolUseId) {
          throw new ClaudeToolPairIntegrityError(
            `user ${source} has a tool_result without a tool_use_id`
          )
        }
        const call = calls.get(toolUseId)
        if (!call) {
          throw new ClaudeToolPairIntegrityError(
            `tool_result ${toolUseId} in ${source} has no preceding tool_use`
          )
        }
        if (results.has(toolUseId)) {
          throw new ClaudeToolPairIntegrityError(
            `duplicate tool_result ${toolUseId} in ${source}; tool_use is in ${call.source}`
          )
        }
        results.add(toolUseId)
      }
    }

    const unresolved = [...calls.keys()].filter((id) => !results.has(id))
    if (unresolved.length > 0) {
      throw new ClaudeToolPairIntegrityError(
        `tool_use ids without committed tool_result: ${unresolved.join(", ")}`
      )
    }
  }

  private resolveActiveLeaf(
    messages: readonly ProjectedContextMessage[],
    recordsById: ReadonlyMap<string, ContextTranscriptRecord>
  ): string | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (!message.sourceUuid || message.content === "") continue
      const record = recordsById.get(message.sourceUuid)
      if (
        record &&
        isMessageRecord(record) &&
        !record.excludedFromProviderProjection
      ) {
        return message.sourceUuid
      }
    }
    return undefined
  }

  private sourceForRecord(
    record: ContextTranscriptRecord
  ): ContextMessageSource {
    switch (record.kind) {
      case "compact_boundary":
        return "boundary"
      case "compact_summary":
        return "summary"
      case "snip_boundary":
        return "snip"
      case "microcompact_boundary":
        return "microcompact"
      case "attachment":
        return "attachment"
      case "hook_result":
        return "hook"
      default:
        return "record"
    }
  }

  private cloneContent(
    content: ContextTranscriptRecord["content"]
  ): ContextTranscriptRecord["content"] {
    return structuredClone(content)
  }

  private hashJson(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex")
  }
}
