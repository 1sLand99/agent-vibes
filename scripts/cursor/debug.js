#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")
const platform = require("../lib/platform")

const ROOT = path.resolve(__dirname, "../..")
const LOG_DIR = path.join(ROOT, ".log")
const LOG_FILE = path.join(LOG_DIR, "cursor_grpc.log")
const cursorBin = platform.cursorBinaryPath()

if (!cursorBin) {
  console.error("Error: Cursor binary path could not be resolved.")
  console.error(
    "Set CURSOR_BINARY_PATH if Cursor is installed in a non-standard location."
  )
  process.exit(1)
}

fs.mkdirSync(LOG_DIR, { recursive: true })

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

const logFileName = `cursor_grpc-${timestampForFilename()}.log`
const logFilePath = path.join(LOG_DIR, logFileName)
const logStream = fs.createWriteStream(logFilePath, { flags: "a" })

try {
  if (fs.existsSync(LOG_FILE)) {
    fs.unlinkSync(LOG_FILE)
  }
  fs.symlinkSync(logFileName, LOG_FILE)
} catch {
  fs.copyFileSync(logFilePath, LOG_FILE)
}

function mirrorStream(stream, output) {
  stream.on("data", (chunk) => {
    logStream.write(chunk)
    output.write(chunk)
  })
}

const child = spawn(cursorBin, [], {
  cwd: ROOT,
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
  },
  stdio: ["inherit", "pipe", "pipe"],
})

child.on("error", (error) => {
  logStream.end()
  console.error(`Failed to launch Cursor: ${error.message}`)
  process.exit(1)
})

if (child.stdout) mirrorStream(child.stdout, process.stdout)
if (child.stderr) mirrorStream(child.stderr, process.stderr)

child.on("exit", (code, signal) => {
  logStream.end()
  if (signal) {
    console.error(`Cursor exited due to signal ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 0)
})

console.log(
  `Writing Cursor debug logs to ${path.relative(ROOT, logFilePath)} (latest: ${path.relative(ROOT, LOG_FILE)})`
)
