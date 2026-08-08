import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
} from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import {
  ContextTelemetryService,
  requireExactDurableIdentifier,
} from "./context"
import { CursorConnectStreamService } from "./protocol/cursor/cursor-connect-stream.service"
import { SessionLifecycleService } from "./protocol/cursor/session/session-lifecycle.service"

interface ManualCompactRequestBody {
  /** Cursor session id whose contextState we should compact. */
  conversationId?: string
  /**
   * Optional operator-selected request budget. Manual triggering is
   * independent from this value; omitting it uses the active model budget.
   */
  maxTokens?: number
}

interface ManualCompactResponseBody {
  ok: boolean
  conversationId: string
  applied: boolean
  reason?: string
  estimatedTokens?: number
  archivedMessageCount?: number
  summaryTokenCount?: number
}

interface WorkingDirectoriesRequestBody {
  /** One path for convenience; `paths` is preferred for batch updates. */
  path?: string
  /** Absolute or workspace-relative directories to add/remove. */
  paths?: string[]
}

/**
 * Read-only diagnostics + manual compaction control surface for the
 * dashboard.
 *
 * The endpoints are deliberately minimal: a counter snapshot for the
 * Diagnostics tab, and a one-shot manual compaction for the "compact
 * now" command-palette action.  Everything else (account state, quotas,
 * etc.) lives on `HealthController`.
 */
@ApiTags("Context")
@Controller("api/context")
export class ContextController {
  private readonly logger = new Logger(ContextController.name)

  constructor(
    private readonly telemetry: ContextTelemetryService,
    private readonly chatSessions: SessionLifecycleService,
    private readonly cursorStream: CursorConnectStreamService
  ) {}

  @Get("telemetry")
  @ApiOperation({
    summary: "Snapshot of the in-memory context-management telemetry counters",
  })
  getTelemetry() {
    const counters = this.telemetry.snapshot()
    const grouped: Record<string, Record<string, number>> = {}
    for (const [key, value] of Object.entries(counters)) {
      const [event, scope] = key.split("::")
      if (!event) continue
      const targetScope = scope || "global"
      grouped[event] = grouped[event] || {}
      grouped[event][targetScope] = value
    }
    return {
      timestamp: new Date().toISOString(),
      counters,
      grouped,
    }
  }

  @Get("sessions")
  @ApiOperation({
    summary:
      "List in-memory Cursor chat sessions with compaction-relevant metadata",
  })
  listSessions() {
    return {
      timestamp: new Date().toISOString(),
      sessions: this.chatSessions.listSessionSummaries(),
    }
  }

  @Get("runtime")
  @ApiOperation({
    summary: "Live Cursor agent activity used by bridge maintenance commands",
  })
  getRuntimeActivity() {
    return this.cursorStream.getRuntimeActivitySnapshot()
  }

  @Get(":conversationId/working-directories")
  @ApiOperation({
    summary: "List allowed working directories for a Cursor chat session",
  })
  getWorkingDirectories(@Param("conversationId") conversationId: string) {
    const session = this.chatSessions.getSession(conversationId)
    if (!session) {
      throw new HttpException(
        `Session not found: ${conversationId}`,
        HttpStatus.NOT_FOUND
      )
    }
    return {
      ok: true,
      conversationId,
      workspace: this.getWorkspaceDescriptor(conversationId),
    }
  }

  @Post(":conversationId/working-directories")
  @ApiOperation({
    summary: "Add additional working directories to a Cursor chat session",
  })
  addWorkingDirectories(
    @Param("conversationId") conversationId: string,
    @Body() body: WorkingDirectoriesRequestBody
  ) {
    const session = this.chatSessions.getSession(conversationId)
    if (!session) {
      throw new HttpException(
        `Session not found: ${conversationId}`,
        HttpStatus.NOT_FOUND
      )
    }
    const paths = this.normalizeWorkingDirectoryPaths(body)
    if (paths.length === 0) {
      throw new HttpException("paths is required", HttpStatus.BAD_REQUEST)
    }
    const added = this.chatSessions.addWorkspaceGrants(conversationId, paths)
    if (!added) {
      throw new HttpException(
        "Invalid working directories or no declared workspace",
        HttpStatus.BAD_REQUEST
      )
    }
    return {
      ok: true,
      conversationId,
      added: added.map((grant) => grant.path),
      workspace: this.getWorkspaceDescriptor(conversationId),
    }
  }

