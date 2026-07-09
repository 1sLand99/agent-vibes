import { Module } from "@nestjs/common"
import { AnthropicModule } from "../anthropic/anthropic.module"
import { GoogleController } from "./google.controller"
import { GoogleProtocolService } from "./google-protocol.service"

@Module({
  imports: [AnthropicModule],
  controllers: [GoogleController],
  providers: [GoogleProtocolService],
  exports: [GoogleProtocolService],
})
export class GoogleProtocolModule {}
