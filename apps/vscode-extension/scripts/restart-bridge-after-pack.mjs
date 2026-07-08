import fs from "fs"
import os from "os"
import path from "path"
import https from "https"
import { execFileSync, spawn } from "child_process"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const extensionRoot = path.resolve(__dirname, "..")
const packageJson = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, "package.json"), "utf-8")
)

const publisher = packageJson.publisher || "funny-vibes"
const extensionName = packageJson.name || "agent-vibes"
const version = packageJson.version || "0.1.0"

const target = `${process.platform}-${process.arch}`
const exeExtension = process.platform === "win32" ? ".exe" : ""
const installedExtensionDir = path.join(
  os.homedir(),
  ".cursor",
  "extensions",
  `${publisher}.${extensionName}-${version}`
)
const binaryPath = path.join(
  installedExtensionDir,
  "bridge",
  target,
  `agent-vibes-bridge${exeExtension}`
)

const PID_FILE = path.join(os.tmpdir(), "agent-vibes-bridge.pid")
const LOG_FILE = path.join(os.tmpdir(), "agent-vibes-bridge.log")
const PREVIOUS_LOG_FILE = path.join(
  os.tmpdir(),
  "agent-vibes-bridge.previous.log"
)
const STARTUP_HEALTH_TIMEOUT_MS = 45000
const RUNTIME_ACTIVITY_TIMEOUT_MS = 3000
const AGENT_VIBES_EXTENSION_LOG_SUFFIX = "Agent Vibes.log"

function stripJsonComments(input) {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1")
}

function loadCursorSettings() {
  const candidates = []

  if (process.platform === "darwin") {
    candidates.push(
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "settings.json"
      )
    )
  } else if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    candidates.push(path.join(appData, "Cursor", "User", "settings.json"))
  } else {
    candidates.push(
      path.join(os.homedir(), ".config", "Cursor", "User", "settings.json")
    )
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    const raw = fs.readFileSync(candidate, "utf-8")
    try {
      return JSON.parse(raw)
    } catch {
      try {
        return JSON.parse(stripJsonComments(raw))
      } catch {
        console.warn(`[restart:bridge] Failed to parse settings: ${candidate}`)
      }
    }
  }

  return {}
}

function resolveConfig() {
  const settings = loadCursorSettings()
  const defaultDataDir = path.join(os.homedir(), ".agent-vibes")
  const dataDir =
    typeof settings["agentVibes.dataDir"] === "string" &&
    settings["agentVibes.dataDir"].trim()
      ? path.resolve(settings["agentVibes.dataDir"].trim())
      : defaultDataDir
  const port =
    typeof settings["agentVibes.port"] === "number" &&
    Number.isFinite(settings["agentVibes.port"])
      ? settings["agentVibes.port"]
      : 2026

  const logsDir = path.join(dataDir, "logs")
  const env = {
    PORT: String(port),
    AGENT_VIBES_DATA_DIR: dataDir,
    AGENT_VIBES_LOG_DIR: logsDir,
    CURSOR_PROTOCOL_TRACE_FILE:
      process.env.CURSOR_PROTOCOL_TRACE_FILE ||
      path.join(logsDir, "cursor_protocol_trace.jsonl"),
    KIRO_WARMUP_ON_START: process.env.KIRO_WARMUP_ON_START || "0",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  }

  const accountOverrides = [
    [
      "agentVibes.antigravityAccountsPath",
      "AGENT_VIBES_ANTIGRAVITY_ACCOUNTS_PATH",
    ],
    [
      "agentVibes.claudeApiAccountsPath",
      "AGENT_VIBES_CLAUDE_API_ACCOUNTS_PATH",
    ],
    ["agentVibes.codexAccountsPath", "AGENT_VIBES_CODEX_ACCOUNTS_PATH"],
    [
      "agentVibes.openaiCompatAccountsPath",
      "AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH",
    ],
  ]

  for (const [settingKey, envKey] of accountOverrides) {
    const value = settings[settingKey]
    if (typeof value === "string" && value.trim()) {
      env[envKey] = path.resolve(value.trim())
    }
  }

  if (settings["agentVibes.debugMode"] === true) {
    env.LOG_DEBUG = "true"
  }

  const caCertPath = path.join(dataDir, "certs", "ca.pem")
  if (fs.existsSync(caCertPath)) {
    env.NODE_EXTRA_CA_CERTS = caCertPath
  }

  return {
    env,
    port,
    dataDir,
    caCertPath,
  }
}

function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

