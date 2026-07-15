import { randomBytes, randomUUID } from "crypto"
import * as fs from "fs"
import * as http from "http"
import * as https from "https"
import * as vscode from "vscode"
import { logger } from "../utils/logger"
import { ConfigManager } from "./config-manager"
import { buildWorkspaceKey } from "./workspace-project-identity"

const CONTROL_TOKEN_SECRET_KEY = "agentVibes.agentInputControlToken"
const WORKSPACE_SYNC_INTERVAL_MS = 20_000

export async function getOrCreateAgentInputControlToken(
  secrets: vscode.SecretStorage
): Promise<string> {
  const existing = await secrets.get(CONTROL_TOKEN_SECRET_KEY)
  if (existing) return existing

  const created = randomBytes(32).toString("base64url")
  await secrets.store(CONTROL_TOKEN_SECRET_KEY, created)
  return created
}

type WorkspaceControlRequest = {
  method: "PUT" | "DELETE"
  path: string
  body?: Record<string, unknown>
}

export class WorkspaceProjectSync implements vscode.Disposable {
  private readonly instanceId = randomUUID()
  private readonly subscriptions: vscode.Disposable[] = []
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private bridgeRunning = false
  private disposed = false

  constructor(
    private readonly config: ConfigManager,
    private readonly controlToken: string
  ) {}

  start(): void {
    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.synchronize()
      })
    )
    this.heartbeat = setInterval(() => {
      void this.synchronize()
    }, WORKSPACE_SYNC_INTERVAL_MS)
  }

  setBridgeRunning(running: boolean): void {
    this.bridgeRunning = running
    if (running) void this.synchronize()
  }

  async synchronize(): Promise<void> {
    if (!this.bridgeRunning || this.disposed) return

    const workspaceFolders = vscode.workspace.workspaceFolders ?? []
    const folderUris = workspaceFolders.map((folder) =>
      folder.uri.toString(true)
    )
    const workspaceKey = buildWorkspaceKey({
      workspaceFileUri: vscode.workspace.workspaceFile?.toString(true),
      remoteName: vscode.env.remoteName,
      folderUris,
      sessionId: vscode.env.sessionId,
    })

    try {
      await this.request({
        method: "PUT",
        path: `/api/agent-input/workspaces/${encodeURIComponent(this.instanceId)}`,
        body: {
          workspaceKey,
          folders: workspaceFolders.map((folder) => ({
            uri: folder.uri.toString(true),
            path: folder.uri.fsPath,
            name: folder.name,
          })),
        },
      })
    } catch (error) {
      logger.debug(
        `Agent input workspace sync failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const subscription of this.subscriptions) subscription.dispose()
    this.subscriptions.length = 0
    if (this.bridgeRunning) {
      void this.request({
        method: "DELETE",
        path: `/api/agent-input/workspaces/${encodeURIComponent(this.instanceId)}`,
      }).catch((error) => {
        logger.debug(
          `Agent input workspace unregister failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    }
  }

  private request(options: WorkspaceControlRequest): Promise<void> {
    const body = options.body ? JSON.stringify(options.body) : undefined
    const useHttps = this.config.hasCertificates()
    const transport = useHttps ? https : http
    const requestOptions: https.RequestOptions = {
      hostname: "localhost",
      port: this.config.port,
      path: options.path,
      method: options.method,
      headers: {
        authorization: `Bearer ${this.controlToken}`,
        ...(body
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            }
          : {}),
      },
      ...(useHttps ? { ca: fs.readFileSync(this.config.caCertPath) } : {}),
    }

    return new Promise((resolve, reject) => {
      const request = transport.request(requestOptions, (response) => {
        response.resume()
        if (
          response.statusCode !== undefined &&
          response.statusCode >= 200 &&
          response.statusCode < 300
        ) {
          resolve()
          return
        }
        reject(
          new Error(`bridge returned HTTP ${response.statusCode ?? "unknown"}`)
        )
      })
      request.on("error", reject)
      request.setTimeout(5_000, () => {
        request.destroy(new Error("bridge request timed out"))
      })
      if (body) request.write(body)
      request.end()
    })
  }
}
