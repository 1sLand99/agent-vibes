import { ForbiddenException, UnauthorizedException } from "@nestjs/common"
import type { FastifyRequest } from "fastify"
import { timingSafeEqual } from "node:crypto"

export function isLoopbackControlAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.split("%")[0]!.toLowerCase()
  if (normalized === "::1") return true
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackControlAddress(normalized.slice("::ffff:".length))
  }
  return normalized.startsWith("127.")
}

export function parseControlBearerToken(
  authorization: string | undefined
): string | null {
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization?.trim() ?? "")
  return match?.[1] ?? null
}

function controlTokensMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  )
}

/**
 * Enforce the shared contract for every /api/agent-input control endpoint:
 * the request must originate from loopback and carry the bearer token the
 * bridge was installed with. Returns the validated control token on success.
 */
export function requireAgentInputControlAccess(
  request: FastifyRequest,
  authorization: string | undefined
): string {
  if (!isLoopbackControlAddress(request.ip)) {
    throw new ForbiddenException("agent input control is loopback-only")
  }
  const controlToken = parseControlBearerToken(authorization)
  const expectedControlToken =
    process.env.AGENT_VIBES_AGENT_INPUT_CONTROL_TOKEN?.trim()
  if (
    !controlToken ||
    !expectedControlToken ||
    !controlTokensMatch(controlToken, expectedControlToken)
  ) {
    throw new UnauthorizedException("invalid agent input control token")
  }
  return controlToken
}
