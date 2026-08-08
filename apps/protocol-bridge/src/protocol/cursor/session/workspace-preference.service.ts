import { Inject, Injectable } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import { PersistenceService } from "../../../persistence"
import type { ParsedCursorRequest } from "../tools/cursor-request-parser"
import {
  ConversationId,
  type ConversationId as ConversationIdType,
} from "../turn/turn.types"
import {
  WorkspacePreferenceRegistry,
  type RegisteredWorkspaceFolder,
  type WorkspacePickerState,
  type WorkspacePreferenceRecord,
  type WorkspacePreferenceRepository,
  type WorkspaceRegistrationInput,
  type WorkspaceSelectionInput,
} from "./workspace-preference"

type WorkspacePreferenceRow = {
  composer_id: string
  workspace_key: string
  folder_uri: string
  folder_path: string
  updated_at: number
}

type WorkspacePreferencePersistence = Pick<PersistenceService, "database">

export class SqliteWorkspacePreferenceRepository implements WorkspacePreferenceRepository {
  private getStatement?: StatementSync
  private upsertStatement?: StatementSync

  constructor(private readonly persistence: WorkspacePreferencePersistence) {}

  get(composerId: ConversationIdType): WorkspacePreferenceRecord | undefined {
    const exactComposerId = ConversationId.of(composerId)
    const statement = (this.getStatement ??= this.persistence.database.prepare(
      `SELECT composer_id, workspace_key, folder_uri, folder_path, updated_at
         FROM workspace_preferences
        WHERE composer_id = ?`
    ))
    const row = statement.get(exactComposerId) as
      | WorkspacePreferenceRow
      | undefined
    if (!row) return undefined
    return {
      composerId: ConversationId.of(row.composer_id),
      workspaceKey: requireExactDurableIdentifier(
        row.workspace_key,
        "workspace preference workspaceKey"
      ),
      folderUri: row.folder_uri,
      folderPath: row.folder_path,
      updatedAt: row.updated_at,
    }
  }

  upsert(record: WorkspacePreferenceRecord): void {
    const composerId = ConversationId.of(record.composerId)
    const workspaceKey = requireExactDurableIdentifier(
      record.workspaceKey,
      "workspace preference workspaceKey"
    )
    const statement = (this.upsertStatement ??=
      this.persistence.database.prepare(
        `INSERT INTO workspace_preferences (
         composer_id, workspace_key, folder_uri, folder_path, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(composer_id) DO UPDATE SET
         workspace_key = excluded.workspace_key,
         folder_uri = excluded.folder_uri,
         folder_path = excluded.folder_path,
         updated_at = excluded.updated_at`
      ))
    statement.run(
      composerId,
      workspaceKey,
      record.folderUri,
      record.folderPath,
      record.updatedAt
    )
  }
}

@Injectable()
export class WorkspacePreferenceService {
  private readonly registry: WorkspacePreferenceRegistry

  constructor(@Inject(PersistenceService) persistence: PersistenceService) {
    this.registry = new WorkspacePreferenceRegistry(
      new SqliteWorkspacePreferenceRepository(persistence)
    )
  }

  synchronizeWorkspace(
    controlToken: string,
    input: WorkspaceRegistrationInput
  ): boolean {
    return this.registry.synchronizeWorkspace(controlToken, input)
  }

  removeWorkspace(controlToken: string, instanceId: string): boolean {
    return this.registry.removeWorkspace(controlToken, instanceId)
  }

  getPickerState(
    controlToken: string,
    composerId: string
  ): WorkspacePickerState {
    return this.registry.getPickerState(controlToken, composerId)
  }

  selectWorkspace(
    controlToken: string,
    input: WorkspaceSelectionInput
  ): boolean {
    return this.registry.selectWorkspace(controlToken, input)
  }

  resolveSelectedFolder(
    controlToken: string,
    composerId: string
  ): RegisteredWorkspaceFolder | null {
    return this.registry.resolveSelectedFolder(controlToken, composerId)
  }

  applyToRequest(
    conversationId: string,
    request: ParsedCursorRequest
  ): ParsedCursorRequest {
    return this.registry.applyToRequest(
      ConversationId.of(conversationId),
      request
    )
  }
}
