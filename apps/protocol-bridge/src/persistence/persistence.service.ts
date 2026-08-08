import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common"
import { DatabaseSync } from "node:sqlite"
import * as fs from "fs"
import * as path from "path"
import {
  getAgentVibesPgDataDir,
  getAgentVibesAccountsDir,
  ensureAgentVibesDirs,
} from "../shared/agent-vibes-paths"
import { resolveProtocolBridgePath } from "../shared/protocol-bridge-paths"

const DB_FILENAME = "agent-vibes.db"
const SESSION_GRAPH_MIGRATIONS = [
  "014_session_graph.sql",
  "017_session_graph_v18.sql",
  "018_session_graph_v19.sql",
  "019_context_runtime_v20.sql",
  "020_context_runtime_v21.sql",
  "021_async_user_interactions_v22.sql",
] as const
const SESSION_GRAPH_MIGRATION = SESSION_GRAPH_MIGRATIONS.at(-1)!
const SESSION_GRAPH_VERSION = "22"
const RETIRED_SESSION_TABLES = [
  "cursor_sessions",
  "session_context_state",
  "summaries",
] as const

interface SessionGraphSchemaObject {
  readonly type: "table" | "index" | "trigger"
  readonly name: string
  readonly tableName: string
  readonly sql: string
}

function readSessionGraphSchemaObjects(
  database: DatabaseSync
): readonly SessionGraphSchemaObject[] {
  const rows = database
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
         FROM sqlite_master
        WHERE type IN ('table', 'index', 'trigger')
          AND name NOT LIKE 'sqlite_%'
          AND sql IS NOT NULL
        ORDER BY type, name`
    )
    .all() as unknown as Array<{
    type: string
    name: string
    tableName: string
    sql: string
  }>
  return rows
    .filter(
      (row): row is SessionGraphSchemaObject =>
        (row.type === "table" ||
          row.type === "index" ||
          row.type === "trigger") &&
        typeof row.name === "string" &&
        typeof row.tableName === "string" &&
        typeof row.sql === "string"
    )
    .map((row) => Object.freeze({ ...row }))
}

/**
 * Canonicalize SQLite DDL lexically, not heuristically: whitespace, comments
 * and keyword case do not define schema identity, while quoted values and
 * every token remain exact. The expected and installed catalogs are then
 * compared object-for-object.
 */
function normalizeSqlDefinition(sql: string): string {
  const tokens: string[] = []
  let index = 0
  while (index < sql.length) {
    const current = sql[index]!
    if (/\s/.test(current)) {
      index += 1
      continue
    }
    if (current === "-" && sql[index + 1] === "-") {
      index += 2
      while (index < sql.length && sql[index] !== "\n") index += 1
      continue
    }
    if (current === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2)
      index = end < 0 ? sql.length : end + 2
      continue
    }
    if (current === "'" || current === '"' || current === "`") {
      const quote = current
      let token = quote
      index += 1
      while (index < sql.length) {
        const character = sql[index]!
        token += character
        index += 1
        if (character !== quote) continue
        if (sql[index] === quote) {
          token += quote
          index += 1
          continue
        }
        break
      }
      tokens.push(token)
      continue
    }
    if (current === "[") {
      const end = sql.indexOf("]", index + 1)
      tokens.push(end < 0 ? sql.slice(index) : sql.slice(index, end + 1))
      index = end < 0 ? sql.length : end + 1
      continue
    }
    if (/[A-Za-z0-9_$]/.test(current)) {
      const start = index
      index += 1
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) {
        index += 1
      }
      tokens.push(sql.slice(start, index).toUpperCase())
      continue
    }
    tokens.push(current)
    index += 1
  }
  return tokens.join(" ")
}

function sessionGraphObjectKey(
  object: Pick<SessionGraphSchemaObject, "type" | "name">
): string {
  return `${object.type}:${object.name}`
}

function isSessionGraphTableName(tableName: string): boolean {
  return (
    tableName === "sessions" ||
    tableName === "turn_events" ||
    tableName === "tool_call_ledger" ||
    tableName.startsWith("session_")
  )
}
/**
 * Unified persistence layer powered by node:sqlite (built-in).
 *
 * Uses Node.js 24+ built-in SQLite module — zero native addon dependencies.
 * This makes SEA (Single Executable Application) packaging straightforward.
 *
 * Architecture benefits:
 * - Single DB connection, single WAL journal
 * - Version-controlled schema migrations
 * - Unified data directory: ~/.agent-vibes/
 * - All services share one PersistenceService via NestJS DI
 * - Zero native C++ addon — SEA-compatible
 */
