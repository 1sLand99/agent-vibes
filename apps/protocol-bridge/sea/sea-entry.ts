/**
 * SEA (Single Executable Application) entry point.
 *
 * This file wraps the NestJS main.ts with SEA-aware initialization:
 * - Detects SEA mode via node:sea API
 * - Extracts SQL migration assets to disk for PersistenceService
 * - Then starts the normal NestJS bootstrap
 */

// CRITICAL: reflect-metadata MUST be imported FIRST for NestJS DI to work in esbuild bundle
import "reflect-metadata"

// Node 24 still labels node:sqlite experimental even though SQLite is the
// bridge's intentional persistence runtime. Suppress only that exact built-in
// notice in the packaged daemon; preserve the default handler for every other
// process warning so real deprecations and runtime defects stay visible.
const inheritedWarningListeners = process.listeners("warning")
process.removeAllListeners("warning")
process.on("warning", (warning: Error) => {
  if (
    warning.name === "ExperimentalWarning" &&
    warning.message ===
      "SQLite is an experimental feature and might change at any time"
  ) {
    return
  }
  for (const listener of inheritedWarningListeners) {
    listener.call(process, warning)
  }
})

const sea = (() => {
  try {
    return require("node:sea")
  } catch {
    return null
  }
})()

if (sea && sea.isSea()) {
  const fs = require("fs")
  const path = require("path")
  const os = require("os")

  // Every process receives an isolated migration directory populated only
  // from this executable's immutable assets. Never reuse user-data or prior
  // package files: the running binary must define the exact migration set.
  const migrationsDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-vibes-migrations-")
  )

  for (const key of sea.getAssetKeys()) {
    if (key.endsWith(".sql")) {
      if (path.basename(key) !== key) {
        throw new Error(`[SEA] Invalid migration asset key: ${key}`)
      }
      const targetPath = path.join(migrationsDir, key)
      const content = sea.getAsset(key, "utf-8")
      fs.writeFileSync(targetPath, content, { flag: "wx", mode: 0o600 })
      console.log(`[SEA] Loaded migration asset: ${key}`)
    }
  }

  process.once("exit", () => {
    fs.rmSync(migrationsDir, { recursive: true, force: true })
  })

  // PersistenceService consumes only this process-owned asset snapshot.
  process.env.SEA_MIGRATIONS_DIR = migrationsDir
}

// Boot the NestJS application
require("../src/main")
