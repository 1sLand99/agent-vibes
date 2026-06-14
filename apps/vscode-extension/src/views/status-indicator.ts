import * as vscode from "vscode"
import type { ServerState } from "../constants"
import { EXTENSION_DISPLAY_NAME } from "../constants"
import { t, tFmt } from "../i18n/messages-i18n"

const LOADING_COLOR = "#34d399"
const FORWARDING_POLL_INTERVAL_MS = 4000

/**
 * Bottom status bar indicator.
 *
 * Service (bridge) and Cursor traffic forwarding are independent concerns,
 * so the item renders two segments side by side: a service dot reflecting the
 * bridge process state, and a Cursor plug reflecting whether Cursor traffic
 * forwarding is wired. Forwarding can be toggled without the bridge and vice
 * versa, so neither segment is derived from the other.
 */
export class StatusIndicator {
  private item: vscode.StatusBarItem
  private state: ServerState = "stopped"
  private forwardingActive = false
  private forwardingPollTimer: ReturnType<typeof setInterval> | null = null
  private transientStatus: {
    text: string
    tooltip: string
    backgroundColor?: vscode.ThemeColor
    color?: string | vscode.ThemeColor
  } | null = null

  /**
   * @param isForwardingActive Cheap local probe (no subprocess) for the
   *   current Cursor forwarding state. Polled on an interval so the segment
   *   tracks sudo-driven enable/disable that happens outside this process.
   */
  constructor(private readonly isForwardingActive?: () => boolean) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    )
    this.item.command = "agentVibes.openDashboard"
    this.refreshForwarding()
    this.update("stopped")
    this.item.show()
    this.startForwardingPoll()
  }

  private refreshForwarding(): boolean {
    if (!this.isForwardingActive) return false
    try {
      this.forwardingActive = this.isForwardingActive()
    } catch {
      this.forwardingActive = false
    }
    return this.forwardingActive
  }

  private startForwardingPoll(): void {
    if (this.forwardingPollTimer || !this.isForwardingActive) return
    this.forwardingPollTimer = setInterval(() => {
      const previous = this.forwardingActive
      const next = this.refreshForwarding()
      if (next !== previous && !this.transientStatus) {
        this.render()
      }
    }, FORWARDING_POLL_INTERVAL_MS)
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
    return this.forwardingActive
      ? t("status.cursor.wired")
      : t("status.cursor.unwired")
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
    // Bridge state changes are a good moment to re-sync forwarding too — a
    // restart can race with a forwarding toggle.
    this.refreshForwarding()
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
    if (this.forwardingPollTimer) {
      clearInterval(this.forwardingPollTimer)
      this.forwardingPollTimer = null
    }
    this.item.dispose()
  }
}
