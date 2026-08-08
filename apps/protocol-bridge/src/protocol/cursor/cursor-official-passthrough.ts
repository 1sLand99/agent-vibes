import { Logger } from "@nestjs/common"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import * as dns from "dns"
import * as https from "https"
import type { IncomingMessage } from "http"
import type { LookupFunction } from "net"

const DEFAULT_OFFICIAL_API_BASE_URL = "https://api2.cursor.sh"
const DEFAULT_OFFICIAL_AGENT_BASE_URL = "https://agentn.api5.cursor.sh"
const DNS_CACHE_TTL_MS = 60_000

// Local allowlist is the core Composer/AgentService surface only.
// AgentHostService (Agents Window / Glass) must remain absent so
// agent.v1.AgentHost* RPCs keep falling through to official passthrough.
const LOCAL_CURSOR_RPC_PATHS = new Set<string>([
  "agent.v1.AgentService/Run",
  "agent.v1.AgentService/NameAgent",
  "agent.v1.AgentService/UpdateConversationMetadata",
  "agent.v1.AgentService/UploadConversationBlobs",
  "agent.v1.AgentService/GetUsableModels",
  "agent.v1.AgentService/GetAllowedModelIntents",
  "agent.v1.AgentService/GetNewChatNudgeLegacyModelPicker",
  "agent.v1.AgentService/GetNewChatNudgeParameterizedModelPicker",
  "aiserver.v1.AiService/RunGenerateImage",
  "aiserver.v1.AiService/AvailableModels",
  "aiserver.v1.AiService/GetDefaultModelNudgeData",
  "aiserver.v1.AiService/CheckFeatureStatus",
  "aiserver.v1.AiService/GetFeatureStatuses",
  "aiserver.v1.AiService/GetServerConfig",
  "aiserver.v1.AiService/GetDefaultModel",
  "aiserver.v1.AiService/GetLastDefaultModelNudge",
  "aiserver.v1.AiService/GetUsableModels",
  "aiserver.v1.AiService/GetDefaultModelForCli",
  "aiserver.v1.AiService/NameTab",
  "aiserver.v1.AiService/CheckQueuePosition",
  "aiserver.v1.AiService/GetModelLabels",
  "aiserver.v1.AiService/TestBidi",
  "aiserver.v1.AiService/KnowledgeBaseAdd",
  "aiserver.v1.AiService/KnowledgeBaseList",
  "aiserver.v1.AiService/KnowledgeBaseUpdate",
  "aiserver.v1.AiService/KnowledgeBaseRemove",
  "aiserver.v1.AnalyticsService/BootstrapStatsig",
  "aiserver.v1.ServerConfigService/GetServerConfig",
  "aiserver.v1.BackgroundComposerService/ListBackgroundComposers",
  "aiserver.v1.BackgroundComposerService/ListPersonalEnvironments",
  "aiserver.v1.BackgroundComposerService/ListTeamEnvironments",
  "aiserver.v1.NetworkService/IsConnected",
])

const LOCAL_CURSOR_AUTH_PATHS = new Set<string>(["auth/full_stripe_profile"])

