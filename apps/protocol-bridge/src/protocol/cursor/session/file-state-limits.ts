export const SESSION_FILE_STATE_CONTENT_LIMIT_BYTES = 2 * 1024 * 1024
export const SESSION_FILE_STATE_TOTAL_LIMIT_BYTES =
  SESSION_FILE_STATE_CONTENT_LIMIT_BYTES * 2

export function sessionFileStateByteLength(value: string | Uint8Array): number {
  return typeof value === "string"
    ? Buffer.byteLength(value, "utf8")
    : value.byteLength
}

export function getSessionFileStateSize(
  beforeContent: string | Uint8Array,
  afterContent: string | Uint8Array
): { beforeBytes: number; afterBytes: number; totalBytes: number } {
  const beforeBytes = sessionFileStateByteLength(beforeContent)
  const afterBytes = sessionFileStateByteLength(afterContent)
  return {
    beforeBytes,
    afterBytes,
    totalBytes: beforeBytes + afterBytes,
  }
}

export function isSessionFileStateWithinLimit(
  beforeContent: string | Uint8Array,
  afterContent: string | Uint8Array
): boolean {
  const size = getSessionFileStateSize(beforeContent, afterContent)
  return (
    size.beforeBytes <= SESSION_FILE_STATE_CONTENT_LIMIT_BYTES &&
    size.afterBytes <= SESSION_FILE_STATE_CONTENT_LIMIT_BYTES &&
    size.totalBytes <= SESSION_FILE_STATE_TOTAL_LIMIT_BYTES
  )
}

export function describeSessionFileStateLimit(
  beforeBytes: number,
  afterBytes: number
): string {
  return (
    `before=${beforeBytes} bytes, after=${afterBytes} bytes, ` +
    `limit=${SESSION_FILE_STATE_CONTENT_LIMIT_BYTES} bytes per side`
  )
}
