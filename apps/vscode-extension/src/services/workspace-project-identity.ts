import { createHash } from "crypto"

export interface WorkspaceKeyInput {
  workspaceFileUri: string | undefined
  remoteName: string | undefined
  folderUris: string[]
  sessionId?: string
}

export function buildWorkspaceKey(input: WorkspaceKeyInput): string {
  const identity = input.workspaceFileUri
    ? `workspace-file\n${input.workspaceFileUri}`
    : [
        "workspace-folders",
        input.remoteName ?? "local",
        ...[...input.folderUris].sort(),
        input.folderUris.length === 0 ? (input.sessionId ?? "empty") : "",
      ].join("\n")
  return createHash("sha256").update(identity).digest("base64url")
}