  @Delete(":conversationId/working-directories")
  @ApiOperation({
    summary: "Remove additional working directories from a Cursor chat session",
  })
  deleteWorkingDirectories(
    @Param("conversationId") conversationId: string,
    @Body() body: WorkingDirectoriesRequestBody
  ) {
    const session = this.chatSessions.getSession(conversationId)
    if (!session) {
      throw new HttpException(
        `Session not found: ${conversationId}`,
        HttpStatus.NOT_FOUND
      )
    }
    const paths = this.normalizeWorkingDirectoryPaths(body)
    if (paths.length === 0) {
      throw new HttpException("paths is required", HttpStatus.BAD_REQUEST)
    }
    const removed = this.chatSessions.removeWorkspaceGrants(
      conversationId,
      paths
    )
    if (!removed) {
      throw new HttpException(
        "Invalid working directories or no declared workspace",
        HttpStatus.BAD_REQUEST
      )
    }
    return {
      ok: true,
      conversationId,
      removed: removed.map((grant) => grant.path),
      workspace: this.getWorkspaceDescriptor(conversationId),
    }
  }

  @Post("compact")
  @ApiOperation({
    summary:
      "Force a manual compaction commit on the given session's transcript",
  })
  async manualCompact(
    @Body() body: ManualCompactRequestBody
  ): Promise<ManualCompactResponseBody> {
    let conversationId: string
    try {
      conversationId = requireExactDurableIdentifier(
        body.conversationId,
        "conversationId"
      )
    } catch {
      throw new HttpException(
        "conversationId must be an exact non-empty session identifier",
        HttpStatus.BAD_REQUEST
      )
    }

    const session = this.chatSessions.getSession(conversationId)
    if (!session) {
      throw new HttpException(
        `Session not found: ${conversationId}`,
        HttpStatus.NOT_FOUND
      )
    }

    const maxTokens =
      typeof body.maxTokens === "number" &&
      Number.isFinite(body.maxTokens) &&
      body.maxTokens > 0
        ? Math.floor(body.maxTokens)
        : undefined

    const result = await this.cursorStream.compactConversationNow(
      conversationId,
      maxTokens
    )

    if (!result.applied) {
      return {
        ok: true,
        conversationId,
        applied: false,
        reason: "no_progress",
        estimatedTokens: result.estimatedTokens,
      }
    }

    this.logger.warn(
      `Manual compaction applied for ${conversationId}: ${result.archivedMessageCount} records archived, ` +
        `summary=${result.summaryTokenCount} tokens`
    )

    return {
      ok: true,
      conversationId,
      applied: true,
      estimatedTokens: result.estimatedTokens,
      archivedMessageCount: result.archivedMessageCount,
      summaryTokenCount: result.summaryTokenCount,
    }
  }

  @Post(":conversationId/force-snip")
  @ApiOperation({
    summary:
      "Force-snip the active Claude conversation: replace its current " +
      "model-facing graph messages with one durable Snip boundary.",
  })
  async forceSnip(
    @Param("conversationId") conversationId: string,
    @Body() body: { reason?: string } | undefined
  ): Promise<{
    ok: boolean
    conversationId: string
    applied: boolean
    snippedCount: number
    totalRecords: number
    boundaryId?: string
    reason?: string
  }> {
    const session = this.chatSessions.getSession(conversationId)
    if (!session) {
      throw new HttpException(
        `Session not found: ${conversationId}`,
        HttpStatus.NOT_FOUND
      )
    }
    const result = await this.cursorStream.forceSnipConversation(
      conversationId,
      {
        ...(typeof body?.reason === "string" ? { reason: body.reason } : {}),
      }
    )

    this.logger.warn(
      `Force-snip ${result.applied ? "applied" : "skipped"} for ${conversationId}: removed ${result.snippedCount} record(s), boundary=${result.boundaryId || "(none)"}`
    )

    return {
      ok: true,
      conversationId,
      ...result,
    }
  }

  private normalizeWorkingDirectoryPaths(
    body: WorkingDirectoriesRequestBody
  ): string[] {
    const raw = [
      ...(Array.isArray(body.paths) ? body.paths : []),
      ...(typeof body.path === "string" ? [body.path] : []),
    ]
    const seen = new Set<string>()
    const out: string[] = []
    for (const value of raw) {
      const normalized = typeof value === "string" ? value.trim() : ""
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      out.push(normalized)
    }
    return out
  }

  private getWorkspaceDescriptor(conversationId: string) {
    const snapshot = this.chatSessions.getWorkspaceScopeSnapshot(conversationId)
    if (!snapshot) return null
    return {
      scope: snapshot,
      roots: this.chatSessions.getWorkspaceRootSources(conversationId),
    }
  }
}
