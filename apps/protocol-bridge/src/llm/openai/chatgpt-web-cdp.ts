import WebSocket from "ws"

/**
 * Just enough Chrome DevTools Protocol to drive one page.
 *
 * The ChatGPT web app computes its own sentinel, turnstile and integrity
 * headers before it calls `fetch`, and none of that is reachable from outside
 * the page — replaying a captured request with identical headers, cookies and
 * body still fails to activate a connector. So the only way found to make a
 * connector-backed turn happen programmatically is to let the real app issue
 * the request, and edit it in flight. That needs a browser, and driving a
 * browser needs this.
 *
 * Deliberately small: no puppeteer dependency, just the handful of domains
 * used by ChatGptWebBrowserService (Runtime, Page, Input).
 */

export interface CdpTarget {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

export class CdpError extends Error {}

/** Normalise a ws payload (Buffer, ArrayBuffer or fragment list) to text. */
function decodeFrame(data: unknown): string {
  if (typeof data === "string") return data
  if (Buffer.isBuffer(data)) return data.toString("utf8")
  if (Array.isArray(data)) {
    return Buffer.concat(data as Buffer[]).toString("utf8")
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8")
  return ""
}

/** List the debuggable targets on a running Chrome. */
export async function listTargets(
  port: number,
  timeoutMs = 5_000
): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new CdpError(`DevTools listing returned ${response.status}`)
  }
  return (await response.json()) as CdpTarget[]
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
}

/** A live CDP session against one page target. */
export class CdpSession {
  private readonly socket: WebSocket
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on("message", (data) => this.onMessage(decodeFrame(data)))
    socket.on("close", () => this.failAll(new CdpError("CDP socket closed")))
    socket.on("error", (error) => this.failAll(new CdpError(error.message)))
  }

  static connect(wsUrl: string, timeoutMs = 15_000): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      // Chrome rejects an Origin header on the debugger socket.
      const socket = new WebSocket(wsUrl, { origin: undefined })
      const timer = setTimeout(() => {
        socket.close()
        reject(new CdpError("Timed out connecting to the CDP socket"))
      }, timeoutMs)
      socket.once("open", () => {
        clearTimeout(timer)
        resolve(new CdpSession(socket))
      })
      socket.once("error", (error) => {
        clearTimeout(timer)
        reject(new CdpError(error.message))
      })
    })
  }

  private onMessage(raw: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      return
    }
    if (typeof message.id !== "number") return // an event; nothing subscribes yet
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    if (message.error) {
      waiter.reject(new CdpError(message.error.message || "CDP error"))
    } else {
      waiter.resolve((message.result as Record<string, unknown>) ?? {})
    }
  }

  private failAll(error: Error): void {
    this.closed = true
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000
  ): Promise<Record<string, unknown>> {
    if (this.closed)
      return Promise.reject(new CdpError("CDP session is closed"))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`CDP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Evaluate an expression and return its value.
   *
   * Page-thrown exceptions surface as CdpError rather than a silent
   * `undefined`, because every caller here treats a failed evaluation as a
   * broken page rather than an empty result.
   */
  async evaluate<T>(expression: string, awaitPromise = false): Promise<T> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    })) as {
      result?: { value?: T }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "unknown error"
      throw new CdpError(`Page evaluation failed: ${detail.slice(0, 300)}`)
    }
    return result.result?.value as T
  }

  /** Click at viewport coordinates with a real browser-level event. */
  async clickAt(x: number, y: number): Promise<void> {
    // A synthetic DOM MouseEvent does not drive the app's React handlers, and
    // the composer's send button ignores one. These go through the browser's
    // own input pipeline instead.
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      })
    }
  }

  close(): void {
    this.closed = true
    try {
      this.socket.close()
    } catch {
      // Already gone; nothing to release.
    }
  }
}