@Injectable()
export class PersistenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PersistenceService.name)
  private db: DatabaseSync | null = null

  get database(): DatabaseSync {
    if (!this.db) {
      throw new Error("Database is not initialized. Call onModuleInit() first.")
    }
    return this.db
  }

  get isReady(): boolean {
    return this.db !== null
  }

  onModuleInit(): void {
    ensureAgentVibesDirs()
    const dataDir = getAgentVibesPgDataDir()
    const dbPath = path.join(dataDir, DB_FILENAME)

    this.logger.log(`Initializing SQLite at ${dbPath}`)
    this.db = new DatabaseSync(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")

    this.runMigrations()
    this.assertSessionGraphSchema()
    this.migrateAccountConfigs()
    this.logger.log("Persistence initialized successfully")
  }

  onModuleDestroy(): void {
    if (this.db) {
      this.db.close()
      this.db = null
      this.logger.log("Database connection closed")
    }
  }

  /**
   * Prepare a SQL statement.
   * Returns a StatementSync compatible with better-sqlite3's .get()/.all()/.run() API.
   */
  prepare(sql: string) {
    return this.database.prepare(sql)
  }

  /**
   * Execute raw SQL (for DDL / multi-statement operations).
   */
  exec(sql: string): void {
    this.database.exec(sql)
  }

  /**
   * Run a function within a transaction.
   * Manually wraps with BEGIN/COMMIT/ROLLBACK since node:sqlite
   * doesn't have a .transaction() helper like better-sqlite3.
   */
  runInTransaction<T>(fn: () => T): T {
    this.database.exec("BEGIN")
    try {
      const result = fn()
      this.database.exec("COMMIT")
      return result
    } catch (err) {
      this.database.exec("ROLLBACK")
      throw err
    }
  }

  /**
   * Acquire SQLite's writer reservation before reading a graph append
   * precondition. Graph sequence allocation and subagent branch-head CAS
   * must not observe a stale deferred snapshot from another bridge process.
   */
  runInImmediateTransaction<T>(fn: () => T): T {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const result = fn()
      this.database.exec("COMMIT")
      return result
    } catch (err) {
      this.database.exec("ROLLBACK")
      throw err
    }
  }

  // ── Migration System ────────────────────────────────────────────────

  private resolveMigrationsDir(): string {
    return process.env.SEA_MIGRATIONS_DIR || path.join(__dirname, "migrations")
  }

  private loadSessionGraphMigrationSql(): string {
    return SESSION_GRAPH_MIGRATIONS.map((migration) => {
      const migrationPath = path.join(this.resolveMigrationsDir(), migration)
      if (!fs.existsSync(migrationPath)) {
        throw new Error(
          `Required session schema migration is missing: ${migration}`
        )
      }
      return fs.readFileSync(migrationPath, "utf-8")
    }).join("\n")
  }

  /**
   * Treat the current destructive migration as the single schema authority.
   * Rebuilding it in an isolated SQLite database lets startup compare every
   * session-graph table, index and trigger definition without inferring
   * correctness from selected columns, foreign keys or SQL substrings.
   */
  private assertSessionGraphCatalog(): void {
    const expectedDatabase = new DatabaseSync(":memory:")
    try {
      expectedDatabase.exec(this.loadSessionGraphMigrationSql())
      const expected = readSessionGraphSchemaObjects(expectedDatabase)
      const expectedTableNames = new Set(
        expected
          .filter((object) => object.type === "table")
          .map((object) => object.name)
      )
      const actual = readSessionGraphSchemaObjects(this.database).filter(
        (object) =>
          object.type === "table"
            ? isSessionGraphTableName(object.name)
            : expectedTableNames.has(object.tableName)
      )
      const expectedByKey = new Map(
        expected.map((object) => [sessionGraphObjectKey(object), object])
      )
      const actualByKey = new Map(
        actual.map((object) => [sessionGraphObjectKey(object), object])
      )
      const missing = [...expectedByKey.keys()].filter(
        (key) => !actualByKey.has(key)
      )
      const unexpected = [...actualByKey.keys()].filter(
        (key) => !expectedByKey.has(key)
      )
      const modified = [...expectedByKey.entries()]
        .filter(([key, expectedObject]) => {
          const actualObject = actualByKey.get(key)
          return (
            actualObject !== undefined &&
            (actualObject.tableName.toUpperCase() !==
              expectedObject.tableName.toUpperCase() ||
              normalizeSqlDefinition(actualObject.sql) !==
                normalizeSqlDefinition(expectedObject.sql))
          )
        })
        .map(([key]) => key)
      if (missing.length > 0 || unexpected.length > 0 || modified.length > 0) {
        const differences = [
          ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
          ...(unexpected.length > 0
            ? [`unexpected ${unexpected.join(", ")}`]
            : []),
          ...(modified.length > 0 ? [`modified ${modified.join(", ")}`] : []),
        ]
        throw new Error(
          `Unsupported session graph schema: installed catalog differs from ${SESSION_GRAPH_MIGRATION} (${differences.join("; ")}). Reset the session database before starting this version.`
        )
      }
    } finally {
      expectedDatabase.close()
    }
  }

  private runMigrations(): void {
    // Ensure migrations tracking table exists
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    // Load migration files (SEA mode uses extracted assets, normal mode uses __dirname)
    const migrationsDir = this.resolveMigrationsDir()
    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`Migrations directory not found: ${migrationsDir}`)
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()

    const missingSessionGraphMigrations = SESSION_GRAPH_MIGRATIONS.filter(
      (migration) => !files.includes(migration)
    )
    if (missingSessionGraphMigrations.length > 0) {
      throw new Error(
        `Required session schema migration is missing: ${missingSessionGraphMigrations.join(", ")}`
      )
    }

    // Get already-applied migrations
    const applied = this.database
      .prepare("SELECT name FROM _migrations ORDER BY id")
      .all() as unknown as Array<{ name: string }>
    const appliedSet = new Set(applied.map((r) => r.name))

    // Apply pending migrations in a transaction
    for (const file of files) {
      if (appliedSet.has(file)) continue

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8")
      this.logger.log(`Applying migration: ${file}`)

      this.runInTransaction(() => {
        this.database.exec(sql)
        this.database
          .prepare("INSERT INTO _migrations (name) VALUES (?)")
          .run(file)
      })

      this.logger.log(`Migration applied: ${file}`)
    }
  }

  /**
   * Session recovery depends on graph identity and provider-native records.
   * Starting against a partially upgraded database would silently resurrect
   * retired session state, so fail at boot rather than attempting a reader
   * fallback or a best-effort repair.
   */
  private assertSessionGraphSchema(): void {
    const migration = this.database
      .prepare("SELECT 1 FROM _migrations WHERE name = ? LIMIT 1")
      .get(SESSION_GRAPH_MIGRATION)
    if (!migration) {
      throw new Error(
        `Required session schema migration was not applied: ${SESSION_GRAPH_MIGRATION}`
      )
    }

    for (const table of RETIRED_SESSION_TABLES) {
      const retiredTable = this.database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
        )
        .get(table)
      if (retiredTable) {
        throw new Error(
          `Unsupported session graph schema: retired table ${table} still exists.`
        )
      }
    }
    this.assertSessionGraphCatalog()

    const row = this.database
      .prepare(
        "SELECT value FROM session_schema_meta WHERE key = 'session_graph_version'"
      )
      .get() as { value?: string } | undefined
    if (row?.value !== SESSION_GRAPH_VERSION) {
      throw new Error(
        `Unsupported session schema version: expected ${SESSION_GRAPH_VERSION}, received ${row?.value ?? "missing"}. Reset the session database before starting this version.`
      )
    }
  }

  /**
   * Auto-migrate account config files from the dev directory
   * (apps/protocol-bridge/data/) to the unified ~/.agent-vibes/data/.
   * Only copies if the target file does NOT already exist (safe first-run migration).
   */
  private migrateAccountConfigs(): void {
    const ACCOUNT_FILES = [
      "antigravity-accounts.json",
      "claude-api-accounts.json",
      "codex-accounts.json",
      "openai-compat-accounts.json",
    ]

    const targetDir = getAgentVibesAccountsDir()

    for (const filename of ACCOUNT_FILES) {
      const targetPath = path.join(targetDir, filename)
      if (fs.existsSync(targetPath)) {
        continue // already migrated or user-created
      }

      // Try to find source in dev data directory
      try {
        const sourcePath = resolveProtocolBridgePath("data", filename)
        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, targetPath)
          this.logger.log(`Migrated ${filename} → ${targetPath}`)
        }
      } catch {
        // Dev directory not available (e.g. SEA mode) — skip silently
      }
    }
  }
}
