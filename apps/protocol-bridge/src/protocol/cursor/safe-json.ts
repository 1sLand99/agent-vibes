import * as crypto from "crypto"

export interface SafeJsonOptions {
  maxDepth?: number
  maxArrayItems?: number
  maxObjectKeys?: number
  maxStringLength?: number
  includeHashes?: boolean
}

const DEFAULT_OPTIONS: Required<SafeJsonOptions> = {
  maxDepth: 8,
  maxArrayItems: 100,
  maxObjectKeys: 100,
  maxStringLength: 16_384,
  includeHashes: false,
}

function resolveOptions(options?: SafeJsonOptions): Required<SafeJsonOptions> {
  return { ...DEFAULT_OPTIONS, ...(options || {}) }
}

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function summarizeString(value: string, options: Required<SafeJsonOptions>) {
  if (value.length <= options.maxStringLength) {
    return value
  }

  return {
    $type: "string",
    length: value.length,
    preview: value.slice(0, options.maxStringLength),
    ...(options.includeHashes ? { sha256: sha256(value) } : {}),
  }
}

function summarizeBytes(value: Uint8Array, options: Required<SafeJsonOptions>) {
  return {
    $type: Buffer.isBuffer(value) ? "Buffer" : "Uint8Array",
    byteLength: value.byteLength,
    ...(options.includeHashes ? { sha256: sha256(value) } : {}),
  }
}

function toSafeJsonInternal(
  value: unknown,
  options: Required<SafeJsonOptions>,
  depth: number,
  seen: WeakSet<object>
): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === "string") {
    return summarizeString(value, options)
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value
  }

  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  }

  if (typeof value === "symbol") {
    return value.description ? `[symbol:${value.description}]` : "[symbol]"
  }

  if (typeof value === "function") {
    return undefined
  }

  if (value instanceof Uint8Array) {
    return summarizeBytes(value, options)
  }

  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? value.toISOString() : null
  }

  if (depth >= options.maxDepth) {
    return "[max-depth]"
  }

  if (seen.has(value)) {
    return "[circular]"
  }
  seen.add(value)

  if (Array.isArray(value)) {
    const limit = Math.max(0, options.maxArrayItems)
    const out = value
      .slice(0, limit)
      .map((item) => toSafeJsonInternal(item, options, depth + 1, seen))
      .filter((item) => item !== undefined)
    if (value.length > limit) {
      out.push({ $truncatedItems: value.length - limit })
    }
    seen.delete(value)
    return out
  }

  if (value instanceof Map) {
    const entries = Array.from(value.entries()).slice(0, options.maxObjectKeys)
    const out: Record<string, unknown> = {}
    for (const [key, nested] of entries) {
      const safeKey =
        typeof key === "string"
          ? key
          : safeJsonStringify(key, { ...options, maxDepth: 2 })
      const safeValue = toSafeJsonInternal(nested, options, depth + 1, seen)
      if (safeValue !== undefined) {
        out[safeKey] = safeValue
      }
    }
    if (value.size > entries.length) {
      out.$truncatedKeys = value.size - entries.length
    }
    seen.delete(value)
    return out
  }

  if (value instanceof Set) {
    const entries = Array.from(value.values()).slice(0, options.maxArrayItems)
    const out = entries
      .map((item) => toSafeJsonInternal(item, options, depth + 1, seen))
      .filter((item) => item !== undefined)
    if (value.size > entries.length) {
      out.push({ $truncatedItems: value.size - entries.length })
    }
    seen.delete(value)
    return out
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const out: Record<string, unknown> = {}
  for (const [key, nested] of entries.slice(0, options.maxObjectKeys)) {
    const safeValue = toSafeJsonInternal(nested, options, depth + 1, seen)
    if (safeValue !== undefined) {
      out[key] = safeValue
    }
  }
  if (entries.length > options.maxObjectKeys) {
    out.$truncatedKeys = entries.length - options.maxObjectKeys
  }

  seen.delete(value)
  return out
}

export function toSafeJson(value: unknown, options?: SafeJsonOptions): unknown {
  return toSafeJsonInternal(value, resolveOptions(options), 0, new WeakSet())
}

export function safeJsonStringify(
  value: unknown,
  options?: SafeJsonOptions
): string {
  return JSON.stringify(toSafeJson(value, options))
}

export function safeJsonByteLength(
  value: unknown,
  options?: SafeJsonOptions
): number {
  return Buffer.byteLength(safeJsonStringify(value, options), "utf8")
}

export function safeJsonEqual(
  left: unknown,
  right: unknown,
  options?: SafeJsonOptions
): boolean {
  const signatureOptions: SafeJsonOptions = {
    includeHashes: true,
    maxDepth: 12,
    maxArrayItems: 1_000,
    maxObjectKeys: 1_000,
    maxStringLength: 64 * 1024,
    ...(options || {}),
  }
  return (
    safeJsonStringify(left, signatureOptions) ===
    safeJsonStringify(right, signatureOptions)
  )
}