function listBridgePids() {
  const binaryRealPath = fs.existsSync(binaryPath)
    ? fs.realpathSync(binaryPath)
    : binaryPath

  const pids = new Set()

  try {
    let lines
    if (process.platform === "win32") {
      // Windows: use wmic or PowerShell to list processes
      const psOutput = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          'Get-Process | Where-Object { $_.ProcessName -like "*agent-vibes-bridge*" } | Select-Object -ExpandProperty Id',
        ],
        { encoding: "utf-8" }
      )
      lines = psOutput
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
      for (const line of lines) {
        const pid = Number.parseInt(line, 10)
        if (Number.isFinite(pid)) pids.add(pid)
      }
    } else {
      const psOutput = execFileSync("ps", ["-axo", "pid=,command="], {
        encoding: "utf-8",
      })
      lines = psOutput
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
      for (const line of lines) {
        const match = line.match(/^(\d+)\s+(.*)$/)
        if (!match) continue
        const pid = Number.parseInt(match[1], 10)
        const command = match[2] || ""
        if (!Number.isFinite(pid)) continue
        if (
          command.includes("agent-vibes-bridge") &&
          (command.includes(binaryRealPath) ||
            command.includes(installedExtensionDir))
        ) {
          pids.add(pid)
        }
      }
    }
  } catch {
    // ps/powershell not available — fall back to PID file only
  }

  const pidFilePid = readPid()
  if (pidFilePid) pids.add(pidFilePid)
  return [...pids]
}

function listCursorAgentVibesExtensionHostPids() {
  if (process.platform === "win32") return []

  try {
    const psOutput = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf-8",
    })
    return psOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/)
        if (!match) return []
        const pid = Number.parseInt(match[1], 10)
        const command = match[2] || ""
        if (
          Number.isFinite(pid) &&
          command.includes("extension-host") &&
          command.includes("agent-vibes")
        ) {
          return [pid]
        }
        return []
      })
  } catch {
    return []
  }
}

function getCursorLogsDir() {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "logs"
    )
  }
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    return path.join(appData, "Cursor", "logs")
  }
  return path.join(os.homedir(), ".config", "Cursor", "logs")
}

function findLatestAgentVibesExtensionLog() {
  const logsDir = getCursorLogsDir()
  if (!fs.existsSync(logsDir)) return null

  const stack = [logsDir]
  let latest = null
  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir) continue
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }
      if (
        !entry.isFile() ||
        !entry.name.endsWith(AGENT_VIBES_EXTENSION_LOG_SUFFIX)
      ) {
        continue
      }
      let stat
      try {
        stat = fs.statSync(entryPath)
      } catch {
        continue
      }
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { path: entryPath, mtimeMs: stat.mtimeMs }
      }
    }
  }
  return latest?.path || null
}

function detectLoadedExtensionVersionFromLog(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return null
  try {
    const content = fs.readFileSync(logPath, "utf-8")
    const escapedId = `${publisher}.${extensionName}`.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    )
    const match = content.match(
      new RegExp(`${escapedId}-([^/\\\\\\s]+)[/\\\\]bridge`)
    )
    return match?.[1] || null
  } catch {
    return null
  }
}

