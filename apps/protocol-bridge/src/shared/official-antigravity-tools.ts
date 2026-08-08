export interface OfficialAntigravityCanonicalToolInvocation {
  toolName: string
  input: Record<string, unknown>
  historyToolName?: string
  historyToolInput?: Record<string, unknown>
  validationErrorMessage?: string
}

/**
 * The official `browser_subagent` tool dispatches the runtime browser
 * sub-agent by this exact identity.  Protocol oneof names are deliberately
 * kept out of this contract: the browser-use wire case is not a second
 * runtime agent name.
 */
export const OFFICIAL_ANTIGRAVITY_BROWSER_SUBAGENT_TYPE = "browser" as const

interface OfficialAntigravityNormalizedEditChunk {
  allowMultiple?: boolean
  targetContent?: string
  replacementContent?: string
  startLine?: number
  endLine?: number
}

export type OfficialAntigravityArtifactType =
  | "implementation_plan"
  | "walkthrough"
  | "task"
  | "other"

export interface OfficialAntigravityArtifactMetadata {
  artifactType: OfficialAntigravityArtifactType
  requestFeedback?: boolean
  summary?: string
}

export function normalizeOfficialAntigravityToolToken(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function pickFirstString(
  source: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw === "string" && raw.trim() !== "") {
      return raw.trim()
    }
  }
  return undefined
}

function pickFirstRawString(
  source: Record<string, unknown>,
  keys: string[],
  options?: { allowEmpty?: boolean }
): string | undefined {
  const allowEmpty = options?.allowEmpty ?? false
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw !== "string") continue
    if (allowEmpty || raw.length > 0) {
      return raw
    }
  }
  return undefined
}

function pickFirstRawStringFromSources(
  sources: Array<Record<string, unknown> | undefined>,
  keys: string[],
  options?: { allowEmpty?: boolean }
): string | undefined {
  for (const source of sources) {
    if (!source) continue
    const value = pickFirstRawString(source, keys, options)
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

function pickFirstNumber(
  source: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.floor(raw)
    }
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number.parseInt(raw, 10)
      if (Number.isFinite(parsed)) {
        return Math.floor(parsed)
      }
    }
  }
  return undefined
}

function pickFirstNumberFromSources(
  sources: Array<Record<string, unknown> | undefined>,
  keys: string[]
): number | undefined {
  for (const source of sources) {
    if (!source) continue
    const value = pickFirstNumber(source, keys)
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

function pickFirstBoolean(
  source: Record<string, unknown>,
  keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw === "boolean") return raw
    if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase()
      if (normalized === "true") return true
      if (normalized === "false") return false
    }
  }
  return undefined
}

function pickFirstBooleanFromSources(
  sources: Array<Record<string, unknown> | undefined>,
  keys: string[]
): boolean | undefined {
  for (const source of sources) {
    if (!source) continue
    const value = pickFirstBoolean(source, keys)
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function pickFirstObject(
  source: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const raw = source[key]
    if (isRecord(raw)) {
      return raw
    }
  }
  return undefined
}

function pickRecordArray(
  source: Record<string, unknown>,
  keys: string[]
): Record<string, unknown>[] {
  for (const key of keys) {
    const raw = source[key]
    if (!Array.isArray(raw)) continue
    const records = raw.filter(isRecord)
    if (records.length > 0) {
      return records
    }
  }
  return []
}

function pickStringArray(
  source: Record<string, unknown>,
  keys: string[]
): string[] {
  for (const key of keys) {
    const raw = source[key]
    if (Array.isArray(raw)) {
      const values = raw
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0)
      if (values.length > 0) {
        return values
      }
    }
    if (typeof raw === "string" && raw.trim() !== "") {
      return [raw.trim()]
    }
  }
  return []
}

