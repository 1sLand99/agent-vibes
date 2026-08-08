import { Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { PersistenceService } from "../../../persistence"
import { cursorBlobIdFromKey, cursorBlobIdToKey } from "../codec/cursor-blob-id"
import type { ConversationId } from "../turn/turn.types"

export type CursorWireDirection = "inbound" | "outbound"

export interface CursorWireFrameRecord {
  conversationId: ConversationId
  streamEpoch: string
  seq: number
  direction: CursorWireDirection
  frameKind: string
  payload: Buffer
  capturedAt: number
}

export interface CursorWireBlobRecord {
  conversationId: ConversationId
  /** Canonical base64url key for Cursor's opaque `bytes id` field. */
  blobId: string
  blobKind: string
  payload: Buffer
  capturedAt: number
}

/**
 * Exact Cursor protocol persistence. Blob identity crosses this boundary only
 * as a canonical base64url key; `cursor-blob-id` is the sole raw-byte codec.
 */
@Injectable()
export class CursorWireStore {
  private stmtInsertFrame?: StatementSync
  private stmtListFrames?: StatementSync
  private stmtInsertBlob?: StatementSync
  private stmtGetBlob?: StatementSync

  constructor(private readonly persistence: PersistenceService) {}

  appendFrame(record: CursorWireFrameRecord): void {
    this.assertFrame(record)
    const stmt = (this.stmtInsertFrame ??= this.persistence.prepare(
      `INSERT INTO session_cursor_wire_frames (
         conversation_id, stream_epoch, seq, direction, frame_kind, payload,
         captured_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ))
    stmt.run(
      record.conversationId,
      record.streamEpoch,
      record.seq,
      record.direction,
      record.frameKind,
      Buffer.from(record.payload),
      record.capturedAt
    )
  }

  listFrames(
    conversationId: ConversationId,
    streamEpoch: string
  ): CursorWireFrameRecord[] {
    const stmt = (this.stmtListFrames ??= this.persistence.prepare(
      `SELECT seq, direction, frame_kind, payload, captured_at
         FROM session_cursor_wire_frames
        WHERE conversation_id = ? AND stream_epoch = ?
        ORDER BY seq ASC`
    ))
    const rows = stmt.all(conversationId, streamEpoch) as unknown as Array<{
      seq: number
      direction: CursorWireDirection
      frame_kind: string
      payload: Buffer | Uint8Array
      captured_at: number
    }>
    return rows.map((row) => ({
      conversationId,
      streamEpoch,
      seq: row.seq,
      direction: row.direction,
      frameKind: row.frame_kind,
      payload: normalizeBlob(row.payload),
      capturedAt: row.captured_at,
    }))
  }

  putBlob(record: CursorWireBlobRecord): void {
    const blobKey = this.assertBlob(record)
    const stmt = (this.stmtInsertBlob ??= this.persistence.prepare(
      `INSERT INTO session_cursor_wire_blobs (
         conversation_id, blob_id, blob_kind, payload, captured_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, blob_id) DO NOTHING`
    ))
    const result = stmt.run(
      record.conversationId,
      blobKey,
      record.blobKind,
      Buffer.from(record.payload),
      record.capturedAt
    ) as { changes?: number }
    if ((result.changes ?? 0) !== 0) return

    const existing = this.getBlob(record.conversationId, record.blobId)
    if (!existing || !existing.payload.equals(record.payload)) {
      throw new Error(
        "CursorWireStore.putBlob: immutable blob key conflicts with different content"
      )
    }
  }

  getBlob(
    conversationId: ConversationId,
    blobId: string
  ): CursorWireBlobRecord | undefined {
    this.assertConversationId(conversationId, "getBlob")
    const blobKey = this.blobKeyFor(blobId, "getBlob")
    const stmt = (this.stmtGetBlob ??= this.persistence.prepare(
      `SELECT blob_kind, payload, captured_at
         FROM session_cursor_wire_blobs
        WHERE conversation_id = ? AND blob_id = ?
        LIMIT 1`
    ))
    const row = stmt.get(conversationId, blobKey) as
      | { blob_kind: string; payload: Buffer | Uint8Array; captured_at: number }
      | undefined
    if (!row) return undefined
    return {
      conversationId,
      blobId: blobKey,
      blobKind: row.blob_kind,
      payload: normalizeBlob(row.payload),
      capturedAt: row.captured_at,
    }
  }

  private assertFrame(record: CursorWireFrameRecord): void {
    this.assertConversationId(record.conversationId, "appendFrame")
    if (!record.streamEpoch.trim() || !record.frameKind.trim()) {
      throw new Error(
        "CursorWireStore.appendFrame: streamEpoch and frameKind are required"
      )
    }
    if (!Number.isInteger(record.seq) || record.seq < 0) {
      throw new Error(
        "CursorWireStore.appendFrame: seq must be a non-negative integer"
      )
    }
    if (!Number.isFinite(record.capturedAt) || record.capturedAt <= 0) {
      throw new Error(
        "CursorWireStore.appendFrame: capturedAt must be a positive epoch"
      )
    }
  }

  private assertBlob(record: CursorWireBlobRecord): string {
    this.assertConversationId(record.conversationId, "putBlob")
    const blobKey = this.blobKeyFor(record.blobId, "putBlob")
    if (!record.blobKind.trim()) {
      throw new Error("CursorWireStore.putBlob: blobKind is required")
    }
    if (!Number.isFinite(record.capturedAt) || record.capturedAt <= 0) {
      throw new Error(
        "CursorWireStore.putBlob: capturedAt must be a positive epoch"
      )
    }
    return blobKey
  }

  private blobKeyFor(blobId: string, operation: "putBlob" | "getBlob"): string {
    try {
      return cursorBlobIdToKey(cursorBlobIdFromKey(blobId))
    } catch {
      throw new Error(
        `CursorWireStore.${operation}: blobId must be canonical base64url`
      )
    }
  }

  private assertConversationId(
    conversationId: ConversationId,
    operation: "appendFrame" | "putBlob" | "getBlob"
  ): void {
    if (!String(conversationId).trim()) {
      throw new Error(
        `CursorWireStore.${operation}: conversationId is required`
      )
    }
  }
}

function normalizeBlob(blob: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(blob) ? Buffer.from(blob) : Buffer.from(blob)
}
