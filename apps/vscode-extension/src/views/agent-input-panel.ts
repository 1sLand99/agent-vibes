import * as vscode from "vscode"
import {
  AGENT_INPUT_CONTAINER_ID,
  AGENT_INPUT_VIEW_ID,
} from "../services/cursor-agent-input-dock"

const AGENT_INPUT_CONTAINER_COMMAND_ID = `workbench.view.extension.${AGENT_INPUT_CONTAINER_ID}`

class AgentInputTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element
  }

  getChildren(): vscode.ProviderResult<vscode.TreeItem[]> {
    return []
  }
}

export function registerAgentInputPanel(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      AGENT_INPUT_VIEW_ID,
      new AgentInputTreeDataProvider()
    )
  )
}

export async function revealAgentInputPanelForDock(): Promise<void> {
  await vscode.commands.executeCommand(AGENT_INPUT_CONTAINER_COMMAND_ID)
}