export function normalizeOfficialAntigravityArtifactType(
  value: string
): OfficialAntigravityArtifactType | undefined {
  const normalized = normalizeOfficialAntigravityToolToken(value)
  if (
    normalized === "implementation_plan" ||
    normalized === "walkthrough" ||
    normalized === "task" ||
    normalized === "other"
  ) {
    return normalized
  }
  return undefined
}

export function extractOfficialAntigravityArtifactMetadata(
  input: Record<string, unknown>
): OfficialAntigravityArtifactMetadata | undefined {
  const raw =
    (input.ArtifactMetadata as Record<string, unknown> | undefined) ||
    (input.artifactMetadata as Record<string, unknown> | undefined) ||
    (input.artifact_metadata as Record<string, unknown> | undefined)
  if (!raw || typeof raw !== "object") return undefined

  const artifactTypeValue = pickFirstString(raw, [
    "ArtifactType",
    "artifactType",
    "artifact_type",
  ])
  const artifactType = artifactTypeValue
    ? normalizeOfficialAntigravityArtifactType(artifactTypeValue)
    : undefined
  if (!artifactType) return undefined

  const summary = pickFirstString(raw, ["Summary", "summary"]) || ""
  const requestFeedback = pickFirstBoolean(raw, [
    "RequestFeedback",
    "requestFeedback",
    "request_feedback",
  ])

  return {
    artifactType,
    ...(summary ? { summary } : {}),
    ...(typeof requestFeedback === "boolean" ? { requestFeedback } : {}),
  }
}

export function pickOfficialAntigravityFilePath(
  input: Record<string, unknown>
): string {
  return (
    pickFirstString(input, [
      "SearchPath",
      "searchPath",
      "search_path",
      "TargetFile",
      "targetFile",
      "target_file",
      "AbsolutePath",
      "absolutePath",
      "absolute_path",
      "DirectoryPath",
      "directoryPath",
      "directory_path",
      "path",
      "filePath",
      "file_path",
    ]) || ""
  )
}

function buildCanonicalOfficialAntigravityEditMetadata(
  input: Record<string, unknown>,
  pathValue: string
): Record<string, unknown> {
  const metadata = extractOfficialAntigravityArtifactMetadata(input)
  const description =
    pickFirstString(input, ["Description", "description"]) || ""
  const instruction =
    pickFirstString(input, ["Instruction", "instruction"]) || ""
  const overwrite = pickFirstBoolean(input, ["Overwrite", "overwrite"])
  const isArtifact = pickFirstBoolean(input, [
    "IsArtifact",
    "isArtifact",
    "is_artifact",
  ])

  return {
    path: pathValue,
    ...(description ? { description } : {}),
    ...(instruction ? { instruction } : {}),
    ...(typeof overwrite === "boolean"
      ? { overwrite, Overwrite: overwrite }
      : {}),
    ...(typeof isArtifact === "boolean"
      ? { isArtifact, is_artifact: isArtifact, IsArtifact: isArtifact }
      : {}),
    ...(metadata
      ? {
          artifactMetadata: metadata,
          artifact_metadata: metadata,
          ArtifactMetadata: {
            ArtifactType: metadata.artifactType,
            ...(typeof metadata.requestFeedback === "boolean"
              ? { RequestFeedback: metadata.requestFeedback }
              : {}),
            ...(metadata.summary ? { Summary: metadata.summary } : {}),
          },
        }
      : {}),
  }
}

function hasOwnEditChunkField(source: Record<string, unknown>): boolean {
  return [
    "AllowMultiple",
    "allowMultiple",
    "allow_multiple",
    "TargetContent",
    "targetContent",
    "target_content",
    "search",
    "target",
    "old_text",
    "oldText",
    "ReplacementContent",
    "replacementContent",
    "replacement_content",
    "replace",
    "replacement",
    "new_text",
    "newText",
    "StartLine",
    "startLine",
    "start_line",
    "EndLine",
    "endLine",
    "end_line",
  ].some((key) => Object.prototype.hasOwnProperty.call(source, key))
}

