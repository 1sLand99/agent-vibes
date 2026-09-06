import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  installCodexModelCatalog,
  removeCodexModelCatalog,
} from "./codex-model-catalog"

interface CatalogSnapshot {
  clientVersion: string
  fetchedAt: number
  etag?: string
  models: unknown[]
}

/** Last-known-good catalogs, isolated by provider, account and CLI version. */
export class CodexModelCatalogCache {
  private readonly snapshots = new Map<string, CatalogSnapshot>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly retryAt = new Map<string, number>()
  private readonly loaded = new Set<string>()
  private readonly revisions = new Map<string, number>()

  invalidate(scope: string, etag: string | null | undefined): void {
    const current = this.snapshots.get(scope)
    if (etag && current && current.etag !== etag) current.fetchedAt = 0
  }

  remove(scope: string): void {
    this.revisions.set(scope, (this.revisions.get(scope) ?? 0) + 1)
    removeCodexModelCatalog(scope)
    this.snapshots.delete(scope)
    this.loaded.delete(scope)
    this.retryAt.delete(scope)
  }

  async refresh(options: {
    scope: string
    directory: string
    clientVersion: string
    fetchCatalog: (etag?: string) => Promise<Response>
    onError: (error: unknown) => void
  }): Promise<void> {
    const { scope } = options
    const pending = this.pending.get(scope)
    if (pending) return pending
    const task = this.refreshOnce(options)
      .catch(options.onError)
      .finally(() => {
        this.pending.delete(scope)
      })
    this.pending.set(scope, task)
    return task
  }

  private async refreshOnce(options: {
    scope: string
    directory: string
    clientVersion: string
    fetchCatalog: (etag?: string) => Promise<Response>
  }): Promise<void> {
    const { scope, directory, clientVersion } = options
    const revision = this.revisions.get(scope) ?? 0
    const removed = () => revision !== (this.revisions.get(scope) ?? 0)
    const filename = join(
      directory,
      `${createHash("sha256").update(scope).digest("hex")}.json`
    )
    if (!this.loaded.has(scope)) {
      this.loaded.add(scope)
      try {
        const saved = JSON.parse(
          await readFile(filename, "utf8")
        ) as CatalogSnapshot
        if (removed()) return
        if (
          saved.clientVersion === clientVersion &&
          Number.isFinite(saved.fetchedAt) &&
          Array.isArray(saved.models)
        ) {
          installCodexModelCatalog(scope, saved.models)
          this.snapshots.set(scope, saved)
        }
      } catch {
        /* Missing or corrupt cache: fetch a fresh catalog. */
      }
    }
    const current = this.snapshots.get(scope)
    if (
      current &&
      current.clientVersion === clientVersion &&
      Date.now() - current.fetchedAt < 300_000
    )
      return
    if ((this.retryAt.get(scope) ?? 0) > Date.now()) return
    this.retryAt.set(scope, Date.now() + 30_000)
    const response = await options.fetchCatalog(current?.etag)
    if (removed()) {
      await response.body?.cancel()
      return
    }
    let snapshot: CatalogSnapshot
    if (response.status === 304 && current) {
      snapshot = { ...current, fetchedAt: Date.now() }
    } else {
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Codex model catalog returned HTTP ${response.status}`)
      }
      const body = (await response.json()) as { models?: unknown[] }
      if (!Array.isArray(body.models))
        throw new Error("Codex model catalog has no models array")
      if (removed()) return
      // Validate atomically before replacing the last-known-good snapshot.
      installCodexModelCatalog(scope, body.models)
      snapshot = {
        clientVersion,
        fetchedAt: Date.now(),
        etag: response.headers.get("etag") ?? undefined,
        models: body.models,
      }
    }
    this.snapshots.set(scope, snapshot)
    this.retryAt.delete(scope)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${filename}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 })
    await rename(temporary, filename)
  }
}
