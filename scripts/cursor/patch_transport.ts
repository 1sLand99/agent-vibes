#!/usr/bin/env node
/**
 * Cursor Transport Layer Patcher
 *
 * Applies the same optional traffic-capture patch exposed by the Agent Vibes
 * extension. The capture stays disabled until this command or the Dashboard
 * action explicitly applies it.
 *
 * Usage:
 *   node --import tsx scripts/cursor/patch_transport.ts [--restore] [--status]
 */

import * as fs from "fs"
import * as path from "path"
import {
  CURSOR_TRAFFIC_CAPTURE_MARKERS,
  CURSOR_TRAFFIC_CAPTURE_RULES,
  getCursorTrafficCaptureDetails,
  patchCursorTrafficCaptureContent,
} from "../../apps/vscode-extension/src/services/cursor-traffic-capture"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const platform = require(path.join(__dirname, "..", "lib", "platform"))

const CURSOR_WORKBENCH_PATH: string = platform.cursorWorkbenchPath()
const BACKUP_SUFFIX = ".transport_backup"

function isFilePatched(content: string): boolean {
  return CURSOR_TRAFFIC_CAPTURE_MARKERS.some((marker) =>
    content.includes(marker)
  )
}

function createBackup(targetFile: string): boolean {
  const backupPath = targetFile + BACKUP_SUFFIX
  const currentContent = fs.readFileSync(targetFile, "utf-8")

  if (fs.existsSync(backupPath)) {
    const backupContent = fs.readFileSync(backupPath, "utf-8")
    if (isFilePatched(backupContent)) {
      console.error("ERROR: Backup file contains traffic-capture patches.")
      console.error(`Delete it after reinstalling Cursor: ${backupPath}`)
      return false
    }
    console.log("Backup already exists and is clean, skipping")
    return true
  }

  if (isFilePatched(currentContent)) {
    console.error(
      "ERROR: Cursor traffic capture is already active without a clean backup."
    )
    return false
  }

  console.log(`Creating backup at ${backupPath}`)
  fs.copyFileSync(targetFile, backupPath)
  console.log("Backup created successfully")
  return true
}

function restoreBackup(targetFile: string): boolean {
  const backupPath = targetFile + BACKUP_SUFFIX
  if (!fs.existsSync(backupPath)) {
    console.error("ERROR: No backup found.")
    return false
  }

  const backupContent = fs.readFileSync(backupPath, "utf-8")
  if (isFilePatched(backupContent)) {
    console.error("ERROR: Backup file contains traffic-capture patches.")
    return false
  }

  console.log(`Restoring from ${backupPath}`)
  fs.copyFileSync(backupPath, targetFile)
  console.log("Restored successfully")
  return true
}

function applyPatches(targetFile: string): boolean {
  console.log(`Reading ${targetFile}...`)
  const content = fs.readFileSync(targetFile, "utf-8")
  const details = getCursorTrafficCaptureDetails(content)
  if (details.applied) {
    console.log(
      `All ${details.totalRules} Cursor traffic-capture hooks are already active.`
    )
    return true
  }
  if (!details.canApply) {
    console.error("Cursor traffic capture is unavailable for this build:")
    for (const name of details.missingRuleNames) {
      console.error(`  - ${name}`)
    }
    return false
  }

  const patched = patchCursorTrafficCaptureContent(content)
  if (patched === null) {
    console.error("Cursor traffic capture could not be applied safely.")
    return false
  }

  fs.writeFileSync(targetFile, patched, "utf-8")
  console.log(
    `Applied ${details.availableRuleNames.length} Cursor traffic-capture hook(s).`
  )
  return true
}

function checkStatus(targetFile: string): void {
  const details = getCursorTrafficCaptureDetails(
    fs.readFileSync(targetFile, "utf-8")
  )
  const applied = new Set(details.appliedRuleNames)
  console.log("Cursor traffic-capture status:")
  for (const rule of CURSOR_TRAFFIC_CAPTURE_RULES) {
    console.log(`  ${rule.name}: ${applied.has(rule.name) ? "active" : "off"}`)
  }
}

function checkMatch(targetFile: string): boolean {
  const backupPath = targetFile + BACKUP_SUFFIX
  const sourcePath = fs.existsSync(backupPath) ? backupPath : targetFile
  const details = getCursorTrafficCaptureDetails(
    fs.readFileSync(sourcePath, "utf-8")
  )
  const available = new Set([
    ...details.appliedRuleNames,
    ...details.availableRuleNames,
  ])
  console.log(
    `Checking bounded semantic matches (${sourcePath === backupPath ? "clean backup" : "current file"})...`
  )
  for (const rule of CURSOR_TRAFFIC_CAPTURE_RULES) {
    console.log(
      `  ${rule.name}: ${available.has(rule.name) ? "match" : "missing"}`
    )
  }
  return details.canApply
}

async function main(): Promise<void> {
  if (!fs.existsSync(CURSOR_WORKBENCH_PATH)) {
    console.error("Error: Cursor workbench file not found")
    process.exit(1)
  }

  const args = process.argv.slice(2)
  if (args.includes("--restore")) {
    process.exit(restoreBackup(CURSOR_WORKBENCH_PATH) ? 0 : 1)
  }
  if (args.includes("--status")) {
    checkStatus(CURSOR_WORKBENCH_PATH)
    return
  }
  if (args.includes("--check-match")) {
    process.exit(checkMatch(CURSOR_WORKBENCH_PATH) ? 0 : 1)
  }
  if (args.includes("--help")) {
    console.log(`
Cursor Transport Layer Patcher

Usage:
  agent-vibes patch [options]

Options:
  --restore      Restore the pre-capture workbench backup
  --status       Check traffic-capture hook status
  --check-match  Verify the current Cursor build is supported
  --help         Show this help message

Traffic capture is disabled by default and may include sensitive request data.
`)
    return
  }

  if (!createBackup(CURSOR_WORKBENCH_PATH)) process.exit(1)
  if (!applyPatches(CURSOR_WORKBENCH_PATH)) process.exit(1)

  console.log(
    "Fully restart Cursor, then run npm run cursor:debug to collect logs."
  )
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