function normalizeOfficialEditChunkFromSources(
  sources: Array<Record<string, unknown> | undefined>
): OfficialAntigravityNormalizedEditChunk {
  return {
    allowMultiple: pickFirstBooleanFromSources(sources, [
      "AllowMultiple",
      "allowMultiple",
      "allow_multiple",
    ]),
    targetContent: pickFirstRawStringFromSources(
      sources,
      [
        "TargetContent",
        "targetContent",
        "target_content",
        "search",
        "target",
        "old_text",
        "oldText",
      ],
      { allowEmpty: true }
    ),
    replacementContent: pickFirstRawStringFromSources(
      sources,
      [
        "ReplacementContent",
        "replacementContent",
        "replacement_content",
        "replace",
        "replacement",
        "new_text",
        "newText",
      ],
      { allowEmpty: true }
    ),
    startLine: pickFirstNumberFromSources(sources, [
      "StartLine",
      "startLine",
      "start_line",
    ]),
    endLine: pickFirstNumberFromSources(sources, [
      "EndLine",
      "endLine",
      "end_line",
    ]),
  }
}

function buildCanonicalReplacementChunk(
  chunk: OfficialAntigravityNormalizedEditChunk
): Record<string, unknown> {
  return {
    ...(typeof chunk.allowMultiple === "boolean"
      ? { allowMultiple: chunk.allowMultiple }
      : {}),
    ...(chunk.targetContent !== undefined
      ? { targetContent: chunk.targetContent }
      : {}),
    ...(chunk.replacementContent !== undefined
      ? { replacementContent: chunk.replacementContent }
      : {}),
    ...(typeof chunk.startLine === "number"
      ? { startLine: chunk.startLine }
      : {}),
    ...(typeof chunk.endLine === "number" ? { endLine: chunk.endLine } : {}),
  }
}

function buildOfficialEditValidationError(
  toolName: string,
  issues: string[]
): string {
  return `${toolName} invalid input: ${issues.join("; ")}`
}

function validateOfficialEditChunk(
  chunk: OfficialAntigravityNormalizedEditChunk,
  options?: { index?: number }
): string[] {
  const issues: string[] = []
  const prefix =
    typeof options?.index === "number"
      ? `ReplacementChunks[${options.index}]`
      : ""

  if (chunk.targetContent === undefined) {
    issues.push(`${prefix || "TargetContent"} is required`)
  } else if (chunk.targetContent.length === 0) {
    issues.push(
      `${prefix ? `${prefix}.TargetContent` : "TargetContent"} must be non-empty`
    )
  }

  if (chunk.replacementContent === undefined) {
    issues.push(
      `${prefix ? `${prefix}.ReplacementContent` : "ReplacementContent"} is required`
    )
  }

  if (chunk.startLine != null && chunk.startLine < 1) {
    issues.push(`${prefix ? `${prefix}.StartLine` : "StartLine"} must be >= 1`)
  }
  if (chunk.endLine != null && chunk.endLine < 1) {
    issues.push(`${prefix ? `${prefix}.EndLine` : "EndLine"} must be >= 1`)
  }
  if (
    chunk.startLine != null &&
    chunk.endLine != null &&
    chunk.endLine < chunk.startLine
  ) {
    issues.push(
      `${prefix ? `${prefix}.EndLine` : "EndLine"} must be >= ${prefix ? `${prefix}.StartLine` : "StartLine"}`
    )
  }

  return issues
}

function pickOfficialTargetLintErrorIds(
  input: Record<string, unknown>
): string[] | undefined {
  const ids = pickStringArray(input, [
    "TargetLintErrorIds",
    "targetLintErrorIds",
    "target_lint_error_ids",
  ])
  return ids.length > 0 ? ids : undefined
}

