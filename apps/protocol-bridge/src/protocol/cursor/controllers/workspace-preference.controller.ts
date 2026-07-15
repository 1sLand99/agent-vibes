import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Put,
  Req,
} from "@nestjs/common"
import type { FastifyRequest } from "fastify"
import type {
  RegisteredWorkspaceFolder,
  WorkspaceRegistrationInput,
} from "../session/workspace-preference"
import { WorkspacePreferenceService } from "../session/workspace-preference.service"
import {
  isLoopbackControlAddress,
  parseControlBearerToken,
  requireAgentInputControlAccess,
} from "./agent-input-control-access"

export { isLoopbackControlAddress, parseControlBearerToken }

interface WorkspaceSyncBody {
  workspaceKey?: unknown
  folders?: unknown
}

interface WorkspaceSelectionBody {
  workspaceKey?: unknown
  folderUri?: unknown
}

function readWorkspaceFolders(value: unknown): RegisteredWorkspaceFolder[] {
  if (!Array.isArray(value))
    throw new BadRequestException("folders is required")

  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new BadRequestException("invalid workspace folder")
    }
    const folder = entry as Record<string, unknown>
    if (
      typeof folder.uri !== "string" ||
      typeof folder.path !== "string" ||
      typeof folder.name !== "string"
    ) {
      throw new BadRequestException("invalid workspace folder")
    }
    return {
      uri: folder.uri,
      path: folder.path,
      name: folder.name,
    }
  })
}

@Controller("api/agent-input")
export class WorkspacePreferenceController {
  constructor(
    private readonly workspacePreferences: WorkspacePreferenceService
  ) {}

  @Put("workspaces/:instanceId")
  synchronizeWorkspace(
    @Req() request: FastifyRequest,
    @Headers("authorization") authorization: string | undefined,
    @Param("instanceId") instanceId: string,
    @Body() body: WorkspaceSyncBody
  ): { ok: true } {
    const controlToken = this.requireControlAccess(request, authorization)
    if (typeof body.workspaceKey !== "string") {
      throw new BadRequestException("workspaceKey is required")
    }
    const input: WorkspaceRegistrationInput = {
      instanceId,
      workspaceKey: body.workspaceKey,
      folders: readWorkspaceFolders(body.folders),
    }
    if (!this.workspacePreferences.synchronizeWorkspace(controlToken, input)) {
      throw new BadRequestException("invalid workspace registration")
    }
    return { ok: true }
  }

  @Delete("workspaces/:instanceId")
  removeWorkspace(
    @Req() request: FastifyRequest,
    @Headers("authorization") authorization: string | undefined,
    @Param("instanceId") instanceId: string
  ): { ok: true } {
    const controlToken = this.requireControlAccess(request, authorization)
    if (!this.workspacePreferences.removeWorkspace(controlToken, instanceId)) {
      throw new ForbiddenException("workspace registration token mismatch")
    }
    return { ok: true }
  }

  @Get("projects/:composerId")
  getProjects(
    @Req() request: FastifyRequest,
    @Headers("authorization") authorization: string | undefined,
    @Param("composerId") composerId: string
  ) {
    const controlToken = this.requireControlAccess(request, authorization)
    return this.workspacePreferences.getPickerState(controlToken, composerId)
  }

  @Put("projects/:composerId")
  selectProject(
    @Req() request: FastifyRequest,
    @Headers("authorization") authorization: string | undefined,
    @Param("composerId") composerId: string,
    @Body() body: WorkspaceSelectionBody
  ): { ok: true } {
    const controlToken = this.requireControlAccess(request, authorization)
    if (
      typeof body.workspaceKey !== "string" ||
      typeof body.folderUri !== "string"
    ) {
      throw new BadRequestException("workspaceKey and folderUri are required")
    }
    if (
      !this.workspacePreferences.selectWorkspace(controlToken, {
        composerId,
        workspaceKey: body.workspaceKey,
        folderUri: body.folderUri,
      })
    ) {
      throw new BadRequestException("folder is not in the registered workspace")
    }
    return { ok: true }
  }

  private requireControlAccess(
    request: FastifyRequest,
    authorization: string | undefined
  ): string {
    return requireAgentInputControlAccess(request, authorization)
  }
}
