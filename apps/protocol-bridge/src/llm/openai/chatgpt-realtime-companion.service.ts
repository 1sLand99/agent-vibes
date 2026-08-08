import { Injectable, OnModuleDestroy } from "@nestjs/common"
import * as crypto from "crypto"
import {
  CHATGPT_WEB_RELAY_TRANSPORT,
  type ChatGptWebRealtimeCallRequest,
  type ChatGptWebRealtimeCallResult,
  extractChatGptWebRealtimeCallId,
} from "./chatgpt-web-realtime"

const DEFAULT_CALL_TIMEOUT_MS = 45_000
const DEFAULT_POLL_TIMEOUT_MS = 20_000
const COMPANION_ACTIVE_WINDOW_MS = 30_000

export interface ChatGptRealtimeCompanionJob {
  id: string
  type: "realtime.create"
  request: ChatGptWebRealtimeCallRequest
}

export interface ChatGptRealtimeCompanionCompletion {
  ok: boolean
  transport?: string
  sdp?: string
  location?: string
  error?: {
    code?: string
    message?: string
  }
}

interface PendingCall {
  job: ChatGptRealtimeCompanionJob
  resolve: (result: ChatGptWebRealtimeCallResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

interface PendingPoll {
  resolve: (job: ChatGptRealtimeCompanionJob | null) => void
  timeout: NodeJS.Timeout
}

export class ChatGptRealtimeCompanionUnavailableError extends Error {
  readonly code = "realtime_companion_unavailable"

  constructor() {
    super(
      "No Agent Vibes ChatGPT Voice companion is connected to a logged-in chatgpt.com page"
    )
    this.name = "ChatGptRealtimeCompanionUnavailableError"
  }
}

export class ChatGptRealtimeCompanionTimeoutError extends Error {
  readonly code = "realtime_companion_timeout"

  constructor() {
    super("The ChatGPT Voice companion did not create the WebRTC relay in time")
    this.name = "ChatGptRealtimeCompanionTimeoutError"
  }
}

export class ChatGptRealtimeCompanionProtocolError extends Error {
  readonly code = "realtime_companion_protocol_error"

  constructor(message: string) {
    super(message)
    this.name = "ChatGptRealtimeCompanionProtocolError"
  }
}

@Injectable()
export class ChatGptRealtimeCompanionService implements OnModuleDestroy {
  private readonly queuedJobs: ChatGptRealtimeCompanionJob[] = []
  private readonly calls = new Map<string, PendingCall>()
  private readonly polls: PendingPoll[] = []
  private lastCompanionSeenAt = 0

  get status(): { connected: boolean; pendingCalls: number } {
    return {
      connected:
        Date.now() - this.lastCompanionSeenAt <= COMPANION_ACTIVE_WINDOW_MS,
      pendingCalls: this.calls.size,
    }
  }

  async createCall(
    request: ChatGptWebRealtimeCallRequest,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS
  ): Promise<ChatGptWebRealtimeCallResult> {
    if (!this.status.connected) {
      throw new ChatGptRealtimeCompanionUnavailableError()
    }

    const job: ChatGptRealtimeCompanionJob = {
      id: crypto.randomUUID(),
      type: "realtime.create",
      request,
    }

    return await new Promise<ChatGptWebRealtimeCallResult>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          this.calls.delete(job.id)
          const queuedIndex = this.queuedJobs.findIndex(
            (queued) => queued.id === job.id
          )
          if (queuedIndex >= 0) this.queuedJobs.splice(queuedIndex, 1)
          reject(new ChatGptRealtimeCompanionTimeoutError())
        }, timeoutMs)
        timeout.unref()

        this.calls.set(job.id, { job, resolve, reject, timeout })
        const poll = this.polls.shift()
        if (poll) {
          clearTimeout(poll.timeout)
          poll.resolve(job)
        } else {
          this.queuedJobs.push(job)
        }
      }
    )
  }

  async nextJob(
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS
  ): Promise<ChatGptRealtimeCompanionJob | null> {
    this.lastCompanionSeenAt = Date.now()
    const queued = this.queuedJobs.shift()
    if (queued) return queued

    return await new Promise<ChatGptRealtimeCompanionJob | null>((resolve) => {
      const pending: PendingPoll = {
        resolve,
        timeout: setTimeout(() => {
          const index = this.polls.indexOf(pending)
          if (index >= 0) this.polls.splice(index, 1)
          resolve(null)
        }, timeoutMs),
      }
      pending.timeout.unref()
      this.polls.push(pending)
    })
  }

  completeJob(
    jobId: string,
    completion: ChatGptRealtimeCompanionCompletion
  ): boolean {
    this.lastCompanionSeenAt = Date.now()
    const pending = this.calls.get(jobId)
    if (!pending) return false

    this.calls.delete(jobId)
    clearTimeout(pending.timeout)

    if (!completion.ok) {
      pending.reject(
        new ChatGptRealtimeCompanionProtocolError(
          completion.error?.message ||
            "The ChatGPT Voice companion could not create the WebRTC relay"
        )
      )
      return true
    }

    if (completion.transport !== CHATGPT_WEB_RELAY_TRANSPORT) {
      pending.reject(
        new ChatGptRealtimeCompanionProtocolError(
          "The companion returned a signaling-only session instead of a page-owned media and event relay"
        )
      )
      return true
    }

    if (
      typeof completion.sdp !== "string" ||
      !/^v=0(?:\r?\n|$)/.test(completion.sdp) ||
      !/(?:^|\r?\n)m=audio\s/.test(completion.sdp)
    ) {
      pending.reject(
        new ChatGptRealtimeCompanionProtocolError(
          "The companion returned an invalid SDP answer"
        )
      )
      return true
    }

    try {
      const callId = extractChatGptWebRealtimeCallId(completion.location || "")
      pending.resolve({
        callId,
        sdp: completion.sdp,
        transport: CHATGPT_WEB_RELAY_TRANSPORT,
      })
    } catch (error) {
      pending.reject(
        error instanceof Error
          ? new ChatGptRealtimeCompanionProtocolError(error.message)
          : new ChatGptRealtimeCompanionProtocolError(
              "The companion returned an invalid call identifier"
            )
      )
    }
    return true
  }

  onModuleDestroy(): void {
    for (const poll of this.polls.splice(0)) {
      clearTimeout(poll.timeout)
      poll.resolve(null)
    }
    for (const pending of this.calls.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new ChatGptRealtimeCompanionUnavailableError())
    }
    this.calls.clear()
    this.queuedJobs.splice(0)
  }
}
