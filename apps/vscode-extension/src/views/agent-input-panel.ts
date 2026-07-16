import * as vscode from "vscode"
import { AGENT_INPUT_VIEW_ID } from "../services/cursor-agent-input-dock"

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
