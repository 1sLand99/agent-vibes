import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
interface RequestWithHeaders {
  headers: {
    "x-api-key"?: string
    "x-goog-api-key"?: string
    authorization?: string
  }
  query?: Record<string, unknown>
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithHeaders>()
    const expectedKey = this.configService.get<string>("PROXY_API_KEY")

    // If no API key configured, allow all requests (for local development)
    if (!expectedKey) {
      return true
    }

    // Check x-api-key header (Anthropic style)
    const xApiKey = request.headers["x-api-key"]
    if (xApiKey && xApiKey === expectedKey) {
      return true
    }

    // Check x-goog-api-key header / key query param (Google SDK style)
    const googleApiKey = request.headers["x-goog-api-key"]
    if (googleApiKey && googleApiKey === expectedKey) {
      return true
    }
    const queryKey = request.query?.key
    if (typeof queryKey === "string" && queryKey === expectedKey) {
      return true
    }

    // Check Authorization header (Bearer token scheme)
    const authHeader = request.headers["authorization"]
    if (authHeader) {
      const bearerToken = authHeader.replace(/^Bearer\s+/i, "")
      if (bearerToken === expectedKey) {
        return true
      }
    }

    throw new UnauthorizedException("Invalid API key")
  }
}
