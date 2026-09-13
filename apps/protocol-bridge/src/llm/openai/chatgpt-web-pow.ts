import * as crypto from "node:crypto"

/**
 * Sentinel proof-of-work for chatgpt.com's web chat endpoint.
 *
 * `POST /backend-api/sentinel/chat-requirements` answers with a seed and a
 * hex difficulty prefix. The client must find an integer `i` such that
 * `sha3-512(seed + base64(config_with_i))` starts with a hex prefix that
 * sorts at or below the difficulty, then send the winning base64 back as
 * `openai-sentinel-proof-token` prefixed with the literal "gAAAAAB".
 *
 * The config array mimics the browser's environment probe. Only slot 3 (the
 * counter) varies while searching; the remaining slots merely have to look
 * plausible, so they are derived once per solve.
 *
 * Observed difficulties sit around 6 hex digits, which resolves in well under
 * a millisecond — the search is bounded anyway so a difficulty spike degrades
 * to the documented fallback token rather than stalling a request.
 */

const MAX_ITERATIONS = 500_000

/** Matches the `Date.prototype.toString()` form the browser serialises. */
function browserTimestamp(now: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  const p = (n: number) => String(n).padStart(2, "0")
  return (
    `${days[now.getUTCDay()]} ${months[now.getUTCMonth()]} ` +
    `${p(now.getUTCDate())} ${now.getUTCFullYear()} ` +
    `${p(now.getUTCHours())}:${p(now.getUTCMinutes())}:${p(now.getUTCSeconds())} ` +
    `GMT+0000 (Coordinated Universal Time)`
  )
}

export interface ChatGptWebPowInput {
  readonly seed: string
  readonly difficulty: string
  readonly userAgent: string
}

export function solveChatGptWebProofOfWork(input: ChatGptWebPowInput): string {
  const { seed, difficulty, userAgent } = input
  if (!seed || !difficulty) return fallbackToken(seed)

  // Shape taken from a real browser payload rather than guessed: 25 slots,
  // with the counter at index 3. Upstream has accepted a shorter array so
  // far, but matching what the sentinel SDK actually sends is the difference
  // between working by luck and working by construction.
  const now = Date.now()
  const config: unknown[] = [
    3000,
    browserTimestamp(new Date(now)),
    4_395_630_592,
    0,
    userAgent,
    "https://chatgpt.com/backend-api/sentinel/sdk.js",
    "prod-e19e9dde1dc2f8240984b529c2e64925ead474f6",
    "en-US",
    "en-US,en",
    Math.random(),
    "appCodeName\u2212Mozilla",
    `_reactListening${crypto.randomBytes(6).toString("hex")}`,
    "webkitRequestFileSystem",
    1_000_000 + Math.floor(Math.random() * 1_000_000),
    crypto.randomUUID(),
    "",
    8,
    now,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]

  const width = difficulty.length
  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    config[3] = i
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
    const digest = crypto
      .createHash("sha3-512")
      .update(seed + encoded)
      .digest("hex")
    if (digest.slice(0, width) <= difficulty) return `gAAAAAB${encoded}`
  }

  return fallbackToken(seed)
}

/**
 * The token the web client emits when its own search gives up. Upstream
 * accepts it for a while before demanding a real solution, which keeps a
 * difficulty spike from turning into a hard failure.
 */
function fallbackToken(seed: string): string {
  return (
    "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" +
    Buffer.from(seed || crypto.randomUUID()).toString("base64")
  )
}