const HOP_BY_HOP_HEADERS = new Set<string>([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

const REWRITTEN_REQUEST_HEADERS = new Set<string>([
  "host",
  "content-length",
  "content-encoding",
  "connect-content-encoding",
])

type DnsCacheEntry = {
  address: string
  family: 4 | 6
  expiresAt: number
}

type OfficialLookupCallback = (
  error: NodeJS.ErrnoException | null,
  addressOrAddresses: string | Array<{ address: string; family: 4 | 6 }>,
  family?: 4 | 6
) => void

export type CursorOfficialPassthroughTarget = {
  baseUrl: string
  normalizedPath: string
  family: "api" | "agent"
}

export type CursorOfficialPassthroughFailureDisposition =
  | "client_cancelled"
  | "replyable_upstream_failure"
  | "unreplyable_upstream_failure"

export function classifyCursorOfficialPassthroughFailure(input: {
  readonly clientAbortSignaled: boolean
  readonly replySent: boolean
  readonly replyDestroyed: boolean
}): CursorOfficialPassthroughFailureDisposition {
  if (input.clientAbortSignaled) return "client_cancelled"
  if (input.replySent || input.replyDestroyed) {
    return "unreplyable_upstream_failure"
  }
  return "replyable_upstream_failure"
}

const dnsCache = new Map<string, DnsCacheEntry>()

export function isCursorOfficialPassthroughEnabled(): boolean {
  const raw = (process.env.CURSOR_OFFICIAL_PASSTHROUGH || "").toLowerCase()
  return !["0", "false", "off", "no"].includes(raw)
}

export function getCursorOfficialPassthroughTarget(
  requestUrl: string,
  method: string
): CursorOfficialPassthroughTarget | null {
  if (!["GET", "HEAD", "POST"].includes(method.toUpperCase())) {
    return null
  }

  const url = new URL(requestUrl, "https://localhost")
  const normalizedPath = url.pathname.replace(/^\/+/u, "")
  if (!normalizedPath) {
    return null
  }

  if (LOCAL_CURSOR_RPC_PATHS.has(normalizedPath)) {
    return null
  }

  if (LOCAL_CURSOR_AUTH_PATHS.has(normalizedPath)) {
    return null
  }

  if (normalizedPath.startsWith("aiserver.v1.")) {
    return {
      baseUrl:
        process.env.CURSOR_OFFICIAL_API_BASE_URL ||
        DEFAULT_OFFICIAL_API_BASE_URL,
      normalizedPath,
      family: "api",
    }
  }

  if (normalizedPath.startsWith("agent.v1.")) {
    return {
      baseUrl:
        process.env.CURSOR_OFFICIAL_AGENT_BASE_URL ||
        DEFAULT_OFFICIAL_AGENT_BASE_URL,
      normalizedPath,
      family: "agent",
    }
  }

  if (isOfficialCursorBackendAuthPath(normalizedPath)) {
    return {
      baseUrl:
        process.env.CURSOR_OFFICIAL_API_BASE_URL ||
        DEFAULT_OFFICIAL_API_BASE_URL,
      normalizedPath,
      family: "api",
    }
  }

  return null
}

function isOfficialCursorBackendAuthPath(normalizedPath: string): boolean {
  return normalizedPath === "auth" || normalizedPath.startsWith("auth/")
}

export function registerCursorOfficialPassthroughHook(
  fastify: FastifyInstance,
  logger: Logger
): void {
  fastify.addHook("preHandler", async (request, reply) => {
    if (!isCursorOfficialPassthroughEnabled()) {
      return
    }

    const target = getCursorOfficialPassthroughTarget(
      request.url,
      request.method
    )
    if (!target) {
      return
    }

    await proxyCursorOfficialRequest(request, reply, target, logger)
  })

  fastify.route({
    method: ["GET", "HEAD", "POST"],
    url: "/*",
    handler: async (request, reply) => {
      if (isCursorOfficialPassthroughEnabled()) {
        const target = getCursorOfficialPassthroughTarget(
          request.url,
          request.method
        )
        if (target) {
          await proxyCursorOfficialRequest(request, reply, target, logger)
          return
        }
      }

      reply.status(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: "Not Found",
        statusCode: 404,
      })
    },
  })
}

function buildUpstreamUrl(
  requestUrl: string,
  target: CursorOfficialPassthroughTarget
): URL {
  const incomingUrl = new URL(requestUrl, "https://localhost")
  const upstreamUrl = new URL(target.baseUrl)
  const basePath = upstreamUrl.pathname.replace(/\/+$/u, "")
  upstreamUrl.pathname = `${basePath}/${target.normalizedPath}`.replace(
    /\/+/gu,
    "/"
  )
  upstreamUrl.search = incomingUrl.search
  return upstreamUrl
}

function getRequestBodyBuffer(req: FastifyRequest): Buffer | null {
  if (["GET", "HEAD"].includes(req.method.toUpperCase())) {
    return null
  }

  const body = req.body
  if (body === undefined || body === null) {
    return Buffer.alloc(0)
  }
  if (Buffer.isBuffer(body)) {
    return body
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body)
  }
  if (typeof body === "string") {
    return Buffer.from(body)
  }

  return Buffer.from(JSON.stringify(body))
}

function sanitizeRequestHeaders(
  req: FastifyRequest,
  upstreamUrl: URL,
  body: Buffer | null
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}

  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (
      lower.startsWith(":") ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      REWRITTEN_REQUEST_HEADERS.has(lower)
    ) {
      continue
    }

    if (value === undefined) {
      continue
    }
    if (Array.isArray(value)) {
      headers[key] = value.map((entry) => String(entry))
    } else {
      headers[key] = String(value)
    }
  }

  headers.host = upstreamUrl.host
  if (body !== null) {
    headers["content-length"] = String(body.length)
  }

  return headers
}

function shouldStripResponseHeader(header: string): boolean {
  const lower = header.toLowerCase()
  return lower.startsWith(":") || HOP_BY_HOP_HEADERS.has(lower)
}

