import * as crypto from "node:crypto"
import { solveChatGptWebProofOfWork } from "./chatgpt-web-pow"

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

/** Re-run upstream's check against a produced token. */
function satisfies(token: string, seed: string, difficulty: string): boolean {
  const encoded = token.slice("gAAAAAB".length)
  const digest = crypto
    .createHash("sha3-512")
    .update(seed + encoded)
    .digest("hex")
  return digest.slice(0, difficulty.length) <= difficulty
}

describe("solveChatGptWebProofOfWork", () => {
  it("produces a token upstream's own comparison accepts", () => {
    const token = solveChatGptWebProofOfWork({
      seed: "0.03616087450245864",
      difficulty: "0747fe",
      userAgent: UA,
    })
    expect(token.startsWith("gAAAAAB")).toBe(true)
    expect(satisfies(token, "0.03616087450245864", "0747fe")).toBe(true)
  })

  it("solves the harder difficulties upstream has been observed to issue", () => {
    for (const difficulty of ["075ad8", "0747fe", "05"]) {
      const seed = `0.${crypto.randomInt(1e12)}`
      const token = solveChatGptWebProofOfWork({
        seed,
        difficulty,
        userAgent: UA,
      })
      expect(satisfies(token, seed, difficulty)).toBe(true)
    }
  })

  it("embeds a decodable browser-shaped config with the winning counter", () => {
    const token = solveChatGptWebProofOfWork({
      seed: "0.5",
      difficulty: "0f",
      userAgent: UA,
    })
    const config = JSON.parse(
      Buffer.from(token.slice("gAAAAAB".length), "base64").toString("utf8")
    ) as unknown[]
    expect(Array.isArray(config)).toBe(true)
    expect(config[4]).toBe(UA)
    expect(Number.isInteger(config[3])).toBe(true)
  })

  it("falls back to a well-formed token when the challenge is unusable", () => {
    // A missing seed/difficulty must not throw: the caller is mid-request and
    // upstream tolerates the documented fallback.
    const token = solveChatGptWebProofOfWork({
      seed: "",
      difficulty: "",
      userAgent: UA,
    })
    expect(token.startsWith("gAAAAAB")).toBe(true)
    expect(token.length).toBeGreaterThan("gAAAAAB".length)
  })
})