function buildCanonicalOfficialSingleEditInvocation(
  toolName: string,
  input: Record<string, unknown>,
  historyToolName: string,
  historyToolInput: Record<string, unknown>,
  filePath: string
): OfficialAntigravityCanonicalToolInvocation {
  const singleChunk = pickFirstObject(input, [
    "ReplacementChunk",
    "replacementChunk",
    "replacement_chunk",
  ])
  const targetLintErrorIds = pickOfficialTargetLintErrorIds(input)
  const chunkArray = pickRecordArray(input, [
    "ReplacementChunks",
    "replacementChunks",
    "replacement_chunks",
  ])
  const issues: string[] = []
  if (!filePath) {
    issues.push("TargetFile is required")
  }
  if (chunkArray.length > 1) {
    issues.push(
      `received ${chunkArray.length} ReplacementChunks; use multi_replace_file_content for multiple edits`
    )
  }

  const chunk = normalizeOfficialEditChunkFromSources([
    input,
    singleChunk,
    chunkArray[0],
  ])
  issues.push(...validateOfficialEditChunk(chunk))

  return {
    toolName: "edit_file_v2",
    input: {
      ...buildCanonicalOfficialAntigravityEditMetadata(input, filePath),
      replacementChunks: [buildCanonicalReplacementChunk(chunk)],
      ...(targetLintErrorIds
        ? { target_lint_error_ids: targetLintErrorIds }
        : {}),
    },
    historyToolName,
    historyToolInput,
    ...(issues.length > 0
      ? {
          validationErrorMessage: buildOfficialEditValidationError(
            toolName,
            issues
          ),
        }
      : {}),
  }
}

function buildCanonicalOfficialMultiEditInvocation(
  toolName: string,
  input: Record<string, unknown>,
  historyToolName: string,
  historyToolInput: Record<string, unknown>,
  filePath: string
): OfficialAntigravityCanonicalToolInvocation {
  const chunkArray = pickRecordArray(input, [
    "ReplacementChunks",
    "replacementChunks",
    "replacement_chunks",
  ])
  const targetLintErrorIds = pickOfficialTargetLintErrorIds(input)
  const singleChunk = pickFirstObject(input, [
    "ReplacementChunk",
    "replacementChunk",
    "replacement_chunk",
  ])
  const rawChunks =
    chunkArray.length > 0
      ? chunkArray
      : singleChunk
        ? [singleChunk]
        : hasOwnEditChunkField(input)
          ? [input]
          : []

  const issues: string[] = []
  if (!filePath) {
    issues.push("TargetFile is required")
  }
  if (rawChunks.length === 0) {
    issues.push("ReplacementChunks must contain at least one replacement chunk")
  }

  const replacementChunks = rawChunks.map((rawChunk, index) => {
    const chunk = normalizeOfficialEditChunkFromSources([rawChunk])
    issues.push(...validateOfficialEditChunk(chunk, { index }))
    return buildCanonicalReplacementChunk(chunk)
  })

  return {
    toolName: "edit_file_v2",
    input: {
      ...buildCanonicalOfficialAntigravityEditMetadata(input, filePath),
      replacementChunks,
      ...(targetLintErrorIds
        ? { target_lint_error_ids: targetLintErrorIds }
        : {}),
    },
    historyToolName,
    historyToolInput,
    ...(issues.length > 0
      ? {
          validationErrorMessage: buildOfficialEditValidationError(
            toolName,
            issues
          ),
        }
      : {}),
  }
}

function buildCanonicalOfficialWriteToFileInvocation(
  toolName: string,
  input: Record<string, unknown>,
  historyToolName: string,
  historyToolInput: Record<string, unknown>,
  filePath: string
): OfficialAntigravityCanonicalToolInvocation {
  const fileText = pickFirstRawString(
    input,
    ["CodeContent", "content", "file_text", "fileText", "text"],
    { allowEmpty: true }
  )
  const issues: string[] = []
  if (!filePath) {
    issues.push("TargetFile is required")
  }
  if (fileText === undefined) {
    issues.push("CodeContent is required")
  }

  return {
    toolName: "edit_file_v2",
    input: {
      ...buildCanonicalOfficialAntigravityEditMetadata(input, filePath),
      ...(fileText !== undefined ? { file_text: fileText } : {}),
    },
    historyToolName,
    historyToolInput,
    ...(issues.length > 0
      ? {
          validationErrorMessage: buildOfficialEditValidationError(
            toolName,
            issues
          ),
        }
      : {}),
  }
}