function warnIfCursorWindowsNeedReload() {
  const hostPids = listCursorAgentVibesExtensionHostPids()
  if (hostPids.length > 0) {
    console.warn(
      `[restart:bridge] Cursor Agent Vibes extension host(s) still running: ${hostPids.join(", ")}`
    )
  }

  const latestLog = findLatestAgentVibesExtensionLog()
  const loadedVersion = detectLoadedExtensionVersionFromLog(latestLog)
  if (loadedVersion && loadedVersion !== version) {
    console.warn(
      `[restart:bridge] Latest Agent Vibes extension log loaded version ${loadedVersion}, but the installed package is ${version}. ` +
        "Reload or quit Cursor before testing; otherwise the bridge binary can be new while UI commands still run old extension code."
    )
    console.warn(`[restart:bridge] Latest extension log: ${latestLog}`)
    return
  }

  if (hostPids.length > 0) {
    console.warn(
      '[restart:bridge] VSIX install does not reload open Cursor windows. Run "Developer: Reload Window" before testing extension UI or command changes.'
    )
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function requestBridgeJson(port, caCertPath, requestPath, timeoutMs) {
  const ca = fs.existsSync(caCertPath) ? fs.readFileSync(caCertPath) : undefined

  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: "localhost",
        port,
        path: requestPath,
        method: "GET",
        ca,
        rejectUnauthorized: !!ca,
      },
      (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8")
          if (res.statusCode !== 200) {
            resolve({
              ok: false,
              statusCode: res.statusCode,
              error: `HTTP ${res.statusCode}`,
              body,
            })
            return
          }
          try {
            resolve({
              ok: true,
              statusCode: res.statusCode,
              value: JSON.parse(body),
            })
          } catch (error) {
            resolve({
              ok: false,
              statusCode: res.statusCode,
              error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
              body,
            })
          }
        })
      }
    )

    req.on("error", (error) => {
      resolve({
        ok: false,
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : undefined,
        error: error instanceof Error ? error.message : String(error),
      })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms`))
    })
  })
}

function formatBusyRuntimeSession(session) {
  return [
    session.conversationId,
    `model=${session.model || "(unknown)"}`,
    `activeTurn=${session.activeTurn === true}`,
    `backendStreams=${Number(session.activeBackendStreams) || 0}`,
    `pendingToolCalls=${Number(session.pendingToolCalls) || 0}`,
    `pendingInteractionQueries=${Number(session.pendingInteractionQueries) || 0}`,
    `deferredContinuations=${Number(session.deferredControlContinuations) || 0}`,
  ].join(" ")
}

async function assertSafeToRestartBridge(port, caCertPath) {
  const result = await requestBridgeJson(
    port,
    caCertPath,
    "/api/context/runtime",
    RUNTIME_ACTIVITY_TIMEOUT_MS
  )

  if (!result.ok) {
    const errorText = result.error || "unknown error"
    if (result.code === "ECONNREFUSED" || errorText.includes("ECONNREFUSED")) {
      console.log(
        "[restart:bridge] No running bridge answered the runtime activity check"
      )
      return
    }
    if (result.statusCode === 404) {
      console.warn(
        "[restart:bridge] Running bridge does not expose /api/context/runtime; " +
          "restarting it to install the current bridge protocol."
      )
      return
    }
    throw new Error(
      `Cannot verify bridge runtime activity before restart (${errorText}); refusing to interrupt unknown Cursor Agent state.`
    )
  }

  const snapshot = result.value || {}
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
  const busySessions = sessions.filter((session) => session?.busy === true)

  if (
    snapshot.canRestartWithoutInterruptingRuns !== true ||
    busySessions.length > 0
  ) {
    const details = busySessions.map(formatBusyRuntimeSession).join("; ")
    throw new Error(
      `Refusing to restart bridge because ${busySessions.length} active Cursor Agent session(s) would be interrupted.` +
        (details ? ` ${details}` : "")
    )
  }

  const recoverySessionCount = Number(snapshot.recoverySessionCount) || 0
  if (recoverySessionCount > 0) {
    console.warn(
      `[restart:bridge] ${recoverySessionCount} session(s) have restart recovery state; restart is allowed because no live work is active`
    )
  }

  console.log(
    `[restart:bridge] Runtime activity check passed: sessions=${sessions.length}, busy=0`
  )
}

async function stopExistingBridge() {
  const pids = listBridgePids().filter((pid) => pid !== process.pid)
  if (pids.length === 0) return

  console.log(
    `[restart:bridge] Stopping existing bridge PID(s): ${pids.join(", ")}`
  )
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const alive = pids.filter(isAlive)
    if (alive.length === 0) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  for (const pid of pids) {
    if (!isAlive(pid)) continue
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }

  try {
    fs.unlinkSync(PID_FILE)
  } catch {}
}

function rotateLogFile() {
  if (!fs.existsSync(LOG_FILE)) return

  try {
    fs.rmSync(PREVIOUS_LOG_FILE, { force: true })
  } catch {}

  try {
    fs.renameSync(LOG_FILE, PREVIOUS_LOG_FILE)
    console.log(`[restart:bridge] Rotated log to ${PREVIOUS_LOG_FILE}`)
    return
  } catch {}

  try {
    fs.truncateSync(LOG_FILE, 0)
    console.log(`[restart:bridge] Truncated existing log at ${LOG_FILE}`)
  } catch {}
}

function waitForHealth(
  port,
  caCertPath,
  timeoutMs = STARTUP_HEALTH_TIMEOUT_MS
) {
  const ca = fs.existsSync(caCertPath) ? fs.readFileSync(caCertPath) : undefined
  const startedAt = Date.now()

  return new Promise((resolve) => {
    const attempt = () => {
      const req = https.get(
        {
          hostname: "localhost",
          port,
          path: "/health",
          method: "GET",
          ca,
          rejectUnauthorized: !!ca,
        },
        (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        }
      )

      req.on("error", () => {
        if (Date.now() - startedAt >= timeoutMs) {
          resolve(false)
          return
        }
        setTimeout(attempt, 500)
      })

      req.setTimeout(3000, () => {
        req.destroy()
      })
    }

    attempt()
  })
}

async function main() {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Installed bridge not found: ${binaryPath}`)
  }

  const { env, port, dataDir, caCertPath } = resolveConfig()
  fs.mkdirSync(env.AGENT_VIBES_LOG_DIR, { recursive: true })
  await assertSafeToRestartBridge(port, caCertPath)
  await stopExistingBridge()
  rotateLogFile()

  const logFd = fs.openSync(LOG_FILE, "a")
  const child = spawn(binaryPath, [], {
    env: {
      ...process.env,
      ...env,
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  })
  child.unref()
  fs.closeSync(logFd)

  if (child.pid) {
    fs.writeFileSync(PID_FILE, String(child.pid))
  }

  const healthy = await waitForHealth(port, caCertPath)
  if (healthy) {
    console.log(
      `[restart:bridge] Bridge restarted successfully on https://localhost:${port} ` +
        `(dataDir=${dataDir}, trace=${env.CURSOR_PROTOCOL_TRACE_FILE})`
    )
    warnIfCursorWindowsNeedReload()
    return
  }

  throw new Error(
    `Bridge restart did not pass health check on port ${port}. ` +
      `Timed out after ${STARTUP_HEALTH_TIMEOUT_MS}ms. ` +
      `Check ${LOG_FILE} or run "Agent Vibes: Restart Server" in Cursor.`
  )
}

main().catch((error) => {
  console.error(
    `[restart:bridge] Restart failed: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
})
