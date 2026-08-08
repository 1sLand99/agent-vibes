import { Injectable } from "@nestjs/common"
import type {
  ContextSessionMemoryEntry,
  SessionMemorySourceKind,
  SessionMemorySummaryLike,
} from "./types"

type SessionMemoryProvenance = {
  sourceToolUseId: unknown
  sourceRecordUuid: unknown
  sourceKind: unknown
}

/**
 * Session memory is valid only when it can point to one accepted terminal
 * delivery. Do not loosen this at projection time: a missing or unsupported
 * source is a corrupt durable relation, not an older shape worth retaining.
 */
export function assertTerminalSessionMemoryProvenance(
  entry: SessionMemoryProvenance,
  label = "Session memory"
): asserts entry is {
  sourceToolUseId: string
  sourceRecordUuid: string
  sourceKind: SessionMemorySourceKind
} {
  assertExactIdentifier(entry.sourceToolUseId, `${label}.sourceToolUseId`)
  assertExactIdentifier(entry.sourceRecordUuid, `${label}.sourceRecordUuid`)
  if (
    entry.sourceKind !== "tool_result" &&
    entry.sourceKind !== "control_notification"
  ) {
    throw new Error(
      `${label}.sourceKind must be tool_result or control_notification`
    )
  }
}

function assertExactIdentifier(
  value: unknown,
  label: string
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /\s/.test(value)
  ) {
    throw new Error(`${label} must be a non-empty whitespace-free identifier`)
  }
}

/**
 * Stores explicit, structured session-memory events.
 *
 * Conversation compaction owns the one provider summary for archived
 * transcript. It must not derive a second memory representation by scanning
 * text. Callers create memory only when they own a structured event (for
 * example, a completed sub-agent), then use this service for identity-based
 * retention and model projection.
 */
@Injectable()
export class SessionMemoryService {
  private readonly MAX_MEMORY_ENTRIES = 64

  /**
   * Merge event revisions by their immutable event id. Equal wording is never
   * evidence of identity; all identity comes from the structured event.
   */
  mergeEntries(
    existing: readonly ContextSessionMemoryEntry[] | undefined,
    additions: readonly ContextSessionMemoryEntry[]
  ): ContextSessionMemoryEntry[] {
    const byId = new Map<string, ContextSessionMemoryEntry>()

    for (const entry of [...(existing || []), ...additions]) {
      this.assertExplicitEntry(entry)
      const previous = byId.get(entry.id)
      if (previous) {
        this.assertImmutableEventProvenance(entry, previous)
      }
      if (!previous || this.isNewerRevision(entry, previous)) {
        byId.set(entry.id, { ...entry })
      }
    }

    // Capacity is a deterministic event-retention bound, never a relevance
    // ranking. Preserve causal order for the model-facing attachment.
    return [...byId.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(-this.MAX_MEMORY_ENTRIES)
  }

  toAttachmentSummaries(
    entries: readonly ContextSessionMemoryEntry[] | undefined
  ): SessionMemorySummaryLike[] {
    return (entries || []).map((entry) => {
      this.assertExplicitEntry(entry)
      return {
        kind: entry.kind,
        text: entry.text,
        createdAt: entry.createdAt,
        weight: entry.weight,
        sourceToolUseId: entry.sourceToolUseId,
        sourceRecordUuid: entry.sourceRecordUuid,
        sourceKind: entry.sourceKind,
      } satisfies SessionMemorySummaryLike
    })
  }

  private isNewerRevision(
    candidate: ContextSessionMemoryEntry,
    current: ContextSessionMemoryEntry
  ): boolean {
    if (candidate.revision !== current.revision) {
      return candidate.revision > current.revision
    }
    if (
      candidate.kind === current.kind &&
      candidate.text === current.text &&
      candidate.sourceEventId === current.sourceEventId &&
      candidate.sourceToolUseId === current.sourceToolUseId &&
      candidate.sourceRecordUuid === current.sourceRecordUuid &&
      candidate.sourceKind === current.sourceKind &&
      candidate.createdAt === current.createdAt &&
      candidate.weight === current.weight
    ) {
      return false
    }
    throw new Error(
      `SessionMemoryService: conflicting materialization for event ${candidate.id} revision ${candidate.revision}`
    )
  }

  /**
   * A higher revision may refresh the materialized event facts, but a memory
   * identity never changes its lifecycle event or terminal graph owner.
   */
  private assertImmutableEventProvenance(
    candidate: ContextSessionMemoryEntry,
    current: ContextSessionMemoryEntry
  ): void {
    if (
      candidate.sourceEventId !== current.sourceEventId ||
      candidate.sourceToolUseId !== current.sourceToolUseId ||
      candidate.sourceRecordUuid !== current.sourceRecordUuid ||
      candidate.sourceKind !== current.sourceKind
    ) {
      throw new Error(
        `SessionMemoryService: provenance is immutable for event ${candidate.id}`
      )
    }
  }

  private assertExplicitEntry(
    entry: ContextSessionMemoryEntry | undefined | null
  ): asserts entry is ContextSessionMemoryEntry {
    if (!entry || typeof entry !== "object") {
      throw new Error("SessionMemoryService: explicit memory entry is required")
    }
    assertExactIdentifier(entry.id, "SessionMemoryService: entry.id")
    if (typeof entry.kind !== "string" || entry.kind.length === 0) {
      throw new Error("SessionMemoryService: entry.kind is required")
    }
    if (typeof entry.text !== "string" || entry.text.trim().length === 0) {
      throw new Error("SessionMemoryService: entry.text is required")
    }
    assertExactIdentifier(
      entry.sourceEventId,
      "SessionMemoryService: entry.sourceEventId"
    )
    assertTerminalSessionMemoryProvenance(entry, "SessionMemoryService: entry")
    if (!Number.isInteger(entry.revision) || entry.revision <= 0) {
      throw new Error("SessionMemoryService: entry.revision must be positive")
    }
    if (!Number.isFinite(entry.createdAt)) {
      throw new Error("SessionMemoryService: entry.createdAt must be finite")
    }
    if (!Number.isFinite(entry.weight)) {
      throw new Error("SessionMemoryService: entry.weight must be finite")
    }
  }
}
