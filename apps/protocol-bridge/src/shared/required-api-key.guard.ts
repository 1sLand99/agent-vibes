import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { ApiKeyGuard } from "./api-key.guard"

/**
 * Protects credential-backed endpoints that must never become anonymous when
 * PROXY_API_KEY is absent. General bridge routes keep their existing local
 * development behavior through ApiKeyGuard.
 *
 * Guards several route families (Realtime voice, ChatGPT Web), so the refusal
 * names the endpoint the caller actually asked for rather than any one of
 * them.
 */
@Injectable()
export class RequiredApiKeyGuard extends ApiKeyGuard implements CanActivate {
  constructor(private readonly requiredConfig: ConfigService) {
    super(requiredConfig)
  }

  override canActivate(context: ExecutionContext): boolean {
    if (!this.requiredConfig.get<string>("PROXY_API_KEY")?.trim()) {
      const path = context.switchToHttp().getRequest<{ url?: string }>()?.url
      throw new ServiceUnavailableException(
        `${path ? `${path.split("?")[0]} ` : "This endpoint "}` +
          `spends a connected account's quota and requires PROXY_API_KEY ` +
          `to be configured`
      )
    }
    return super.canActivate(context)
  }
}
