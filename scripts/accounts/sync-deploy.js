#!/usr/bin/env node

/**
 * Deploy credentials to remote server via GitHub Secrets + CI/CD.
 *
 * Reads local credential files and uploads them as GitHub Secrets,
 * then optionally triggers a deployment workflow.
 *
 * Usage:
 *   agent-vibes sync --deploy          Upload credentials to GitHub Secrets
 *   agent-vibes sync --deploy --run    Upload + trigger deploy workflow
 *   npm run deploy:sync
 */

const { execSync } = require("child_process")
const fs = require("fs")
const path = require("path")
const {
  resolveDefaultAccountConfigPath,
} = require("./lib/account-config-paths")

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, "../..")
const REPO = "funny-vibes/agent-vibes"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkGhCli() {
  try {
    execSync("gh --version", { stdio: "pipe" })
  } catch {
    console.error("❌ GitHub CLI (gh) is not installed or not in PATH.")
    console.error("   Install: https://cli.github.com/")
    process.exit(1)
  }

  try {
    execSync("gh auth status", { stdio: "pipe" })
  } catch {
    console.error("❌ GitHub CLI is not authenticated.")
    console.error("   Run: gh auth login")
    process.exit(1)
  }
}

function setSecret(secretName, value) {
  try {
    const payload = Buffer.from(value, "utf8").toString("base64")
    execSync(`gh secret set ${secretName} --repo ${REPO}`, {
      input: payload,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return true
  } catch (e) {
    console.error(`   ❌ Failed to set ${secretName}: ${e.message}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Also sync .env.local as PROXY_ENV_PRODUCTION (non-credential config)
// ---------------------------------------------------------------------------

function ensureProductionEnvContent(rawContent) {
  const lines = rawContent.replace(/\r\n/g, "\n").split("\n")
  const values = new Map()

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }
    const idx = trimmed.indexOf("=")
    if (idx <= 0) {
      continue
    }
    values.set(trimmed.slice(0, idx), trimmed.slice(idx + 1))
  }

  values.set("AGENT_VIBES_DATA_DIR", "/opt/protocol-bridge")
  if (!values.get("PORT")) {
    values.set("PORT", "2026")
  }

  const proxyApiKey = values.get("PROXY_API_KEY")?.trim()
  if (!proxyApiKey) {
    throw new Error(
      "PROXY_API_KEY is required in apps/protocol-bridge/.env.local for production deploy"
    )
  }

  const orderedKeys = ["PORT", "PROXY_API_KEY", "AGENT_VIBES_DATA_DIR"]
  const body = []
  for (const key of orderedKeys) {
    if (values.has(key)) {
      body.push(`${key}=${values.get(key)}`)
      values.delete(key)
    }
  }
  for (const [key, value] of values.entries()) {
    body.push(`${key}=${value}`)
  }

  return `${body.join("\n")}\n`
}

function syncEnvConfig() {
  const envPath = path.join(BRIDGE_DIR, ".env.local")
  if (!fs.existsSync(envPath)) {
    if (triggerDeploy) {
      console.error(
        "❌ Missing apps/protocol-bridge/.env.local (copy from .env.local.example and set PROXY_API_KEY)"
      )
      process.exit(1)
    }
    console.log("   ⏭️  No .env.local found, skipping PROXY_ENV_PRODUCTION")
    return true
  }

  let content = fs.readFileSync(envPath, "utf-8")
  if (!content.trim()) {
    console.error("❌ apps/protocol-bridge/.env.local is empty")
    process.exit(1)
  }

  try {
    content = ensureProductionEnvContent(content)
  } catch (error) {
    console.error(`   ❌ ${error.message}`)
    process.exit(1)
  }

  process.stdout.write("   📄 PROXY_ENV_PRODUCTION (.env.local)... ")
  const ok = setSecret("PROXY_ENV_PRODUCTION", content)
  if (ok) console.log("✅")
  return ok
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const triggerDeploy = args.includes("--run")
const BRIDGE_DIR = path.join(PROJECT_ROOT, "apps/protocol-bridge")
const CREDENTIAL_FILES = [
  {
    localPath: resolveDefaultAccountConfigPath(
      PROJECT_ROOT,
      "antigravity-accounts.json",
      []
    ),
    secretName: "ANTIGRAVITY_ACCOUNTS",
    label: "Antigravity accounts",
  },
  {
    localPath: resolveDefaultAccountConfigPath(
      PROJECT_ROOT,
      "codex-accounts.json",
      []
    ),
    secretName: "CODEX_ACCOUNTS",
    label: "Codex accounts",
  },
  {
    localPath: resolveDefaultAccountConfigPath(
      PROJECT_ROOT,
      "openai-compat-accounts.json",
      []
    ),
    secretName: "OPENAI_COMPAT_ACCOUNTS",
    label: "OpenAI-compat accounts",
  },
  {
    localPath: resolveDefaultAccountConfigPath(
      PROJECT_ROOT,
      "claude-api-accounts.json",
      []
    ),
    secretName: "CLAUDE_API_ACCOUNTS",
    label: "Claude API accounts",
  },
  {
    localPath: resolveDefaultAccountConfigPath(
      PROJECT_ROOT,
      "kiro-accounts.json",
      []
    ),
    secretName: "KIRO_ACCOUNTS",
    label: "Kiro accounts",
  },
]

console.log("🚀 Deploying credentials to GitHub Secrets...\n")

checkGhCli()

let allSuccess = true
let uploadedCount = 0

for (const { localPath, secretName, label } of CREDENTIAL_FILES) {
  if (!fs.existsSync(localPath)) {
    console.log(
      `   ⏭️  ${label}: not found (${path.basename(localPath)}), skipping`
    )
    continue
  }

  const content = fs.readFileSync(localPath, "utf-8")

  // Validate JSON and skip empty pools (avoid overwriting server secrets)
  let accountCount = 0
  try {
    const parsed = JSON.parse(content)
    accountCount = Array.isArray(parsed.accounts) ? parsed.accounts.length : 0
    if (accountCount === 0) {
      console.log(`   ⏭️  ${label}: no accounts configured, skipping`)
      continue
    }
    process.stdout.write(
      `   🔑 ${label} (${accountCount} account${accountCount !== 1 ? "s" : ""})... `
    )
  } catch {
    console.log(`   ❌ ${label}: invalid JSON, skipping`)
    allSuccess = false
    continue
  }

  const ok = setSecret(secretName, content)
  if (ok) {
    console.log("✅")
    uploadedCount++
  } else {
    allSuccess = false
  }
}

// Sync .env.local config
syncEnvConfig()

console.log("")

if (uploadedCount === 0) {
  console.log("⚠️  No credentials were uploaded.")
  if (!triggerDeploy) {
    console.log("   Run sync commands first:")
    console.log("     npm run antigravity:sync -- --tools")
    console.log("     npm run claude:sync")
    console.log("     npm run codex:sync")
    process.exit(1)
  }
  console.log("   Continuing with deploy trigger only.")
} else {
  console.log(
    `✅ ${uploadedCount} credential file(s) uploaded to GitHub Secrets.`
  )
}

if (triggerDeploy) {
  console.log("\n🔄 Triggering deployment workflow...")
  try {
    execSync(`gh workflow run deploy-proxy.yml --repo ${REPO} --ref main`, {
      stdio: "inherit",
    })
    console.log("✅ Deployment triggered. Check: gh run list --repo " + REPO)
  } catch {
    console.log("⚠️  Could not trigger workflow. Push to main to deploy.")
  }
} else {
  console.log(
    "\n💡 To also trigger a deployment, run: npm run deploy:sync -- --run"
  )
}
