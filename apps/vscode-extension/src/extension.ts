import * as vscode from "vscode"
import { registerCommands } from "./commands"
import { CMD, type ServerState } from "./constants"
import { t, tFmt } from "./i18n/messages-i18n"
import { BridgeManager } from "./services/bridge-manager"
import { CertManager } from "./services/cert-manager"
import { ConfigManager } from "./services/config-manager"
import { CursorPatchService } from "./services/cursor-patch"
import { CursorPatchManagerService } from "./services/cursor-patch-manager"
import { ExtensionUpdateService } from "./services/extension-update"
import { NetworkManager } from "./services/network-manager"
import { logger } from "./utils/logger"
import { executePrivileged } from "./utils/terminal"
import {
  StatusIndicator,
  type CursorConnectionState,
} from "./views/status-indicator"

// Singleton references for cleanup
let bridge: BridgeManager | null = null
let network: NetworkManager | null = null
let statusIndicator: StatusIndicator | null = null

/**
 * Extension entry point — called on startup (onStartupFinished).
 */
export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // Initialize logger
  logger.initialize()
  logger.info("Agent Vibes extension activating...")

  // Create core services
  const config = new ConfigManager()
  bridge = new BridgeManager(config, context.extensionPath)
  network = new NetworkManager()
  network.setExtensionPath(context.extensionPath)
  network.setPort(config.port)
  const cursorPatch = new CursorPatchService(logger)
  const cursorPatchManager = new CursorPatchManagerService()
  const cert = new CertManager(config)
  const updater = new ExtensionUpdateService(context)

  // Create UI
  const getCursorConnectionState = (): CursorConnectionState => {
    const bridgeEndpointPatch = cursorPatch.getBridgeEndpointPatchStatus(
      config.port
    )
    if (bridgeEndpointPatch.applied) {
      cursorPatchManager.ensureBridgeEndpointPatchTracked(bridgeEndpointPatch)
      return "patched"
    }
    if (network?.isForwardingActive()) return "forwarding"
    return "unwired"
  }
  statusIndicator = new StatusIndicator(getCursorConnectionState)

  let forwardingRepairPromptShown = false
  let directPatchRestartPromptShown = false

  const maybeApplyCursorDirectPatch = async (): Promise<void> => {
    if (config.trafficMode !== "cursorPatch") return

    const status = cursorPatch.getBridgeEndpointPatchStatus(config.port)
    if (!status.fileExists || !status.canApply) {
      statusIndicator?.update(bridge?.state ?? "stopped")
      return
    }
    if (status.applied && !status.requiresPortUpdate) {
      cursorPatchManager.ensureBridgeEndpointPatchTracked(status)
      statusIndicator?.update(bridge?.state ?? "stopped")
      return
    }

    const result = cursorPatch.applyBridgeEndpointPatch(config.port)
    if (!result.success) {
      logger.warn(
        `Cursor direct connection patch could not be applied: ${result.errors.join("; ")}`
      )
      statusIndicator?.update(bridge?.state ?? "stopped")
      return
    }

    const patchedStatus = cursorPatch.getBridgeEndpointPatchStatus(
      config.port,
      { force: true }
    )
    cursorPatchManager.recordBridgeEndpointPatchSuccess(patchedStatus)

    logger.info("Cursor direct connection patch applied from traffic mode")
    statusIndicator?.update(bridge?.state ?? "stopped")

    if (result.restartRequired !== true) return
    if (directPatchRestartPromptShown) return
    directPatchRestartPromptShown = true
    const action = await vscode.window.showInformationMessage(
      t("patches.bridgeEndpointApplied"),
      t("forwarding.action.quit"),
      t("setup.action.later")
    )
    if (action === t("forwarding.action.quit")) {
      await vscode.commands.executeCommand("workbench.action.quit")
    }
  }

  const maybePromptForForwardingRepair = async (): Promise<void> => {
    if (config.trafficMode !== "systemForwarding") return
    if (forwardingRepairPromptShown || !bridge?.isRunning || !network) return
    const bridgeEndpointPatch = cursorPatch.getBridgeEndpointPatchStatus(
      config.port
    )
    if (bridgeEndpointPatch.applied) return
    if (!network.hasHostEntries() || network.isForwardingActive()) return

    forwardingRepairPromptShown = true
    logger.warn(
      "Cursor host entries are present but local forwarding is inactive"
    )

    const action = await vscode.window.showWarningMessage(
      t("forwarding.needsRepair"),
      t("forwarding.action.enable"),
      t("setup.action.later")
    )

    if (action === t("forwarding.action.enable")) {
      executePrivileged(
        network.getEnableCommand(),
        t("terminal.enableForwarding")
      )
    }
  }

  // Update status bar when server state changes
  bridge.on("stateChanged", (state: ServerState) => {
    statusIndicator?.update(state)
    if (state === "running") {
      void maybePromptForForwardingRepair()
    }
  })

  // Register all commands
  registerCommands(context, bridge, config, cert, network, updater)

  let currentPort = config.port
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      const portChanged = event.affectsConfiguration("agentVibes.port")
      const trafficModeChanged = event.affectsConfiguration(
        "agentVibes.trafficMode"
      )
      if (!portChanged && !trafficModeChanged) return

      if (trafficModeChanged && !portChanged) {
        await maybeApplyCursorDirectPatch()
        statusIndicator?.update(bridge?.state ?? "stopped")
        return
      }

      const nextPort = config.port
      if (nextPort === currentPort) {
        if (trafficModeChanged) {
          await maybeApplyCursorDirectPatch()
          statusIndicator?.update(bridge?.state ?? "stopped")
        }
        return
      }

      const previousPort = currentPort
      currentPort = nextPort
      network?.setPort(nextPort)

      logger.info(`Agent Vibes port changed: ${previousPort} → ${nextPort}`)

      const bridgeRunning = bridge?.isRunning ?? false
      const forwardingActive = network?.isForwardingActive() ?? false

      try {
        if (bridgeRunning) {
          statusIndicator?.showBusy(
            t("bridge.restartingBusy"),
            tFmt("bridge.restartingTooltip", { port: nextPort })
          )
          await bridge?.restart()
          logger.info(`Bridge restarted on new port ${nextPort}`)
        }
      } catch (error) {
        statusIndicator?.clearBusy()
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`Failed to restart bridge after port change`, error)
        void vscode.window.showErrorMessage(
          tFmt("bridge.failedRestart", { port: nextPort, message })
        )
        return
      }

      if (config.trafficMode === "cursorPatch") {
        await maybeApplyCursorDirectPatch()
      }

      if (
        config.trafficMode === "systemForwarding" &&
        forwardingActive &&
        network
      ) {
        statusIndicator?.showBusy(
          t("bridge.reconfiguringBusy"),
          tFmt("bridge.reconfiguringTooltip", { port: nextPort })
        )
        executePrivileged(
          network.getReconfigureCommand(previousPort),
          t("terminal.reconfigureForwarding")
        )
        setTimeout(() => statusIndicator?.clearBusy(), 8000)
      } else {
        statusIndicator?.clearBusy()
      }
    })
  )

  void maybeApplyCursorDirectPatch()

  // Push disposables
  context.subscriptions.push({
    dispose: () => {
      statusIndicator?.dispose()
      bridge?.dispose()
      network?.dispose()
      logger.dispose()
    },
  })

  // ── First-run onboarding ──────────────────────────────────────────
  const needsCerts = !config.hasCertificates()
  const hasAnyAccounts =
    config.getAccountCount(config.antigravityAccountsPath) > 0 ||
    config.getAccountCount(config.claudeApiAccountsPath) > 0 ||
    config.getAccountCount(config.codexAccountsPath) > 0 ||
    config.getAccountCount(config.openaiCompatAccountsPath) > 0 ||
    config.getAccountCount(config.kiroAccountsPath) > 0

  if (needsCerts || !hasAnyAccounts) {
    const missing: string[] = []
    if (needsCerts) missing.push(t("setup.missing.certs"))
    if (!hasAnyAccounts) missing.push(t("setup.missing.accounts"))

    const action = await vscode.window.showInformationMessage(
      tFmt("setup.needsSetup", { missing: missing.join(" / ") }),
      t("setup.action.now"),
      t("setup.action.later")
    )

    if (action === t("setup.action.now")) {
      if (needsCerts) {
        await vscode.commands.executeCommand(CMD.GENERATE_CERT)
      }
      if (!hasAnyAccounts) {
        await vscode.commands.executeCommand(CMD.OPEN_DASHBOARD)
        vscode.window.showInformationMessage(t("setup.addAccountHint"))
      }
    }
  }

  // Auto-start if configured — starts the bridge only. Cursor traffic
  // forwarding is an independent, user-driven action managed from the
  // Dashboard API tab, so auto-start never prompts to enable forwarding.
  if (config.autoStart) {
    logger.info("Auto-start enabled, starting server...")
    bridge
      .start()
      .then(() => {
        if (bridge!.state === "running") {
          logger.info("Bridge auto-started successfully")
          void maybePromptForForwardingRepair()
        }
      })
      .catch((err) => {
        logger.warn(
          `Auto-start failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })
  }

  void updater.checkForUpdatesOnStartup()

  logger.info("Agent Vibes extension activated")
}

/**
 * Extension deactivation — clean up all resources.
 */
export function deactivate(): void {
  bridge?.dispose()
  network?.dispose()
  statusIndicator?.dispose()
  logger.info("Agent Vibes extension deactivated")
  logger.dispose()
}
