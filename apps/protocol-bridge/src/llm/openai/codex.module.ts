import { Module } from "@nestjs/common"
import { UsageStatsModule } from "../../usage"
import { CodexAuthService } from "./codex-auth.service"
import { CodexCacheService } from "./codex-cache.service"
import { CodexClientIdentityService } from "./codex-client-identity.service"
import { CodexWebSocketService } from "./codex-websocket.service"
import { CodexService } from "./codex.service"
import { ChatGptWebRealtimeService } from "./chatgpt-web-realtime.service"
import { ChatGptWebVoiceTransport } from "./chatgpt-web-transport"

@Module({
  imports: [UsageStatsModule],
  providers: [
    CodexAuthService,
    CodexCacheService,
    CodexClientIdentityService,
    CodexWebSocketService,
    CodexService,
    ChatGptWebVoiceTransport,
    ChatGptWebRealtimeService,
  ],
  exports: [
    CodexAuthService,
    CodexCacheService,
    CodexClientIdentityService,
    CodexWebSocketService,
    CodexService,
    ChatGptWebRealtimeService,
  ],
})
export class CodexModule {}