async function proxyCursorOfficialRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  target: CursorOfficialPassthroughTarget,
  logger: Logger
): Promise<void> {
  const upstreamUrl = buildUpstreamUrl(req.url, target)
  const body = getRequestBodyBuffer(req)
  const headers = sanitizeRequestHeaders(req, upstreamUrl, body)
  const abortController = new AbortController()
  const abortUpstream = () => abortController.abort()
  const cleanupClientAbortListeners = () => {
    req.raw.removeListener("aborted", abortUpstream)
    reply.raw.removeListener("close", abortUpstream)
  }
  req.raw.once("aborted", abortUpstream)
  reply.raw.once("close", abortUpstream)

  try {
    const upstreamResponse = await openOfficialRequest(
      upstreamUrl,
      req.method,
      headers,
      body,
      abortController.signal
    )
    upstreamResponse.once("close", cleanupClientAbortListeners)

    for (const [header, value] of Object.entries(upstreamResponse.headers)) {
      if (value === undefined || shouldStripResponseHeader(header)) {
        continue
      }
      reply.header(header, value)
    }

    // Send the IncomingMessage itself so Connect streaming RPCs retain their
    // chunk boundaries and backpressure. Buffering the complete body would
    // turn endpoints such as StreamAiCursorHelp into pseudo-unary calls and
    // can trip Cursor's stream liveness deadline.
    reply.status(upstreamResponse.statusCode || 502).send(upstreamResponse)
  } catch (error) {
    cleanupClientAbortListeners()
    const detail = error instanceof Error ? error.message : String(error)
    const disposition = classifyCursorOfficialPassthroughFailure({
      clientAbortSignaled: abortController.signal.aborted,
      replySent: reply.sent,
      replyDestroyed: reply.raw.destroyed,
    })
    if (disposition === "client_cancelled") {
      logger.debug(
        `Cursor official passthrough cancelled by client for ${target.normalizedPath} (${target.family})`
      )
      return
    }
    logger.warn(
      `Cursor official passthrough failed for ${target.normalizedPath} (${target.family}): ${detail}`
    )
    if (disposition === "replyable_upstream_failure") {
      reply.status(502).send({
        error: "cursor_official_passthrough_failed",
        message: detail,
      })
    }
  }
}

function openOfficialRequest(
  url: URL,
  method: string,
  headers: Record<string, string | string[]>,
  body: Buffer | null,
  signal: AbortSignal
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        servername: url.hostname,
        lookup: lookupOfficialCursorHost,
      },
      resolve
    )

    req.on("error", reject)
    const abort = () => {
      req.destroy(new Error(`client disconnected from ${url.hostname}`))
    }
    signal.addEventListener("abort", abort, { once: true })
    req.once("close", () => signal.removeEventListener("abort", abort))
    if (signal.aborted) {
      abort()
      return
    }

    if (body !== null && body.length > 0) {
      req.write(body)
    }
    req.end()
  })
}

const lookupOfficialCursorHost = ((
  hostname: string,
  optionsOrCallback: unknown,
  callback?: unknown
) => {
  const candidate =
    typeof optionsOrCallback === "function" ? optionsOrCallback : callback
  if (!isOfficialLookupCallback(candidate)) {
    return
  }
  const cb = candidate

  const family =
    typeof optionsOrCallback === "object" &&
    optionsOrCallback !== null &&
    "family" in optionsOrCallback &&
    typeof optionsOrCallback.family === "number"
      ? optionsOrCallback.family
      : 0
  const all =
    typeof optionsOrCallback === "object" &&
    optionsOrCallback !== null &&
    "all" in optionsOrCallback &&
    optionsOrCallback.all === true
  const cacheKey = `${hostname}:${family || 0}`
  const cached = dnsCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    if (all) {
      cb(null, [{ address: cached.address, family: cached.family }])
    } else {
      cb(null, cached.address, cached.family)
    }
    return
  }

  resolveOfficialCursorAddress(hostname, family === 6 ? 6 : 4)
    .then((entry) => {
      dnsCache.set(cacheKey, {
        ...entry,
        expiresAt: Date.now() + DNS_CACHE_TTL_MS,
      })
      if (all) {
        cb(null, [{ address: entry.address, family: entry.family }])
      } else {
        cb(null, entry.address, entry.family)
      }
    })
    .catch((error) => {
      if (all) {
        cb(error as NodeJS.ErrnoException, [])
      } else {
        cb(error as NodeJS.ErrnoException, "", 4)
      }
    })
}) as LookupFunction

function isOfficialLookupCallback(
  value: unknown
): value is OfficialLookupCallback {
  return typeof value === "function"
}

async function resolveOfficialCursorAddress(
  hostname: string,
  preferredFamily: 4 | 6
): Promise<{ address: string; family: 4 | 6 }> {
  const families: Array<4 | 6> = preferredFamily === 6 ? [6, 4] : [4, 6]

  for (const family of families) {
    try {
      const addresses =
        family === 4
          ? await dns.promises.resolve4(hostname)
          : await dns.promises.resolve6(hostname)
      const address = addresses[0]
      if (address) {
        return { address, family }
      }
    } catch {
      // Try the other family.
    }
  }

  throw new Error(`could not resolve official Cursor host ${hostname}`)
}
