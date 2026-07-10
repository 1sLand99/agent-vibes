#!/usr/bin/env node
/**
 * Cursor Transport Layer Patcher
 *
 * Applies patches to capture ALL network traffic at the transport layer.
 * This intercepts requests and responses at a lower level than application-specific patches.
 *
 * Usage:
 *   node --import tsx scripts/cursor/patch_transport.ts [--restore] [--status]
 */

import * as fs from "fs"
import * as path from "path"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const platform = require(path.join(__dirname, "..", "lib", "platform"))

const CURSOR_WORKBENCH_PATH: string = platform.cursorWorkbenchPath()
const BACKUP_SUFFIX = ".transport_backup"

interface PatchRule {
  name: string
  find: string | RegExp
  replace: string
  marker: string
}

const TRANSPORT_PATCHES: PatchRule[] = [
  // ============ Stream Transport Layer Patches ============
  // All patches use capture groups for minified variable names so that
  // re-minification across Cursor releases does not break the matchers.
  // Anchors are stable: string literals, $pushAi.../$callAi... method names,
  // and field accesses like .typeName/.I/.O/.toBinary/.fromBinary/.message.

  // Patch 1: Log request metadata when stream is initiated
  // Anchors: structuredLogService.debug + "Initiating stream AI connect"
  {
    name: "Transport Request Initiation",
    find: /this\.structuredLogService\.debug\("transport","Initiating stream AI connect",\{service:(\w+)\.typeName,method:(\w+)\.name,streamId:(\w+),requestId:(\w+)\?\?"not-found"/,
    replace:
      'console.warn("[TRANSPORT_REQUEST]",JSON.stringify({service:$1.typeName,method:$2.name,streamId:$3,requestId:$4,requestType:$2.I?.typeName,responseType:$2.O?.typeName})),this.structuredLogService.debug("transport","Initiating stream AI connect",{service:$1.typeName,method:$2.name,streamId:$3,requestId:$4??"not-found"',
    marker: "[TRANSPORT_REQUEST]",
  },
  // Patch 2: Capture full request payload BEFORE serialization (JSON format)
  // Anchors: new <method>.I(...) + .wrap(.toBinary()) followed by ; (assignment, stream side)
  {
    name: "Transport Request Payload",
    find: /const (\w+)=new (\w+)\.I\((\w+)\);(\w+)=(\w+)\.wrap\(\1\.toBinary\(\)\)/,
    replace:
      'const $1=new $2.I($3);(()=>{try{console.warn("[TRANSPORT_REQUEST_PAYLOAD]",JSON.stringify({type:$2.I?.typeName,payload:$1.toJson?$1.toJson():$3}))}catch(xErr){console.warn("[TRANSPORT_REQUEST_PAYLOAD]",JSON.stringify({type:$2.I?.typeName,error:String(xErr)}))}})();$4=$5.wrap($1.toBinary())',
    marker: "[TRANSPORT_REQUEST_PAYLOAD]",
  },
  // Patch 3: Capture response chunk with binary data (base64 encoded for debugging)
  // Anchors: $pushAiConnectTransportStreamChunk proxy method call
  {
    name: "Transport Response Chunk",
    find: /this\._proxy\.\$pushAiConnectTransportStreamChunk\((\w+),(\w+),(\w+)\)/,
    replace:
      '(console.warn("[TRANSPORT_CHUNK]",JSON.stringify({streamId:$2,chunkSize:$1?.length||0,chunkB64:$1?btoa(String.fromCharCode.apply(null,$1.slice(0,2000))):null})),this._proxy.$pushAiConnectTransportStreamChunk($1,$2,$3))',
    marker: "[TRANSPORT_CHUNK]",
  },
  // Patch 4: Capture deserialized response in the generator yield
  // Anchors: for await + isCancellationRequested + <method>.O.fromBinary(*.buffer)
  {
    name: "Transport Response Yield",
    find: /for await\(const (\w+) of (\w+)\)\{if\((\w+)\.token\.isCancellationRequested\)continue;yield (\w+)\.O\.fromBinary\(\1\.buffer\)\}/,
    replace:
      'for await(const $1 of $2){if($3.token.isCancellationRequested)continue;const xResp=$4.O.fromBinary($1.buffer);(()=>{try{console.warn("[TRANSPORT_RESPONSE]",JSON.stringify({type:$4.O?.typeName,payload:xResp.toJson?xResp.toJson():xResp}))}catch(xErr){console.warn("[TRANSPORT_RESPONSE]",JSON.stringify({type:$4.O?.typeName,error:String(xErr)}))}})();yield xResp}',
    marker: "[TRANSPORT_RESPONSE]",
  },
  // Patch 5: Log when provider stream call completes with headers
  // Anchors: $callAiConnectTransportProviderStream + (<svc>.typeName in <map>, <svc>.typeName)
  //          + <helper>(<method>.name) + _streamIdToAsyncReturnQueue
  {
    name: "Transport Call Complete",
    find: /const (\w+)=await this\._proxy\.\$callAiConnectTransportProviderStream\((\w+),\((\w+)\.typeName in ([A-Za-z0-9_$]+),\3\.typeName\),([A-Za-z0-9_$]+)\((\w+)\.name\),(\w+),(\w+),(\w+),(\w+)\.token\),(\w+)=this\._streamIdToAsyncReturnQueue/,
    replace:
      'const $1=(console.warn("[TRANSPORT_STREAM_STARTED]",JSON.stringify({streamId:$2,service:$3.typeName,method:$6.name,headers:$8})),await this._proxy.$callAiConnectTransportProviderStream($2,($3.typeName in $4,$3.typeName),$5($6.name),$7,$8,$9,$10.token)),$11=this._streamIdToAsyncReturnQueue',
    marker: "[TRANSPORT_STREAM_STARTED]",
  },

  // ============ Unary Transport Layer Patches ============
  // Patch 6: Capture unary request before serialization (with filtering)
  // Anchors: new <method>.I(...) + .wrap(.toBinary()) followed by , (declaration list, unary side)
  //          + ;if(!(<svc>.typeName in ...) (unary-only service whitelist check)
  {
    name: "Unary Request Payload",
    find: /const (\w+)=new (\w+)\.I\((\w+)\),(\w+)=(\w+)\.wrap\(\1\.toBinary\(\)\);if\(!\((\w+)\.typeName in/,
    replace:
      'const $1=new $2.I($3),$4=$5.wrap($1.toBinary());(()=>{try{const svc=$6.typeName,mth=$2.name;const skip=["GetTeams","GetUser","GetSubscription","CheckQueuePosition","FlushEvents","Batch","SubmitLogs","SubmitSpans","BootstrapStatsig","ReportClientNumericMetrics"];if(skip.includes(mth))return;console.warn("[UNARY_REQUEST]",JSON.stringify({service:svc,method:mth,type:$2.I?.typeName,payload:$1.toJson?$1.toJson():$3}))}catch(xErr){console.warn("[UNARY_REQUEST]",JSON.stringify({service:$6.typeName,method:$2.name,type:$2.I?.typeName,error:String(xErr)}))}})();if(!($6.typeName in',
    marker: "[UNARY_REQUEST]",
  },
  // Patch 7: Capture unary response after deserialization (with filtering)
  // Anchors: .message + .header + .trailer + <method>.O.fromBinary(*) + return{service:<svc>,method:<method>
  {
    name: "Unary Response",
    find: /const (\w+)=(\w+)\.message,(\w+)=\2\.header,(\w+)=\2\.trailer,(\w+)=(\w+)\.O\.fromBinary\(\1\);return\{service:(\w+),method:\6/,
    replace:
      'const $1=$2.message,$3=$2.header,$4=$2.trailer,$5=$6.O.fromBinary($1);(()=>{try{const svc=$7.typeName,mth=$6.name;const skip=["GetTeams","GetUser","GetSubscription","CheckQueuePosition","FlushEvents","Batch","SubmitLogs","SubmitSpans","BootstrapStatsig","ReportClientNumericMetrics"];if(skip.includes(mth))return;console.warn("[UNARY_RESPONSE]",JSON.stringify({service:svc,method:mth,type:$6.O?.typeName,payload:$5.toJson?$5.toJson():$5}))}catch(xErr){console.warn("[UNARY_RESPONSE]",JSON.stringify({service:$7.typeName,method:$6.name,type:$6.O?.typeName,error:String(xErr)}))}})();return{service:$7,method:$6',
    marker: "[UNARY_RESPONSE]",
  },
  // Patch 8: Log unary call initiation (with filtering)
  // Anchors: <svc>.typeName + <helper>(<method>.name) + $callAiConnectTransportProviderUnary
  {
    name: "Unary Call Started",
    find: /const (\w+)=(\w+)\.typeName,(\w+)=([A-Za-z0-9_$]+)\((\w+)\.name\),(\w+)=await (\w+)\.\$callAiConnectTransportProviderUnary\(\1,\3,(\w+),(\w+),(\w+),(\w+)\.token\)/,
    replace:
      'const $1=$2.typeName,$3=$4($5.name);const xSkip=["GetTeams","GetUser","GetSubscription","CheckQueuePosition","FlushEvents","Batch","SubmitLogs","SubmitSpans","BootstrapStatsig","ReportClientNumericMetrics"];if(!xSkip.includes($5.name)){console.warn("[UNARY_CALL_STARTED]",JSON.stringify({service:$1,method:$5.name,headers:$10}))}const $6=await $7.$callAiConnectTransportProviderUnary($1,$3,$8,$9,$10,$11.token)',
    marker: "[UNARY_CALL_STARTED]",
  },
]

// Markers to detect if file has been patched
const PATCH_MARKERS = [
  "[TRANSPORT_REQUEST]",
  "[TRANSPORT_REQUEST_PAYLOAD]",
  "[TRANSPORT_CHUNK]",
  "[TRANSPORT_RESPONSE]",
  "[TRANSPORT_STREAM_STARTED]",
  "[UNARY_REQUEST]",
  "[UNARY_RESPONSE]",
  "[UNARY_CALL_STARTED]",
]

function isFilePatched(content: string): boolean {
  return PATCH_MARKERS.some((marker) => content.includes(marker))
}

function createBackup(targetFile: string): boolean {
  const backupPath = targetFile + BACKUP_SUFFIX

  // Read current source to check if it's clean
  const currentContent = fs.readFileSync(targetFile, "utf-8")

  if (fs.existsSync(backupPath)) {
    // Backup exists - verify it's clean
    const backupContent = fs.readFileSync(backupPath, "utf-8")
    if (isFilePatched(backupContent)) {
      console.error("ERROR: Backup file is corrupted (contains patches)!")
      console.error("Please reinstall Cursor and delete the backup file:")
      console.error(`  rm "${backupPath}"`)
      return false
    }
    console.log("Backup already exists and is clean, skipping")
    return true
  }

  // No backup exists - create one only if source is clean
  if (isFilePatched(currentContent)) {
    console.error(
      "ERROR: Source file is already patched, cannot create clean backup!"
    )
    console.error("Please reinstall Cursor to get a clean source file.")
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
    console.error("ERROR: No backup found!")
    return false
  }

  // Verify backup is clean before restoring
  const backupContent = fs.readFileSync(backupPath, "utf-8")
  if (isFilePatched(backupContent)) {
    console.error("ERROR: Backup file is corrupted (contains patches)!")
    console.error("Please reinstall Cursor and delete the backup file:")
    console.error(`  rm "${backupPath}"`)
    return false
  }

  console.log(`Restoring from ${backupPath}`)
  fs.copyFileSync(backupPath, targetFile)
  console.log("Restored successfully")
  return true
}

function applyPatches(targetFile: string): boolean {
  console.log(`Reading ${targetFile}...`)
  let content = fs.readFileSync(targetFile, "utf-8")
  const originalContent = content
  let appliedCount = 0
  let alreadyAppliedCount = 0

  console.log("\n--- Applying Transport Layer Patches ---")
  for (const patch of TRANSPORT_PATCHES) {
    const hasMarker = content.includes(patch.marker)
    const canApply =
      typeof patch.find === "string"
        ? content.includes(patch.find)
        : patch.find.test(content)

    if (canApply) {
      content = content.replace(patch.find, patch.replace)
      appliedCount++
      console.log(`  ✓ ${patch.name}`)
    } else if (hasMarker) {
      alreadyAppliedCount++
      console.log(`  - ${patch.name} (already applied)`)
    } else {
      console.log(`  ✗ ${patch.name} (pattern not found)`)
    }
  }

  // Only write if changes were made
  if (content !== originalContent) {
    console.log(`\nWriting patched content...`)
    fs.writeFileSync(targetFile, content, "utf-8")
    console.log(`\n✓ Applied ${appliedCount} transport patches`)
  } else if (alreadyAppliedCount > 0) {
    console.log(
      `\n✓ All ${alreadyAppliedCount} patches already applied, no changes needed`
    )
  }

  return true
}

function checkStatus(targetFile: string): void {
  console.log(`Checking transport patch status...`)
  const content = fs.readFileSync(targetFile, "utf-8")

  console.log("\nStatus:")
  for (const patch of TRANSPORT_PATCHES) {
    const isApplied = content.includes(patch.marker)
    console.log(`  ${patch.name}: ${isApplied ? "✓" : "✗"}`)
  }
}

function checkMatch(targetFile: string): boolean {
  const backupPath = targetFile + BACKUP_SUFFIX
  const content = fs.existsSync(backupPath)
    ? fs.readFileSync(backupPath, "utf-8")
    : fs.readFileSync(targetFile, "utf-8")
  const source = fs.existsSync(backupPath) ? "clean backup" : "current file"

  console.log(`Checking find-pattern match (${source})...`)
  let allMatch = true
  for (const patch of TRANSPORT_PATCHES) {
    const found =
      typeof patch.find === "string"
        ? content.includes(patch.find)
        : patch.find.test(content)
    if (!found) allMatch = false
    console.log(`  ${patch.name}: ${found ? "✓ match" : "✗ not found"}`)
  }
  return allMatch
}

async function main(): Promise<void> {
  if (!fs.existsSync(CURSOR_WORKBENCH_PATH)) {
    console.error(`Error: Cursor workbench file not found`)
    process.exit(1)
  }

  const args = process.argv.slice(2)

  if (args.includes("--restore")) {
    restoreBackup(CURSOR_WORKBENCH_PATH)
    return
  }

  if (args.includes("--status")) {
    checkStatus(CURSOR_WORKBENCH_PATH)
    return
  }

  if (args.includes("--check-match")) {
    const ok = checkMatch(CURSOR_WORKBENCH_PATH)
    process.exit(ok ? 0 : 1)
  }

  if (args.includes("--help")) {
    console.log(`
Cursor Transport Layer Patcher

Usage:
  agent-vibes patch [options]

Options:
  --restore      Restore original file from backup
  --status       Check current patch status
  --check-match  Verify find patterns match (use backup if exists)
  --help         Show this help message

This patches at the transport layer to capture ALL network traffic.
    `)
    return
  }

  if (!createBackup(CURSOR_WORKBENCH_PATH)) {
    process.exit(1)
  }
  applyPatches(CURSOR_WORKBENCH_PATH)

  const cursorBin = platform.cursorBinaryPath()
  console.log("\n" + "=".repeat(60))
  console.log("Transport layer patches applied!")
  console.log("To capture logs, run: npm run cursor:debug")
  console.log(`Cursor binary: ${cursorBin}`)
  console.log("=".repeat(60))
}

main().catch(console.error)
