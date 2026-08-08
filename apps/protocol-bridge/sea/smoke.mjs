import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const STARTUP_TIMEOUT_MS = 45_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const OUTPUT_LIMIT = 128 * 1024

const binaryArgument = process.argv[2]
if (!binaryArgument) {
  throw new Error("Usage: node sea/smoke.mjs <bridge-binary>")
}

const binaryPath = path.resolve(binaryArgument)
if (!fs.existsSync(binaryPath)) {
  throw new Error(`Bridge binary does not exist: ${binaryPath}`)
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Failed to reserve a bridge smoke-test port"))
        return
      }
      const port = address.port
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })
}

function appendOutput(current, chunk) {
  const next = current + Buffer.from(chunk).toString("utf8")
  return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next
}

function requestHealth(port) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        timeout: 1_000,
      },
      (response) => {
        const chunks = []
        response.on("data", (chunk) => chunks.push(chunk))
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8")
          if (response.statusCode !== 200) {
            resolve(false)
            return
          }
          try {
            resolve(JSON.parse(body)?.status === "ok")
          } catch {
            resolve(false)
          }
        })
      }
    )
    request.once("error", () => resolve(false))
    request.once("timeout", () => request.destroy())
  })
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once("exit", onExit)
  })
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  if (await waitForExit(child, SHUTDOWN_TIMEOUT_MS)) return
  child.kill("SIGKILL")
  await waitForExit(child, SHUTDOWN_TIMEOUT_MS)
}

async function main() {
  const port = await reservePort()
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-vibes-sea-smoke-")
  )
  const logsDir = path.join(dataDir, "logs")
  const accountsDir = path.join(dataDir, "data")
  let output = ""
  const child = spawn(binaryPath, [], {
    cwd: path.dirname(binaryPath),
    env: {
      ...process.env,
      PORT: String(port),
      USE_HTTP2: "false",
      FORWARD_PROXY_ENABLED: "false",
      KIRO_WARMUP_ON_START: "0",
      AGENT_VIBES_GOOGLE_STARTUP_UPSTREAM_CHECK: "false",
      AGENT_VIBES_DATA_DIR: dataDir,
      AGENT_VIBES_LOG_DIR: logsDir,
      AGENT_VIBES_ACTIVE_LOG_FILE: path.join(logsDir, "bridge.log"),
      AGENT_VIBES_PREVIOUS_LOG_FILE: path.join(logsDir, "bridge.previous.log"),
      CURSOR_PROTOCOL_TRACE_FILE: path.join(logsDir, "cursor-trace.jsonl"),
      AGENT_VIBES_ANTIGRAVITY_ACCOUNTS_PATH: path.join(
        accountsDir,
        "antigravity-accounts.json"
      ),
      AGENT_VIBES_CLAUDE_API_ACCOUNTS_PATH: path.join(
        accountsDir,
        "claude-api-accounts.json"
      ),
      AGENT_VIBES_CODEX_ACCOUNTS_PATH: path.join(
        accountsDir,
        "codex-accounts.json"
      ),
      AGENT_VIBES_OPENAI_COMPAT_ACCOUNTS_PATH: path.join(
        accountsDir,
        "openai-compat-accounts.json"
      ),
      AGENT_VIBES_KIRO_ACCOUNTS_PATH: path.join(
        accountsDir,
        "kiro-accounts.json"
      ),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let spawnError
  child.once("error", (error) => {
    spawnError = error
  })

  child.stdout.on("data", (chunk) => {
    output = appendOutput(output, chunk)
  })
  child.stderr.on("data", (chunk) => {
    output = appendOutput(output, chunk)
  })

  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(`Bridge process could not start: ${spawnError.message}`)
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Bridge exited before becoming healthy (exit=${child.exitCode}, signal=${child.signalCode})`
        )
      }
      if (await requestHealth(port)) {
        console.log(`  ✓ SEA startup smoke passed on isolated port ${port}`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(
      `Bridge did not become healthy within ${STARTUP_TIMEOUT_MS}ms`
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const diagnostics = output.trim()
    throw new Error(
      diagnostics ? `${detail}\n--- bridge output ---\n${diagnostics}` : detail
    )
  } finally {
    await stopChild(child)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(
    `SEA startup smoke failed: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
})
