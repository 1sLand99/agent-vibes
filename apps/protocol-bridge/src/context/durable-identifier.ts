/**
 * Exact identity contract for values that address a durable session object.
 *
 * Graph record UUIDs, provider projection ids, tool-use ids and related
 * keys are opaque.  Normalizing one after it has crossed a persistence
 * boundary can address a different row and silently turn corruption into a
 * valid-looking relation.  Keep the original bytes once accepted.
 */
export function requireExactDurableIdentifier(
  value: unknown,
  label: string
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`)
  }
  if (value.length === 0) {
    throw new Error(`${label} must be a non-empty durable identifier`)
  }
  if (value !== value.trim()) {
    throw new Error(
      `${label} must be a durable identifier without surrounding whitespace`
    )
  }
  if (value.includes("\u0000")) {
    throw new Error(`${label} must not contain NUL bytes`)
  }
  return value
}

/** A missing optional field is the only absence sentinel for a durable id. */
export function requireOptionalExactDurableIdentifier(
  value: unknown,
  label: string
): string | undefined {
  return value === undefined
    ? undefined
    : requireExactDurableIdentifier(value, label)
}
