import { Module } from "@nestjs/common"
import { UsageStatsModule } from "../../usage"
import { CodexAuthService } from "./codex-auth.service"
import { CodexCacheService } from "./codex-cache.service"
import { CodexClientIdentityService } from "./codex-client-identity.service"
import { CodexWebSocketService } from "./codex-websocket.service"
import { CodexService } from "./codex.service"
import { ChatGptWebRealtimeService } from "./chatgpt-web-realtime.service"
import { ChatGptWebVoiceTransport } from "./chatgpt-web-transport"
import { ChatGptWebSessionStore } from "./chatgpt-web-session"
import { ChatGptWebConversationService } from "./chatgpt-web-conversation.service"
import { ChatGptWebBrowserService } from "./chatgpt-web-browser.service"

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
    ChatGptWebSessionStore,
    ChatGptWebConversationService,
    ChatGptWebBrowserService,
  ],
  exports: [
    CodexAuthService,
    CodexCacheService,
    CodexClientIdentityService,
    CodexWebSocketService,
    CodexService,
    ChatGptWebRealtimeService,
    ChatGptWebSessionStore,
    ChatGptWebConversationService,
    ChatGptWebBrowserService,
  ],
})
export class CodexModule {}