export function canonicalizeOfficialAntigravityToolInvocation(
  toolName: string,
  input: Record<string, unknown>
): OfficialAntigravityCanonicalToolInvocation | null {
  const normalized = normalizeOfficialAntigravityToolToken(toolName)
  const historyToolInput = { ...input }
  const historyToolName = toolName
  const filePath = pickOfficialAntigravityFilePath(input)

  switch (normalized) {
    case "grep_search": {
      const query =
        pickFirstString(input, [
          "Query",
          "query",
          "pattern",
          "searchTerm",
          "search_term",
        ]) || ""
      const includes = pickStringArray(input, [
        "Includes",
        "includes",
        "include",
        "glob",
        "globs",
      ])
      const matchPerLine = pickFirstBoolean(input, [
        "MatchPerLine",
        "matchPerLine",
        "match_per_line",
      ])
      return {
        toolName: "grep_search",
        input: {
          path:
            pickFirstString(input, [
              "SearchPath",
              "searchPath",
              "search_path",
              "path",
            ]) || filePath,
          query,
          ...(query ? { Query: query } : {}),
          ...(includes.length > 0 ? { includes: [...includes] } : {}),
          ...(typeof pickFirstBoolean(input, [
            "IsRegex",
            "isRegex",
            "is_regex",
          ]) === "boolean"
            ? {
                isRegex: pickFirstBoolean(input, [
                  "IsRegex",
                  "isRegex",
                  "is_regex",
                ]),
              }
            : {}),
          ...(typeof pickFirstBoolean(input, [
            "CaseInsensitive",
            "caseInsensitive",
            "case_insensitive",
            "-i",
          ]) === "boolean"
            ? {
                caseInsensitive: pickFirstBoolean(input, [
                  "CaseInsensitive",
                  "caseInsensitive",
                  "case_insensitive",
                  "-i",
                ]),
              }
            : {}),
          ...(typeof matchPerLine === "boolean" ? { matchPerLine } : {}),
          output_mode:
            matchPerLine === false ? "files_with_matches" : "content",
          head_limit:
            pickFirstNumber(input, ["HeadLimit", "headLimit", "head_limit"]) ??
            50,
          offset: pickFirstNumber(input, ["Offset", "offset"]),
        },
        historyToolName,
        historyToolInput,
      }
    }
    case "view_file":
      return {
        toolName: "read_file",
        input: {
          path: filePath,
          start_line: pickFirstNumber(input, [
            "StartLine",
            "start_line",
            "startLine",
          ]),
          end_line: pickFirstNumber(input, ["EndLine", "end_line", "endLine"]),
          is_skill_file: pickFirstBoolean(input, [
            "IsSkillFile",
            "is_skill_file",
            "isSkillFile",
          ]),
        },
        historyToolName,
        historyToolInput,
      }
    case "list_dir":
      return {
        toolName: "list_directory",
        input: {
          path: filePath,
          recursive: input.recursive,
        },
        historyToolName,
        historyToolInput,
      }
    case "run_command":
      return {
        toolName: "run_terminal_command",
        input: {
          command: pickFirstString(input, ["CommandLine", "command", "cmd"]),
          cwd: pickFirstString(input, [
            "Cwd",
            "cwd",
            "working_directory",
            "workingDirectory",
          ]),
          safeToAutoRun: pickFirstBoolean(input, [
            "SafeToAutoRun",
            "safeToAutoRun",
            "safe_to_auto_run",
          ]),
          runPersistent: pickFirstBoolean(input, [
            "RunPersistent",
            "runPersistent",
            "run_persistent",
          ]),
          requestedTerminalId: pickFirstString(input, [
            "RequestedTerminalID",
            "requestedTerminalId",
            "requested_terminal_id",
          ]),
          waitMsBeforeAsync: pickFirstNumber(input, [
            "WaitMsBeforeAsync",
            "waitMsBeforeAsync",
            "wait_ms_before_async",
          ]),
        },
        historyToolName,
        historyToolInput,
      }
    case "send_command_input":
      return {
        toolName: "write_shell_stdin",
        input: {
          shellId: pickFirstString(input, [
            "CommandId",
            "shellId",
            "shell_id",
            "command_id",
            "commandId",
          ]),
          data:
            pickFirstRawString(input, ["Input", "data", "input", "text"], {
              allowEmpty: true,
            }) ?? undefined,
          terminate: pickFirstBoolean(input, [
            "Terminate",
            "terminate",
            "shouldTerminate",
          ]),
          wait_ms: pickFirstNumber(input, ["WaitMs", "waitMs", "wait_ms"]),
          safeToAutoRun: pickFirstBoolean(input, [
            "SafeToAutoRun",
            "safeToAutoRun",
            "safe_to_auto_run",
          ]),
        },
        historyToolName,
        historyToolInput,
      }
    case "replace_file_content":
      return buildCanonicalOfficialSingleEditInvocation(
        toolName,
        input,
        historyToolName,
        historyToolInput,
        filePath
      )
    case "multi_replace_file_content":
      return buildCanonicalOfficialMultiEditInvocation(
        toolName,
        input,
        historyToolName,
        historyToolInput,
        filePath
      )
    case "write_to_file":
      return buildCanonicalOfficialWriteToFileInvocation(
        toolName,
        input,
        historyToolName,
        historyToolInput,
        filePath
      )
    case "search_web":
      return {
        toolName: "web_search",
        input: {
          query: pickFirstString(input, [
            "query",
            "search_query",
            "searchQuery",
          ]),
          domain: pickFirstString(input, ["domain"]),
        },
        historyToolName,
        historyToolInput,
      }
    case "read_url_content":
      return {
        toolName: "web_fetch",
        input: {
          url: pickFirstString(input, ["url", "Url", "URL"]),
        },
        historyToolName,
        historyToolInput,
      }
    case "command_status":
      return {
        toolName: "command_status",
        input: {
          commandId: pickFirstString(input, [
            "CommandId",
            "commandId",
            "command_id",
          ]),
          waitDurationSeconds: pickFirstNumber(input, [
            "WaitDurationSeconds",
            "waitDurationSeconds",
            "wait_duration_seconds",
          ]),
          outputCharacterCount: pickFirstNumber(input, [
            "OutputCharacterCount",
            "outputCharacterCount",
            "output_character_count",
          ]),
        },
        historyToolName,
        historyToolInput,
      }
    case "generate_image":
      return {
        toolName: "generate_image",
        input: {
          prompt: pickFirstString(input, ["Prompt", "prompt"]),
          filePath: pickFirstString(input, [
            "ImageName",
            "imageName",
            "image_name",
          ]),
          referenceImagePaths:
            pickStringArray(input, [
              "ImagePaths",
              "imagePaths",
              "image_paths",
            ]) || undefined,
        },
        historyToolName,
        historyToolInput,
      }
    case "browser_subagent":
      return {
        toolName: "task",
        input: {
          description:
            input.Task || input.task || input.description || input.TaskSummary,
          prompt: input.Task || input.task || input.description,
          subagent_type: OFFICIAL_ANTIGRAVITY_BROWSER_SUBAGENT_TYPE,
        },
        historyToolName,
        historyToolInput,
      }
    default:
      return null
  }
}
