import * as vscode from "vscode"
import type { ServerState } from "../constants"
import { EXTENSION_DISPLAY_NAME } from "../constants"
import { t, tFmt } from "../i18n/messages-i18n"

const LOADING_COLOR = "#34d399"
const CURSOR_CONNECTION_POLL_INTERVAL_MS = 30_000

export type CursorConnectionState = "patched" | "forwarding" | "unwired"

/**
 * Bottom status bar indicator.
 *
 * Service (bridge) and Cursor traffic wiring are independent concerns.
 * Cursor wiring can be a direct patch or legacy forwarding, so the status bar
 * asks the caller for the current connection state instead of assuming the
 * forwarding backend is the only source of truth.
 */
export class StatusIndicator {
  private item: vscode.StatusBarItem
  private state: ServerState = "stopped"
  private cursorConnection: CursorConnectionState = "unwired"
  private connectionPollTimer: ReturnType<typeof setInterval> | null = null
  private transientStatus: {
    text: string
    tooltip: string
    backgroundColor?: vscode.ThemeColor
    color?: string | vscode.ThemeColor
  } | null = null

  /**
   * @param getCursorConnectionState Cheap local probe for the current Cursor
   *   connection state. Polled on an interval so the segment tracks patch and
   *   forwarding changes that happen outside this process.
   */
  constructor(
    private readonly getCursorConnectionState?: () => CursorConnectionState
  ) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    )
    this.item.command = "agentVibes.openDashboard"
    this.refreshCursorConnection()
    this.update("stopped")
    this.item.show()
    this.startConnectionPoll()
  }

  private refreshCursorConnection(): CursorConnectionState {
    if (!this.getCursorConnectionState) return "unwired"
    try {
      this.cursorConnection = this.getCursorConnectionState()
    } catch {
      this.cursorConnection = "unwired"
    }
    return this.cursorConnection
  }

  private startConnectionPoll(): void {
    if (this.connectionPollTimer || !this.getCursorConnectionState) return
    this.connectionPollTimer = setInterval(() => {
      const previous = this.cursorConnection
      const next = this.refreshCursorConnection()
      if (next !== previous && !this.transientStatus) {
        this.render()
      }
    }, CURSOR_CONNECTION_POLL_INTERVAL_MS)
  }

  private serviceSegment(): {
    icon: string
    background?: vscode.ThemeColor
    color?: string
  } {
    switch (this.state) {
      case "running":
        return { icon: "$(circle-filled)" }
      case "starting":
        return { icon: "$(sync~spin)", color: LOADING_COLOR }
      case "error":
        return {
          icon: "$(error)",
          background: new vscode.ThemeColor("statusBarItem.errorBackground"),
        }
      case "stopped":
      default:
        return { icon: "$(circle-outline)" }
    }
  }

  private serviceLabel(): string {
    switch (this.state) {
      case "running":
        return t("status.svc.running")
      case "starting":
        return t("status.svc.starting")
      case "error":
        return t("status.svc.error")
      case "stopped":
      default:
        return t("status.svc.stopped")
    }
  }

  private cursorLabel(): string {
    switch (this.cursorConnection) {
      case "patched":
        return t("status.cursor.patched")
      case "forwarding":
        return t("status.cursor.forwarding")
      case "unwired":
      default:
        return t("status.cursor.unwired")
    }
  }

  private render(): void {
    // Always open Dashboard on click
    this.item.command = "agentVibes.openDashboard"

    if (this.transientStatus) {
      this.item.text = this.transientStatus.text
      this.item.tooltip = this.transientStatus.tooltip
      this.item.backgroundColor = this.transientStatus.backgroundColor
      this.item.color = this.transientStatus.color
      return
    }

    const svc = this.serviceSegment()

    // Single brand label with the service (bridge) state icon. Cursor
    // forwarding state is surfaced in the tooltip rather than a second icon.
    this.item.text = `${svc.icon} ${EXTENSION_DISPLAY_NAME}`
    this.item.tooltip = tFmt("status.tooltip.combined", {
      service: this.serviceLabel(),
      cursor: this.cursorLabel(),
    })
    this.item.backgroundColor = svc.background
    this.item.color = svc.color
  }

  update(state: ServerState): void {
    this.state = state
    // Bridge state changes are a good moment to re-sync connection state too.
    this.refreshCursorConnection()
    this.render()
  }

  showBusy(label: string, tooltip?: string): void {
    this.transientStatus = {
      text: `$(sync~spin) ${EXTENSION_DISPLAY_NAME} ${label}`,
      tooltip: tooltip || tFmt("status.tooltip.busy", { label }),
      backgroundColor: undefined,
      color: LOADING_COLOR,
    }
    this.render()
  }

  clearBusy(): void {
    this.transientStatus = null
    this.render()
  }

  dispose(): void {
    if (this.connectionPollTimer) {
      clearInterval(this.connectionPollTimer)
      this.connectionPollTimer = null
    }
    this.item.dispose()
  }
}
