/**
 * Codex prompt-cache body writer.
 *
 * The upstream Codex cache namespace is the native Responses session id.
 * This service intentionally has no user, account, API-key, OAuth, model,
 * or bridge-local fallback namespace.
 */
import { Injectable } from "@nestjs/common"
import { resolveCodexPromptCacheKey } from "./codex-cache-identity-policy"
import {
  assertCodexProviderIdentity,
  type CodexProviderIdentity,
} from "./codex-provider-identity"

@Injectable()
export class CodexCacheService {
  injectSessionCacheKey(
    body: Record<string, unknown>,
    upstreamIdentity: CodexProviderIdentity
  ): Record<string, unknown> {
    assertCodexProviderIdentity(upstreamIdentity)
    return {
      ...body,
      prompt_cache_key: resolveCodexPromptCacheKey(upstreamIdentity.sessionId),
    }
  }
}
