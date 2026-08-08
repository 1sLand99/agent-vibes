/**
 * Cursor blob identifiers are opaque protocol bytes. Persistence and maps use
 * a canonical base64url key so UTF-8 decoding can never alter their identity.
 */
const CANONICAL_BASE64URL = /^[A-Za-z0-9_-]+$/

export function cursorBlobIdToKey(blobId: Uint8Array): string {
  if (blobId.length === 0) {
    throw new Error("Cursor blob id must not be empty")
  }
  return Buffer.from(blobId).toString("base64url")
}

export function cursorBlobIdFromKey(key: string): Uint8Array {
  if (!key) {
    throw new Error("Cursor blob id key must not be empty")
  }
  if (!CANONICAL_BASE64URL.test(key)) {
    throw new Error("Cursor blob id key is not canonical base64url")
  }
  const decoded = Buffer.from(key, "base64url")
  if (decoded.length === 0 || decoded.toString("base64url") !== key) {
    throw new Error("Cursor blob id key is not canonical base64url")
  }
  return new Uint8Array(decoded)
}

export function cursorTextBlobIdToKey(blobId: string): string {
  return cursorBlobIdToKey(new TextEncoder().encode(blobId))
}
