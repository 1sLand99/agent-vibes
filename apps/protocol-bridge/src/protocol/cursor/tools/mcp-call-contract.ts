import type { McpToolDef } from "./cursor-request-parser"

const EMPTY_MCP_INPUT_SCHEMA = {
  type: "object",
  properties: {},
} as const

/**
 * Exact MCP capability advertised during one parent turn. This snapshot is
 * detached from Cursor's mutable request objects and is the sole authority
 * for parent-level discovery after the provider tool catalog is emitted.
 */
export interface ParentMcpToolSnapshot {
  readonly name: string
  readonly toolName: string
  readonly providerIdentifier: string
  readonly ideRegistryKey: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export interface ResolvedMcpCallFields {
  name: string
  toolName: string
  providerIdentifier: string
  serverIdentifier: string
  rawArgs: Record<string, unknown>
}

/**
 * The immutable identity of a child-visible MCP capability. Unlike
 * {@link McpToolDef}, this is read from the child's durable spawn request,
 * not from the live session registry.
 */
export interface FrozenMcpDispatchIdentity {
  readonly definitionName: string
  readonly toolName: string
  readonly providerIdentifier: string
  readonly ideRegistryKey: string
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

/**
 * Normalize an MCP schema exactly as provider tool advertisement does.
 * Cursor may omit the schema or its top-level type/properties fields.
 */
export function normalizeMcpToolInputSchema(
  schema: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { ...EMPTY_MCP_INPUT_SCHEMA }
  }
  const normalizedType =
    typeof schema.type === "string" && schema.type.length > 0
      ? schema.type
      : "object"
  const properties =
    normalizedType === "object" &&
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {}
  return {
    ...schema,
    type: normalizedType,
    ...(normalizedType === "object" ? { properties } : {}),
  }
}

/**
 * Freeze the parent turn's mounted MCP catalog without imposing the stricter
 * child-spawn capability contract. Empty descriptions and omitted schemas are
 * valid Cursor protocol inputs and are normalized exactly as provider tools.
 */
export function snapshotParentMcpToolDefinitions(
  definitions: readonly McpToolDef[]
): readonly ParentMcpToolSnapshot[] {
  const names = new Set<string>()
  return Object.freeze(
    definitions.map((definition, index) => {
      const name = requireSnapshotIdentifier(
        definition.name,
        `definitions[${index}].name`
      )
      if (names.has(name)) {
        throw new Error(`Duplicate parent MCP tool definition name: ${name}`)
      }
      names.add(name)

      const toolName = requireSnapshotIdentifier(
        definition.toolName,
        `definitions[${index}].toolName`
      )
      const providerIdentifier = requireOptionalSnapshotIdentifier(
        definition.providerIdentifier,
        `definitions[${index}].providerIdentifier`
      )
      const ideRegistryKey = requireOptionalSnapshotIdentifier(
        definition.ideRegistryKey,
        `definitions[${index}].ideRegistryKey`
      )
      const description =
        definition.description || `MCP tool ${toolName || name}`
      const inputSchema = deepFreezeRecord(
        structuredClone(normalizeMcpToolInputSchema(definition.inputSchema))
      )

      return Object.freeze({
        name,
        toolName,
        providerIdentifier,
        ideRegistryKey,
        description,
        inputSchema,
      })
    })
  )
}

function requireSnapshotIdentifier(value: string, field: string): string {
  if (!value || value !== value.trim() || value.includes("\u0000")) {
    throw new Error(`Invalid parent MCP capability ${field}`)
  }
  return value
}

function requireOptionalSnapshotIdentifier(
  value: string,
  field: string
): string {
  if (value !== value.trim() || value.includes("\u0000")) {
    throw new Error(`Invalid parent MCP capability ${field}`)
  }
  return value
}

function deepFreezeRecord(
  value: Record<string, unknown>
): Readonly<Record<string, unknown>> {
  const freeze = (candidate: unknown): void => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Object.isFrozen(candidate)
    ) {
      return
    }
    for (const nested of Object.values(candidate)) {
      freeze(nested)
    }
    Object.freeze(candidate)
  }
  freeze(value)
  return value
}

function pickFirstString(
  source: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = asString(source[key]).trim()
    if (value) return value
  }
  return undefined
}

function composeMcpName(providerIdentifier: string, toolName: string): string {
  const normalizedToolName = toolName.trim()
  if (!normalizedToolName) return ""

  const normalizedProvider = providerIdentifier.trim()
  if (!normalizedProvider) return normalizedToolName

  const compactTool = normalizeMcpToolIdentifier(normalizedToolName)
  const compactProvider = normalizeMcpToolIdentifier(normalizedProvider)
  if (compactProvider && compactTool.startsWith(compactProvider)) {
    return normalizedToolName
  }

  return `${normalizedProvider}-${normalizedToolName}`
}

function extractToolNameFromComposedName(
  name: string,
  providerIdentifier: string
): string {
  const normalizedName = name.trim()
  if (!normalizedName) return ""

  const normalizedProvider = providerIdentifier.trim()
  if (!normalizedProvider) return normalizedName

  const providerPrefix = `${normalizedProvider}-`
  if (
    normalizedName.length > providerPrefix.length &&
    normalizedName.toLowerCase().startsWith(providerPrefix.toLowerCase())
  ) {
    return normalizedName.slice(providerPrefix.length)
  }

  return normalizedName
}

export function normalizeMcpToolIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

