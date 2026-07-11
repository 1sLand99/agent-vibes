/**
 * CodexService — Core executor for Codex (OpenAI Responses API) reverse proxy.
 *
 * Handles:
 * - Canonical Codex request execution
 * - HTTP POST to Codex upstream (SSE streaming)
 * - WebSocket transport (with automatic fallback to HTTP)
 * - Codex SSE → Claude SSE response translation
 * - Non-streaming mode
 * - Proxy support (HTTP/HTTPS/SOCKS5)
 * - Request header emulation matching CLIProxyAPI Codex behavior
 * - OAuth token management with auto-refresh
 * - Prompt caching via prompt_cache_key
 * - Retry-after handling for rate limits
 *
 * Ported from CLIProxyAPI:
 *   - internal/runtime/executor/codex_executor.go
 *   - internal/runtime/executor/codex_websockets_executor.go
 *   - internal/translator/codex/claude/
 */

import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import WebSocket from "ws"
import type {
  ProviderAdapter,
  ProviderWarmupHint,
} from "../shared/provider-adapter.interface"
import type { AnthropicResponse } from "../../shared/anthropic"
import {
  getAccountConfigPathCandidates,
  resolveDefaultAccountConfigPath,
} from "../../shared/protocol-bridge-paths"
import { UsageStatsService } from "../../usage"
import {
  createAbortPromise,
  createAbortSignalWithTimeout,
  toUpstreamRequestAbortedError,
  UpstreamRequestAbortedError,
} from "../shared/abort-signal"
import {
  type CooldownableAccount,
  clearAccountDisablement,
  disableAccount,
  isAccountDisabled,
  markAccountCooldown,
  markAccountSuccess,
} from "../shared/account-cooldown"
import { BackendAccountStateStore } from "../shared/backend-account-state-store"
import { PersistenceService } from "../../persistence"
import type { CodexReplacementHistoryItem } from "../../shared/provider-content"
import {
  BackendPoolStatus,
  type CodexRateLimitAccountSummary,
  type CodexRateLimitModelSummary,
  type CodexRateLimitSnapshot,
  type CodexRateLimitSource,
} from "../shared/backend-pool-status"
import { buildBackendPoolStatus } from "../shared/backend-pool-status-summary"
import {
  CodexModelTier,
  getCodexModelIdsForTier,
  getPublicModelMetadata,
  isChatGptCodexModelSupported,
  normalizeCodexModelTier,
  resolveCodexRequestCapabilities,
  supportsCodexModelForTier,
} from "../shared/model-registry"
import { CodexAuthService, type CodexTokenData } from "./codex-auth.service"
import { CodexCacheService } from "./codex-cache.service"
import { CodexClientIdentityService } from "./codex-client-identity.service"
import { buildCodexDispatchLogLine } from "./codex-dispatch-log-summary"
import { resolveCodexPromptCacheIdentity } from "./codex-cache-identity-policy"
import {
  buildCodexHttpHeaders,
  type CodexForwardHeaders,
} from "./codex-header-utils"
import {
  createCodexApiErrorFromBody,
  resolveCodexHttpErrorResponse,
} from "./codex-api-error-response"
import {
  formatCodexRateLimitWindow,
  parseCodexRateLimitHeaders,
} from "./codex-rate-limit-headers"
import {
  getAllCodexAccountsRateLimitedRetrySeconds,
  getCodexAllAccountsRateLimitRetryDelayMs,
  getCodexQuotaCooldownUntil,
  getCodexQuotaRemainingPercent,
  isCodexRateLimitSnapshotExhausted,
} from "./codex-rate-limit-policy"
import {
  getActiveCodexModelCooldowns,
  resolveCodexPoolEntryState,
} from "./codex-pool-status-policy"
import {
  getCodexSlotRecoveryTimeForModel,
  isCodexSlotAvailableForModel,
} from "./codex-slot-availability-policy"
import {
  getCodexRateLimitAccountSummary,
  getCodexRateLimitModelSummary,
  hasCodexRateLimitData,
  normalizeCodexRateLimitModelName,
  setCodexRateLimitSnapshot,
} from "./codex-rate-limit-summary"
import {
  extractCodexCompletedUsage,
  parseCodexSsePayload,
} from "./codex-sse-parsing"
import {
  buildCodexHttpRequestLogLine,
  summarizeCodexCompletedResponseForLogs,
  summarizeCodexRequestForLogs,
} from "./codex-request-log-summary"
import { prepareCodexRequestForSend } from "./codex-request-sanitizer"
import { CodexApiError } from "./codex-api-error"
import { CodexRuntimeCacheStore } from "./codex-runtime-cache-store"
import {
  buildCodexCompactRequestPayload,
  parseCodexCompactOutputHistory,
  summarizeCodexCompactResponseForLogs,
} from "./codex-compact-payload"
import type { CodexTurnContext } from "./codex-turn-context"
import { CodexTurnContextManager } from "./codex-turn-context-manager"
import {
  buildCodexRequest,
  extractWarmupPayload,
} from "./codex-request-builder"
import { CodexSlotRouter } from "./codex-slot-router"
import {
  createCodexPersistedAccountStates,
  getCodexCredentialFingerprint,
  restoreCodexPersistedAccountStates,
  shouldClearCodexDisablementForCredentialChange,
} from "./codex-account-state-policy"
import {
  buildCodexSlotStateKey,
  buildCodexSlotStickyKey,
} from "./codex-slot-identity"
import {
  extractCodexServiceTierFromToml,
  normalizeCodexServiceTier,
} from "./codex-service-tier"
import type {
  CodexExecutionRequest,
  CodexInputItem,
  CodexRequest,
} from "./codex-native-types"
import {
  appendCodexResponseOutputItemToLedger,
  getCodexCompletedResponseId,
} from "./codex-turn-ledger"
import { buildCodexContinuationDecisionLogLine } from "./codex-turn-state"
import {
  captureCodexTurnState,
  extractCodexTurnStateFromMetadataEvent,
  extractCodexTurnKey,
  applyCodexTurnStateHeader as writeCodexTurnStateHeader,
  readCodexTurnStateFromHeaders,
} from "./codex-turn-metadata"
import { isCodexRefreshTokenInvalidationMessage } from "./codex-token-refresh-policy"
import {
  resolveCodexWebSocketFailure,
  shouldReplayCodexRequestWithoutPreviousResponseId,
  shouldRetryCodexWebSocketBeforeHttpFallback,
  shouldRetryCodexSessionWebSocketError,
} from "./codex-transport-error-policy"
import { CodexStreamAttemptBuffer } from "./codex-stream-attempt-buffer"
import {
  isCodexAuthRetryStatus,
  isCodexGatewayTransientStatus,
  isCodexRateLimitRetryStatus,
  shouldFailOverCodexAccountForStatus,
  shouldRefreshCodexTokenForStatus,
  shouldRetryCodexGatewayTransientOnSameSlot,
} from "./codex-status-retry-policy"
import { resolveCodexSlotSelection } from "./codex-slot-selection-policy"
import { shouldSendCodexWarmupPayload } from "./codex-warmup-policy"
import {
  applyCodexFileSlotRecordMetadata,
  buildCodexFileSlotRecordFields,
  buildCodexLoadedAccountTokenSeed,
  buildCodexFileSlotReloadKey,
  buildCodexLoadedRecordReloadKey,
  hydrateCodexTokenData,
  type LoadedCodexAccountRecord,
  mergeCodexLoadedAccountRecords,
  type PersistedCodexAccountRecord,
  upsertCodexPersistedAccountRecord,
} from "./codex-account-records"
import {
  createStreamState,
  translateCodexSseEvent,
  translateCodexToClaudeNonStream,
} from "./codex-response-translator"
import {
  CodexWebSocketService,
  CodexWebSocketUpgradeError,
} from "./codex-websocket.service"
import { buildReverseMapFromClaudeTools } from "./tool-name-shortener"

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex"
const CODEX_ACCOUNTS_CONFIG_PATHS = getAccountConfigPathCandidates(
  "codex-accounts.json"
)
const CODEX_ACCOUNTS_DEFAULT_PATH = resolveDefaultAccountConfigPath(
  "codex-accounts.json"
)
const CODEX_MODEL_TIER_ORDER: CodexModelTier[] = ["free", "plus", "team", "pro"]
const DEFAULT_CODEX_RATE_LIMIT_MODEL = "gpt-5.5"
const DEFAULT_CODEX_WEBSOCKET_STREAM_MAX_RETRIES = 2
const DEFAULT_CODEX_ALL_RATE_LIMIT_MAX_RETRIES = 3
const DEFAULT_CODEX_ALL_RATE_LIMIT_MAX_WAIT_SECONDS = 120

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number.parseInt(value?.trim() || "", 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function codexWebSocketRetryDelayMs(retryCount: number): number {
  return Math.min(250 * 2 ** Math.max(0, retryCount - 1), 1_000)
}

// ── Service ────────────────────────────────────────────────────────────

interface CodexAccountSlot extends CooldownableAccount {
  label?: string
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  accountId?: string
  workspaceId?: string
  email?: string
  planType?: CodexModelTier
  baseUrl: string
  proxyUrl?: string
  configPath?: string
  source: "env" | "file"
  /** 持久化 disabled 状态的唯一标识 key */
  stateKey: string
  /** Per-slot token data for independent refresh */
  tokenData: CodexTokenData | null
  refreshPromise?: Promise<CodexTokenData | null>
  persistedMatch?: {
    apiKey?: string
    email?: string
    accountId?: string
    accessToken?: string
    refreshToken?: string
  }
  /** Rate limit snapshots from x-codex-* response headers, keyed by model */
  rateLimitSnapshots: Map<
    string,
    Partial<Record<CodexRateLimitSource, CodexRateLimitSnapshot>>
  >
}

@Injectable()
export class CodexService implements OnModuleInit, ProviderAdapter {
  private readonly logger = new Logger(CodexService.name)

  /** All loaded accounts (round-robin pool) */
  private accounts: CodexAccountSlot[] = []
  /** Backing file used for multi-account OAuth persistence */
  private accountsFilePath: string = CODEX_ACCOUNTS_DEFAULT_PATH

  private readonly slotRouter = new CodexSlotRouter({
    affinityTtlMs: 60 * 60 * 1000,
  })

  private configuredModelTier: CodexModelTier | null = null
  private configuredDefaultServiceTier: string | undefined

  /** Whether to prefer WebSocket transport over HTTP */
  private useWebSocket: boolean = false
  private readonly sessionWarmupPromises = new Map<string, Promise<void>>()

  private readonly runtimeCache = new CodexRuntimeCacheStore()
  private readonly websocketStreamMaxRetries: number
  private readonly allRateLimitMaxRetries: number
  private readonly allRateLimitMaxWaitSeconds: number

  /**
   * Logical Codex turn lifecycle. Physical WebSocket transport still belongs
   * to wsService; this manager owns the conversation-scoped ModelClientSession
   * state that mirrors the upstream Codex CLI runtime.
   */
  private readonly turnContexts: CodexTurnContextManager

  private rateLimitProbePromise: Promise<number> | null = null
  private activeLiveRequests = 0
  private activeRateLimitProbeAbortController: AbortController | null = null

  /** 持久化 Codex 账号 disabled 状态的 store */
  private readonly accountStateStore: BackendAccountStateStore

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: CodexAuthService,
    private readonly cacheService: CodexCacheService,
    private readonly wsService: CodexWebSocketService,
    private readonly identity: CodexClientIdentityService,
    private readonly usageStats: UsageStatsService,
    persistence: PersistenceService
  ) {
    this.turnContexts = new CodexTurnContextManager({
      runtimeCache: this.runtimeCache,
      closeWsSession: (sessionId) => this.wsService.closeSession(sessionId),
    })
    this.websocketStreamMaxRetries = parseNonNegativeInteger(
      this.configService.get<string>("CODEX_WEBSOCKET_STREAM_MAX_RETRIES", ""),
      DEFAULT_CODEX_WEBSOCKET_STREAM_MAX_RETRIES
    )
    this.allRateLimitMaxRetries = parseNonNegativeInteger(
      this.configService.get<string>("CODEX_ALL_RATE_LIMIT_MAX_RETRIES", ""),
      DEFAULT_CODEX_ALL_RATE_LIMIT_MAX_RETRIES
    )
    this.allRateLimitMaxWaitSeconds = parseNonNegativeInteger(
      this.configService.get<string>(
        "CODEX_ALL_RATE_LIMIT_MAX_WAIT_SECONDS",
        ""
      ),
      DEFAULT_CODEX_ALL_RATE_LIMIT_MAX_WAIT_SECONDS
    )
    this.accountStateStore = new BackendAccountStateStore(
      persistence,
      this.logger
    )
  }

  onModuleInit() {
    const envApiKey = this.configService.get<string>("CODEX_API_KEY", "").trim()
    const envAccessToken = this.configService
      .get<string>("CODEX_ACCESS_TOKEN", "")
      .trim()
    const envIdToken = this.configService
      .get<string>("CODEX_ID_TOKEN", "")
      .trim()
    const envRefreshToken = this.configService
      .get<string>("CODEX_REFRESH_TOKEN", "")
      .trim()
    const envAccountId = this.configService
      .get<string>("CODEX_ACCOUNT_ID", "")
      .trim()
    const envPlanType = normalizeCodexModelTier(
      this.configService.get<string>("CODEX_PLAN_TYPE", "")
    )
    const envBaseUrl =
      this.configService
        .get<string>("CODEX_BASE_URL", DEFAULT_BASE_URL)
        .trim() || DEFAULT_BASE_URL
    const envProxyUrl = this.configService
      .get<string>("CODEX_PROXY_URL", "")
      .trim()

    // WebSocket transport preference.
    // Default to enabled because it offers lower latency and will
    // automatically fall back to HTTP when the upstream rejects upgrades.
    const wsEnv = this.configService
      .get<string>("CODEX_USE_WEBSOCKET", "")
      .trim()
      .toLowerCase()
    this.useWebSocket = !["false", "0", "off", "no"].includes(wsEnv)

    // 1. Load all accounts from codex-accounts.json
    const fileAccounts = this.loadAllCodexAccountsFromFile()

    // 2. Load persisted tokens (for legacy single-account mode)
    const persisted = this.authService.loadPersistedTokens()

    // 3. Add env-var account as first slot if it has credentials
    if (envApiKey || envAccessToken || persisted?.refreshToken) {
      const envSlot: CodexAccountSlot = {
        label: "env",
        apiKey: envApiKey || undefined,
        accessToken: envAccessToken || undefined,
        baseUrl: envBaseUrl,
        proxyUrl: envProxyUrl || undefined,
        source: "env",
        stateKey: this.buildCodexSlotStateKey({
          apiKey: envApiKey,
          email: "",
          accountId: envAccountId,
          baseUrl: envBaseUrl,
        }),
        tokenData: null,
        cooldownUntil: 0,
        modelStates: new Map(),
        rateLimitSnapshots: new Map(),
      }

      if (persisted?.refreshToken) {
        this.applyTokenDataToSlot(envSlot, persisted)
      } else if (envAccessToken || envRefreshToken || envIdToken) {
        this.applyTokenDataToSlot(
          envSlot,
          this.hydrateTokenData({
            idToken: envIdToken,
            accessToken: envAccessToken,
            refreshToken: envRefreshToken,
            accountId: envAccountId,
            email: "",
          })
        )
      }

      if (envPlanType) {
        envSlot.planType = envPlanType
      }

      // Only add if not duplicated in file accounts
      const isDuplicate = fileAccounts.some(
        (a) =>
          (a.apiKey && a.apiKey === envSlot.apiKey) ||
          ((a.email || a.accountId) &&
            a.email === envSlot.email &&
            (a.accountId || "") === (envSlot.accountId || ""))
      )
      if (!isDuplicate) {
        this.accounts.unshift(envSlot)
      }
    }

    // 4. Add file accounts
    for (const fa of fileAccounts) {
      this.accounts.push(
        this.createFileSlotFromLoadedRecord(fa, envBaseUrl, envProxyUrl)
      )
    }

    this.configuredModelTier = this.resolveConfiguredModelTier()
    this.configuredDefaultServiceTier =
      this.resolveConfiguredDefaultServiceTier()

    this.logger.log(
      `Codex backend initialized: ${this.accounts.length} account(s), ` +
        `defaultBaseUrl=${envBaseUrl}, useWebSocket=${this.useWebSocket}, ` +
        `modelTier=${this.configuredModelTier || "unknown"}, ` +
        `serviceTier=${this.configuredDefaultServiceTier || "default"}`
    )
    for (const acct of this.accounts) {
      this.logger.log(
        `  → ${acct.label || acct.email || "unnamed"}: ` +
          `${acct.apiKey ? "api-key" : "oauth"} @ ${acct.baseUrl}`
      )
    }
    if (this.accounts.length === 0) {
      this.logger.warn(
        "No Codex credentials configured. " +
          "GPT/O-series models will not be available."
      )
    }

    // 5. 恢复持久化的 disabled 状态，避免重启后再次用失效账号做 warmup 导致无意义 401
    this.restorePersistedAccountStates()
  }

  /**
   * Check if Codex backend is available (has at least one account).
   */
  isAvailable(): boolean {
    return this.accounts.length > 0
  }

  /**
   * Hot-reload accounts from config file.
   * Reconciles file-backed slots against the latest account file, preserving
   * runtime state only for matching live slots and removing stale file slots.
   * Returns the number of newly added accounts.
   */
  reloadAccounts(): number {
    const freshRecords = this.loadAllCodexAccountsFromFile()
    const envBaseUrl =
      this.configService
        .get<string>("CODEX_BASE_URL", DEFAULT_BASE_URL)
        .trim() || DEFAULT_BASE_URL
    const envProxyUrl = this.configService
      .get<string>("CODEX_PROXY_URL", "")
      .trim()

    const existingFileSlots = new Map<string, CodexAccountSlot>()
    for (const slot of this.accounts) {
      if (slot.source !== "file") {
        continue
      }
      existingFileSlots.set(
        buildCodexFileSlotReloadKey(slot, DEFAULT_BASE_URL),
        slot
      )
    }

    const nextAccounts = this.accounts.filter((slot) => slot.source !== "file")
    const seenReloadKeys = new Set<string>()
    let added = 0

    freshRecords.forEach((record, index) => {
      const reloadKey = buildCodexLoadedRecordReloadKey(
        record,
        envBaseUrl,
        DEFAULT_BASE_URL,
        index
      )
      if (seenReloadKeys.has(reloadKey)) {
        return
      }
      seenReloadKeys.add(reloadKey)

      const existingSlot = existingFileSlots.get(reloadKey)
      if (existingSlot) {
        this.refreshFileSlotFromRecord(
          existingSlot,
          record,
          envBaseUrl,
          envProxyUrl
        )
        nextAccounts.push(existingSlot)
        existingFileSlots.delete(reloadKey)
        return
      }

      const slot = this.createFileSlotFromLoadedRecord(
        record,
        envBaseUrl,
        envProxyUrl
      )
      nextAccounts.push(slot)
      added++
      this.logger.log(
        `[Hot-reload] Added new Codex account: ${this.getAccountLabel(slot)}`
      )
    })

    const removedSlots = Array.from(existingFileSlots.values())
    if (removedSlots.length > 0) {
      this.pruneConversationBindingsForSlots(removedSlots)
      this.logger.log(
        `[Hot-reload] Codex: removed ${removedSlots.length} stale file account(s)`
      )
    }

    this.accounts = nextAccounts
    this.slotRouter.normalizeAccountIndex(this.accounts.length)
    this.configuredModelTier = this.resolveConfiguredModelTier()

    if (added > 0 || removedSlots.length > 0) {
      this.logger.log(
        `[Hot-reload] Codex: +${added} / -${removedSlots.length}, total=${this.accounts.length}`
      )
    }

    return added
  }

  getPoolStatus(): BackendPoolStatus {
    const now = Date.now()
    const entries = this.accounts.map((account) => {
      const modelCooldowns = getActiveCodexModelCooldowns(account, now)
      const state = resolveCodexPoolEntryState(account, modelCooldowns, now)
      return {
        id: [
          account.email || "",
          account.accountId || "",
          account.workspaceId || "",
          account.apiKey || "",
          account.baseUrl,
        ].join("\0"),
        label: this.getAccountLabel(account),
        state,
        cooldownUntil: account.cooldownUntil,
        disabledAt: account.disabledAt,
        disabledReason: account.disabledReason,
        source: account.source,
        baseUrl: account.baseUrl,
        proxyUrl: account.proxyUrl,
        planType: account.planType,
        email: account.email,
        accountId: account.accountId,
        workspaceId: account.workspaceId,
        modelCooldowns,
        rateLimits: this.getRateLimitAccountSummary(account),
      }
    })

    return buildBackendPoolStatus({
      backend: "codex",
      kind: "account-pool",
      configured: this.accounts.length > 0,
      configPath: this.accountsFilePath,
      entries,
    })
  }

  getModelTier(): CodexModelTier | null {
    return this.getHighestLoadedModelTier() || this.configuredModelTier
  }

  getDefaultServiceTier(): string | undefined {
    return this.configuredDefaultServiceTier
  }

  supportsModel(modelName: string): boolean {
    const normalized = modelName.toLowerCase().trim()
    if (!normalized) {
      return false
    }

    return this.hasSupportingAccount(normalized)
  }

  private resolveConfiguredModelTier(): CodexModelTier | null {
    const envTier = normalizeCodexModelTier(
      this.configService.get<string>("CODEX_PLAN_TYPE", "")
    )
    if (envTier) {
      return envTier
    }

    return this.readModelTierFromLocalAuthFile()
  }

  private resolveConfiguredDefaultServiceTier(): string | undefined {
    const envTier = normalizeCodexServiceTier(
      this.configService.get<string>("CODEX_SERVICE_TIER", "")
    )
    if (envTier) {
      return envTier
    }

    return this.readServiceTierFromLocalConfig()
  }

  private readServiceTierFromLocalConfig(): string | undefined {
    const codexHome =
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
    const configFile = path.join(codexHome, "config.toml")

    try {
      if (!fs.existsSync(configFile)) {
        return undefined
      }

      const raw = fs.readFileSync(configFile, "utf8")
      return extractCodexServiceTierFromToml(raw)
    } catch (error) {
      this.logger.warn(
        `Failed to infer Codex service tier from ${configFile}: ${error instanceof Error ? error.message : String(error)}`
      )
      return undefined
    }
  }

  private readModelTierFromLocalAuthFile(): CodexModelTier | null {
    const codexHome =
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
    const authFile = path.join(codexHome, "auth.json")

    try {
      if (!fs.existsSync(authFile)) {
        return null
      }

      const raw = fs.readFileSync(authFile, "utf8")
      const parsed = JSON.parse(raw) as {
        tokens?: { id_token?: string }
      }

      return this.authService.getPlanTypeFromIdToken(
        parsed.tokens?.id_token || ""
      )
    } catch (error) {
      this.logger.warn(
        `Failed to infer Codex plan type from ${authFile}: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  /**
   * Load all Codex accounts from codex-accounts.json.
   */
  private loadAllCodexAccountsFromFile(): LoadedCodexAccountRecord[] {
    const loadedRecords: LoadedCodexAccountRecord[] = []
    const loadedPaths: string[] = []

    for (const configPath of CODEX_ACCOUNTS_CONFIG_PATHS) {
      if (!fs.existsSync(configPath)) continue

      try {
        const data = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
          accounts?: PersistedCodexAccountRecord[]
        }
        if (Array.isArray(data.accounts) && data.accounts.length > 0) {
          loadedPaths.push(configPath)
          this.logger.log(
            `Loaded ${data.accounts.length} Codex account(s) from ${configPath}`
          )
          loadedRecords.push(
            ...data.accounts.map((account) => ({
              ...account,
              configPath,
            }))
          )
        }
      } catch (err) {
        this.logger.warn(
          `Failed to parse ${configPath}: ${(err as Error).message}`
        )
      }
    }

    if (loadedRecords.length === 0) {
      return []
    }

    const mergedRecords = mergeCodexLoadedAccountRecords(loadedRecords)
    const preferredConfigPath =
      mergedRecords[mergedRecords.length - 1]?.configPath ||
      loadedPaths[loadedPaths.length - 1] ||
      CODEX_ACCOUNTS_DEFAULT_PATH

    this.accountsFilePath = preferredConfigPath

    if (
      loadedPaths.length > 1 ||
      mergedRecords.length !== loadedRecords.length
    ) {
      this.logger.log(
        `Merged ${mergedRecords.length} Codex account(s) from ${loadedPaths.join(", ")}`
      )
    }

    return mergedRecords
  }

  /**
   * Derive per-slot token metadata from persisted or env-backed credentials.
   */
  private hydrateTokenData(tokenData: Partial<CodexTokenData>): CodexTokenData {
    return hydrateCodexTokenData(tokenData, {
      getAccountIdFromIdToken: (idToken) =>
        this.authService.getAccountIdFromIdToken(idToken),
      getWorkspaceIdFromIdToken: (idToken) =>
        this.authService.getWorkspaceIdFromIdToken(idToken),
      getTokenExpiryFromJwt: (token) =>
        this.authService.getTokenExpiryFromJwt(token),
    })
  }

  private applyTokenDataToSlot(
    slot: CodexAccountSlot,
    tokenData: CodexTokenData
  ): void {
    slot.tokenData = tokenData
    slot.accessToken = tokenData.accessToken || slot.accessToken
    slot.refreshToken = tokenData.refreshToken || slot.refreshToken
    slot.accountId =
      tokenData.accountId ||
      slot.accountId ||
      this.authService.getAccountIdFromIdToken(tokenData.idToken)
    slot.workspaceId =
      tokenData.workspaceId ||
      slot.workspaceId ||
      this.authService.getWorkspaceIdFromIdToken(tokenData.idToken)
    slot.email = tokenData.email || slot.email

    // 与 CLIProxyAPI 的管理面板保持一致：
    // 如果账号文件里已经明确声明了 planType，就不要再被 token claim 覆盖。
    // 某些账号会出现 token 里仍然是 free，但实际账号/面板展示应保持 plus 的情况。
    if (!slot.planType) {
      slot.planType =
        this.authService.getPlanTypeFromTokenData(tokenData) ?? undefined
    }
  }

  private getSlotPlanType(slot: CodexAccountSlot): CodexModelTier | null {
    return (
      slot.planType || this.authService.getPlanTypeFromTokenData(slot.tokenData)
    )
  }

  private getHighestLoadedModelTier(): CodexModelTier | null {
    let highest: CodexModelTier | null = null

    for (const slot of this.accounts) {
      const tier = this.getSlotPlanType(slot)
      if (!tier) continue
      if (
        !highest ||
        CODEX_MODEL_TIER_ORDER.indexOf(tier) >
          CODEX_MODEL_TIER_ORDER.indexOf(highest)
      ) {
        highest = tier
      }
    }

    return highest
  }

  private getSlotAccountId(slot: CodexAccountSlot): string {
    return (
      this.authService.getAccountIdFromTokenData(slot.tokenData) ||
      slot.accountId ||
      ""
    )
  }

  private getConversationId(
    request: Pick<CodexExecutionRequest, "conversationId">
  ): string {
    return typeof request.conversationId === "string"
      ? request.conversationId.trim()
      : ""
  }

  private getCodexTurnKey(codexRequest: Record<string, unknown>): string {
    return extractCodexTurnKey(codexRequest)
  }

  private usesResponsesLite(modelName: string): boolean {
    return resolveCodexRequestCapabilities(modelName)?.useResponsesLite === true
  }

  private applyCodexTurnStateHeader(
    headers: Record<string, string>,
    context: CodexTurnContext | undefined
  ): void {
    writeCodexTurnStateHeader(headers, context?.turnState)
  }

  private captureCodexTurnStateFromConnection(
    context: CodexTurnContext | undefined,
    ws: WebSocket
  ): void {
    if (!context) {
      return
    }
    const turnState = this.wsService
      .getConnectionMetadata(ws)
      ?.turnState?.trim()
    if (!captureCodexTurnState(context, turnState)) {
      return
    }
    this.logger.debug(
      `[Codex][TurnContext] Captured x-codex-turn-state for session=${context.wsSessionId} turn=${context.turnKey || "unknown"}`
    )
  }

  private captureCodexTurnStateFromHttpHeaders(
    context: CodexTurnContext | undefined,
    headers: Pick<Headers, "get">
  ): void {
    if (!context) {
      return
    }
    const turnState = readCodexTurnStateFromHeaders(headers)
    if (!captureCodexTurnState(context, turnState)) {
      return
    }
    this.logger.debug(
      `[Codex][TurnContext] Captured x-codex-turn-state from HTTP for session=${context.wsSessionId} turn=${context.turnKey || "unknown"}`
    )
  }

  private captureCodexTurnStateFromSsePayload(
    context: CodexTurnContext | undefined,
    payload: Record<string, unknown> | null
  ): void {
    if (!context) {
      return
    }
    const turnState = extractCodexTurnStateFromMetadataEvent(payload)
    if (!captureCodexTurnState(context, turnState)) {
      return
    }
    this.logger.debug(
      `[Codex][TurnContext] Captured x-codex-turn-state from response.metadata for session=${context.wsSessionId} turn=${context.turnKey || "unknown"}`
    )
  }

  // ── CodexTurnContext lifecycle management ──────────────────────────────
  //
  // Mirrors the official Codex CLI ModelClient.new_session() / ModelClientSession.Drop.
  // All requests for a conversation (prewarm + stream) share a single CodexTurnContext.
  // When a turn ends the connection is returned to cachedWsSessions.
  // Eliminates the warm pool promotion mechanism entirely.

  /**
   * Generate the cross-turn connection cache key.
   * Conversation-scoped requests must not share previous_response_id state.
   * Global keys are only used for startup/model-picker warmups with no conversation.
   */
  private getCachedWsKey(
    slot: CodexAccountSlot,
    modelName: string,
    conversationId?: string
  ): string {
    return this.turnContexts.buildWsCacheKey({
      slotKey: this.getSlotStickyKey(slot),
      modelName,
      conversationId,
    })
  }

  /**
   * Get or create a turn context for the given conversation.
   * Mirrors the official ModelClient.new_session().
   *
   * If cachedWsSessions has a matching connection, it is taken and reused.
   * If an active turn context already exists, it is returned directly.
   */
  private getOrCreateTurnContext(
    conversationId: string,
    slot: CodexAccountSlot,
    modelName: string,
    turnKey?: string
  ): CodexTurnContext {
    return this.turnContexts.getOrCreateContext({
      conversationId,
      slotKey: this.getSlotStickyKey(slot),
      modelName,
      turnKey,
    })
  }

  /**
   * Return the turn context's connection to cachedWsSessions.
   * Mirrors the official ModelClientSession.Drop.
   */
  private disposeTurnContext(
    conversationId: string,
    slot: CodexAccountSlot,
    modelName: string
  ): void {
    this.turnContexts.disposeContext({
      conversationId,
      slotKey: this.getSlotStickyKey(slot),
      modelName,
    })
  }

  /**
   * Automatically inject previous_response_id before sending a request.
   * Mirrors official prepare_websocket_request() + get_incremental_items().
   *
   * The response-chain baseline is scoped to the live upstream WebSocket.
   * When that socket is rebuilt, the server rejects the old response id, so the
   * new connection must start with a full request and rely on prompt caching.
   */
  private prepareRequestWithTurnContext(
    codexRequest: Record<string, unknown>,
    context: CodexTurnContext,
    conversationId: string
  ): Record<string, unknown> {
    const { request, decision } = this.turnContexts.prepareRequest(
      codexRequest,
      context
    )
    this.logger.debug(
      buildCodexContinuationDecisionLogLine(conversationId, decision)
    )
    return request
  }

  private beginFullCodexResponseChain(
    context: CodexTurnContext | undefined,
    conversationId: string | undefined,
    codexRequest: Record<string, unknown>,
    reason: string
  ): void {
    if (!context) {
      return
    }

    const previousResponseId = this.turnContexts.beginFullResponseChain(
      context,
      codexRequest
    )
    if (conversationId && previousResponseId) {
      this.logger.debug(
        `[Codex][TurnContext] Reset response chain for ${conversationId}: ${reason}; ` +
          `discarded previous_response_id=${previousResponseId}`
      )
    }
  }

  /**
   * Capture the response_id and output items from a response.completed event.
   * Mirrors map_response_stream() ResponseEvent::Completed → LastResponse.
   */
  private captureResponseInTurnContext(
    conversationId: string,
    responseId: string,
    itemsAdded: CodexInputItem[]
  ): void {
    if (
      !this.turnContexts.captureResponse(conversationId, responseId, itemsAdded)
    ) {
      return
    }
    this.logger.debug(
      `[Codex][TurnContext] Captured response_id=${responseId} ` +
        `for conversation=${conversationId}; items_added=${itemsAdded.length}`
    )
  }

  /**
   * Clear response state in the turn context when the transcript baseline is
   * no longer safe for incremental append.
   */
  private resetTurnContextResponseState(
    conversationId: string,
    reason?: string
  ): void {
    const previousResponseId =
      this.turnContexts.resetResponseState(conversationId)
    if (previousResponseId && reason) {
      this.logger.debug(
        `[Codex][TurnContext] ${reason} for ${conversationId}, ` +
          `discarding stale previous_response_id=${previousResponseId}`
      )
    }
  }

  private recordTurnContextTransportReconnect(
    conversationId: string | undefined,
    slot: CodexAccountSlot,
    modelName: string,
    reason: string
  ): void {
    const normalizedConversationId = conversationId?.trim()
    if (!normalizedConversationId) {
      return
    }

    const result = this.turnContexts.recordTransportReconnect({
      conversationId: normalizedConversationId,
      slotKey: this.getSlotStickyKey(slot),
      modelName,
    })
    if (!result.hadContinuationBaseline) {
      return
    }

    const discarded = result.discardedPreviousResponseId
      ? ` discarded_previous_response_id=${result.discardedPreviousResponseId}`
      : ""
    this.logger.debug(
      `[Codex][TurnContext] ${reason} for ${normalizedConversationId}; ` +
        `cleared response chain for rebuilt WebSocket${discarded}`
    )
  }

  private isHttpFallbackTransport(
    conversationId: string | undefined,
    slot: CodexAccountSlot,
    modelName: string
  ): boolean {
    const normalizedConversationId = conversationId?.trim()
    if (!normalizedConversationId) {
      return false
    }

    return this.turnContexts.isHttpFallbackTransport({
      conversationId: normalizedConversationId,
      slotKey: this.getSlotStickyKey(slot),
      modelName,
    })
  }

  private beginHttpTransportTurn(
    conversationId: string | undefined,
    slot: CodexAccountSlot,
    modelName: string,
    reason: string,
    persistHttpFallback: boolean = false
  ): void {
    const normalizedConversationId = conversationId?.trim()
    if (!normalizedConversationId) {
      return
    }

    const result = this.turnContexts.beginHttpTransportTurn({
      conversationId: normalizedConversationId,
      slotKey: this.getSlotStickyKey(slot),
      modelName,
      persistHttpFallback,
    })

    if (
      !result.httpFallbackActivated &&
      !result.clearedActiveContext &&
      !result.deletedCachedContext
    ) {
      return
    }

    const discarded = result.discardedPreviousResponseId
      ? ` discarded previous_response_id=${result.discardedPreviousResponseId}`
      : ""
    const closed =
      result.closedSessionIds.length > 0
        ? ` closed_sessions=${result.closedSessionIds.join(",")}`
        : ""
    this.logger.debug(
      `[Codex][TurnContext] ${reason} for ${normalizedConversationId}; ` +
        `using HTTP transport${persistHttpFallback ? " for session" : ""}${discarded}${closed}`
    )
  }

  /**
   * Reset Codex continuation state after the model-facing transcript was
   * rewritten by compaction, snip, microcompact, or hard-fit projection.
   *
   * This mirrors Codex CLI's ModelClientSession.reset_websocket_session():
   * once history is rewritten, the previous WebSocket response chain is no
   * longer a valid baseline for previous_response_id deltas.
   */
  resetConversationContinuationState(
    conversationId: string | undefined,
    modelName?: string,
    reason?: string
  ): void {
    const normalizedConversationId = conversationId?.trim()
    if (!normalizedConversationId) {
      return
    }

    const result = this.turnContexts.resetContinuationState({
      conversationId: normalizedConversationId,
      modelName,
      slotKeys: this.accounts.map((slot) => this.getSlotStickyKey(slot)),
    })

    if (result.discardedActivePreviousResponseId && reason) {
      this.logger.debug(
        `[Codex][TurnContext] ${reason} for ${normalizedConversationId}, ` +
          `discarding stale previous_response_id=${result.discardedActivePreviousResponseId}`
      )
    }

    if (result.resetCount > 0 || reason) {
      this.logger.debug(
        `[Codex][TurnContext] Reset continuation state for ${normalizedConversationId}` +
          `${result.modelName ? ` model=${result.modelName}` : ""}` +
          `${reason ? `: ${reason}` : ""}`
      )
    }
  }

  /**
   * Discard the previous_response_id baseline without closing the current
   * upstream transport. Use this when the next turn's prompt surface changes
   * while the current Codex response stream is still open.
   */
  clearConversationContinuationBaseline(
    conversationId: string | undefined,
    modelName?: string,
    reason?: string
  ): void {
    const normalizedConversationId = conversationId?.trim()
    if (!normalizedConversationId) {
      return
    }

    const result = this.turnContexts.clearContinuationBaseline({
      conversationId: normalizedConversationId,
      modelName,
      slotKeys: this.accounts.map((slot) => this.getSlotStickyKey(slot)),
    })

    const discarded = result.discardedPreviousResponseId
      ? ` discarded_previous_response_id=${result.discardedPreviousResponseId}`
      : ""
    if (result.resetCount > 0 || reason) {
      this.logger.debug(
        `[Codex][TurnContext] Cleared continuation baseline for ${normalizedConversationId}` +
          `${result.modelName ? ` model=${result.modelName}` : ""}` +
          `${reason ? `: ${reason}` : ""}${discarded}`
      )
    }
  }

  private hasConversationContinuationState(
    conversationId: string,
    slot?: CodexAccountSlot,
    modelName?: string
  ): boolean {
    return this.turnContexts.hasContinuationState(
      conversationId,
      slot && modelName
        ? {
            slotKey: this.getSlotStickyKey(slot),
            modelName,
          }
        : undefined
    )
  }

  private async acquireConversationStreamLock(
    conversationId: string
  ): Promise<() => void> {
    return this.turnContexts.acquireStreamLock(conversationId)
  }

  private onLiveRequestStart(): void {
    this.activeLiveRequests += 1
    if (this.activeRateLimitProbeAbortController) {
      this.activeRateLimitProbeAbortController.abort()
    }
  }

  private onLiveRequestEnd(): void {
    this.activeLiveRequests = Math.max(0, this.activeLiveRequests - 1)
  }

  private setWarmupPayloadCache(
    conversationId: string,
    payload: Record<string, unknown>
  ): void {
    this.turnContexts.setWarmupPayload(conversationId, payload)
  }

  private getWarmupPayloadCache(
    conversationId: string | undefined
  ): Record<string, unknown> | undefined {
    return this.turnContexts.getWarmupPayload(conversationId)
  }

  private getSlotStickyKey(slot: CodexAccountSlot): string {
    return buildCodexSlotStickyKey({
      apiKey: slot.apiKey,
      accountId: this.getSlotAccountId(slot),
      email: slot.email,
      refreshToken: slot.tokenData?.refreshToken || slot.refreshToken,
      accessToken: slot.tokenData?.accessToken || slot.accessToken,
      label: slot.label,
      baseUrl: slot.baseUrl,
    })
  }

  private purgeExpiredConversationBindings(now: number = Date.now()): void {
    this.slotRouter.pruneExpiredBindings(now, (conversationId) => {
      // 同步清理 conversationSession 的 active turn 字段（仅文本元数据，无连接句柄）。
      // 物理 WS 连接由 wsService 自己的 STALE_TIMEOUT_MS 兜底。
      this.turnContexts.clearActiveContext(conversationId)
    })
  }

  private bindConversationToSlot(
    conversationId: string,
    slot: CodexAccountSlot
  ): void {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId) return

    this.purgeExpiredConversationBindings()
    this.slotRouter.bindConversation(
      normalizedConversationId,
      this.getSlotStickyKey(slot)
    )
  }

  private getStickyConversationSlot(
    conversationId: string,
    modelName: string
  ): CodexAccountSlot | null {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId) {
      return null
    }

    const normalizedModelName = modelName.toLowerCase().trim()
    const now = Date.now()
    this.purgeExpiredConversationBindings(now)
    return this.slotRouter.getStickySlot(normalizedConversationId, {
      candidates: this.accounts,
      getSlotKey: (candidate) => this.getSlotStickyKey(candidate),
      isSlotUsable: (candidate) =>
        this.isModelSupportedBySlot(candidate, normalizedModelName) &&
        this.isSlotAvailableForModel(candidate, normalizedModelName, now),
    })
  }

  private isModelSupportedBySlot(
    slot: CodexAccountSlot,
    modelName: string
  ): boolean {
    if (this.isApiKeyMode(slot)) {
      return true
    }

    const tier = this.getSlotPlanType(slot) || this.getModelTier() || "pro"
    return (
      isChatGptCodexModelSupported(modelName) &&
      supportsCodexModelForTier(modelName, tier)
    )
  }

  private hasSupportingAccount(modelName: string): boolean {
    const normalized = modelName.toLowerCase().trim()
    if (!normalized) {
      return false
    }

    return this.accounts.some(
      (slot) =>
        !isAccountDisabled(slot) &&
        this.isModelSupportedBySlot(slot, normalized)
    )
  }

  // ── Codex 账号 disabled 状态持久化 ──────────────────────────────────

  /**
   * 生成 slot 的持久化 stateKey。
   * 优先使用 email+accountId（与 Codex 账号一一对应），
   * fallback 到 apiKey hash，最终 fallback 到 baseUrl hash。
   */
  private buildCodexSlotStateKey(identity: {
    apiKey?: string
    email?: string
    accountId?: string
    baseUrl?: string
  }): string {
    return buildCodexSlotStateKey(identity, DEFAULT_BASE_URL)
  }

  /**
   * 从 SQLite 恢复持久化的 disabled 状态。
   * 重启后已经被永久 disable 的账号直接跳过，不再做 warmup。
   *
   * 凭据指纹比对：如果当前文件里的凭据与被 disable 时记录的指纹不一致，
   * 说明用户已经重新同步了新凭据（例如官方 CLI 抢先轮换 refresh token 导致
   * 旧凭据失效后用户重新登录），原 disable 原因已不成立，跳过恢复并清除这条
   * 过期记录。这样重新 sync 凭据 + 重启即可自愈，无需手动清库。
   */
  private restorePersistedAccountStates(): void {
    const persistedStates = this.accountStateStore.loadStates("codex")
    if (persistedStates.size === 0) return

    const result = restoreCodexPersistedAccountStates(
      this.accounts,
      persistedStates
    )

    for (const { slot, state } of result.stale) {
      this.logger.log(
        `[Codex] 检测到凭据已更新，清除过期 disabled 状态: ${this.getAccountLabel(slot)} (reason=${state.disabledReason})`
      )
    }

    for (const { slot, state } of result.restored) {
      this.logger.warn(
        `[Codex] 恢复已 disabled 账号: ${this.getAccountLabel(slot)} (reason=${state.disabledReason})`
      )
    }

    // 有过期记录被清除时，把内存状态重新写回 DB，保证持久化层与内存对齐。
    if (result.stale.length > 0) {
      this.persistCodexAccountStates()
    }
  }

  /**
   * 将所有 Codex 账号的 disabled 状态持久化到 SQLite。
   * 仅在 disableAccount 后调用，保证下次重启时跳过失效账号。
   */
  private persistCodexAccountStates(): void {
    const states = createCodexPersistedAccountStates(this.accounts, Date.now())
    this.accountStateStore.replaceStates("codex", states)
  }

  private getAccountLabel(slot: CodexAccountSlot): string {
    const base = slot.label || slot.email || slot.accountId || "slot"
    const details: string[] = []

    if (slot.accountId) {
      details.push(slot.accountId.slice(0, 8))
    } else if (slot.workspaceId) {
      details.push(`ws:${slot.workspaceId.slice(0, 8)}`)
    } else {
      details.push(slot.source)
    }

    if (slot.planType) {
      details.push(slot.planType)
    }

    return `${base} (${details.join(", ")})`
  }

  private createFileSlotFromLoadedRecord(
    record: LoadedCodexAccountRecord,
    fallbackBaseUrl: string,
    fallbackProxyUrl: string
  ): CodexAccountSlot {
    const fields = buildCodexFileSlotRecordFields(
      record,
      fallbackBaseUrl,
      fallbackProxyUrl
    )
    const slot: CodexAccountSlot = {
      ...fields,
      source: "file",
      stateKey: this.buildCodexSlotStateKey({
        apiKey: record.apiKey,
        email: record.email,
        accountId: record.accountId,
        baseUrl: fields.baseUrl,
      }),
      tokenData: null,
      cooldownUntil: 0,
      modelStates: new Map(),
      rateLimitSnapshots: new Map(),
    }

    const tokenSeed = buildCodexLoadedAccountTokenSeed(record)
    if (tokenSeed) {
      this.applyTokenDataToSlot(slot, this.hydrateTokenData(tokenSeed))
    }

    return slot
  }

  private refreshFileSlotFromRecord(
    slot: CodexAccountSlot,
    record: LoadedCodexAccountRecord,
    fallbackBaseUrl: string,
    fallbackProxyUrl: string
  ): void {
    // 捕获更新前的凭据指纹，用于热重载（如 Sync Codex CLI）时判断凭据是否已变更。
    const wasDisabled = isAccountDisabled(slot)
    const previousFingerprint = wasDisabled
      ? getCodexCredentialFingerprint(slot)
      : ""

    const fields = buildCodexFileSlotRecordFields(
      record,
      fallbackBaseUrl,
      fallbackProxyUrl
    )
    applyCodexFileSlotRecordMetadata(slot, fields)

    const tokenSeed = buildCodexLoadedAccountTokenSeed(record)
    if (tokenSeed) {
      this.applyTokenDataToSlot(slot, this.hydrateTokenData(tokenSeed))
      this.clearDisablementIfCredentialChanged(
        slot,
        wasDisabled,
        previousFingerprint
      )
      return
    }

    slot.accessToken = undefined
    slot.refreshToken = undefined
    slot.tokenData = null
    slot.refreshPromise = undefined
    this.clearDisablementIfCredentialChanged(
      slot,
      wasDisabled,
      previousFingerprint
    )
  }

  /**
   * 热重载时，如果账号此前被 disable，且更新后的凭据指纹与之前不同，
   * 说明用户重新同步了新凭据（如官方 CLI 抢先轮换 refresh token 后重新登录），
   * 原 disable 原因已不成立。清除内存中的 disabled 状态并同步落库。
   */
  private clearDisablementIfCredentialChanged(
    slot: CodexAccountSlot,
    wasDisabled: boolean,
    previousFingerprint: string
  ): void {
    if (
      !shouldClearCodexDisablementForCredentialChange(
        slot,
        wasDisabled,
        previousFingerprint
      )
    ) {
      return
    }
    clearAccountDisablement(slot)
    this.persistCodexAccountStates()
    this.logger.log(
      `[Hot-reload] 检测到凭据已更新，清除 disabled 状态: ${this.getAccountLabel(slot)}`
    )
  }

  private pruneConversationBindingsForSlots(slots: CodexAccountSlot[]): void {
    if (slots.length === 0 || this.slotRouter.bindingCount === 0) {
      return
    }

    this.slotRouter.pruneBindingsForSlotKeys(
      slots.map((slot) => this.getSlotStickyKey(slot))
    )
  }

  private normalizeCodexModelName(modelName: string): string {
    return normalizeCodexRateLimitModelName(modelName)
  }

  private getCodexDisplayModel(modelName: string): string {
    const normalized = this.normalizeCodexModelName(modelName)
    return getPublicModelMetadata(normalized)?.displayName || normalized
  }

  private hasRateLimitData(account: CodexAccountSlot): boolean {
    return hasCodexRateLimitData(account.rateLimitSnapshots)
  }

  private getRateLimitModelSummary(
    account: CodexAccountSlot,
    modelName: string
  ): CodexRateLimitModelSummary | null {
    return getCodexRateLimitModelSummary(
      account.rateLimitSnapshots,
      modelName,
      (normalizedModel) => this.getCodexDisplayModel(normalizedModel)
    )
  }

  private getRateLimitAccountSummary(
    account: CodexAccountSlot
  ): CodexRateLimitAccountSummary | undefined {
    return getCodexRateLimitAccountSummary(
      account.rateLimitSnapshots,
      DEFAULT_CODEX_RATE_LIMIT_MODEL,
      (normalizedModel) => this.getCodexDisplayModel(normalizedModel)
    )
  }

  private setRateLimitSnapshot(
    slot: CodexAccountSlot,
    snapshot: CodexRateLimitSnapshot
  ): void {
    setCodexRateLimitSnapshot(
      slot.rateLimitSnapshots,
      snapshot,
      (normalizedModel) => this.getCodexDisplayModel(normalizedModel)
    )
  }

  private getQuotaRemainingPercent(
    account: CodexAccountSlot,
    tier: "primary" | "secondary",
    modelName: string
  ): number | null {
    const effective = this.getRateLimitModelSummary(
      account,
      modelName
    )?.effective
    return getCodexQuotaRemainingPercent(effective || null, tier)
  }

  private getQuotaCooldownUntil(
    account: CodexAccountSlot,
    tier: "primary" | "secondary",
    modelName: string
  ): number {
    const effective = this.getRateLimitModelSummary(
      account,
      modelName
    )?.effective
    return getCodexQuotaCooldownUntil(effective || null, tier)
  }

  private isRateLimitExhaustedForModel(
    slot: CodexAccountSlot,
    model: string
  ): boolean {
    const effective = this.getRateLimitModelSummary(slot, model)?.effective
    return isCodexRateLimitSnapshotExhausted(effective || null)
  }

  private isSlotAvailableForModel(
    slot: CodexAccountSlot,
    model: string,
    now: number
  ): boolean {
    return isCodexSlotAvailableForModel({
      slot,
      model,
      now,
      isRateLimitExhausted: (candidate, candidateModel) =>
        this.isRateLimitExhaustedForModel(candidate, candidateModel),
      getQuotaCooldownUntil: (candidate, tier, candidateModel) =>
        this.getQuotaCooldownUntil(candidate, tier, candidateModel),
    })
  }

  private getSlotRecoveryTimeForModel(
    slot: CodexAccountSlot,
    model: string,
    now: number
  ): number | null {
    return getCodexSlotRecoveryTimeForModel({
      slot,
      model,
      now,
      isModelSupported: (candidate, candidateModel) =>
        this.isModelSupportedBySlot(candidate, candidateModel),
      getQuotaCooldownUntil: (candidate, tier, candidateModel) =>
        this.getQuotaCooldownUntil(candidate, tier, candidateModel),
    })
  }

  /**
   * Round-robin: pick the next available account, respecting cooldowns.
   *
   * @param model - The model being requested (for per-model cooldown checks)
   * @returns The slot, or null if all accounts are in cooldown
   */
  private pickNextAvailableAccount(model: string): CodexAccountSlot | null {
    const now = Date.now()
    const normalized = model.toLowerCase().trim()
    const slot = this.slotRouter.pickFromCurrentIndex({
      candidates: this.accounts,
      isSlotUsable: (candidate) =>
        this.isModelSupportedBySlot(candidate, normalized) &&
        this.isSlotAvailableForModel(candidate, normalized, now),
    })
    if (slot) {
      return slot
    }

    this.logger.warn(
      `[Codex] All supporting account(s) are in cooldown for model=${normalized}`
    )
    return null
  }

  /**
   * Persist refreshed OAuth metadata to the appropriate backing store.
   */
  private persistSlotTokens(slot: CodexAccountSlot): void {
    if (!slot.tokenData) return

    if (slot.source === "env") {
      this.authService.persistTokenData(slot.tokenData)
      return
    }

    this.persistFileBackedAccount(slot)
  }

  /**
   * Persist a refreshed file-backed OAuth slot back into codex-accounts.json.
   */
  private persistFileBackedAccount(slot: CodexAccountSlot): void {
    const tokenData = slot.tokenData
    if (!tokenData) return

    try {
      const filePath =
        slot.configPath || this.accountsFilePath || CODEX_ACCOUNTS_DEFAULT_PATH
      const payload: { accounts: PersistedCodexAccountRecord[] } = {
        accounts: [],
      }

      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
          accounts?: PersistedCodexAccountRecord[]
        }
        payload.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
      }

      payload.accounts = upsertCodexPersistedAccountRecord({
        accounts: payload.accounts,
        account: slot,
        tokenData,
        accountId: this.getSlotAccountId(slot) || undefined,
        workspaceId: slot.workspaceId || tokenData.workspaceId || undefined,
        planType: this.getSlotPlanType(slot) || undefined,
      })

      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8")
      slot.configPath = filePath
      slot.persistedMatch = {
        apiKey: slot.apiKey,
        email: slot.email,
        accountId: slot.accountId,
        accessToken: slot.accessToken,
        refreshToken: slot.refreshToken,
      }
    } catch (error) {
      this.logger.warn(
        `Failed to persist Codex account to ${this.accountsFilePath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Get the bearer token for authentication.
   * Refreshes OAuth credentials per slot without mutating singleton service state.
   */
  private async getBearerToken(slot: CodexAccountSlot): Promise<string> {
    if (slot.apiKey) return slot.apiKey

    if (slot.tokenData) {
      const tokenData = await this.ensureFreshTokenData(slot)
      if (tokenData?.accessToken) {
        return tokenData.accessToken
      }
    }

    return slot.accessToken || ""
  }

  /**
   * Refresh an OAuth slot once, sharing the in-flight refresh per slot.
   */
  private async ensureFreshTokenData(
    slot: CodexAccountSlot
  ): Promise<CodexTokenData | null> {
    if (!slot.tokenData) {
      return null
    }

    if (!this.authService.isTokenExpired(slot.tokenData)) {
      return slot.tokenData
    }

    if (!slot.tokenData.refreshToken) {
      return slot.tokenData
    }

    if (!slot.refreshPromise) {
      slot.refreshPromise = (async () => {
        this.logger.log(
          `[Codex] Refreshing token for ${this.getAccountLabel(slot)}`
        )
        try {
          const refreshed = await this.authService.refreshTokensWithRetry(
            slot.tokenData?.refreshToken || "",
            3,
            { persist: false, updateState: false }
          )
          this.applyTokenDataToSlot(slot, refreshed)
          this.persistSlotTokens(slot)
          return slot.tokenData
        } catch (error) {
          this.logger.error(
            `[Codex] Token refresh failed for ${this.getAccountLabel(slot)}: ${error instanceof Error ? error.message : String(error)}`
          )
          return null
        } finally {
          slot.refreshPromise = undefined
        }
      })()
    }

    const refreshed = await slot.refreshPromise
    return refreshed || slot.tokenData
  }

  /**
   * Attempt to refresh a slot's token on 401/403.
   * Reuses slot.refreshPromise to prevent concurrent refresh-token rotation violations.
   * Returns the new accessToken on success, null on failure.
   */
  private async tryRefreshSlotToken(
    slot: CodexAccountSlot,
    reason: string
  ): Promise<string | null> {
    if (this.isApiKeyMode(slot) || !slot.tokenData?.refreshToken) {
      return null
    }

    // Reuse existing refresh promise to prevent concurrent rotation violations
    if (slot.refreshPromise) {
      const existing = await slot.refreshPromise
      return existing?.accessToken || null
    }

    slot.refreshPromise = (async () => {
      this.logger.log(
        `[Codex] ${reason}: forcing token refresh for ${this.getAccountLabel(slot)}`
      )
      try {
        const refreshed = await this.authService.refreshTokensWithRetry(
          slot.tokenData?.refreshToken || "",
          2,
          { persist: false, updateState: false }
        )
        this.applyTokenDataToSlot(slot, refreshed)
        this.persistSlotTokens(slot)
        return slot.tokenData
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        this.logger.warn(
          `[Codex] ${reason}: token refresh failed for ${this.getAccountLabel(slot)}: ${errorMsg}`
        )

        // Refresh token rotation violation or revoked → permanently disable
        // this account to stop the pool from repeatedly selecting a slot
        // whose credentials are permanently invalid.
        if (isCodexRefreshTokenInvalidationMessage(errorMsg)) {
          disableAccount(slot, "token_invalidated", {
            statusCode: 401,
            message: errorMsg,
            accountLabel: this.getAccountLabel(slot),
          })
          this.persistCodexAccountStates()
        }
        return null
      } finally {
        slot.refreshPromise = undefined
      }
    })()

    const result = await slot.refreshPromise
    return result?.accessToken || null
  }

  /**
   * Determine if the slot is using an API key (vs OAuth access token).
   */
  private isApiKeyMode(slot: CodexAccountSlot): boolean {
    return !!slot.apiKey
  }

  private readProxyEnvValue(keys: string[]): string | undefined {
    for (const key of keys) {
      const value = process.env[key] || process.env[key.toLowerCase()]
      const normalized = value?.trim()
      if (normalized) {
        return normalized
      }
    }

    return undefined
  }

  /**
   * Build an undici dispatcher for Codex HTTP fetches.
   * Uses the selected slot's proxyUrl, then falls back to standard proxy env vars.
   */
  private buildProxyDispatcher(
    slot: CodexAccountSlot
  ): import("undici").Dispatcher | undefined {
    const explicitProxyUrl = slot.proxyUrl?.trim()
    if (explicitProxyUrl) {
      if (explicitProxyUrl.toLowerCase() === "direct") {
        return undefined
      }

      return this.buildExplicitProxyDispatcher(explicitProxyUrl)
    }

    return this.buildEnvProxyDispatcher()
  }

  private buildExplicitProxyDispatcher(
    proxyUrl: string
  ): import("undici").Dispatcher | undefined {
    try {
      const parsed = new URL(proxyUrl)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        this.logger.error(
          `Unsupported Codex HTTP proxy scheme for fetch: ${parsed.protocol}`
        )
        return undefined
      }

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ProxyAgent } = require("undici") as typeof import("undici")
      return new ProxyAgent(proxyUrl)
    } catch (e) {
      this.logger.error(`Failed to parse proxy URL: ${(e as Error).message}`)
      return undefined
    }
  }

  private buildEnvProxyDispatcher(): import("undici").Dispatcher | undefined {
    const allProxy = this.readProxyEnvValue(["ALL_PROXY"])
    const httpProxy = this.readProxyEnvValue(["HTTP_PROXY"]) || allProxy
    const httpsProxy =
      this.readProxyEnvValue(["HTTPS_PROXY"]) || allProxy || httpProxy
    const noProxy = this.readProxyEnvValue(["NO_PROXY"])

    if (!httpProxy && !httpsProxy) {
      return undefined
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { EnvHttpProxyAgent } = require("undici") as typeof import("undici")
      return new EnvHttpProxyAgent({
        ...(httpProxy ? { httpProxy } : {}),
        ...(httpsProxy ? { httpsProxy } : {}),
        ...(noProxy ? { noProxy } : {}),
      })
    } catch (e) {
      this.logger.error(
        `Failed to configure proxy dispatcher from env: ${(e as Error).message}`
      )
      return undefined
    }
  }

  /**
   * Build request headers matching the upstream Codex Responses client.
   */
  private buildHeaders(
    slot: CodexAccountSlot,
    token: string,
    stream: boolean,
    options?: {
      conversationId?: string
      omitAccountId?: boolean
      forwardHeaders?: CodexForwardHeaders
      clientMetadata?: CodexForwardHeaders
      useResponsesLite?: boolean
      includeInstallationIdHeader?: boolean
    }
  ): Record<string, string> {
    return buildCodexHttpHeaders({
      token,
      isApiKey: this.isApiKeyMode(slot),
      conversationId: options?.conversationId,
      clientMetadata: options?.clientMetadata,
      accountId: this.getSlotAccountId(slot),
      workspaceId: slot.workspaceId,
      stream,
      forwardHeaders: options?.forwardHeaders,
      omitAccountId: options?.omitAccountId,
      useResponsesLite: options?.useResponsesLite,
      includeInstallationIdHeader: options?.includeInstallationIdHeader,
      identity: {
        version: this.identity.version(),
        userAgent: this.identity.userAgent(),
        originator: this.identity.originator(),
      },
    })
  }

  private getCodexRequestClientMetadata(
    request: Record<string, unknown> | undefined
  ): CodexForwardHeaders | undefined {
    const metadata = request?.client_metadata
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return undefined
    }

    const entries = Object.entries(metadata as Record<string, unknown>).flatMap(
      ([key, value]): Array<[string, string]> =>
        typeof value === "string" && value.trim().length > 0
          ? [[key, value]]
          : []
    )

    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }

  private logCodexUsage(
    transport: "http" | "websocket",
    modelName: string,
    cacheId: string,
    slot: CodexAccountSlot,
    event: Record<string, unknown> | null,
    requestStartedAt?: number
  ): void {
    if (event?.type === "response.completed") {
      this.logger.log(
        `[Codex][${transport === "websocket" ? "WS" : "HTTP"} Response][Completed] ` +
          summarizeCodexCompletedResponseForLogs(event)
      )
    }

    const usage = extractCodexCompletedUsage(event)
    if (!usage) return

    const durationMs =
      typeof requestStartedAt === "number"
        ? Math.max(0, Date.now() - requestStartedAt)
        : 0

    const message =
      `[Codex][Cache] transport=${transport} model=${modelName} ` +
      `cache=${cacheId || "(none)"} input=${usage.inputTokens} ` +
      `cached=${usage.cachedInputTokens} cacheWrite=${usage.cacheCreationInputTokens} ` +
      `output=${usage.outputTokens} duration=${durationMs}ms`

    this.usageStats.recordCodexUsage({
      transport,
      modelName,
      accountKey: this.getSlotStickyKey(slot),
      accountLabel: this.getAccountLabel(slot),
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      outputTokens: usage.outputTokens,
      webSearchRequests: usage.webSearchRequests,
      durationMs,
    })

    if (usage.cachedInputTokens > 0) {
      this.logger.log(message)
      return
    }

    this.logger.debug(message)
  }

  /**
   * Build the Codex request URL.
   * Uses the selected slot's baseUrl.
   */
  private buildUrl(
    slot: CodexAccountSlot,
    endpoint: string = "responses"
  ): string {
    const baseUrl = slot.baseUrl || DEFAULT_BASE_URL
    return `${baseUrl.replace(/\/+$/, "")}/${endpoint}`
  }

  /**
   * Get cache ID for the current request.
   */
  private getCacheId(
    request: Pick<
      CodexExecutionRequest,
      "cacheUserId" | "conversationId" | "model" | "pendingToolUseIds"
    >,
    slot: CodexAccountSlot
  ): string {
    this.turnContexts.pruneRuntimeState()
    const conversationId = this.getConversationId(request)
    const decision = resolveCodexPromptCacheIdentity({
      model: request.model,
      conversationId,
      cacheUserId: request.cacheUserId,
      apiKey: slot.apiKey,
      slotKey: this.getSlotStickyKey(slot),
    })

    switch (decision.kind) {
      case "conversation":
        return decision.cacheId
      case "user":
        return this.cacheService.getOrCreateCacheId(
          decision.model,
          decision.userId
        )
      case "api_key":
        return this.cacheService.getCacheIdFromApiKey(decision.apiKey)
      case "oauth":
        return this.cacheService.getCacheIdFromIdentity(decision.identity)
    }
  }

  private createAllAccountsRateLimitedError(modelName: string): CodexApiError {
    const now = Date.now()
    const normalizedModelName = modelName.toLowerCase().trim()
    const retrySeconds = getAllCodexAccountsRateLimitedRetrySeconds(
      this.accounts.map((slot) =>
        this.getSlotRecoveryTimeForModel(slot, normalizedModelName, now)
      ),
      now
    )
    return new CodexApiError(
      429,
      `All Codex accounts are rate-limited for model ${modelName}. ` +
        `Retry after ${retrySeconds} seconds.`,
      retrySeconds
    )
  }

  private findNextAvailableAccount(
    model: string
  ): { slot: CodexAccountSlot; index: number } | null {
    const now = Date.now()
    const normalized = model.toLowerCase().trim()
    const selection = this.slotRouter.findFromCurrentIndex({
      candidates: this.accounts,
      isSlotUsable: (slot) =>
        this.isModelSupportedBySlot(slot, normalized) &&
        this.isSlotAvailableForModel(slot, normalized, now),
    })

    return selection
      ? { slot: selection.account, index: selection.index }
      : null
  }

  private isWarmPoolSlotUsable(
    slot: CodexAccountSlot,
    normalizedModel: string,
    now: number
  ): boolean {
    if (!this.isModelSupportedBySlot(slot, normalizedModel)) {
      return false
    }

    if (!this.isSlotAvailableForModel(slot, normalizedModel, now)) {
      return false
    }

    const wsUrl = this.wsService.buildWebSocketUrl(
      this.buildUrl(slot, "responses")
    )
    return this.turnContexts.getWarmPoolAvailability({
      slotKey: this.getSlotStickyKey(slot),
      modelName: normalizedModel,
      wsUrl,
      hasOpenSessionConnection: (sessionId, targetWsUrl) =>
        this.wsService.hasOpenSessionConnection(sessionId, targetWsUrl),
    }).available
  }

  private findWarmPoolAccount(
    model: string
  ): { slot: CodexAccountSlot; index: number } | null {
    if (!this.useWebSocket || !this.wsService.isWebSocketAvailable()) {
      return null
    }

    const now = Date.now()
    const normalized = model.toLowerCase().trim()
    const selection = this.slotRouter.findFromCurrentIndex({
      candidates: this.accounts,
      isSlotUsable: (slot) => this.isWarmPoolSlotUsable(slot, normalized, now),
    })

    return selection
      ? { slot: selection.account, index: selection.index }
      : null
  }

  private pickWarmPoolAccount(model: string): CodexAccountSlot | null {
    if (!this.useWebSocket || !this.wsService.isWebSocketAvailable()) {
      return null
    }

    const now = Date.now()
    const normalized = model.toLowerCase().trim()
    return this.slotRouter.pickFromCurrentIndex({
      candidates: this.accounts,
      isSlotUsable: (slot) => this.isWarmPoolSlotUsable(slot, normalized, now),
    })
  }

  private selectWarmupSlot(
    modelName: string,
    conversationId?: string
  ): CodexAccountSlot {
    if (this.accounts.length === 0) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    if (!this.hasSupportingAccount(modelName)) {
      throw new CodexApiError(
        400,
        `Model ${modelName} is not supported by the configured Codex account(s).`
      )
    }

    const selection = resolveCodexSlotSelection({
      getStickySlot: () =>
        conversationId
          ? this.getStickyConversationSlot(conversationId, modelName)
          : null,
      getWarmPoolSlot: () => this.findWarmPoolAccount(modelName)?.slot ?? null,
      getNextAvailableSlot: () =>
        this.findNextAvailableAccount(modelName)?.slot ?? null,
      preferWarmPool: true,
    })
    if (selection.kind === "none") {
      throw this.createAllAccountsRateLimitedError(modelName)
    }

    return selection.slot
  }

  private selectRequestSlot(
    modelName: string,
    conversationId?: string,
    options?: {
      preferWarmPool?: boolean
    }
  ): CodexAccountSlot {
    if (this.accounts.length === 0) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    if (!this.hasSupportingAccount(modelName)) {
      throw new CodexApiError(
        400,
        `Model ${modelName} is not supported by the configured Codex account(s).`
      )
    }

    const selection = resolveCodexSlotSelection({
      getStickySlot: () =>
        conversationId
          ? this.getStickyConversationSlot(conversationId, modelName)
          : null,
      getWarmPoolSlot: () => this.pickWarmPoolAccount(modelName),
      getNextAvailableSlot: () => this.pickNextAvailableAccount(modelName),
      preferWarmPool: options?.preferWarmPool,
    })
    if (selection.kind === "none") {
      throw this.createAllAccountsRateLimitedError(modelName)
    }
    return selection.slot
  }

  private getAllRateLimitRetryDelayMs(
    error: CodexApiError,
    retryAttempt: number
  ): number | null {
    return getCodexAllAccountsRateLimitRetryDelayMs({
      statusCode: error.getStatus(),
      retryAfterSeconds: error.retryAfterSeconds,
      retryAttempt,
      maxRetries: this.allRateLimitMaxRetries,
      maxWaitSeconds: this.allRateLimitMaxWaitSeconds,
    })
  }

  private async waitForAllRateLimitRetry(
    error: CodexApiError,
    modelName: string,
    retryAttempt: number,
    context: string,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    const delayMs = this.getAllRateLimitRetryDelayMs(error, retryAttempt)
    if (delayMs == null) {
      return false
    }

    this.logger.warn(
      `[Codex] All account(s) rate-limited for model=${modelName}; ` +
        `waiting ${Math.ceil(delayMs / 1000)}s before retry ` +
        `${retryAttempt + 1}/${this.allRateLimitMaxRetries} (${context})`
    )
    await this.sleepWithAbort(
      delayMs,
      abortSignal,
      `Codex rate-limit retry wait aborted for model ${modelName}`
    )
    return true
  }

  private async sleepWithAbort(
    delayMs: number,
    abortSignal: AbortSignal | undefined,
    abortMessage: string
  ): Promise<void> {
    if (delayMs <= 0) {
      return
    }

    let timeout: NodeJS.Timeout | undefined
    const delay = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, delayMs)
    })
    const externalAbort = createAbortPromise(abortSignal, abortMessage)
    try {
      await Promise.race([
        delay,
        ...(externalAbort.promise ? [externalAbort.promise] : []),
      ])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
      externalAbort.cleanup()
    }
  }

  // ── Non-streaming ────────────────────────────────────────────────────

  /**
   * Send a non-streaming message through Codex.
   */
  async sendMessage(
    request: CodexExecutionRequest,
    forwardHeaders?: CodexForwardHeaders
  ): Promise<AnthropicResponse> {
    this.onLiveRequestStart()
    try {
      return await this.executeWithCooldownRetry(request, forwardHeaders, 1)
    } finally {
      this.onLiveRequestEnd()
    }
  }

  async compactConversationHistory(
    request: CodexExecutionRequest,
    forwardHeaders?: CodexForwardHeaders
  ): Promise<CodexReplacementHistoryItem[]> {
    this.onLiveRequestStart()
    try {
      return await this.compactConversationHistoryWithRetry(
        request,
        forwardHeaders,
        1
      )
    } finally {
      this.onLiveRequestEnd()
    }
  }

  private async compactConversationHistoryWithRetry(
    request: CodexExecutionRequest,
    forwardHeaders: CodexForwardHeaders | undefined,
    attempt: number,
    slot?: CodexAccountSlot,
    allRateLimitRetryAttempt: number = 0
  ): Promise<CodexReplacementHistoryItem[]> {
    if (this.accounts.length === 0) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    const modelName = request.model
    const conversationId =
      this.getConversationId(request) || `compact-${crypto.randomUUID()}`
    let requestSlot: CodexAccountSlot
    try {
      requestSlot =
        slot ||
        this.selectRequestSlot(modelName, conversationId, {
          preferWarmPool: false,
        })
    } catch (error) {
      if (
        error instanceof CodexApiError &&
        (await this.waitForAllRateLimitRetry(
          error,
          modelName,
          allRateLimitRetryAttempt,
          "compact slot selection"
        ))
      ) {
        return this.compactConversationHistoryWithRetry(
          request,
          forwardHeaders,
          attempt,
          undefined,
          allRateLimitRetryAttempt + 1
        )
      }
      throw error
    }
    const token = await this.getBearerToken(requestSlot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    this.bindConversationToSlot(conversationId, requestSlot)

    const compactRequest: CodexExecutionRequest = {
      ...request,
      conversationId,
      inputToolIntegrity: "preserve",
    }
    let codexRequest = buildCodexRequest(compactRequest, modelName)
    const cacheId = this.getCacheId(compactRequest, requestSlot)
    if (cacheId) {
      codexRequest = this.cacheService.injectCacheKey(
        codexRequest as Record<string, unknown>,
        cacheId
      ) as CodexRequest
    }
    const compactTurnKey = this.getCodexTurnKey(codexRequest)
    const compactTurnContext = this.getOrCreateTurnContext(
      conversationId,
      requestSlot,
      modelName,
      compactTurnKey
    )
    const preparedCodexRequest = prepareCodexRequestForSend(codexRequest)
    const payload = buildCodexCompactRequestPayload(preparedCodexRequest)
    this.logger.debug(
      `[Codex][Compact Request] ${summarizeCodexRequestForLogs({
        ...payload,
        client_metadata: preparedCodexRequest.client_metadata,
      })}`
    )
    const url = this.buildUrl(requestSlot, "responses/compact")
    const headers = this.buildHeaders(requestSlot, token, false, {
      conversationId,
      forwardHeaders,
      clientMetadata: this.getCodexRequestClientMetadata(codexRequest),
      useResponsesLite: this.usesResponsesLite(modelName),
      includeInstallationIdHeader: true,
    })
    this.applyCodexTurnStateHeader(headers, compactTurnContext)
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    }
    const dispatcher = this.buildProxyDispatcher(requestSlot)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    try {
      const response = await fetch(url, fetchOptions)
      if (!response.ok) {
        const errorBody = await response.text()
        throw createCodexApiErrorFromBody(response.status, errorBody)
      }
      this.captureCodexRateLimitHeaders(
        response.headers,
        requestSlot,
        modelName,
        "request"
      )
      this.captureCodexTurnStateFromHttpHeaders(
        compactTurnContext,
        response.headers
      )
      markAccountSuccess(requestSlot, modelName)

      const compactResponseBody: unknown = await response.json()
      this.logger.debug(
        `[Codex][Compact Response] ${summarizeCodexCompactResponseForLogs(compactResponseBody)}`
      )
      return parseCodexCompactOutputHistory(compactResponseBody)
    } catch (error) {
      if (error instanceof CodexApiError) {
        const statusCode = error.getStatus()
        if (
          shouldRefreshCodexTokenForStatus({
            statusCode,
            attempt,
            isApiKeyMode: this.isApiKeyMode(requestSlot),
          })
        ) {
          const newToken = await this.tryRefreshSlotToken(
            requestSlot,
            `${statusCode} compact`
          )
          if (newToken) {
            return this.compactConversationHistoryWithRetry(
              request,
              forwardHeaders,
              attempt + 1,
              requestSlot
            )
          }
        }

        const retryAfterHeader = error.retryAfterSeconds?.toString()
        markAccountCooldown(
          requestSlot,
          statusCode,
          modelName,
          retryAfterHeader,
          this.getAccountLabel(requestSlot)
        )

        if (
          shouldFailOverCodexAccountForStatus({
            statusCode,
            attempt,
            accountCount: this.accounts.length,
          })
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== requestSlot) {
            this.logger.log(
              `[Codex] compact ${statusCode} on ${this.getAccountLabel(requestSlot)}, retrying with ${this.getAccountLabel(nextSlot)} (attempt ${attempt + 1}/${this.accounts.length})`
            )
            return this.compactConversationHistoryWithRetry(
              request,
              forwardHeaders,
              attempt + 1,
              nextSlot
            )
          }
        }

        if (
          isCodexRateLimitRetryStatus(statusCode) &&
          (await this.waitForAllRateLimitRetry(
            error,
            modelName,
            allRateLimitRetryAttempt,
            "compact request"
          ))
        ) {
          return this.compactConversationHistoryWithRetry(
            request,
            forwardHeaders,
            attempt,
            undefined,
            allRateLimitRetryAttempt + 1
          )
        }
      }
      throw error
    }
  }

  /**
   * Execute a one-shot web search via the Codex Responses API server-side
   * `web_search` tool. The model is asked a single user question that wraps
   * the supplied query, the server runs `web_search_call` items end-to-end,
   * and we collect every `url_citation` annotation plus any final assistant
   * text into the same shape the Google backend returns from
   * `executeWebSearch()` — so callers can stay backend-agnostic.
   */
  async executeWebSearch(input: {
    query: string
    model?: string
    conversationId?: string
    signal?: AbortSignal
  }): Promise<{
    text: string
    references: Array<{ title: string; url: string; chunk: string }>
  }> {
    const query = input.query.trim()
    if (!query) {
      return { text: "", references: [] }
    }

    if (this.accounts.length === 0) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    const requestedModel = input.model?.trim() || ""
    const modelName =
      requestedModel && this.hasSupportingAccount(requestedModel)
        ? requestedModel
        : DEFAULT_CODEX_RATE_LIMIT_MODEL
    const conversationId =
      input.conversationId || `web-search-${crypto.randomUUID()}`
    const slot = this.selectRequestSlot(modelName, conversationId, {
      preferWarmPool: false,
    })
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    const codexRequest = buildCodexRequest(
      {
        model: modelName,
        conversationId,
        messages: [
          {
            role: "user",
            content:
              "Use the web_search tool to find authoritative, recent results " +
              "for the following query, then summarize the findings in a few " +
              "sentences and list the sources you used.\n\n" +
              `Query: ${query}`,
          },
        ],
        tools: [
          {
            type: "web_search",
            name: "web_search",
            description: "Server-side web search backed by the Codex backend.",
            external_web_access: true,
          },
        ],
        parallelToolCalls: false,
        textVerbosity: "low",
      },
      modelName
    ) as Record<string, unknown>

    const url = this.buildUrl(slot, "responses")
    const headers = this.buildHeaders(slot, token, true, {
      conversationId,
      clientMetadata: this.getCodexRequestClientMetadata(codexRequest),
      useResponsesLite: this.usesResponsesLite(modelName),
    })
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(prepareCodexRequestForSend(codexRequest)),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(300_000)])
        : AbortSignal.timeout(300_000),
    }
    const dispatcher = this.buildProxyDispatcher(slot)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const response = await fetch(url, fetchOptions)
    if (!response.ok) {
      const errorBody = await response.text()
      throw createCodexApiErrorFromBody(response.status, errorBody)
    }
    this.captureCodexRateLimitHeaders(
      response.headers,
      slot,
      modelName,
      "request"
    )

    if (!response.body) {
      throw new Error("Codex response has no body")
    }

    const summaryParts: string[] = []
    const references: Array<{ title: string; url: string; chunk: string }> = []
    const seenUrls = new Set<string>()

    const collectFromContentBlock = (block: unknown): void => {
      if (!block || typeof block !== "object") return
      const record = block as Record<string, unknown>
      if (typeof record.text === "string" && record.text.trim()) {
        summaryParts.push(record.text)
      }
      const annotations = record.annotations
      if (Array.isArray(annotations)) {
        for (const ann of annotations) {
          if (!ann || typeof ann !== "object") continue
          const a = ann as Record<string, unknown>
          if (a.type !== "url_citation" && a.type !== "web_search_citation") {
            continue
          }
          const refUrl = typeof a.url === "string" ? a.url.trim() : ""
          if (!refUrl || seenUrls.has(refUrl)) continue
          seenUrls.add(refUrl)
          references.push({
            title: (typeof a.title === "string" && a.title.trim()) || refUrl,
            url: refUrl,
            chunk:
              typeof a.quote === "string"
                ? a.quote
                : typeof a.text === "string"
                  ? a.text
                  : "",
          })
        }
      }
    }

    const collectFromOutputItem = (item: unknown): void => {
      if (!item || typeof item !== "object") return
      const record = item as Record<string, unknown>
      const itemType = record.type
      if (itemType === "message") {
        const content = record.content
        if (Array.isArray(content)) {
          for (const block of content) {
            collectFromContentBlock(block)
          }
        }
      }
      // web_search_call items can carry sources / queries on completion.
      if (itemType === "web_search_call") {
        const action = record.action
        if (action && typeof action === "object") {
          const sources = (action as Record<string, unknown>).sources
          if (Array.isArray(sources)) {
            for (const src of sources) {
              if (!src || typeof src !== "object") continue
              const s = src as Record<string, unknown>
              const srcUrl = typeof s.url === "string" ? s.url.trim() : ""
              if (!srcUrl || seenUrls.has(srcUrl)) continue
              seenUrls.add(srcUrl)
              references.push({
                title:
                  (typeof s.title === "string" && s.title.trim()) || srcUrl,
                url: srcUrl,
                chunk:
                  typeof s.snippet === "string"
                    ? s.snippet
                    : typeof s.text === "string"
                      ? s.text
                      : "",
              })
            }
          }
        }
      }
    }

    const processPayload = (payload: Record<string, unknown>): boolean => {
      if (payload.type === "response.output_item.done" && payload.item) {
        collectFromOutputItem(payload.item)
      }

      if (
        payload.type === "response.completed" &&
        payload.response &&
        typeof payload.response === "object"
      ) {
        const responseOutput = (payload.response as Record<string, unknown>)
          .output
        if (Array.isArray(responseOutput)) {
          for (const outputItem of responseOutput) {
            collectFromOutputItem(outputItem)
          }
        }
        return true
      }

      return false
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let completed = false

    try {
      while (!completed) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const payload = parseCodexSsePayload(line.trim())
          if (payload && processPayload(payload)) {
            completed = true
            break
          }
        }
      }

      const tail = buffer.trim()
      if (!completed && tail) {
        const payload = parseCodexSsePayload(tail)
        if (payload) {
          processPayload(payload)
        }
      }
    } finally {
      reader.cancel().catch(() => undefined)
    }

    markAccountSuccess(slot, modelName)

    const text = summaryParts.length > 0 ? summaryParts.join("\n").trim() : ""
    return { text, references }
  }

  async generateImage(input: {
    prompt: string
    model?: string
    conversationId?: string
    outputFormat?: string
  }): Promise<{
    imageData: string
    revisedPrompt?: string
    status?: string
  }> {
    const prompt = input.prompt.trim()
    if (!prompt) {
      throw new Error("Image generation prompt is required")
    }

    const requestedModel = input.model?.trim() || ""
    const modelName =
      requestedModel && this.hasSupportingAccount(requestedModel)
        ? requestedModel
        : DEFAULT_CODEX_RATE_LIMIT_MODEL
    const conversationId =
      input.conversationId || `image-${crypto.randomUUID()}`
    const slot = this.selectRequestSlot(modelName, conversationId, {
      preferWarmPool: false,
    })
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    const codexRequest = buildCodexRequest(
      {
        model: modelName,
        conversationId,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        tools: [
          {
            type: "image_generation",
            name: "image_generation",
            description: "Generate an image from the user prompt.",
            output_format: input.outputFormat?.trim() || "png",
          },
        ],
        parallelToolCalls: false,
        textVerbosity: "low",
      },
      modelName
    ) as Record<string, unknown>

    const url = this.buildUrl(slot, "responses")
    const headers = this.buildHeaders(slot, token, true, {
      conversationId,
      clientMetadata: this.getCodexRequestClientMetadata(codexRequest),
      useResponsesLite: this.usesResponsesLite(modelName),
    })
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(prepareCodexRequestForSend(codexRequest)),
      signal: AbortSignal.timeout(600_000),
    }
    const dispatcher = this.buildProxyDispatcher(slot)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const response = await fetch(url, fetchOptions)
    if (!response.ok) {
      const errorBody = await response.text()
      throw createCodexApiErrorFromBody(response.status, errorBody)
    }

    this.captureCodexRateLimitHeaders(
      response.headers,
      slot,
      modelName,
      "request"
    )
    const fullBody = await response.text()
    let imageData = ""
    let revisedPrompt: string | undefined
    let status: string | undefined

    for (const line of fullBody.split("\n")) {
      const payload = parseCodexSsePayload(line.trim())
      const item =
        payload?.type === "response.output_item.done" &&
        payload.item &&
        typeof payload.item === "object"
          ? (payload.item as Record<string, unknown>)
          : undefined
      if (item?.type === "image_generation_call") {
        if (typeof item.result === "string" && item.result.trim()) {
          imageData = item.result.trim()
        }
        if (typeof item.revised_prompt === "string") {
          revisedPrompt = item.revised_prompt
        }
        if (typeof item.status === "string") {
          status = item.status
        }
      }

      const responseOutput =
        payload?.type === "response.completed" &&
        payload.response &&
        typeof payload.response === "object"
          ? (payload.response as Record<string, unknown>).output
          : undefined
      if (Array.isArray(responseOutput)) {
        for (const outputItem of responseOutput) {
          if (
            outputItem &&
            typeof outputItem === "object" &&
            (outputItem as Record<string, unknown>).type ===
              "image_generation_call"
          ) {
            const record = outputItem as Record<string, unknown>
            if (typeof record.result === "string" && record.result.trim()) {
              imageData = record.result.trim()
            }
            if (typeof record.revised_prompt === "string") {
              revisedPrompt = record.revised_prompt
            }
            if (typeof record.status === "string") {
              status = record.status
            }
          }
        }
      }
    }

    if (!imageData) {
      throw new Error("Codex image_generation completed without image data")
    }

    markAccountSuccess(slot, modelName)
    return { imageData, revisedPrompt, status }
  }

  /**
   * Core execution logic with cooldown-aware account selection and
   * automatic retry on 429 (switches to next available account).
   */
  private async executeWithCooldownRetry(
    request: CodexExecutionRequest,
    forwardHeaders?: CodexForwardHeaders,
    attempt: number = 1,
    selectedSlot?: CodexAccountSlot,
    allRateLimitRetryAttempt: number = 0
  ): Promise<AnthropicResponse> {
    const modelName = request.model
    let slot: CodexAccountSlot
    try {
      slot =
        selectedSlot ??
        this.selectRequestSlot(request.model, this.getConversationId(request), {
          preferWarmPool: !this.hasConversationContinuationState(
            this.getConversationId(request)
          ),
        })
    } catch (error) {
      if (
        error instanceof CodexApiError &&
        (await this.waitForAllRateLimitRetry(
          error,
          modelName,
          allRateLimitRetryAttempt,
          "non-stream slot selection"
        ))
      ) {
        return this.executeWithCooldownRetry(
          request,
          forwardHeaders,
          attempt,
          undefined,
          allRateLimitRetryAttempt + 1
        )
      }
      throw error
    }

    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    this.bindConversationToSlot(this.getConversationId(request), slot)

    const reverseToolMap = buildReverseMapFromClaudeTools(request.tools)
    let codexRequest = buildCodexRequest(request, modelName) as Record<
      string,
      unknown
    >

    const cacheId = this.getCacheId(request, slot)
    if (cacheId) {
      codexRequest = this.cacheService.injectCacheKey(codexRequest, cacheId)
    }
    const conversationId = this.getConversationId(request)
    const turnKey = this.getCodexTurnKey(codexRequest)
    const shouldTryWebSocket =
      this.useWebSocket &&
      this.wsService.isWebSocketAvailable() &&
      !this.isHttpFallbackTransport(conversationId, slot, modelName)
    const turnContext =
      conversationId && shouldTryWebSocket
        ? this.getOrCreateTurnContext(conversationId, slot, modelName, turnKey)
        : undefined

    try {
      let result: AnthropicResponse

      // Try WebSocket transport first when enabled for this Codex session.
      if (shouldTryWebSocket) {
        try {
          result = await this.sendViaWebSocket(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId,
            request,
            forwardHeaders,
            turnContext
          )
        } catch (e) {
          const failureAction = resolveCodexWebSocketFailure(e, {
            isApiKeyMode: this.isApiKeyMode(slot),
          })

          switch (failureAction.kind) {
            case "retry_http_without_account":
              this.logger.warn(
                `[Codex] WebSocket returned deactivated_workspace for ${this.getAccountLabel(slot)}, retrying over HTTP without Chatgpt-Account-Id`
              )
              this.beginHttpTransportTurn(
                conversationId,
                slot,
                modelName,
                "WebSocket deactivated_workspace forced HTTP retry",
                true
              )
              result = await this.sendViaHttp(
                slot,
                token,
                codexRequest,
                modelName,
                reverseToolMap,
                cacheId,
                conversationId,
                true,
                forwardHeaders,
                turnContext
              )
              break
            case "fallback_http":
              if (failureAction.reason === "upgrade_rejected") {
                this.logger.warn(
                  "WebSocket upgrade rejected, falling back to HTTP"
                )
              } else {
                this.logger.warn(
                  `[Codex] WebSocket transport unavailable, falling back to HTTP: ${e instanceof Error ? e.message : String(e)}`
                )
              }
              this.beginHttpTransportTurn(
                conversationId,
                slot,
                modelName,
                "WebSocket transport fallback",
                true
              )
              result = await this.sendViaHttp(
                slot,
                token,
                codexRequest,
                modelName,
                reverseToolMap,
                cacheId,
                conversationId,
                false,
                forwardHeaders,
                turnContext
              )
              break
            case "throw_codex_api_error":
              throw createCodexApiErrorFromBody(
                failureAction.statusCode,
                failureAction.body
              )
            case "throw_original":
              throw e
          }
        }
      } else {
        this.beginHttpTransportTurn(
          conversationId,
          slot,
          modelName,
          this.isHttpFallbackTransport(conversationId, slot, modelName)
            ? "Codex session pinned to HTTP transport"
            : "WebSocket transport disabled or unavailable"
        )
        result = await this.sendViaHttp(
          slot,
          token,
          codexRequest,
          modelName,
          reverseToolMap,
          cacheId,
          conversationId,
          false,
          forwardHeaders,
          turnContext
        )
      }

      // Success — clear any cooldown on this slot
      markAccountSuccess(slot, modelName)
      return result
    } catch (e) {
      if (e instanceof CodexApiError) {
        const statusCode = e.getStatus()

        // 401/403: 尝试 refresh token 后用同一 slot 重试一次，避免直接 cooldown
        if (
          shouldRefreshCodexTokenForStatus({
            statusCode,
            attempt,
            isApiKeyMode: this.isApiKeyMode(slot),
          })
        ) {
          const newToken = await this.tryRefreshSlotToken(
            slot,
            `${statusCode} non-stream retry`
          )
          if (newToken) {
            return this.executeWithCooldownRetry(
              request,
              forwardHeaders,
              attempt + 1,
              slot
            )
          }
        }

        const retryAfterHeader = e.retryAfterSeconds?.toString()
        markAccountCooldown(
          slot,
          statusCode,
          modelName,
          retryAfterHeader,
          this.getAccountLabel(slot)
        )

        // 401/403: refresh 失败后，尝试用下一个可用账号重试（跨 slot 故障转移）
        if (
          isCodexAuthRetryStatus(statusCode) &&
          shouldFailOverCodexAccountForStatus({
            statusCode,
            attempt,
            accountCount: this.accounts.length,
          })
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] ${statusCode} on ${this.getAccountLabel(slot)}, ` +
                `falling over to ${this.getAccountLabel(nextSlot)} ` +
                `(attempt ${attempt + 1}/${this.accounts.length})`
            )
            return this.executeWithCooldownRetry(
              request,
              forwardHeaders,
              attempt + 1,
              nextSlot
            )
          }
        }

        // Auto-retry on 429 if another account is available
        if (
          isCodexRateLimitRetryStatus(statusCode) &&
          shouldFailOverCodexAccountForStatus({
            statusCode,
            attempt,
            accountCount: this.accounts.length,
          })
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] 429 on ${this.getAccountLabel(slot)}, retrying with ${this.getAccountLabel(nextSlot)} (attempt ${attempt + 1}/${this.accounts.length})`
            )
            return this.executeWithCooldownRetry(
              request,
              forwardHeaders,
              attempt + 1,
              nextSlot
            )
          }
        }

        if (
          isCodexRateLimitRetryStatus(statusCode) &&
          (await this.waitForAllRateLimitRetry(
            e,
            modelName,
            allRateLimitRetryAttempt,
            "non-stream request"
          ))
        ) {
          return this.executeWithCooldownRetry(
            request,
            forwardHeaders,
            attempt,
            undefined,
            allRateLimitRetryAttempt + 1
          )
        }
      }
      throw e
    }
  }

  /**
   * Send non-streaming via HTTP.
   */
  private async sendViaHttp(
    slot: CodexAccountSlot,
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string,
    conversationId?: string,
    omitAccountId: boolean = false,
    forwardHeaders?: CodexForwardHeaders,
    turnContext?: CodexTurnContext
  ): Promise<AnthropicResponse> {
    const requestStartedAt = Date.now()
    const preparedCodexRequest = prepareCodexRequestForSend(codexRequest)
    const requestBody = JSON.stringify(preparedCodexRequest)
    const url = this.buildUrl(slot, "responses")
    const headers = this.buildHeaders(slot, token, true, {
      conversationId,
      omitAccountId,
      forwardHeaders,
      clientMetadata: this.getCodexRequestClientMetadata(codexRequest),
      useResponsesLite: this.usesResponsesLite(modelName),
    })
    this.applyCodexTurnStateHeader(headers, turnContext)

    this.logger.log(
      buildCodexDispatchLogLine({
        slotLabel: this.getAccountLabel(slot),
        modelName,
        transport: "http",
        omitAccountId,
        accountId: this.getSlotAccountId(slot),
        workspaceId: slot.workspaceId,
        headers,
      })
    )
    this.logger.log(
      buildCodexHttpRequestLogLine({
        kind: "non_stream",
        modelName,
        url,
        codexRequest: preparedCodexRequest,
      })
    )
    this.logger.debug(
      `[Codex][HTTP Request][Payload] ${summarizeCodexRequestForLogs(preparedCodexRequest)}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(300_000),
    }

    const dispatcher = this.buildProxyDispatcher(slot)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[Codex] Request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )

      const failureAction = resolveCodexHttpErrorResponse(
        response.status,
        errorBody,
        {
          omitAccountId,
          isApiKeyMode: this.isApiKeyMode(slot),
        }
      )

      switch (failureAction.kind) {
        case "retry_http_without_account":
          this.logger.warn(
            `[Codex] deactivated_workspace for ${this.getAccountLabel(slot)}, retrying without Chatgpt-Account-Id`
          )
          return this.sendViaHttp(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId,
            conversationId,
            true,
            forwardHeaders,
            turnContext
          )
        case "throw_codex_api_error":
          throw createCodexApiErrorFromBody(
            failureAction.statusCode,
            failureAction.body
          )
      }
    }

    // Read the full SSE stream and find response.completed
    this.captureCodexRateLimitHeaders(
      response.headers,
      slot,
      modelName,
      "request"
    )
    this.captureCodexTurnStateFromHttpHeaders(turnContext, response.headers)
    const fullBody = await response.text()
    const lines = fullBody.split("\n")

    // Aggregate output items the same way the WebSocket path does: the codex
    // backend may emit message/reasoning/tool content only on intermediate
    // `response.output_item.done` events and leave `response.completed.response
    // .output` empty. Collect them so the completed frame can be backfilled,
    // otherwise non-stream responses would drop all content.
    const collectedItems: Array<Record<string, unknown>> = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue

      const jsonStr = trimmed.slice(5).trim()
      if (!jsonStr || jsonStr === "[DONE]") continue

      try {
        const event = JSON.parse(jsonStr) as Record<string, unknown>
        this.captureCodexTurnStateFromSsePayload(turnContext, event)
        if (event.type === "response.output_item.done") {
          const item = event.item as Record<string, unknown> | undefined
          if (item && typeof item === "object") {
            collectedItems.push(item)
          }
          continue
        }
        if (event.type === "response.completed") {
          this.logCodexUsage(
            "http",
            modelName,
            cacheId,
            slot,
            event,
            requestStartedAt
          )
          const completedResponse =
            (event.response as Record<string, unknown>) || {}
          const existingOutput = completedResponse.output
          const hasUsableOutput =
            Array.isArray(existingOutput) && existingOutput.length > 0
          const completedEvent =
            !hasUsableOutput && collectedItems.length > 0
              ? {
                  ...event,
                  response: { ...completedResponse, output: collectedItems },
                }
              : event
          const result = translateCodexToClaudeNonStream(
            completedEvent,
            reverseToolMap
          )
          if (result) {
            this.logger.log(
              `[Codex] Non-stream response: model=${result.model}, stop=${result.stop_reason}`
            )
            return result
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    throw new Error("Codex stream ended without response.completed event")
  }

  /**
   * Send non-streaming via WebSocket.
   */
  private async sendViaWebSocket(
    slot: CodexAccountSlot,
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string,
    request: Pick<
      CodexExecutionRequest,
      "conversationId" | "model" | "pendingToolUseIds"
    >,
    forwardHeaders?: CodexForwardHeaders,
    turnContextOverride?: CodexTurnContext
  ): Promise<AnthropicResponse> {
    const requestStartedAt = Date.now()
    const httpUrl = this.buildUrl(slot, "responses")
    const wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
    const conversationId = this.getConversationId(request)
    const turnKey = this.getCodexTurnKey(codexRequest)
    const turnContext =
      turnContextOverride ||
      (conversationId
        ? this.getOrCreateTurnContext(conversationId, slot, modelName, turnKey)
        : undefined)
    const wsHeaders = this.wsService.buildWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      conversationId,
      this.getSlotAccountId(slot),
      slot.workspaceId,
      forwardHeaders,
      false,
      this.usesResponsesLite(modelName),
      this.getCodexRequestClientMetadata(codexRequest)
    )
    this.applyCodexTurnStateHeader(wsHeaders, turnContext)
    const sessionId =
      turnContext?.wsSessionId || this.getCachedWsKey(slot, request.model)

    const buildWsBody = (requestForSend: Record<string, unknown>) =>
      this.wsService.buildWebSocketRequestBody(
        prepareCodexRequestForSend(requestForSend),
        {
          useResponsesLite: this.usesResponsesLite(modelName),
          forwardHeaders,
          streamRequestStartMs: Date.now(),
          turnState: turnContext?.turnState,
        }
      )

    const logWsRequest = (wsBody: Record<string, unknown>) => {
      this.logger.log(
        buildCodexDispatchLogLine({
          slotLabel: this.getAccountLabel(slot),
          modelName,
          transport: "websocket",
          omitAccountId: false,
          accountId: this.getSlotAccountId(slot),
          workspaceId: slot.workspaceId,
          headers: wsHeaders,
        })
      )
      this.logger.log(
        `[Codex] WebSocket non-stream request: model=${modelName}, url=${wsUrl}`
      )
      this.logger.debug(
        `[Codex][WS Request][Payload] ${summarizeCodexRequestForLogs(wsBody)}`
      )
    }

    const captureNonStreamResponse = (
      completedEvent: Record<string, unknown>
    ) => {
      if (!conversationId || !turnContext) {
        return
      }

      const response = completedEvent.response as
        | Record<string, unknown>
        | undefined
      const output = response?.output
      const itemsAdded: CodexInputItem[] = []
      if (Array.isArray(output)) {
        for (const item of output) {
          appendCodexResponseOutputItemToLedger(
            itemsAdded,
            item as Record<string, unknown> | undefined
          )
        }
      }

      const capturedId = getCodexCompletedResponseId(completedEvent)
      if (capturedId) {
        this.captureResponseInTurnContext(
          conversationId,
          capturedId,
          itemsAdded
        )
      }
    }

    const executeRequest = async (
      ws: WebSocket,
      requestForSend: Record<string, unknown>
    ): Promise<AnthropicResponse> => {
      const wsBody = buildWsBody(requestForSend)
      logWsRequest(wsBody)
      const completedEvent = await this.wsService.sendViaWebSocket(ws, wsBody, {
        onMessage: (msg) =>
          this.captureCodexTurnStateFromSsePayload(
            turnContext,
            msg as Record<string, unknown>
          ),
      })
      this.logCodexUsage(
        "websocket",
        modelName,
        cacheId,
        slot,
        completedEvent as Record<string, unknown>,
        requestStartedAt
      )
      captureNonStreamResponse(completedEvent as Record<string, unknown>)

      const result = translateCodexToClaudeNonStream(
        completedEvent as Record<string, unknown>,
        reverseToolMap
      )
      if (!result) {
        throw new Error("WebSocket response did not contain valid completion")
      }

      this.logger.log(
        `[Codex] WebSocket non-stream response: model=${result.model}, stop=${result.stop_reason}`
      )
      return result
    }

    if (sessionId && conversationId && sessionId !== conversationId) {
      this.logger.debug(
        `[Codex] Reusing warm WebSocket pool session ${sessionId} for initial request conversation=${conversationId}`
      )
    }

    const prepareWebSocketRequest = (
      requestForSend: Record<string, unknown>
    ): Record<string, unknown> =>
      turnContext && conversationId
        ? this.prepareRequestWithTurnContext(
            requestForSend,
            turnContext,
            conversationId
          )
        : requestForSend

    try {
      if (!sessionId) {
        const ws = await this.wsService.connect(
          wsUrl,
          wsHeaders,
          slot.proxyUrl || undefined
        )
        this.captureCodexTurnStateFromConnection(turnContext, ws)
        try {
          return await executeRequest(ws, prepareWebSocketRequest(codexRequest))
        } finally {
          ws.close()
        }
      }

      const { release } = await this.wsService.acquireSession(sessionId)
      try {
        const sessionState = this.wsService.getOrCreateSession(sessionId)
        const hadOpenConnection =
          !!sessionState.conn &&
          sessionState.wsUrl === wsUrl &&
          sessionState.conn.readyState === 1

        let ws = await this.wsService.ensureSessionConnection(
          sessionId,
          wsUrl,
          wsHeaders,
          slot.proxyUrl || undefined
        )
        this.captureCodexTurnStateFromConnection(turnContext, ws)

        if (!hadOpenConnection) {
          this.recordTurnContextTransportReconnect(
            conversationId,
            slot,
            modelName,
            "WebSocket non-stream connection rebuilt before request"
          )
        }

        const originalCodexRequest = codexRequest
        let requestForSend = prepareWebSocketRequest(codexRequest)

        try {
          return await executeRequest(ws, requestForSend)
        } catch (error) {
          if (
            shouldReplayCodexRequestWithoutPreviousResponseId(error, {
              conversationId,
              currentRequest: requestForSend,
              originalRequest: originalCodexRequest,
            })
          ) {
            this.logger.warn(
              `[Codex] Previous response_id rejected by server for ${conversationId}, retrying non-stream without previous_response_id`
            )
            this.beginFullCodexResponseChain(
              turnContext,
              conversationId,
              originalCodexRequest,
              "Server rejected stale previous_response_id on non-stream request"
            )
            return executeRequest(ws, originalCodexRequest)
          }

          if (!shouldRetryCodexSessionWebSocketError(error)) {
            throw error
          }

          this.logger.warn(
            `[Codex] Reconnecting stale WebSocket session ${sessionId} before non-stream retry`
          )
          this.wsService.invalidateSessionConnection(
            sessionId,
            ws,
            "previous_response_rejected_non_stream_retry"
          )
          this.applyCodexTurnStateHeader(wsHeaders, turnContext)
          ws = await this.wsService.ensureSessionConnection(
            sessionId,
            wsUrl,
            wsHeaders,
            slot.proxyUrl || undefined
          )
          this.captureCodexTurnStateFromConnection(turnContext, ws)
          this.recordTurnContextTransportReconnect(
            conversationId,
            slot,
            modelName,
            "WebSocket non-stream connection rebuilt before retry"
          )
          requestForSend = prepareWebSocketRequest(originalCodexRequest)
          return executeRequest(ws, requestForSend)
        }
      } finally {
        release()
      }
    } finally {
      if (conversationId) {
        this.disposeTurnContext(conversationId, slot, modelName)
      }
    }
  }

  // ── Streaming ────────────────────────────────────────────────────────

  /**
   * Send a streaming message through Codex.
   * Returns an async generator yielding Claude SSE event strings.
   */
  async *sendMessageStream(
    request: CodexExecutionRequest,
    forwardHeadersOrAbortSignal?: CodexForwardHeaders | AbortSignal,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const forwardHeaders =
      forwardHeadersOrAbortSignal instanceof AbortSignal
        ? undefined
        : forwardHeadersOrAbortSignal
    const resolvedAbortSignal =
      forwardHeadersOrAbortSignal instanceof AbortSignal
        ? forwardHeadersOrAbortSignal
        : abortSignal

    const conversationId = this.getConversationId(request)
    const releaseConversationLock =
      await this.acquireConversationStreamLock(conversationId)

    this.onLiveRequestStart()
    try {
      yield* this.executeStreamWithCooldownRetry(
        request,
        forwardHeaders,
        resolvedAbortSignal,
        1
      )
    } finally {
      this.onLiveRequestEnd()
      releaseConversationLock()
    }
  }

  async prewarmSessionConnection(
    request: Pick<
      CodexExecutionRequest,
      "model" | "conversationId" | "cacheUserId" | "pendingToolUseIds"
    >,
    options?: {
      forwardHeaders?: CodexForwardHeaders
      reason?: string
      turnKey?: string
      /**
       * 完整的 CodexRequest 请求体（由 buildCodexRequest 构建）。
       * 当提供时，连接建立后会发送 generate:false 的 warmup payload，
       * 对齐官方 Codex CLI（session_startup_prewarm.rs）的 prompt cache 预热行为。
       */
      warmupPayload?: Record<string, unknown>
    }
  ): Promise<void> {
    if (!this.useWebSocket || !this.wsService.isWebSocketAvailable()) {
      return
    }

    const warmupReason = options?.reason?.trim() || "request"
    const turnKey = options?.turnKey?.trim()
    if (!turnKey) {
      this.logger.debug(
        `[Codex][Warmup] reason=${warmupReason} model=${request.model} skipped: Codex WebSocket warmup requires a turn-scoped context`
      )
      return
    }

    let slot: CodexAccountSlot
    let wsUrl: string
    let sessionId: string
    try {
      const modelName = request.model
      const conversationId = this.getConversationId(request)
      slot = this.selectWarmupSlot(modelName, conversationId)
      if (this.isHttpFallbackTransport(conversationId, slot, modelName)) {
        this.logger.debug(
          `[Codex][Warmup] reason=${options?.reason?.trim() || "request"} model=${modelName} skipped: Codex session is pinned to HTTP transport`
        )
        return
      }
      const httpUrl = this.buildUrl(slot, "responses")
      wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
      sessionId = this.turnContexts.prepareWarmupContext({
        slotKey: this.getSlotStickyKey(slot),
        modelName: request.model,
        conversationId: conversationId || undefined,
        turnKey,
      }).sessionId
    } catch (error) {
      this.logger.debug(
        `[Codex][Warmup] reason=${options?.reason?.trim() || "request"} model=${request.model} skipped before dispatch: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }

    const existingWarmup = this.sessionWarmupPromises.get(sessionId)
    if (existingWarmup) {
      return existingWarmup
    }

    const warmupPromise = this.runSessionWarmup(
      request,
      slot,
      wsUrl,
      sessionId,
      options?.forwardHeaders,
      warmupReason,
      options?.warmupPayload
    )
      .catch((error) => {
        // Warmup 401 时主动 refresh token，为后续实际请求做准备
        if (
          error instanceof CodexWebSocketUpgradeError &&
          (error.statusCode === 401 || error.statusCode === 403)
        ) {
          this.tryRefreshSlotToken(slot, "warmup-401").catch(() => {})
        }
        this.logger.debug(
          `[Codex][Warmup] reason=${warmupReason} session=${sessionId} model=${request.model} skipped: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        if (this.sessionWarmupPromises.get(sessionId) === warmupPromise) {
          this.sessionWarmupPromises.delete(sessionId)
        }
      })

    this.sessionWarmupPromises.set(sessionId, warmupPromise)
    return warmupPromise
  }

  private async runSessionWarmup(
    request: Pick<
      CodexExecutionRequest,
      "model" | "conversationId" | "cacheUserId" | "pendingToolUseIds"
    >,
    slot: CodexAccountSlot,
    wsUrl: string,
    sessionId: string,
    forwardHeaders: CodexForwardHeaders | undefined,
    warmupReason: string,
    warmupPayload?: Record<string, unknown>
  ): Promise<void> {
    const modelName = request.model
    const conversationId = this.getConversationId(request)
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    this.bindConversationToSlot(conversationId, slot)

    const cacheId = this.getCacheId(request, slot)
    const wsHeaders = this.wsService.buildWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      conversationId || sessionId,
      this.getSlotAccountId(slot),
      slot.workspaceId,
      forwardHeaders,
      false,
      this.usesResponsesLite(modelName),
      this.getCodexRequestClientMetadata(warmupPayload)
    )

    const { release } = await this.wsService.acquireSession(sessionId)
    const startedAt = Date.now()
    try {
      const session = this.wsService.getOrCreateSession(sessionId)
      const reusedConnection =
        !!session.conn &&
        session.wsUrl === wsUrl &&
        session.conn.readyState === 1
      const conversationHadContinuation =
        !!conversationId &&
        this.hasConversationContinuationState(conversationId, slot, modelName)

      const ws = await this.wsService.ensureSessionConnection(
        sessionId,
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )

      if (!reusedConnection) {
        this.recordTurnContextTransportReconnect(
          conversationId,
          slot,
          modelName,
          "Warmup rebuilt WebSocket connection"
        )
      }

      // Send generate:false warmup payload to prime the server-side prompt cache (mirrors Codex CLI).
      //
      // IMPORTANT: Only send warmup payload for initial-chat warmups (session startup).
      // The official Codex CLI only does prewarm_websocket() when last_request.is_none()
      // (i.e., before the first request in a session). For continuation warmups
      // (shell-continuation, tool-continuation), sending generate:false creates a new
      // response on the server that breaks the previous_response_id chain — the server
      // won't recognize the response_id from the actual request because it belongs to
      // a different chain than the warmup response.
      //
      const warmupPayloadDecision = shouldSendCodexWarmupPayload({
        warmupPayloadAvailable: !!warmupPayload,
        reusedConnection,
        warmupReason,
        conversationHasContinuation: conversationHadContinuation,
      })
      if (warmupPayloadDecision.sendPayload && warmupPayload) {
        let warmupBody = { ...warmupPayload }
        if (cacheId) {
          warmupBody = this.cacheService.injectCacheKey(warmupBody, cacheId)
        }
        warmupBody = prepareCodexRequestForSend(warmupBody)
        const wsBody = this.wsService.buildWarmupRequestBody(warmupBody, {
          useResponsesLite: this.usesResponsesLite(modelName),
          forwardHeaders,
          streamRequestStartMs: Date.now(),
        })

        this.logger.debug(
          `[Codex][Warmup] reason=${warmupReason} session=${sessionId} model=${modelName} sending generate:false payload`
        )

        try {
          await this.wsService.sendWarmupRequest(ws, wsBody)
          this.logger.debug(
            `[Codex][Warmup] reason=${warmupReason} session=${sessionId} model=${modelName} warmup payload completed duration=${Date.now() - startedAt}ms`
          )
        } catch (warmupError) {
          // warmup payload 失败不应阻塞后续实际请求，连接已建立就够了
          this.logger.warn(
            `[Codex][Warmup] reason=${warmupReason} session=${sessionId} warmup payload failed: ${warmupError instanceof Error ? warmupError.message : String(warmupError)}`
          )
        }
      } else {
        this.logger.debug(
          `[Codex][Warmup] reason=${warmupReason} session=${sessionId} model=${modelName} slot=${this.getAccountLabel(slot)} reused=${reusedConnection} connection-only duration=${Date.now() - startedAt}ms`
        )
      }
    } finally {
      release()
    }
  }

  // ── ProviderAdapter Interface ────────────────────────────────────────

  /**
   * ProviderAdapter.warmup() — fire-and-forget connection prewarming.
   * Translates the provider-agnostic ProviderWarmupHint into the Codex-specific
   * prewarmSessionConnection() call, using the internal warmupPayloadCache.
   */
  warmup(hint: ProviderWarmupHint): void {
    const warmupPayload =
      hint.warmupPayload || this.getWarmupPayloadCache(hint.conversationId)

    void this.prewarmSessionConnection(
      {
        model: hint.model,
        conversationId: hint.conversationId,
        pendingToolUseIds:
          hint.pendingToolUseIds && hint.pendingToolUseIds.length > 0
            ? hint.pendingToolUseIds
            : undefined,
      },
      {
        reason: hint.reason,
        warmupPayload,
      }
    )
  }

  /**
   * Internal warmup payload cache management.
   * Previously exposed as a ProviderAdapter method and called from the protocol bridge.
   * Now fully internal — auto-cached during executeStreamWithCooldownRetry().
   */
  private cacheWarmupPayload(
    conversationId: string,
    payload: Record<string, unknown>
  ): void {
    this.setWarmupPayloadCache(conversationId, payload)
  }

  /**
   * ProviderAdapter.dispose() — release all resources for a conversation.
   * Returns WS connection to cache (via disposeTurnContext) and clears warmup cache.
   * Called by SessionLifecycleService when a session expires or is deleted.
   */
  dispose(conversationId: string): void {
    const normalized = conversationId.trim()
    if (!normalized) return
    this.turnContexts.deleteConversation(normalized)
  }

  private async *retryStreamWithFreshTurnContext(
    request: CodexExecutionRequest,
    forwardHeaders: CodexForwardHeaders | undefined,
    abortSignal: AbortSignal | undefined,
    attempt: number,
    currentSlot: CodexAccountSlot,
    retrySlot: CodexAccountSlot,
    modelName: string,
    conversationId: string,
    delayMs: number = 0
  ): AsyncGenerator<string, void, unknown> {
    if (conversationId) {
      this.disposeTurnContext(conversationId, currentSlot, modelName)
    }
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    yield* this.executeStreamWithCooldownRetry(
      request,
      forwardHeaders,
      abortSignal,
      attempt + 1,
      retrySlot
    )
  }

  private async *executeStreamWithCooldownRetry(
    request: CodexExecutionRequest,
    forwardHeaders?: CodexForwardHeaders,
    abortSignal?: AbortSignal,
    attempt: number = 1,
    selectedSlot?: CodexAccountSlot,
    allRateLimitRetryAttempt: number = 0
  ): AsyncGenerator<string, void, unknown> {
    const modelName = request.model
    let slot: CodexAccountSlot
    try {
      slot =
        selectedSlot ??
        this.selectRequestSlot(request.model, this.getConversationId(request), {
          preferWarmPool: !this.hasConversationContinuationState(
            this.getConversationId(request)
          ),
        })
    } catch (error) {
      if (
        error instanceof CodexApiError &&
        (await this.waitForAllRateLimitRetry(
          error,
          modelName,
          allRateLimitRetryAttempt,
          "stream slot selection",
          abortSignal
        ))
      ) {
        yield* this.executeStreamWithCooldownRetry(
          request,
          forwardHeaders,
          abortSignal,
          attempt,
          undefined,
          allRateLimitRetryAttempt + 1
        )
        return
      }
      throw error
    }

    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    this.bindConversationToSlot(this.getConversationId(request), slot)

    const reverseToolMap = buildReverseMapFromClaudeTools(request.tools)
    let codexRequest = buildCodexRequest(request, modelName) as Record<
      string,
      unknown
    >

    // Auto-cache warmup payload for future continuation warmups.
    // This replaces the external cacheWarmupPayload() call from the protocol bridge,
    // ensuring the adapter always has an up-to-date warmup snapshot.
    const conversationId = this.getConversationId(request)
    if (conversationId) {
      this.setWarmupPayloadCache(
        conversationId,
        extractWarmupPayload(codexRequest as CodexRequest)
      )
    }

    const cacheId = this.getCacheId(request, slot)
    if (cacheId) {
      codexRequest = this.cacheService.injectCacheKey(codexRequest, cacheId)
    }

    // ── Turn-scoped context management ─────────────────────────────────
    // Each executeStreamWithCooldownRetry() call = one turn.
    // Create a fresh turn context at entry; dispose in finally.
    // This matches the official Codex CLI ModelClientSession lifecycle:
    //   client.new_session() → turn → Drop → store_cached_websocket_session
    const turnKey = this.getCodexTurnKey(codexRequest)
    const turnContext = conversationId
      ? this.getOrCreateTurnContext(conversationId, slot, modelName, turnKey)
      : undefined

    let emittedEvents = false
    let websocketRetryCount = 0

    try {
      // Try WebSocket transport first when enabled for this Codex session.
      if (
        this.useWebSocket &&
        this.wsService.isWebSocketAvailable() &&
        !this.isHttpFallbackTransport(conversationId, slot, modelName)
      ) {
        while (true) {
          const attemptBuffer = new CodexStreamAttemptBuffer()
          try {
            for await (const event of this.streamViaWebSocket(
              slot,
              token,
              codexRequest,
              modelName,
              reverseToolMap,
              cacheId,
              request,
              forwardHeaders,
              abortSignal
            )) {
              for (const readyEvent of attemptBuffer.push(event)) {
                emittedEvents = true
                yield readyEvent
              }
            }
            for (const readyEvent of attemptBuffer.finish()) {
              emittedEvents = true
              yield readyEvent
            }
            markAccountSuccess(slot, modelName)
            return
          } catch (e) {
            const abortedError = toUpstreamRequestAbortedError(
              e,
              abortSignal,
              "Codex WebSocket stream aborted"
            )
            if (abortedError) {
              throw abortedError
            }

            if (
              shouldRetryCodexWebSocketBeforeHttpFallback(e, {
                emittedEvents:
                  emittedEvents || attemptBuffer.hasCommittedOutput(),
                retryCount: websocketRetryCount,
                maxRetries: this.websocketStreamMaxRetries,
              })
            ) {
              websocketRetryCount++
              this.recordTurnContextTransportReconnect(
                conversationId,
                slot,
                modelName,
                `WebSocket stream retry ${websocketRetryCount}/${this.websocketStreamMaxRetries}`
              )
              this.logger.warn(
                `[Codex] WebSocket stream ended before downstream output, retrying ` +
                  `(${websocketRetryCount}/${this.websocketStreamMaxRetries}): ` +
                  `${e instanceof Error ? e.message : String(e)}`
              )
              await new Promise((resolve) =>
                setTimeout(
                  resolve,
                  codexWebSocketRetryDelayMs(websocketRetryCount)
                )
              )
              continue
            }

            const failureAction = resolveCodexWebSocketFailure(e, {
              isApiKeyMode: this.isApiKeyMode(slot),
            })

            switch (failureAction.kind) {
              case "retry_http_without_account":
                this.logger.warn(
                  `[Codex] WebSocket returned deactivated_workspace for ${this.getAccountLabel(slot)}, retrying stream over HTTP without Chatgpt-Account-Id`
                )
                this.beginHttpTransportTurn(
                  conversationId,
                  slot,
                  modelName,
                  "WebSocket deactivated_workspace forced HTTP stream retry",
                  true
                )
                for await (const event of this.streamViaHttp(
                  slot,
                  token,
                  codexRequest,
                  modelName,
                  reverseToolMap,
                  cacheId,
                  this.getConversationId(request),
                  true,
                  forwardHeaders,
                  abortSignal,
                  turnContext
                )) {
                  emittedEvents = true
                  yield event
                }
                markAccountSuccess(slot, modelName)
                return
              case "fallback_http":
                if (
                  failureAction.reason === "transport_unavailable" &&
                  emittedEvents
                ) {
                  throw e
                }

                if (failureAction.reason === "upgrade_rejected") {
                  this.logger.warn(
                    "WebSocket upgrade rejected, falling back to HTTP for streaming"
                  )
                } else {
                  this.logger.warn(
                    `[Codex] WebSocket streaming unavailable, falling back to HTTP: ${e instanceof Error ? e.message : String(e)}`
                  )
                }
                this.beginHttpTransportTurn(
                  conversationId,
                  slot,
                  modelName,
                  "WebSocket streaming transport fallback",
                  true
                )
                break
              case "throw_codex_api_error":
                throw createCodexApiErrorFromBody(
                  failureAction.statusCode,
                  failureAction.body
                )
              case "throw_original":
                throw e
            }
            break
          }
        }
      }

      this.beginHttpTransportTurn(
        conversationId,
        slot,
        modelName,
        this.isHttpFallbackTransport(conversationId, slot, modelName)
          ? "Codex session pinned to HTTP transport"
          : "WebSocket transport disabled or unavailable"
      )
      for await (const event of this.streamViaHttp(
        slot,
        token,
        codexRequest,
        modelName,
        reverseToolMap,
        cacheId,
        this.getConversationId(request),
        false,
        forwardHeaders,
        abortSignal,
        turnContext
      )) {
        emittedEvents = true
        yield event
      }
      markAccountSuccess(slot, modelName)
    } catch (e) {
      const abortedError = toUpstreamRequestAbortedError(
        e,
        abortSignal,
        "Codex stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }

      if (e instanceof CodexApiError) {
        const statusCode = e.getStatus()

        // 401/403: 尚未输出任何 event 时，尝试 refresh token 后用同一 slot 重试
        if (
          shouldRefreshCodexTokenForStatus({
            statusCode,
            attempt,
            emittedEvents,
            isApiKeyMode: this.isApiKeyMode(slot),
          })
        ) {
          const newToken = await this.tryRefreshSlotToken(
            slot,
            `${statusCode} stream retry`
          )
          if (newToken) {
            yield* this.retryStreamWithFreshTurnContext(
              request,
              forwardHeaders,
              abortSignal,
              attempt,
              slot,
              slot,
              modelName,
              conversationId
            )
            return
          }
        }

        // 网关/上游瞬时错误（500 / 502 / 503 / 504）：常见于 server overloaded、
        // "upstream connect error" 或 "reset reason: connection termination"。
        // 这类错误不代表账号不可用。立即 markAccountCooldown 会让单账号场景
        // 1 分钟内完全失活、整个 turn 直接 fail（参见 bridge 日志中
        // delete_file -> PostToolContinuation 的 503 中断）。
        // 策略：第一次失败时先在同一 slot 上短暂 backoff 后重试一次；
        // 仍然失败再走原有的 cooldown + 跨账号故障转移路径。
        const isGatewayTransient = isCodexGatewayTransientStatus(statusCode)
        if (
          shouldRetryCodexGatewayTransientOnSameSlot({
            statusCode,
            attempt,
            emittedEvents,
          })
        ) {
          this.logger.warn(
            `[Codex] ${statusCode} transient gateway error on ${this.getAccountLabel(slot)} ` +
              `(${e.message}); retrying same slot once before cooldown`
          )
          yield* this.retryStreamWithFreshTurnContext(
            request,
            forwardHeaders,
            abortSignal,
            attempt,
            slot,
            slot,
            modelName,
            conversationId,
            500
          )
          return
        }

        markAccountCooldown(
          slot,
          statusCode,
          modelName,
          e.retryAfterSeconds?.toString(),
          this.getAccountLabel(slot)
        )

        // 网关瞬时错误：同 slot 重试已经失败，如果还有其它可用账号就跨 slot
        // 故障转移；只剩一个账号时就直接落到下面的 throw 让上层处理
        if (
          isGatewayTransient &&
          shouldFailOverCodexAccountForStatus({
            statusCode,
            attempt,
            emittedEvents,
            accountCount: this.accounts.length,
            includeGatewayTransient: true,
          })
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] ${statusCode} persisted on ${this.getAccountLabel(slot)}, ` +
                `failing over to ${this.getAccountLabel(nextSlot)} ` +
                `(attempt ${attempt + 1}/${this.accounts.length})`
            )
            yield* this.retryStreamWithFreshTurnContext(
              request,
              forwardHeaders,
              abortSignal,
              attempt,
              slot,
              nextSlot,
              modelName,
              conversationId
            )
            return
          }
        }

        // 401/403: refresh 失败后，尝试用下一个可用账号重试（跨 slot 故障转移）
        if (
          isCodexAuthRetryStatus(statusCode) &&
          shouldFailOverCodexAccountForStatus({
            statusCode,
            attempt,
            emittedEvents,
            accountCount: this.accounts.length,
          })
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] ${statusCode} on ${this.getAccountLabel(slot)}, ` +
                `falling over to ${this.getAccountLabel(nextSlot)} ` +
                `(attempt ${attempt + 1}/${this.accounts.length})`
            )
            yield* this.retryStreamWithFreshTurnContext(
              request,
              forwardHeaders,
              abortSignal,
              attempt,
              slot,
              nextSlot,
              modelName,
              conversationId
            )
            return
          }
        }

        // Auto-retry on 429 if another account is available
        if (
          isCodexRateLimitRetryStatus(statusCode) &&
          shouldFailOverCodexAccountForStatus({
            statusCode,
            attempt,
            emittedEvents,
            accountCount: this.accounts.length,
          })
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] 429 on ${this.getAccountLabel(slot)}, retrying streamed request with ${this.getAccountLabel(nextSlot)} (attempt ${attempt + 1}/${this.accounts.length})`
            )
            yield* this.retryStreamWithFreshTurnContext(
              request,
              forwardHeaders,
              abortSignal,
              attempt,
              slot,
              nextSlot,
              modelName,
              conversationId
            )
            return
          }
        }

        if (
          isCodexRateLimitRetryStatus(statusCode) &&
          !emittedEvents &&
          (await this.waitForAllRateLimitRetry(
            e,
            modelName,
            allRateLimitRetryAttempt,
            "stream request",
            abortSignal
          ))
        ) {
          if (conversationId) {
            this.disposeTurnContext(conversationId, slot, modelName)
          }
          yield* this.executeStreamWithCooldownRetry(
            request,
            forwardHeaders,
            abortSignal,
            attempt,
            undefined,
            allRateLimitRetryAttempt + 1
          )
          return
        }
      }
      throw e
    } finally {
      // ── Turn end: return WS connection to cache ──────────────────────
      // Mirrors Drop for ModelClientSession → store_cached_websocket_session.
      // The connection is returned to cachedWsSessions for reuse by the next turn.
      if (conversationId) {
        this.disposeTurnContext(conversationId, slot, modelName)
      }
    }
  }

  /**
   * Stream via HTTP SSE transport.
   */
  private async *streamViaHttp(
    slot: CodexAccountSlot,
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string,
    conversationId?: string,
    omitAccountId: boolean = false,
    forwardHeaders?: CodexForwardHeaders,
    abortSignal?: AbortSignal,
    turnContext?: CodexTurnContext
  ): AsyncGenerator<string, void, unknown> {
    const requestStartedAt = Date.now()
    const preparedCodexRequest = prepareCodexRequestForSend(codexRequest)
    const requestBody = JSON.stringify(preparedCodexRequest)
    const url = this.buildUrl(slot, "responses")
    const headers = this.buildHeaders(slot, token, true, {
      conversationId,
      omitAccountId,
      forwardHeaders,
      clientMetadata: this.getCodexRequestClientMetadata(codexRequest),
      useResponsesLite: this.usesResponsesLite(modelName),
    })
    this.applyCodexTurnStateHeader(headers, turnContext)

    this.logger.log(
      buildCodexDispatchLogLine({
        slotLabel: this.getAccountLabel(slot),
        modelName,
        transport: "http-stream",
        omitAccountId,
        accountId: this.getSlotAccountId(slot),
        workspaceId: slot.workspaceId,
        headers,
      })
    )
    this.logger.log(
      buildCodexHttpRequestLogLine({
        kind: "stream",
        modelName,
        url,
        codexRequest: preparedCodexRequest,
      })
    )
    this.logger.debug(
      `[Codex][HTTP Request][Payload] ${summarizeCodexRequestForLogs(preparedCodexRequest)}`
    )

    const requestSignal = createAbortSignalWithTimeout(600_000, abortSignal)
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
      signal: requestSignal.signal,
    }

    const dispatcher = this.buildProxyDispatcher(slot)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const state = createStreamState()
    let firstUpstreamMs: number | undefined
    let firstContentMs: number | undefined
    let firstContentType: string | undefined

    try {
      const response = await fetch(url, fetchOptions)

      if (!response.ok) {
        const errorBody = await response.text()
        this.logger.error(
          `[Codex] Stream request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
        )

        const failureAction = resolveCodexHttpErrorResponse(
          response.status,
          errorBody,
          {
            omitAccountId,
            isApiKeyMode: this.isApiKeyMode(slot),
          }
        )

        switch (failureAction.kind) {
          case "retry_http_without_account":
            this.logger.warn(
              `[Codex] deactivated_workspace for ${this.getAccountLabel(slot)}, retrying stream without Chatgpt-Account-Id`
            )
            yield* this.streamViaHttp(
              slot,
              token,
              codexRequest,
              modelName,
              reverseToolMap,
              cacheId,
              conversationId,
              true,
              forwardHeaders,
              abortSignal,
              turnContext
            )
            return
          case "throw_codex_api_error":
            throw createCodexApiErrorFromBody(
              failureAction.statusCode,
              failureAction.body
            )
        }
      }

      if (!response.body) {
        throw new Error("Codex response has no body")
      }

      // Capture rate-limit headers from successful response
      this.captureCodexRateLimitHeaders(
        response.headers,
        slot,
        modelName,
        "request"
      )
      this.captureCodexTurnStateFromHttpHeaders(turnContext, response.headers)

      // Stream SSE events
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      try {
        while (true) {
          const externalAbort = createAbortPromise(
            abortSignal,
            "Codex HTTP stream aborted"
          )
          try {
            const { done, value } = await Promise.race([
              reader.read(),
              ...(externalAbort.promise ? [externalAbort.promise] : []),
            ])
            if (done) break

            buffer += decoder.decode(value, { stream: true })

            const lines = buffer.split("\n")
            buffer = lines.pop() || ""

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) continue
              const payload = parseCodexSsePayload(trimmed)
              this.captureCodexTurnStateFromSsePayload(turnContext, payload)

              if (
                firstUpstreamMs === undefined &&
                typeof payload?.type === "string"
              ) {
                firstUpstreamMs = Date.now() - requestStartedAt
                this.logger.debug(
                  `[Codex] First upstream HTTP event after ${firstUpstreamMs}ms: type=${payload.type}`
                )
              }
              if (
                firstContentMs === undefined &&
                (payload?.type === "response.output_text.delta" ||
                  payload?.type === "response.reasoning_summary_text.delta" ||
                  payload?.type === "response.function_call_arguments.delta")
              ) {
                firstContentMs = Date.now() - requestStartedAt
                firstContentType = String(payload.type)
                this.logger.debug(
                  `[Codex] First content HTTP event after ${firstContentMs}ms: type=${firstContentType}`
                )
              }

              this.logCodexUsage(
                "http",
                modelName,
                cacheId,
                slot,
                payload,
                requestStartedAt
              )

              if (
                payload?.type === "response.output_item.done" &&
                payload.item &&
                typeof payload.item === "object"
              ) {
                yield `event: codex_response_item\ndata: ${JSON.stringify({
                  type: "codex_response_item",
                  item: payload.item,
                })}\n\n`
              }

              const claudeEvents = translateCodexSseEvent(
                trimmed,
                state,
                reverseToolMap
              )
              for (const event of claudeEvents) {
                yield event
              }
            }
          } finally {
            externalAbort.cleanup()
          }
        }

        // Process remaining buffer
        if (buffer.trim()) {
          const payload = parseCodexSsePayload(buffer.trim())
          this.captureCodexTurnStateFromSsePayload(turnContext, payload)
          if (
            firstUpstreamMs === undefined &&
            typeof payload?.type === "string"
          ) {
            firstUpstreamMs = Date.now() - requestStartedAt
            this.logger.debug(
              `[Codex] First upstream HTTP event after ${firstUpstreamMs}ms: type=${payload.type}`
            )
          }
          if (
            firstContentMs === undefined &&
            (payload?.type === "response.output_text.delta" ||
              payload?.type === "response.reasoning_summary_text.delta" ||
              payload?.type === "response.function_call_arguments.delta")
          ) {
            firstContentMs = Date.now() - requestStartedAt
            firstContentType = String(payload.type)
            this.logger.debug(
              `[Codex] First content HTTP event after ${firstContentMs}ms: type=${firstContentType}`
            )
          }
          this.logCodexUsage(
            "http",
            modelName,
            cacheId,
            slot,
            payload,
            requestStartedAt
          )
          if (
            payload?.type === "response.output_item.done" &&
            payload.item &&
            typeof payload.item === "object"
          ) {
            yield `event: codex_response_item\ndata: ${JSON.stringify({
              type: "codex_response_item",
              item: payload.item,
            })}\n\n`
          }
          const claudeEvents = translateCodexSseEvent(
            buffer.trim(),
            state,
            reverseToolMap
          )
          for (const event of claudeEvents) {
            yield event
          }
        }
      } finally {
        reader.releaseLock()
      }
    } catch (error) {
      if (requestSignal.didTimeout()) {
        throw new Error(
          "Codex stream timed out waiting for upstream response after 600000ms"
        )
      }
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "Codex HTTP stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }
      throw error
    } finally {
      requestSignal.cleanup()
    }

    this.logger.log(
      `[Codex] Stream completed: model=${modelName}, blocks=${state.blockIndex}, hasToolCall=${state.hasToolCall}`
    )
    const totalMs = Date.now() - requestStartedAt
    this.logger.log(
      `[Codex][TurnTiming] conv=${conversationId || "none"} ` +
        `transport=http model=${modelName} ` +
        `firstFrameMs=${firstUpstreamMs ?? -1} ` +
        `firstContentMs=${firstContentMs ?? -1} ` +
        `firstContentType=${firstContentType || "none"} ` +
        `totalMs=${totalMs} completed=true ` +
        `blocks=${state.blockIndex} hasToolCall=${state.hasToolCall} ` +
        `slot=${this.getAccountLabel(slot)}`
    )
  }

  /**
   * Stream via WebSocket transport.
   * Converts WebSocket JSON messages to SSE-formatted lines for the
   * existing response translator.
   */
  private async *streamViaWebSocket(
    slot: CodexAccountSlot,
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string,
    request: Pick<
      CodexExecutionRequest,
      "conversationId" | "model" | "pendingToolUseIds"
    >,
    forwardHeaders?: CodexForwardHeaders,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const requestStartedAt = Date.now()
    const httpUrl = this.buildUrl(slot, "responses")
    const wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
    const conversationId = this.getConversationId(request)
    const turnKey = this.getCodexTurnKey(codexRequest)
    // Use CodexTurnContext to obtain session ID (eliminates warm pool promotion)
    const turnContext = conversationId
      ? this.getOrCreateTurnContext(conversationId, slot, modelName, turnKey)
      : undefined
    const wsHeaders = this.wsService.buildWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      conversationId,
      this.getSlotAccountId(slot),
      slot.workspaceId,
      forwardHeaders,
      false,
      this.usesResponsesLite(modelName),
      this.getCodexRequestClientMetadata(codexRequest)
    )
    this.applyCodexTurnStateHeader(wsHeaders, turnContext)
    const sessionId = turnContext?.wsSessionId || ""
    if (!sessionId) {
      const ws = await this.wsService.connect(
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )
      this.captureCodexTurnStateFromConnection(turnContext, ws)
      yield* this.streamViaWebSocketConnection(
        ws,
        slot,
        modelName,
        reverseToolMap,
        cacheId,
        codexRequest,
        requestStartedAt,
        "",
        abortSignal,
        conversationId,
        forwardHeaders,
        turnContext
      )
      return
    }

    const { release } = await this.wsService.acquireSession(sessionId)
    try {
      // Check if the previous connection is still alive BEFORE ensureSessionConnection
      const sessionState = this.wsService.getOrCreateSession(sessionId)
      const hadOpenConnection =
        !!sessionState.conn &&
        sessionState.wsUrl === wsUrl &&
        sessionState.conn.readyState === 1 // WebSocket.OPEN

      let ws = await this.wsService.ensureSessionConnection(
        sessionId,
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )
      this.captureCodexTurnStateFromConnection(turnContext, ws)

      if (!hadOpenConnection) {
        this.recordTurnContextTransportReconnect(
          conversationId,
          slot,
          modelName,
          "WebSocket connection rebuilt before request"
        )
      }

      const originalCodexRequest = codexRequest
      if (turnContext && conversationId) {
        codexRequest = this.prepareRequestWithTurnContext(
          codexRequest,
          turnContext,
          conversationId
        )
      }

      try {
        this.logger.log(
          buildCodexDispatchLogLine({
            slotLabel: this.getAccountLabel(slot),
            modelName,
            transport: "websocket-stream",
            omitAccountId: false,
            accountId: this.getSlotAccountId(slot),
            workspaceId: slot.workspaceId,
            headers: wsHeaders,
          })
        )
        this.logger.log(
          `[Codex] WebSocket stream request: model=${modelName}, url=${wsUrl}`
        )
        this.logger.debug(
          `[Codex][WS Request][Payload] ${summarizeCodexRequestForLogs(
            this.wsService.buildWebSocketRequestBody(
              prepareCodexRequestForSend(codexRequest),
              {
                useResponsesLite: this.usesResponsesLite(modelName),
                forwardHeaders,
                turnState: turnContext?.turnState,
              }
            )
          )}`
        )

        yield* this.streamViaWebSocketConnection(
          ws,
          slot,
          modelName,
          reverseToolMap,
          cacheId,
          codexRequest,
          requestStartedAt,
          sessionId,
          abortSignal,
          conversationId,
          forwardHeaders,
          turnContext
        )
        return
      } catch (error) {
        // Handle "Previous response with id ... not found" — the server evicted
        // the response from its cache. Clear turn context and retry with the full
        // input (no previous_response_id). This commonly happens when parallel
        // tool calls take long enough for the server-side session to expire.
        if (
          shouldReplayCodexRequestWithoutPreviousResponseId(error, {
            conversationId,
            currentRequest: codexRequest,
            originalRequest: originalCodexRequest,
          })
        ) {
          this.logger.warn(
            `[Codex] Previous response_id rejected by server for ${conversationId}, ` +
              `retrying without previous_response_id (full input)`
          )
          this.beginFullCodexResponseChain(
            turnContext,
            conversationId,
            originalCodexRequest,
            "Server rejected stale previous_response_id"
          )
          codexRequest = originalCodexRequest
          // 协议级错误：若 ws 仍 OPEN，streamViaSessionWebSocket 已通过
          // preserveConnection 保留它，直接复用，跳过 invalidate+ensure 的额外 RTT。
          const wsStillUsable = ws.readyState === WebSocket.OPEN
          if (wsStillUsable) {
            this.logger.debug(
              `[Codex][TurnContext] Reusing live WebSocket session=${sessionId} after prev_resp rejection`
            )
          } else {
            this.wsService.invalidateSessionConnection(
              sessionId,
              ws,
              "previous_response_rejected_stream_retry"
            )
            this.applyCodexTurnStateHeader(wsHeaders, turnContext)
            ws = await this.wsService.ensureSessionConnection(
              sessionId,
              wsUrl,
              wsHeaders,
              slot.proxyUrl || undefined
            )
            this.captureCodexTurnStateFromConnection(turnContext, ws)
          }
          yield* this.streamViaWebSocketConnection(
            ws,
            slot,
            modelName,
            reverseToolMap,
            cacheId,
            codexRequest,
            Date.now(),
            sessionId,
            abortSignal,
            conversationId,
            forwardHeaders,
            turnContext
          )
          return
        }

        // Transport retries are owned by executeStreamWithCooldownRetry so the
        // retry budget, continuation reset, and HTTPS fallback are applied once
        // at the request level.
        throw error
      }
    } finally {
      release()
    }
  }

  private async *streamViaWebSocketConnection(
    ws: WebSocket,
    slot: CodexAccountSlot,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string,
    codexRequest: Record<string, unknown>,
    requestStartedAt: number,
    sessionId: string,
    abortSignal?: AbortSignal,
    conversationId?: string,
    forwardHeaders?: CodexForwardHeaders,
    turnContext?: CodexTurnContext
  ): AsyncGenerator<string, void, unknown> {
    const state = createStreamState()
    const itemsAdded: CodexInputItem[] = []
    let firstUpstreamMs: number | undefined
    let firstContentMs: number | undefined
    let firstContentType: string | undefined
    let responseCompleted = false
    let abortListenerAttached = false
    const onAbort = () => {
      if (responseCompleted) {
        this.logger.debug(
          `[Codex][WS] Ignored abort after response.completed for session=${sessionId || "standalone"} conversation=${conversationId || "none"}`
        )
        return
      }

      if (sessionId) {
        this.wsService.invalidateSessionConnection(
          sessionId,
          ws,
          "abort_signal"
        )
      } else {
        ws.close()
      }
    }

    try {
      if (abortSignal?.aborted) {
        throw new UpstreamRequestAbortedError(
          abortSignal.reason instanceof Error
            ? abortSignal.reason.message
            : "Codex WebSocket stream aborted"
        )
      }

      if (abortSignal) {
        abortSignal.addEventListener("abort", onAbort, { once: true })
        abortListenerAttached = true
      }
      const wsBody = this.wsService.buildWebSocketRequestBody(
        prepareCodexRequestForSend(codexRequest),
        {
          useResponsesLite: this.usesResponsesLite(modelName),
          forwardHeaders,
          streamRequestStartMs: Date.now(),
          turnState: turnContext?.turnState,
        }
      )

      for await (const msg of this.wsService.streamViaWebSocket(ws, wsBody)) {
        this.captureCodexTurnStateFromSsePayload(
          turnContext,
          msg as Record<string, unknown>
        )

        if (msg.type === "response.output_item.done") {
          const item = (msg as Record<string, unknown>).item as
            | Record<string, unknown>
            | undefined
          appendCodexResponseOutputItemToLedger(itemsAdded, item)
          if (item && typeof item === "object") {
            yield `event: codex_response_item\ndata: ${JSON.stringify({
              type: "codex_response_item",
              item,
            })}\n\n`
          }
        }

        if (msg.type === "response.completed") {
          responseCompleted = true
          if (abortSignal && abortListenerAttached) {
            abortSignal.removeEventListener("abort", onAbort)
            abortListenerAttached = false
          }
          // Mirrors map_response_stream() ResponseEvent::Completed → LastResponse.
          if (conversationId && sessionId) {
            const capturedId = getCodexCompletedResponseId(
              msg as Record<string, unknown>
            )
            if (capturedId) {
              this.captureResponseInTurnContext(
                conversationId,
                capturedId,
                itemsAdded
              )
            }
          }
        }
        if (firstUpstreamMs === undefined && msg.type) {
          firstUpstreamMs = Date.now() - requestStartedAt
          this.logger.debug(
            `[Codex] First upstream WebSocket event after ${firstUpstreamMs}ms: type=${msg.type}`
          )
        }
        if (
          firstContentMs === undefined &&
          (msg.type === "response.output_text.delta" ||
            msg.type === "response.reasoning_summary_text.delta" ||
            msg.type === "response.function_call_arguments.delta")
        ) {
          firstContentMs = Date.now() - requestStartedAt
          firstContentType = msg.type
          this.logger.debug(
            `[Codex] First content WebSocket event after ${firstContentMs}ms: type=${msg.type}`
          )
        }
        this.logCodexUsage(
          "websocket",
          modelName,
          cacheId,
          slot,
          msg as Record<string, unknown>,
          requestStartedAt
        )

        // Convert WebSocket message to SSE line for the translator
        const sseLine = `data: ${JSON.stringify(msg)}`
        const claudeEvents = translateCodexSseEvent(
          sseLine,
          state,
          reverseToolMap
        )
        for (const event of claudeEvents) {
          yield event
        }
      }

      if (abortSignal?.aborted) {
        throw new UpstreamRequestAbortedError(
          abortSignal.reason instanceof Error
            ? abortSignal.reason.message
            : "Codex WebSocket stream aborted"
        )
      }
    } finally {
      if (abortSignal && abortListenerAttached) {
        abortSignal.removeEventListener("abort", onAbort)
        abortListenerAttached = false
      }
      if (sessionId) {
        if (!responseCompleted) {
          this.wsService.invalidateSessionConnection(
            sessionId,
            ws,
            "stream_finally_incomplete"
          )
        }
      } else {
        ws.close()
      }
    }

    const totalMs = Date.now() - requestStartedAt
    // 结构化 turn timing：grep '[Codex][TurnTiming]' 即可拉出每个 turn 的耗时分布
    this.logger.log(
      `[Codex][TurnTiming] conv=${conversationId || "none"} ` +
        `transport=ws model=${modelName} ` +
        `firstFrameMs=${firstUpstreamMs ?? -1} ` +
        `firstContentMs=${firstContentMs ?? -1} ` +
        `firstContentType=${firstContentType || "none"} ` +
        `totalMs=${totalMs} ` +
        `completed=${responseCompleted} ` +
        `blocks=${state.blockIndex} hasToolCall=${state.hasToolCall} ` +
        `slot=${this.getAccountLabel(slot)}`
    )
  }

  // ── Rate Limit Header Parsing ───────────────────────────────────────

  /**
   * Parse x-codex-* rate limit headers from Codex API responses.
   * Headers follow the pattern:
   *   x-codex-primary-used-percent / x-codex-primary-window-minutes / x-codex-primary-reset-at
   *   x-codex-secondary-used-percent / x-codex-secondary-window-minutes / x-codex-secondary-reset-at
   */
  private captureCodexRateLimitHeaders(
    headers: Headers,
    slot: CodexAccountSlot,
    modelName: string,
    source: CodexRateLimitSource
  ): void {
    try {
      const { primary, secondary } = parseCodexRateLimitHeaders(headers)

      if (!primary && !secondary) {
        return
      }

      const normalizedModel = this.normalizeCodexModelName(modelName)
      const snapshot: CodexRateLimitSnapshot = {
        model: normalizedModel,
        displayModel: this.getCodexDisplayModel(normalizedModel),
        source,
        updatedAt: Date.now(),
      }
      if (primary) {
        snapshot.primary = primary
      }
      if (secondary) {
        snapshot.secondary = secondary
      }

      this.setRateLimitSnapshot(slot, snapshot)

      const label = this.getAccountLabel(slot)
      const parts: string[] = []
      if (primary) {
        parts.push(formatCodexRateLimitWindow("primary", primary))
      }
      if (secondary) {
        parts.push(formatCodexRateLimitWindow("secondary", secondary))
      }
      const sourceLabel = source === "request" ? "live" : "healthcheck"
      const message = `[Codex][RateLimit] ${label}: model=${normalizedModel}, source=${sourceLabel}, ${parts.join(", ")}`
      if (
        source === "request" ||
        (source === "probe" &&
          normalizedModel === DEFAULT_CODEX_RATE_LIMIT_MODEL)
      ) {
        this.logger.log(message)
      } else {
        this.logger.debug(message)
      }
    } catch {
      // Non-critical: silently ignore parse failures
    }
  }

  // ── Availability ─────────────────────────────────────────────────────

  /**
   * Check if the Codex backend is reachable.
   */
  checkAvailability(): Promise<boolean> {
    return Promise.resolve(this.isAvailable())
  }

  // ── Rate Limit Probing ────────────────────────────────────────────────

  /**
   * Probe rate limits for accounts.
   * When force=false (default), only probes accounts without existing data.
   * When force=true, re-probes all non-disabled accounts to refresh data.
   *
   * Sends a lightweight completions request with max_output_tokens=1 and
   * immediately aborts the stream to capture x-codex-* rate limit headers.
   */
  async probeRateLimits(force = false): Promise<number> {
    if (this.rateLimitProbePromise) {
      return this.rateLimitProbePromise
    }

    this.rateLimitProbePromise = this.runRateLimitProbe(force)
    try {
      return await this.rateLimitProbePromise
    } finally {
      this.rateLimitProbePromise = null
    }
  }

  private async runRateLimitProbe(force = false): Promise<number> {
    const supportedModels = new Set(
      getCodexModelIdsForTier(this.getModelTier())
    )
    const probeModels = supportedModels.has(DEFAULT_CODEX_RATE_LIMIT_MODEL)
      ? [DEFAULT_CODEX_RATE_LIMIT_MODEL]
      : Array.from(supportedModels)
    const slotsToProbe = this.accounts.filter(
      (slot) =>
        (force || !this.hasRateLimitData(slot)) && !isAccountDisabled(slot)
    )

    if (slotsToProbe.length === 0) {
      return 0
    }

    this.logger.log(
      `[Codex] Probing rate limits for ${slotsToProbe.length} account(s) across ${probeModels.length} model(s)...`
    )

    let probed = 0

    // Probe sequentially to avoid parallel token refresh races
    for (const slot of slotsToProbe) {
      if (!force && this.activeLiveRequests > 0) {
        this.logger.log(
          "[Codex] Rate limit probe paused while live requests are active"
        )
        break
      }

      const label = this.getAccountLabel(slot)
      try {
        let token = await this.getBearerToken(slot)
        if (!token) {
          this.logger.warn(
            `[Codex] Probe skipped for ${label}: no bearer token`
          )
          continue
        }

        // Send the smallest valid streaming responses request we can. The
        // ChatGPT Codex backend rejects max_output_tokens on this endpoint, but
        // it still returns x-codex-* headers on the initial 200 response.
        // Abort immediately after headers are captured to avoid spending quota.
        const dispatcher = this.buildProxyDispatcher(slot)

        const doProbe = async (
          bearerToken: string,
          probeModel: string
        ): Promise<Response> => {
          const abortController = new AbortController()
          this.activeRateLimitProbeAbortController = abortController
          const timeout = setTimeout(() => abortController.abort(), 15_000)
          try {
            const url = this.buildUrl(slot, "responses")
            const headers = this.buildHeaders(slot, bearerToken, true)
            const fetchOptions: RequestInit & { dispatcher?: unknown } = {
              method: "POST",
              headers,
              body: JSON.stringify({
                model: probeModel,
                instructions: "",
                input: [
                  {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "." }],
                  },
                ],
                stream: true,
                store: false,
                parallel_tool_calls: false,
                reasoning: { effort: "low", summary: "auto" },
              }),
              signal: abortController.signal,
            }
            if (dispatcher) {
              fetchOptions.dispatcher = dispatcher
            }
            const resp = await fetch(url, fetchOptions)
            // Capture rate limit headers BEFORE aborting the stream
            this.captureCodexRateLimitHeaders(
              resp.headers,
              slot,
              probeModel,
              "probe"
            )
            // Now abort the stream to avoid generating output
            abortController.abort()
            return resp
          } finally {
            clearTimeout(timeout)
            if (this.activeRateLimitProbeAbortController === abortController) {
              this.activeRateLimitProbeAbortController = null
            }
          }
        }

        for (const probeModel of probeModels) {
          const response = await doProbe(token, probeModel)

          // 401/403: 复用 tryRefreshSlotToken 统一 refresh 逻辑（含旋转竞态保护）
          if (response.status === 401 || response.status === 403) {
            const refreshedToken = await this.tryRefreshSlotToken(
              slot,
              `Probe ${label} HTTP ${response.status}`
            )
            if (refreshedToken) {
              token = refreshedToken
              await doProbe(token, probeModel)
            }
          }

          const summary = this.getRateLimitModelSummary(slot, probeModel)
          if (summary?.probe) {
            this.logger.log(
              `[Codex] Probe ${label}: rate limits captured for model=${probeModel}`
            )
          } else {
            this.logger.warn(
              `[Codex] Probe ${label}: no x-codex-* headers in response for model=${probeModel} (HTTP ${response.status})`
            )
          }
        }
        probed++
      } catch (err) {
        if (
          !force &&
          this.activeLiveRequests > 0 &&
          err instanceof Error &&
          err.name === "AbortError"
        ) {
          this.logger.log(
            "[Codex] Rate limit probe aborted to prioritize a live request"
          )
          break
        }
        this.logger.warn(
          `[Codex] Rate limit probe failed for ${label}: ${(err as Error).message}`
        )
      }
    }

    this.logger.log(`[Codex] Rate limit probe completed: ${probed} account(s)`)
    return probed
  }
}
