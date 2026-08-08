/**
 * Cursor IDE browser MCP admission policy.
 *
 * Cursor owns the browser process and enforces this same wire boundary: the
 * navigation tool accepts web URLs, while local files belong to file-reading
 * tools. The bridge evaluates that boundary before emitting an Exec request so
 * parent and frozen-child dispatches have identical behavior and a rejected
 * call becomes an ordinary model-visible tool error rather than a client-side
 * exception.
 */

export const CURSOR_IDE_BROWSER_MCP_SERVER_NAME = "cursor-ide-browser"

const CONTEXT_FREE_BROWSER_TOOLS = new Set([
  "browser_tabs",
  "browser_lock",
  "browser_profile_start",
  "browser_profile_stop",
])

export interface CursorBrowserMcpToolIdentity {
  readonly definitionName: string
  readonly toolName: string
  readonly providerIdentifier: string
  readonly ideRegistryKey: string
}

export interface CursorBrowserMcpContext {
  readonly hasPage: boolean
  readonly lastToolName?: string
  readonly lastUrl?: string
}

export interface CursorBrowserMcpNextContext {
  readonly hasPage: true
  readonly lastToolName: string
  readonly lastUrl?: string
}

export type CursorBrowserMcpDispatchDecision =
  | { readonly kind: "not-browser" }
  | {
      readonly kind: "rejected"
      readonly message: string
    }
  | {
      readonly kind: "accepted"
      readonly nextContext?: CursorBrowserMcpNextContext
    }

export function evaluateCursorBrowserMcpDispatch(input: {
  readonly identity: CursorBrowserMcpToolIdentity
  readonly input: Readonly<Record<string, unknown>>
  readonly context?: CursorBrowserMcpContext
}): CursorBrowserMcpDispatchDecision {
  if (!isExactCursorBrowserServer(input.identity)) {
    return { kind: "not-browser" }
  }

  const args = resolveBrowserArguments(input.input)
  if (input.identity.toolName === "browser_navigate") {
    const urlResult = validateBrowserNavigationUrl(args.url)
    if (urlResult.kind === "rejected") return urlResult
    return {
      kind: "accepted",
      nextContext: {
        hasPage: true,
        lastToolName: input.identity.definitionName,
        lastUrl: urlResult.url,
      },
    }
  }

  const explicitViewId =
    typeof args.viewId === "string" ? args.viewId.trim() : ""
  const tabAction =
    typeof args.action === "string" ? args.action.trim().toLowerCase() : ""
  const opensPage =
    explicitViewId.length > 0 ||
    (input.identity.toolName === "browser_tabs" &&
      (tabAction === "new" || tabAction === "select"))

  if (
    !CONTEXT_FREE_BROWSER_TOOLS.has(input.identity.toolName) &&
    !input.context?.hasPage &&
    !explicitViewId
  ) {
    return {
      kind: "rejected",
      message:
        `Browser tool ${JSON.stringify(input.identity.definitionName)} requires an active page. ` +
        `Call ${JSON.stringify(`${CURSOR_IDE_BROWSER_MCP_SERVER_NAME}-browser_navigate`)} ` +
        "with an absolute http:// or https:// URL, or create/select a tab first.",
    }
  }

  if (!input.context?.hasPage && !opensPage) {
    return { kind: "accepted" }
  }

  return {
    kind: "accepted",
    nextContext: {
      hasPage: true,
      lastToolName: input.identity.definitionName,
      lastUrl: input.context?.lastUrl,
    },
  }
}

function isExactCursorBrowserServer(
  identity: CursorBrowserMcpToolIdentity
): boolean {
  return (
    identity.providerIdentifier === CURSOR_IDE_BROWSER_MCP_SERVER_NAME &&
    identity.ideRegistryKey === CURSOR_IDE_BROWSER_MCP_SERVER_NAME
  )
}

function resolveBrowserArguments(
  input: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const args = input.arguments
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Readonly<Record<string, unknown>>
  }
  return input
}

function validateBrowserNavigationUrl(
  value: unknown
):
  | { readonly kind: "accepted"; readonly url: string }
  | { readonly kind: "rejected"; readonly message: string } {
  const rawUrl = typeof value === "string" ? value.trim() : ""
  if (!rawUrl) {
    return {
      kind: "rejected",
      message:
        "Browser navigation requires a non-empty absolute http:// or https:// URL.",
    }
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return {
      kind: "rejected",
      message:
        `Browser navigation rejected ${JSON.stringify(rawUrl)}: ` +
        "the URL must be absolute and use http:// or https://.",
    }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      kind: "rejected",
      message:
        `Browser navigation rejected ${JSON.stringify(rawUrl)}: ` +
        "Cursor browser tools accept only http:// or https:// URLs. " +
        "Inspect local files with a file-capable sub-agent instead.",
    }
  }

  return { kind: "accepted", url: rawUrl }
}