export function resolveMcpToolDefinition(
  defs: McpToolDef[] | undefined,
  toolName: string
): McpToolDef | undefined {
  if (!defs || defs.length === 0) return undefined

  const normalizedRequested = normalizeMcpToolIdentifier(toolName)
  if (!normalizedRequested) return undefined

  const validDefs = defs.filter((def): def is McpToolDef =>
    Boolean(def && typeof def.name === "string" && def.name.trim())
  )
  const selectUnique = (matches: McpToolDef[]): McpToolDef | undefined =>
    matches.length === 1 ? matches[0] : undefined

  const exactName = selectUnique(
    validDefs.filter((def) => def.name === toolName)
  )
  if (exactName) return exactName

  const normalizedName = selectUnique(
    validDefs.filter(
      (def) => normalizeMcpToolIdentifier(def.name) === normalizedRequested
    )
  )
  if (normalizedName) return normalizedName

  return selectUnique(
    validDefs.filter(
      (def) =>
        typeof def.toolName === "string" &&
        normalizeMcpToolIdentifier(def.toolName) === normalizedRequested
    )
  )
}

export function resolveMcpToolDefinitionByIdentity(
  defs: McpToolDef[] | undefined,
  identity: Pick<ResolvedMcpCallFields, "providerIdentifier" | "toolName">
): McpToolDef | undefined {
  if (!defs || defs.length === 0) return undefined

  const providerIdentifier = normalizeMcpToolIdentifier(
    identity.providerIdentifier
  )
  const toolName = normalizeMcpToolIdentifier(identity.toolName)
  if (!providerIdentifier || !toolName) return undefined

  const matches = defs.filter(
    (def) =>
      Boolean(def) &&
      normalizeMcpToolIdentifier(def.providerIdentifier || "") ===
        providerIdentifier &&
      normalizeMcpToolIdentifier(def.toolName || "") === toolName
  )
  return matches.length === 1 ? matches[0] : undefined
}

export function extractMcpRawArguments(
  input: Record<string, unknown>
): Record<string, unknown> {
  return asRecord(input.arguments) || asRecord(input.args) || input
}

export function buildMcpDispatchInput(
  input: Record<string, unknown>,
  mcpToolDef: McpToolDef
): Record<string, unknown> {
  const declaredToolName =
    typeof mcpToolDef.name === "string" ? mcpToolDef.name.trim() : ""
  if (!declaredToolName) {
    throw new Error("Invalid MCP tool definition: missing name")
  }

  const rawArgs = extractMcpRawArguments(input)
  const toolName =
    (typeof mcpToolDef.toolName === "string"
      ? mcpToolDef.toolName.trim()
      : "") || declaredToolName
  if (!toolName) {
    throw new Error(
      "Invalid MCP dispatch input: missing args.toolName/tool_name"
    )
  }
  const providerIdentifier = (mcpToolDef.providerIdentifier || "").trim()
  const serverIdentifier = (
    mcpToolDef.ideRegistryKey || providerIdentifier
  ).trim()

  return {
    ...input,
    // The registry definition selected by the outer tool name is the sole
    // dispatch identity. Fields inside the tool's argument object may have
    // the same names, but they can never redirect execution to another MCP
    // server or tool.
    name: declaredToolName,
    toolName,
    providerIdentifier,
    serverIdentifier,
    arguments: rawArgs,
  }
}

/**
 * Build a client MCP envelope from a frozen child capability. Model supplied
 * fields can remain application arguments, but never redirect the server,
 * registered definition, or concrete MCP tool selected at spawn time.
 */
export function buildFrozenMcpDispatchInput(
  input: Record<string, unknown>,
  identity: FrozenMcpDispatchIdentity
): Record<string, unknown> {
  assertFrozenMcpDispatchIdentifier(identity.definitionName, "definitionName")
  assertFrozenMcpDispatchIdentifier(identity.toolName, "toolName")
  assertFrozenMcpDispatchIdentifier(
    identity.providerIdentifier,
    "providerIdentifier"
  )
  assertFrozenMcpDispatchIdentifier(identity.ideRegistryKey, "ideRegistryKey")

  return {
    ...input,
    name: identity.definitionName,
    toolName: identity.toolName,
    providerIdentifier: identity.providerIdentifier,
    serverIdentifier: identity.ideRegistryKey,
    arguments: extractMcpRawArguments(input),
  }
}

function assertFrozenMcpDispatchIdentifier(value: string, field: string): void {
  if (!value || value !== value.trim() || value.includes("\u0000")) {
    throw new Error(`Invalid frozen MCP dispatch ${field}`)
  }
}

export function resolveMcpCallFields(
  args: Record<string, unknown>
): ResolvedMcpCallFields {
  const serverName =
    pickFirstString(args, [
      "serverName",
      "server",
      "server_name",
      "provider",
    ]) || ""
  const providerIdentifier =
    pickFirstString(args, ["providerIdentifier", "provider_identifier"]) ||
    serverName
  const serverIdentifier =
    pickFirstString(args, ["serverIdentifier", "server_identifier"]) || ""

  const explicitName = pickFirstString(args, ["name"])
  const explicitToolName = pickFirstString(args, ["toolName", "tool_name"])
  const aliasTool = pickFirstString(args, ["tool"])

  let toolName =
    explicitToolName ||
    (explicitName
      ? extractToolNameFromComposedName(explicitName, providerIdentifier)
      : "") ||
    aliasTool ||
    ""

  let name =
    explicitName ||
    (toolName ? composeMcpName(providerIdentifier, toolName) : "")

  if (!name && aliasTool) {
    name = composeMcpName(providerIdentifier, aliasTool)
  }
  if (!toolName && name) {
    toolName = extractToolNameFromComposedName(name, providerIdentifier)
  }

  if (!name || !toolName) {
    throw new Error(
      `Invalid MCP args: name/toolName unresolved (received name="${explicitName || ""}", toolName="${explicitToolName || ""}")`
    )
  }

  return {
    name,
    toolName,
    providerIdentifier,
    serverIdentifier,
    rawArgs: extractMcpRawArguments(args),
  }
}
