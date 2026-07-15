import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Put,
  Req,
} from "@nestjs/common"
import type { FastifyRequest } from "fastify"
import {
  GitBranchService,
  type GitBranchState,
} from "../session/git-branch.service"
import { WorkspacePreferenceService } from "../session/workspace-preference.service"
import { requireAgentInputControlAccess } from "./agent-input-control-access"

interface BranchSelectionBody {
  branch?: unknown
}

type BranchPickerState = GitBranchState | { kind: "no-project" }

type BranchSelectionResult = { ok: boolean; message?: string }

@Controller("api/agent-input")
export class WorkspaceBranchController {
  constructor(
    private readonly workspacePreferences: WorkspacePreferenceService,
    private readonly gitBranches: GitBranchService
  ) {}

  @Get("branches/:composerId")
  async getBranches(
    @Req() request: FastifyRequest,
    @Headers("authorization") authorization: string | undefined,
    @Param("composerId") composerId: string
  ): Promise<BranchPickerState> {
    const controlToken = requireAgentInputControlAccess(request, authorization)
    const folder = this.workspacePreferences.resolveSelectedFolder(
      controlToken,
      composerId
    )
    if (!folder) return { kind: "no-project" }
    return this.gitBranches.getBranchState(folder.path)
  }

  @Put("branches/:composerId")
  async selectBranch(
    @Req() request: FastifyRequest,
    @Headers("authorization") authorization: string | undefined,
    @Param("composerId") composerId: string,
    @Body() body: BranchSelectionBody
  ): Promise<BranchSelectionResult> {
    const controlToken = requireAgentInputControlAccess(request, authorization)
    if (typeof body.branch !== "string" || !body.branch.trim()) {
      throw new BadRequestException("branch is required")
    }
    const folder = this.workspacePreferences.resolveSelectedFolder(
      controlToken,
      composerId
    )
    if (!folder) {
      return { ok: false, message: "No project selected for this chat" }
    }
    const result = await this.gitBranches.checkout(
      folder.path,
      body.branch.trim()
    )
    return result.ok ? { ok: true } : { ok: false, message: result.message }
  }
}
