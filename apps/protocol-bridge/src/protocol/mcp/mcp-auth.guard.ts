import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "node:crypto"

/**
 * Auth for the MCP endpoint.
 *
 * This route is the one part of the bridge designed to be reachable from the
 * open internet — OpenAI's connector fetcher calls it directly — so it is
 * deliberately stricter than ApiKeyGuard:
 *
 *   - Its own secret (MCP_API_KEY), never PROXY_API_KEY. Compromising the
 *     proxy key must not hand an attacker the MCP surface, and vice versa.
 *   - Unset secret means 503, never anonymous access. A misconfigured deploy
 *     fails closed.
 *   - Header only. ApiKeyGuard also accepts `?key=`, which would write the
 *     secret into access logs, referrers and proxy traces.
 *   - Constant-time comparison, so a network attacker cannot recover the
 *     secret byte-by-byte from response timing.
 *
 * Note that authentication is the outer layer, not the safety property: the
 * endpoint owns no tools of its own, so even a full auth bypass yields no
 * ability to touch the workspace. See McpService.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  private readonly logger = new Logger(McpAuthGuard.name)

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>("MCP_API_KEY")?.trim()
    if (!expected) {
      throw new ServiceUnavailableException(
        "The MCP endpoint requires MCP_API_KEY to be configured"
      )
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>
      ip?: string
    }>()

    if (!presentedSecret(request.headers, expected)) {
      // Log that a rejection happened, never what was presented.
      this.logger.warn(`MCP auth rejected (${request.ip || "unknown peer"})`)
      throw new UnauthorizedException("Invalid MCP credential")
    }
    return true
  }
}

/** True when any accepted header carries exactly the expected secret. */
function presentedSecret(
  headers: Record<string, string | string[] | undefined>,
  expected: string
): boolean {
  const read = (name: string): string => {
    const value = headers[name]
    return (Array.isArray(value) ? value[0] : value) || ""
  }

  const candidates = [
    read("authorization").replace(/^Bearer\s+/i, ""),
    read("x-api-key"),
  ]
  // Evaluate every candidate rather than short-circuiting: the comparison is
  // constant-time, and returning early on the first match would leak which
  // header was accepted through timing.
  let matched = false
  for (const candidate of candidates) {
    if (timingSafeEqual(candidate, expected)) matched = true
  }
  return matched
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  // timingSafeEqual throws on length mismatch, which would itself be a timing
  // signal, so compare digests of fixed width instead.
  const leftDigest = crypto.createHash("sha256").update(left).digest()
  const rightDigest = crypto.createHash("sha256").update(right).digest()
  return crypto.timingSafeEqual(leftDigest, rightDigest)
}
