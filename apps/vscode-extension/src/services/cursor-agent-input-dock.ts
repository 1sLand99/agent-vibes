export const AGENT_INPUT_VIEW_ID = "agentVibes.agentInput"
export const AGENT_INPUT_CONTAINER_ID = "agentVibesAgentInput"

// Single source of truth for the shared injected runtime version. Dock and
// Workspace Control remain independent features inside this runtime.
const AGENT_INPUT_RUNTIME_VERSION = 102

const agentInputRuntimeMarkerFor = (version: number): string =>
  "[AGENT_VIBES_AGENT_INPUT_RUNTIME_V" + version + "]"
const agentInputDockMarkerFor = (version: number): string =>
  "[AGENT_VIBES_AGENT_INPUT_DOCK_V" + version + "]"

export const CURSOR_AGENT_INPUT_RUNTIME_PATCH_MARKER =
  agentInputRuntimeMarkerFor(AGENT_INPUT_RUNTIME_VERSION)
export const CURSOR_AGENT_INPUT_DOCK_PATCH_MARKER = agentInputDockMarkerFor(
  AGENT_INPUT_RUNTIME_VERSION
)
export const CURSOR_WORKSPACE_CONTROL_PATCH_MARKER =
  "[AGENT_VIBES_WORKSPACE_CONTROL_V1]"

// Historical marker names used before the V-numbered scheme (V7+).
const CURSOR_AGENT_INPUT_DOCK_LEGACY_NAMED_MARKERS = [
  "[AGENT_VIBES_CHAT_INPUT_RESIZE]",
  "[AGENT_VIBES_CHAT_INPUT_DOCK_V6]",
  "[AGENT_VIBES_CHAT_INPUT_DOCK_V5]",
  "[AGENT_VIBES_CHAT_INPUT_DOCK_V4]",
  "[AGENT_VIBES_CHAT_INPUT_DOCK_V3]",
  "[AGENT_VIBES_CHAT_INPUT_DOCK_V2]",
] as const

// All prior V-numbered markers (V7 .. current-1) are derived from the version
// counter, so bumping the runtime only requires incrementing
// AGENT_INPUT_RUNTIME_VERSION above.
const CURSOR_AGENT_INPUT_DOCK_LEGACY_MARKERS: readonly string[] = [
  ...Array.from({ length: AGENT_INPUT_RUNTIME_VERSION - 7 }, (_unused, index) =>
    agentInputDockMarkerFor(AGENT_INPUT_RUNTIME_VERSION - 1 - index)
  ),
  ...CURSOR_AGENT_INPUT_DOCK_LEGACY_NAMED_MARKERS,
]

const CURSOR_AGENT_INPUT_RUNTIME_LEGACY_MARKERS: readonly string[] = Array.from(
  { length: AGENT_INPUT_RUNTIME_VERSION - 7 },
  (_unused, index) =>
    agentInputRuntimeMarkerFor(AGENT_INPUT_RUNTIME_VERSION - 1 - index)
)

export const CURSOR_AGENT_INPUT_DOCK_PATCH_MARKERS: readonly string[] = [
  CURSOR_AGENT_INPUT_DOCK_PATCH_MARKER,
  ...CURSOR_AGENT_INPUT_DOCK_LEGACY_MARKERS,
]

export const CURSOR_AGENT_INPUT_RUNTIME_PATCH_MARKERS: readonly string[] = [
  CURSOR_AGENT_INPUT_RUNTIME_PATCH_MARKER,
  CURSOR_AGENT_INPUT_DOCK_PATCH_MARKER,
  CURSOR_WORKSPACE_CONTROL_PATCH_MARKER,
  ...CURSOR_AGENT_INPUT_RUNTIME_LEGACY_MARKERS,
  ...CURSOR_AGENT_INPUT_DOCK_LEGACY_MARKERS,
]

const CURSOR_AGENT_INPUT_DOCK_MARKER_PATTERN_SOURCE =
  CURSOR_AGENT_INPUT_DOCK_PATCH_MARKERS.map((marker) =>
    marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  ).join("|")

export type CursorAgentInputDockDetails = {
  applied: boolean
  partial: boolean
  canApply: boolean
  legacyMarkers: string[]
}

export type AgentInputDockPlacement = "bottom" | "editor" | "chat"
export type AgentInputDockDragSource = "bottom" | "native"
export type WorkspaceControlRuntimeConfig = {
  bridgePort: number
  controlToken: string
  useHttps: boolean
}

export function readWorkspaceControlRuntimeConfig(
  content: string
): WorkspaceControlRuntimeConfig | null {
  const match = /const workspaceControlConfig = (\{[^\n]+\})/u.exec(content)
  if (!match) return null

  try {
    const parsed = JSON.parse(
      match[1]!
    ) as Partial<WorkspaceControlRuntimeConfig>
    if (
      !Number.isInteger(parsed.bridgePort) ||
      parsed.bridgePort! < 0 ||
      parsed.bridgePort! > 65_535 ||
      typeof parsed.controlToken !== "string" ||
      typeof parsed.useHttps !== "boolean"
    ) {
      return null
    }
    return {
      bridgePort: parsed.bridgePort!,
      controlToken: parsed.controlToken,
      useHttps: parsed.useHttps,
    }
  } catch {
    return null
  }
}

export type AgentInputDockPhase = "revealing" | "docked" | "native"

export type AgentInputDockNativePlacement = "editor" | "chat"

export type AgentInputDockState = {
  placement: AgentInputDockPlacement
  nativePlacement: AgentInputDockNativePlacement
  phase: AgentInputDockPhase
}

export type AgentInputDockEvent =
  | { type: "MOVE"; placement: "bottom" }
  | { type: "PANEL_ACTIVE" }
  | { type: "PANEL_HIDDEN" }
  | { type: "NATIVE_READY"; placement: AgentInputDockNativePlacement }

export function reduceAgentInputDockState(
  state: AgentInputDockState | undefined,
  event: AgentInputDockEvent
): AgentInputDockState {
  const createNativeState = (
    placement: AgentInputDockNativePlacement
  ): AgentInputDockState => ({
    placement,
    nativePlacement: placement,
    phase: "native",
  })

  if (!state) {
    return event.type === "NATIVE_READY"
      ? createNativeState(event.placement)
      : createNativeState("editor")
  }

  switch (event.type) {
    case "MOVE":
      return {
        ...state,
        placement: "bottom",
        phase: "revealing",
      }
    case "PANEL_ACTIVE":
      return {
        ...state,
        placement: "bottom",
        nativePlacement:
          state.placement === "bottom"
            ? state.nativePlacement
            : state.placement,
        phase: "docked",
      }
    case "PANEL_HIDDEN":
      return createNativeState(state.nativePlacement)
    case "NATIVE_READY":
      return state.placement === "bottom"
        ? { ...state, nativePlacement: event.placement }
        : createNativeState(event.placement)
  }
}

function buildCursorAgentInputRuntimePatchInsertion(
  agentInputDockEnabled: boolean,
  workspaceControlEnabled: boolean,
  runtimeConfig: WorkspaceControlRuntimeConfig | null
): string {
  return (
    "/*" +
    CURSOR_AGENT_INPUT_RUNTIME_PATCH_MARKER +
    "*" +
    "/" +
    `
;(() => {
  ${agentInputDockEnabled ? `/*${CURSOR_AGENT_INPUT_DOCK_PATCH_MARKER}*/` : ""}
  const agentInputDockEnabled = ${JSON.stringify(agentInputDockEnabled)}
  ${workspaceControlEnabled ? `/*${CURSOR_WORKSPACE_CONTROL_PATCH_MARKER}*/` : ""}
  const workspaceControlEnabled = ${JSON.stringify(workspaceControlEnabled)}
  const styleId = "agent-vibes-agent-input-runtime-v${AGENT_INPUT_RUNTIME_VERSION}"
  const workspaceControlConfig = ${workspaceControlEnabled ? JSON.stringify(runtimeConfig) : "null"}
  const ownedPanelId = agentInputDockEnabled
    ? ${JSON.stringify(AGENT_INPUT_CONTAINER_ID)}
    : "__agent_vibes_disabled_dock__"
  const ownedPanelCompositeId = "workbench.view.extension." + ownedPanelId
  const ownedPanelCompositeSelector =
    "[id='" + ownedPanelCompositeId + "']"
  const ownedPanelActionAttribute =
    "data-agent-vibes-owned-panel-action"
  const panelToggleCommandId = "workbench.action.togglePanel"
  const panelToggleSelector =
    "[data-command-id='" + panelToggleCommandId + "']"
  const agentsToggleCommandId = "workbench.action.toggleAgents"
  const agentsToggleSelector =
    "[data-command-id='" + agentsToggleCommandId + "']," +
    ".part.titlebar .titlebar-agents-icon," +
    ".part.titlebar .titlebar-agents-icon-filled," +
    ".part.titlebar .titlebar-agents-icon-outline"
  const auxiliaryToggleCommandId =
    "workbench.action.toggleAuxiliaryBar"
  const auxiliaryToggleSelector =
    "[data-command-id='" + auxiliaryToggleCommandId + "']"
  const auxiliaryPartSelector =
    "[id='workbench.parts.auxiliarybar'],.part.auxiliarybar,.part.unifiedsidebar"
  const nativeRootSelector =
    "[data-composer-id][data-composer-location]"
  const inputSelector = ".full-input-box:not(.compact)"
  const panelUnavailableAttribute = "data-agent-vibes-panel-unavailable"
  const panelBodyAttribute = "data-agent-vibes-agent-panel-body"
  const panelMountedAttribute = "data-agent-vibes-agent-panel-mounted"
  const panelHostAttribute = "data-agent-vibes-agent-input-host"
  const sourceAnchorAttribute = "data-agent-vibes-input-source-anchor"
  const dockedInputAttribute = "data-agent-vibes-docked-input"
  const fillShellAttribute = "data-agent-vibes-input-fill-shell"
  const fillEditorAttribute = "data-agent-vibes-input-fill-editor"
  const fillScrollAttribute = "data-agent-vibes-input-fill-scroll"
  const fillGridAttribute = "data-agent-vibes-input-fill-grid"
  const fillEditableAttribute = "data-agent-vibes-input-fill-editable"
  const projectPickerAttribute = "data-agent-vibes-project-picker"
  const projectPickerTriggerAttribute =
    "data-agent-vibes-project-picker-trigger"
  const projectPickerMenuAttribute = "data-agent-vibes-project-picker-menu"
  const branchPickerAttribute = "data-agent-vibes-branch-picker"
  const branchPickerTriggerAttribute =
    "data-agent-vibes-branch-picker-trigger"
  const branchPickerMenuAttribute = "data-agent-vibes-branch-picker-menu"
  const pickerDockAttribute = "data-agent-vibes-dock-pickers"
  const projectPickerRefreshMs = 10_000
  const branchPickerRefreshMs = 10_000
  const transition = ${reduceAgentInputDockState.toString()}
  const states = new Map()
  const projectPickerStates = new Map()
  const branchPickerStates = new Map()
  let activeComposerId = null
  let mounted = null
  let openProjectPicker = null
  let openBranchPicker = null
  let observer = null
  let scanScheduled = false
  let ownedPanelAction = null

  const createInitialState = nativePlacement =>
    transition(undefined, {
      type: "NATIVE_READY",
      placement: nativePlacement,
    })

  const getState = (composerId, nativePlacement = "editor") => {
    let state = states.get(composerId)
    if (!state) {
      state = createInitialState(nativePlacement)
      states.set(composerId, state)
    }
    return state
  }

  const dispatch = (composerId, event) => {
    const next = transition(getState(composerId), event)
    states.set(composerId, next)
    return next
  }

  const isElementHidden = element =>
    !(element instanceof HTMLElement) ||
    element.hidden ||
    element.getAttribute("aria-hidden") === "true" ||
    element.classList.contains("hidden") ||
    element.style.display === "none" ||
    element.style.visibility === "hidden"

  const isElementTreeHidden = element => {
    let current = element
    while (current instanceof HTMLElement) {
      if (isElementHidden(current)) return true
      current = current.parentElement
    }
    return false
  }

  const getPanelPart = () => {
    const panel = document.querySelector(".part.panel")
    return panel instanceof HTMLElement ? panel : null
  }

  const isRenderedElement = element =>
    element instanceof HTMLElement &&
    !isElementTreeHidden(element) &&
    element.offsetParent !== null &&
    element.offsetWidth > 0 &&
    element.offsetHeight > 0

  const getOwnedPanelComposite = () => {
    const composite = document.getElementById(ownedPanelCompositeId)
    return composite instanceof HTMLElement ? composite : null
  }

  const rememberOwnedPanelAction = () => {
    const composite = getOwnedPanelComposite()
    if (!isRenderedElement(composite)) return null
    const action = getPanelPart()?.querySelector(
      ".composite-bar [role='tab'][aria-selected='true']"
    )
    if (!(action instanceof HTMLElement)) return null
    const actionItem = action.closest(".action-item") ?? action
    if (!(actionItem instanceof HTMLElement)) return null
    if (
      ownedPanelAction instanceof HTMLElement &&
      ownedPanelAction !== actionItem
    ) {
      ownedPanelAction.removeAttribute(ownedPanelActionAttribute)
    }
    actionItem.setAttribute(ownedPanelActionAttribute, "")
    ownedPanelAction = actionItem
    return actionItem
  }

  const getOwnedPanelAction = () => {
    if (
      ownedPanelAction instanceof HTMLElement &&
      ownedPanelAction.isConnected
    ) {
      return ownedPanelAction
    }
    const taggedAction = document.querySelector(
      "[" + ownedPanelActionAttribute + "]"
    )
    if (taggedAction instanceof HTMLElement) {
      ownedPanelAction = taggedAction
      return taggedAction
    }
    return rememberOwnedPanelAction()
  }

  const getTitlebarCommandAction = selector => {
    const candidates = Array.from(
      document.querySelectorAll(selector)
    ).filter(
      element =>
        element instanceof HTMLElement && !isElementTreeHidden(element)
    )
    const action = candidates.find(
      element => element.closest(".part.titlebar") instanceof HTMLElement
    ) ?? candidates[0]
    if (!(action instanceof HTMLElement)) return null
    return action.closest(".action-item") ?? action
  }

  const getPanelToggleAction = () =>
    getTitlebarCommandAction(panelToggleSelector)

  const getActionCheckedState = action => {
    if (!(action instanceof HTMLElement)) return null
    const candidates = [
      action,
      ...action.querySelectorAll("[aria-checked],.checked"),
    ].filter(element => element instanceof HTMLElement)
    const explicit = candidates.find(element =>
      ["true", "false"].includes(element.getAttribute("aria-checked"))
    )
    if (explicit instanceof HTMLElement) {
      return explicit.getAttribute("aria-checked") === "true"
    }
    return candidates.some(element => element.classList.contains("checked"))
      ? true
      : null
  }

  const isPanelToggleElement = element =>
    element instanceof Element &&
    (element.matches(panelToggleSelector) ||
      element.closest(panelToggleSelector) instanceof Element)

  const isAuxiliaryToggleElement = element =>
    element instanceof Element &&
    (element.matches(auxiliaryToggleSelector) ||
      element.closest(auxiliaryToggleSelector) instanceof Element)

  const isPanelPartVisible = () => {
    const toggleState = getActionCheckedState(getPanelToggleAction())
    if (toggleState !== null) return toggleState
    const panel = getPanelPart()
    return (
      panel instanceof HTMLElement &&
      !isElementTreeHidden(panel) &&
      panel.offsetParent !== null &&
      panel.offsetWidth > 0 &&
      panel.offsetHeight > 0
    )
  }

  const isOwnedPanelActive = () => {
    const active = isRenderedElement(getOwnedPanelComposite())
    if (active) rememberOwnedPanelAction()
    return active
  }

  const setPanelAvailable = available => {
    const action = getOwnedPanelAction()
    if (!action) return
    if (available) {
      action.removeAttribute(panelUnavailableAttribute)
    } else {
      action.setAttribute(panelUnavailableAttribute, "")
    }
  }

  const getPanelParts = () => {
    if (!isOwnedPanelActive() || !isPanelPartVisible()) return null
    const composite = getOwnedPanelComposite()
    if (!composite) return null
    const bodies = Array.from(composite.querySelectorAll(".pane-body")).filter(
      body =>
        body instanceof HTMLElement &&
        isRenderedElement(body)
    )
    const body = bodies[bodies.length - 1]
    if (!(body instanceof HTMLElement)) return null
    const list = body.querySelector(".monaco-list")
    return {
      body,
      list: list instanceof HTMLElement ? list : null,
    }
  }

  const getEditorParts = input => {
    const editorSurface = input.querySelector(".smooth-height")
    const editable = editorSurface?.querySelector(".aislash-editor-input")
    const editorGrid = editable?.closest(".aislash-editor-grid")
    if (
      !(editorSurface instanceof HTMLElement) ||
      !(editable instanceof HTMLElement) ||
      !(editorGrid instanceof HTMLElement)
    ) {
      return null
    }
    return { editorSurface, editable, editorGrid }
  }

  const findReadyInput = root => {
    const input = root.querySelector(inputSelector)
    return input instanceof HTMLElement && getEditorParts(input) ? input : null
  }

  const clearFillAttributes = input => {
    input.removeAttribute(dockedInputAttribute)
    const selector = [
      fillShellAttribute,
      fillEditorAttribute,
      fillScrollAttribute,
      fillGridAttribute,
      fillEditableAttribute,
    ]
      .map(attribute => "[" + attribute + "]")
      .join(",")
    input
      .querySelectorAll(selector)
      .forEach(element => {
        element.removeAttribute(fillShellAttribute)
        element.removeAttribute(fillEditorAttribute)
        element.removeAttribute(fillScrollAttribute)
        element.removeAttribute(fillGridAttribute)
        element.removeAttribute(fillEditableAttribute)
      })
  }

  const fillDockedInput = input => {
    const parts = getEditorParts(input)
    if (!parts) return false
    const { editorSurface, editable, editorGrid } = parts
    input.setAttribute(dockedInputAttribute, "")
    editorSurface.setAttribute(fillEditorAttribute, "")
    editorGrid.setAttribute(fillGridAttribute, "")
    editable.setAttribute(fillEditableAttribute, "")

    let shell = editorSurface.parentElement
    while (shell instanceof HTMLElement && shell !== input) {
      shell.setAttribute(fillShellAttribute, "")
      shell = shell.parentElement
    }

    let scrollLayer = editorGrid.parentElement
    while (
      scrollLayer instanceof HTMLElement &&
      scrollLayer !== editorSurface
    ) {
      scrollLayer.setAttribute(fillScrollAttribute, "")
      scrollLayer = scrollLayer.parentElement
    }
    return true
  }

  const releaseMountedInput = (restore = true) => {
    if (!mounted) return null
    const record = mounted
    mounted = null
    clearFillAttributes(record.input)

    if (restore && record.anchor.isConnected) {
      record.anchor.replaceWith(record.input)
    } else {
      record.input.remove()
      record.anchor.remove()
    }

    if (record.panelBody.isConnected) {
      record.panelBody.removeAttribute(panelMountedAttribute)
    }
    if (
      record.host.isConnected &&
      !record.host.querySelector(inputSelector)
    ) {
      record.host.remove()
    }
    return record
  }

  const ensurePanelHost = (parts, composerId) => {
    parts.body.setAttribute(panelBodyAttribute, "")
    let host = parts.body.querySelector(
      ":scope > [" + panelHostAttribute + "]"
    )
    if (!(host instanceof HTMLElement)) {
      host = document.createElement("div")
      host.className = "agent-vibes-agent-input-host"
      host.setAttribute(panelHostAttribute, "")
      parts.body.appendChild(host)
    }
    host.setAttribute("data-agent-vibes-composer-id", composerId)
    return host
  }

  const dockInput = (record, parts) => {
    const { composerId, root, input } = record
    if (!(input instanceof HTMLElement) || !getEditorParts(input)) return false

    if (mounted && mounted.input !== input) {
      releaseMountedInput(mounted.composerId !== composerId)
    }

    const host = ensurePanelHost(parts, composerId)
    if (!mounted) {
      if (!input.parentNode) return false
      const anchor = document.createElement("span")
      anchor.hidden = true
      anchor.setAttribute(sourceAnchorAttribute, "")
      input.parentNode.insertBefore(anchor, input)
      mounted = {
        composerId,
        input,
        anchor,
        sourceRoot: root,
        sourceGroup: root.closest(".editor-group-container"),
        host,
        panelBody: parts.body,
      }
    } else {
      mounted.sourceRoot = root
      mounted.sourceGroup = root.closest(".editor-group-container")
      mounted.host = host
      mounted.panelBody = parts.body
    }

    host
      .querySelectorAll(inputSelector)
      .forEach(element => {
        if (element !== input) element.remove()
      })
    fillDockedInput(input)
    parts.body.setAttribute(panelMountedAttribute, "")
    if (input.parentElement !== host) host.appendChild(input)
    dispatch(composerId, { type: "PANEL_ACTIVE" })
    return true
  }

  const getNativeLocation = root => {
    const location = root.getAttribute("data-composer-location")
    if (location === "pane" || location === "editor") return location
    return root.closest(auxiliaryPartSelector) ? "pane" : null
  }

  const getNativeSurface = root =>
    root.closest(auxiliaryPartSelector)
      ? "pane"
      : getNativeLocation(root)

  const getRootsForComposer = composerId =>
    Array.from(document.querySelectorAll(nativeRootSelector)).filter(
      root =>
        root instanceof HTMLElement &&
        root.getAttribute("data-composer-id") === composerId
    )

  const restoreDockedComposer = () => {
    if (!mounted) return
    const composerId = mounted.composerId
    releaseMountedInput(true)
    dispatch(composerId, { type: "PANEL_HIDDEN" })
  }

  const normalizeComposerResourceName = resourceName => {
    let normalized = resourceName
    try {
      normalized = decodeURIComponent(resourceName)
    } catch {}
    return normalized.startsWith("/") ? normalized.slice(1) : normalized
  }

  const getComposerIdFromTab = tab => {
    const group = tab.closest(".editor-group-container")
    if (!(group instanceof HTMLElement)) return null
    const resourceName = tab.getAttribute("data-resource-name")
    if (resourceName) {
      const resourceComposerId = normalizeComposerResourceName(resourceName)
      const matchesComposerRoot = getRootsForComposer(
        resourceComposerId
      ).some(root =>
        root.closest(".editor-group-container") === group
      )
      if (matchesComposerRoot) return resourceComposerId
    }
    if (!tab.querySelector(".composer-tab-label")) return null
    const composerTabs = Array.from(
      group.querySelectorAll(".tabs-container .tab")
    ).filter(candidate =>
      candidate.querySelector(".composer-tab-label")
    )
    const composerRoots = Array.from(
      group.querySelectorAll(nativeRootSelector)
    ).filter(candidate => candidate instanceof HTMLElement)
    if (composerTabs.length !== 1 || composerRoots.length !== 1) {
      return null
    }
    return composerRoots[0].getAttribute("data-composer-id")
  }

  const getComposerEditorTab = root => {
    const group = root.closest(".editor-group-container")
    if (!(group instanceof HTMLElement)) return null
    const composerId = root.getAttribute("data-composer-id")
    if (!composerId) return null
    return (
      Array.from(
        group.querySelectorAll(".tabs-container .tab")
      ).find(
        tab =>
          tab instanceof HTMLElement &&
          getComposerIdFromTab(tab) === composerId
      ) ?? null
    )
  }

  const getSelectedComposerIdFromGroup = group => {
    if (!(group instanceof HTMLElement)) return null
    const tab =
      group.querySelector(
        ".tabs-container .tab[aria-selected='true']"
      ) ??
      group.querySelector(".tabs-container .tab.active")
    return tab instanceof HTMLElement ? getComposerIdFromTab(tab) : null
  }

  const getEditorGroups = () => {
    const part = document.getElementById("workbench.parts.editor")
    if (!(part instanceof HTMLElement)) return []
    const groups = Array.from(
      part.querySelectorAll(".editor-group-container")
    ).filter(group => group instanceof HTMLElement)
    groups.sort((left, right) => {
      const leftBounds = left.getBoundingClientRect()
      const rightBounds = right.getBoundingClientRect()
      return (
        leftBounds.left - rightBounds.left ||
        leftBounds.top - rightBounds.top
      )
    })
    return groups
  }

  const getRenderedEditorGroups = () =>
    getEditorGroups().filter(group => isRenderedElement(group))

  const getMainEditorGroup = () =>
    getRenderedEditorGroups()[0] ??
    (mounted?.sourceGroup instanceof HTMLElement &&
    mounted.sourceGroup.isConnected
      ? mounted.sourceGroup
      : null) ??
    getEditorGroups()[0] ??
    null

  const getPreferredPaneComposerId = () => {
    const paneRoots = Array.from(
      document.querySelectorAll(nativeRootSelector)
    ).filter(
      root =>
        root instanceof HTMLElement &&
        getNativeSurface(root) === "pane" &&
        isRenderedElement(root)
    )
    const activeElement = document.activeElement
    const activeRoot =
      activeElement instanceof Element
        ? paneRoots.find(root => root.contains(activeElement))
        : null
    const root = activeRoot ?? paneRoots[paneRoots.length - 1]
    return root?.getAttribute("data-composer-id") ?? null
  }

  const getPreferredSelectedComposerId = () => {
    const part = document.getElementById("workbench.parts.editor")
    if (!(part instanceof HTMLElement)) return null
    const activeGroup = part.querySelector(
      ".editor-group-container.active"
    )
    return (
      getSelectedComposerIdFromGroup(activeGroup) ??
      getSelectedComposerIdFromGroup(getMainEditorGroup())
    )
  }

  const scoreRecordActivity = record => {
    let score = 0
    const activeElement = document.activeElement
    if (
      activeElement instanceof Element &&
      (record.root.contains(activeElement) ||
        record.input.contains(activeElement))
    ) {
      score += 4000
    }
    if (record.root.closest(".editor-group-container.active")) score += 2000
    const group = record.root.closest(".editor-group-container")
    if (
      getSelectedComposerIdFromGroup(group) === record.composerId
    ) {
      score += 8000
    }
    const auxiliarySurface = record.root.closest(auxiliaryPartSelector)
    if (isRenderedElement(auxiliarySurface)) {
      score += 2500
    }
    if (mounted?.composerId === record.composerId && isOwnedPanelActive()) {
      score += 1000
    }
    if (record.composerId === activeComposerId) score += 100
    return score
  }

  const selectActiveRecord = (records, preferredComposerId) => {
    const selectableRecords = preferredComposerId
      ? records.filter(
          record => record.composerId === preferredComposerId
        )
      : records
    if (preferredComposerId && selectableRecords.length === 0) {
      return null
    }
    const composerScores = new Map()
    selectableRecords.forEach(record => {
      const score = scoreRecordActivity(record)
      composerScores.set(
        record.composerId,
        Math.max(composerScores.get(record.composerId) ?? -1, score)
      )
    })

    let selectedComposerId = null
    let selectedComposerScore = -1
    composerScores.forEach((score, composerId) => {
      if (score >= selectedComposerScore) {
        selectedComposerId = composerId
        selectedComposerScore = score
      }
    })
    if (!selectedComposerId) return null

    let selected = null
    let selectedScore = -1
    selectableRecords
      .filter(record => record.composerId === selectedComposerId)
      .forEach(record => {
        const state = getState(record.composerId)
        const preferredNative =
          state.placement === "bottom"
            ? state.nativePlacement === "chat"
              ? "pane"
              : "editor"
            : state.placement === "chat"
              ? "pane"
              : "editor"
        const score =
          scoreRecordActivity(record) +
          (record.surface === preferredNative ? 3000 : 0)
        if (score >= selectedScore) {
          selected = record
          selectedScore = score
        }
      })
    return selected
  }

  const getRootState = (root, composerId) => {
    const nativePlacement =
      getNativeSurface(root) === "pane" ? "chat" : "editor"
    const state = getState(composerId, nativePlacement)
    if (
      state.nativePlacement !== nativePlacement ||
      (state.placement !== "bottom" && state.placement !== nativePlacement)
    ) {
      return dispatch(composerId, {
        type: "NATIVE_READY",
        placement: nativePlacement,
      })
    }
    return state
  }

  const projectControlOrigin =
    workspaceControlConfig && workspaceControlConfig.bridgePort > 0
      ? (workspaceControlConfig.useHttps ? "https" : "http") +
        "://localhost:" + workspaceControlConfig.bridgePort
      : null

  const requestProjectControl = async (path, options = {}) => {
    if (!projectControlOrigin) {
      throw new Error("Project control is unavailable")
    }
    const response = await fetch(projectControlOrigin + path, {
      ...options,
      headers: {
        authorization: "Bearer " + workspaceControlConfig.controlToken,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
    })
    if (!response.ok) {
      throw new Error("Project control returned HTTP " + response.status)
    }
    return response.json()
  }

  const getProjectPickerState = composerId => {
    let state = projectPickerStates.get(composerId)
    if (!state) {
      state = {
        data: null,
        error: null,
        loadedAt: 0,
        request: null,
      }
      projectPickerStates.set(composerId, state)
    }
    return state
  }

  const getProjectPickerElements = composerId =>
    Array.from(
      document.querySelectorAll("[" + projectPickerAttribute + "]")
    ).filter(picker => picker.dataset.composerId === composerId)

  const getUnavailableProjectLabel = folderUri => {
    const path = folderUri.replace(/\\/$/u, "").split("/").pop()
    return "Unavailable: " + (path ? decodeURIComponent(path) : folderUri)
  }

  const getProjectPickerPresentation = state => {
    if (state.error) {
      return {
        label: "Projects unavailable",
        title: state.error,
        disabled: true,
        workspaceKey: null,
        options: [],
      }
    }

    const data = state.data
    if (!data) {
      return {
        label: "Loading projects...",
        title: "Loading projects",
        disabled: true,
        workspaceKey: null,
        options: [],
      }
    }
    if (data.kind === "ambiguous") {
      return {
        label: "Project window unavailable",
        title:
          "Close other Cursor windows before choosing a project for a new chat",
        disabled: true,
        workspaceKey: null,
        options: [],
      }
    }
    if (data.kind !== "ready") {
      return {
        label: "Projects unavailable",
        title: "The extension host has not published this workspace",
        disabled: true,
        workspaceKey: null,
        options: [],
      }
    }

    const options = []
    if (data.selectedFolderUri && !data.selectedFolderAvailable) {
      options.push({
        value: data.selectedFolderUri,
        label: getUnavailableProjectLabel(data.selectedFolderUri),
        disabled: true,
        selected: true,
      })
    }
    data.folders.forEach(folder => {
      options.push({
        value: folder.uri,
        label: folder.name,
        disabled: false,
        selected: data.selectedFolderAvailable
          ? folder.uri === (data.selectedFolderUri || data.folders[0]?.uri)
          : false,
      })
    })
    if (options.length === 0) {
      options.push({
        value: "",
        label: "No workspace folders",
        disabled: true,
        selected: true,
      })
    }

    const selectedOption =
      options.find(option => option.selected) ?? options[0]
    return {
      label: selectedOption.label,
      title: data.selectedFolderAvailable
        ? "Default project for this chat"
        : "The selected project is no longer open",
      // A single available folder is still shown as the current project
      // default instead of being disabled; only a folderless window disables
      // the picker.
      disabled: data.folders.length === 0,
      workspaceKey: data.workspaceKey,
      options,
    }
  }

  const closeProjectPicker = (restoreFocus = false) => {
    if (!openProjectPicker) return
    const { picker, menu } = openProjectPicker
    openProjectPicker = null
    menu.remove()
    const trigger = picker.querySelector(
      "button[" + projectPickerTriggerAttribute + "]"
    )
    if (trigger instanceof HTMLButtonElement) {
      trigger.setAttribute("aria-expanded", "false")
      if (restoreFocus) trigger.focus()
    }
  }

  const positionProjectPickerMenu = (trigger, menu) => {
    const triggerRect = trigger.getBoundingClientRect()
    const gap = 6
    const edge = 8
    const width = Math.max(220, Math.min(320, menu.offsetWidth))
    menu.style.width = width + "px"
    const left = Math.min(
      Math.max(edge, triggerRect.left),
      window.innerWidth - width - edge
    )
    const menuHeight = menu.offsetHeight
    const topAbove = triggerRect.top - menuHeight - gap
    const top = topAbove >= edge
      ? topAbove
      : Math.min(
          window.innerHeight - menuHeight - edge,
          triggerRect.bottom + gap
        )
    menu.style.left = left + "px"
    menu.style.top = Math.max(edge, top) + "px"
  }

  const moveProjectPickerFocus = (menu, direction) => {
    const options = Array.from(
      menu.querySelectorAll("button[role='option']:not(:disabled)")
    )
    if (options.length === 0) return
    const activeIndex = options.indexOf(document.activeElement)
    const nextIndex = activeIndex < 0
      ? direction > 0 ? 0 : options.length - 1
      : (activeIndex + direction + options.length) % options.length
    options[nextIndex].focus()
  }

  const openProjectPickerMenu = picker => {
    const trigger = picker.querySelector(
      "button[" + projectPickerTriggerAttribute + "]"
    )
    if (!(trigger instanceof HTMLButtonElement) || trigger.disabled) return
    const composerId = picker.dataset.composerId
    if (!composerId) return
    const presentation = getProjectPickerPresentation(
      getProjectPickerState(composerId)
    )
    if (presentation.disabled || presentation.options.length === 0) return

    closeProjectPicker()
    const menu = document.createElement("div")
    menu.setAttribute(projectPickerMenuAttribute, "")
    menu.setAttribute("role", "listbox")
    menu.setAttribute("aria-label", "Project")
    presentation.options.forEach(option => {
      const item = document.createElement("button")
      item.type = "button"
      item.setAttribute("role", "option")
      item.setAttribute("aria-selected", option.selected ? "true" : "false")
      item.disabled = option.disabled
      item.dataset.value = option.value

      const label = document.createElement("span")
      label.className = "agent-vibes-project-picker-option-label"
      label.textContent = option.label
      const check = document.createElement("span")
      check.className = "codicon codicon-check"
      check.setAttribute("aria-hidden", "true")
      if (!option.selected) check.style.visibility = "hidden"
      item.append(label, check)
      item.addEventListener("click", () => {
        closeProjectPicker(true)
        void selectProject(picker, option.value)
      })
      menu.append(item)
    })
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault()
        closeProjectPicker(true)
        return
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        moveProjectPickerFocus(menu, event.key === "ArrowDown" ? 1 : -1)
        return
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault()
        const options = Array.from(
          menu.querySelectorAll("button[role='option']:not(:disabled)")
        )
        const option = event.key === "Home"
          ? options[0]
          : options[options.length - 1]
        option?.focus()
      }
    })
    document.body.append(menu)
    openProjectPicker = { picker, menu }
    trigger.setAttribute("aria-expanded", "true")
    positionProjectPickerMenu(trigger, menu)
    const selected = menu.querySelector(
      "button[role='option'][aria-selected='true']:not(:disabled)"
    )
    const first = menu.querySelector("button[role='option']:not(:disabled)")
    ;(selected ?? first)?.focus()
  }

  const toggleProjectPicker = picker => {
    if (openProjectPicker?.picker === picker) {
      closeProjectPicker(true)
      return
    }
    openProjectPickerMenu(picker)
  }

  const renderProjectPicker = composerId => {
    const presentation = getProjectPickerPresentation(
      getProjectPickerState(composerId)
    )
    getProjectPickerElements(composerId).forEach(picker => {
      const trigger = picker.querySelector(
        "button[" + projectPickerTriggerAttribute + "]"
      )
      const label = picker.querySelector(
        ".agent-vibes-project-picker-trigger-label"
      )
      if (!(trigger instanceof HTMLButtonElement) || !(label instanceof HTMLElement)) {
        return
      }
      label.textContent = presentation.label
      trigger.disabled = presentation.disabled
      trigger.title = presentation.title
      if (presentation.workspaceKey) {
        picker.dataset.workspaceKey = presentation.workspaceKey
      } else {
        delete picker.dataset.workspaceKey
      }
      if (presentation.disabled && openProjectPicker?.picker === picker) {
        closeProjectPicker()
      }
    })
  }

  const loadProjectPicker = (composerId, force = false) => {
    const state = getProjectPickerState(composerId)
    if (!workspaceControlConfig?.controlToken || !projectControlOrigin) {
      state.error = "Project control is not configured"
      renderProjectPicker(composerId)
      return
    }
    if (!force && state.data && Date.now() - state.loadedAt < projectPickerRefreshMs) {
      renderProjectPicker(composerId)
      return
    }
    if (state.request) return

    state.error = null
    state.request = requestProjectControl(
      "/api/agent-input/projects/" + encodeURIComponent(composerId)
    )
      .then(data => {
        state.data = data
        state.loadedAt = Date.now()
      })
      .catch(error => {
        state.error = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        state.request = null
        renderProjectPicker(composerId)
      })
  }

  const selectProject = async (picker, folderUri) => {
    const composerId = picker.dataset.composerId
    const workspaceKey = picker.dataset.workspaceKey
    if (!composerId || !workspaceKey || !folderUri) return

    const trigger = picker.querySelector(
      "button[" + projectPickerTriggerAttribute + "]"
    )
    if (trigger instanceof HTMLButtonElement) trigger.disabled = true
    try {
      await requestProjectControl(
        "/api/agent-input/projects/" + encodeURIComponent(composerId),
        {
          method: "PUT",
          body: JSON.stringify({
            workspaceKey,
            folderUri,
          }),
        }
      )
    } catch (error) {
      const state = getProjectPickerState(composerId)
      state.error = error instanceof Error ? error.message : String(error)
    }
    loadProjectPicker(composerId, true)
    // The active project drives which repository the branch picker inspects,
    // so refresh it whenever the project selection changes.
    loadBranchPicker(composerId, true)
  }

  const ensurePickerDock = input => {
    let dock = input.querySelector("[" + pickerDockAttribute + "]")
    if (!(dock instanceof HTMLElement)) {
      dock = document.createElement("div")
      dock.setAttribute(pickerDockAttribute, "")
    }
    // Mount the picker dock as the input box's first child so it inherits the
    // input's visibility and docking transitions while remaining an in-flow
    // context row above the editor on every surface.
    if (input.firstElementChild !== dock) {
      input.insertBefore(dock, input.firstChild)
    }
    return dock
  }

  const ensureProjectPicker = (dock, composerId) => {
    let picker = dock.querySelector("[" + projectPickerAttribute + "]")
    if (!(picker instanceof HTMLElement)) {
      picker = document.createElement("div")
      picker.setAttribute(projectPickerAttribute, "")
      const trigger = document.createElement("button")
      trigger.type = "button"
      trigger.setAttribute(projectPickerTriggerAttribute, "")
      trigger.setAttribute("aria-label", "Project")
      trigger.setAttribute("aria-haspopup", "listbox")
      trigger.setAttribute("aria-expanded", "false")
      const icon = document.createElement("span")
      icon.className = "codicon codicon-folder"
      icon.setAttribute("aria-hidden", "true")
      const label = document.createElement("span")
      label.className = "agent-vibes-project-picker-trigger-label"
      const chevron = document.createElement("span")
      chevron.className = "codicon codicon-chevron-down"
      chevron.setAttribute("aria-hidden", "true")
      trigger.append(icon, label, chevron)
      trigger.addEventListener("click", event => {
        event.stopPropagation()
        toggleProjectPicker(picker)
      })
      trigger.addEventListener("keydown", event => {
        if (event.key !== "ArrowDown") return
        event.preventDefault()
        openProjectPickerMenu(picker)
      })
      picker.append(trigger)
    }

    // The project pill is always the leading element inside the dock.
    if (dock.firstElementChild !== picker) {
      dock.insertBefore(picker, dock.firstChild)
    }

    if (picker.dataset.composerId !== composerId) {
      picker.dataset.composerId = composerId
      delete picker.dataset.workspaceKey
    }
    renderProjectPicker(composerId)
    loadProjectPicker(composerId)
  }

  const getBranchPickerState = composerId => {
    let state = branchPickerStates.get(composerId)
    if (!state) {
      state = {
        data: null,
        error: null,
        actionError: null,
        loadedAt: 0,
        request: null,
      }
      branchPickerStates.set(composerId, state)
    }
    return state
  }

  const getBranchPickerElements = composerId =>
    Array.from(
      document.querySelectorAll("[" + branchPickerAttribute + "]")
    ).filter(picker => picker.dataset.composerId === composerId)

  const getBranchPickerPresentation = state => {
    if (state.error) {
      return {
        label: "Branch unavailable",
        title: state.error,
        disabled: true,
        options: [],
      }
    }
    const data = state.data
    if (!data) {
      return {
        label: "Loading branches...",
        title: "Loading branches",
        disabled: true,
        options: [],
      }
    }
    if (data.kind === "no-project") {
      return {
        label: "No project",
        title: "Choose a project for this chat first",
        disabled: true,
        options: [],
      }
    }
    if (data.kind === "no-repo") {
      return {
        label: "No branch",
        title: "This project is not a Git repository",
        disabled: true,
        options: [],
      }
    }
    if (data.kind !== "ready") {
      return {
        label: "Branch unavailable",
        title: data.message || "Git branch information is unavailable",
        disabled: true,
        options: [],
      }
    }

    const branches = Array.isArray(data.branches) ? data.branches : []
    const current = typeof data.current === "string" ? data.current : null
    const options = branches.map(branch => ({
      value: branch,
      label: branch,
      disabled: false,
      selected: branch === current,
    }))
    const baseTitle = current
      ? "Switch the Git branch for this project"
      : "Detached HEAD — choose a branch to check out"
    if (options.length === 0) {
      return {
        label: current || "No branches",
        title: state.actionError
          ? state.actionError
          : current
            ? "Current branch"
            : "This repository has no local branches",
        disabled: true,
        options: [],
      }
    }
    return {
      label: current || "Detached HEAD",
      title: state.actionError || baseTitle,
      disabled: false,
      options,
    }
  }

  const closeBranchPicker = (restoreFocus = false) => {
    if (!openBranchPicker) return
    const { picker, menu } = openBranchPicker
    openBranchPicker = null
    menu.remove()
    const trigger = picker.querySelector(
      "button[" + branchPickerTriggerAttribute + "]"
    )
    if (trigger instanceof HTMLButtonElement) {
      trigger.setAttribute("aria-expanded", "false")
      if (restoreFocus) trigger.focus()
    }
  }

  const openBranchPickerMenu = picker => {
    const trigger = picker.querySelector(
      "button[" + branchPickerTriggerAttribute + "]"
    )
    if (!(trigger instanceof HTMLButtonElement) || trigger.disabled) return
    const composerId = picker.dataset.composerId
    if (!composerId) return
    const presentation = getBranchPickerPresentation(
      getBranchPickerState(composerId)
    )
    if (presentation.disabled || presentation.options.length === 0) return

    closeBranchPicker()
    const menu = document.createElement("div")
    menu.setAttribute(branchPickerMenuAttribute, "")
    menu.setAttribute("role", "listbox")
    menu.setAttribute("aria-label", "Branch")
    presentation.options.forEach(option => {
      const item = document.createElement("button")
      item.type = "button"
      item.setAttribute("role", "option")
      item.setAttribute("aria-selected", option.selected ? "true" : "false")
      item.disabled = option.disabled
      item.dataset.value = option.value

      const label = document.createElement("span")
      label.className = "agent-vibes-branch-picker-option-label"
      label.textContent = option.label
      const check = document.createElement("span")
      check.className = "codicon codicon-check"
      check.setAttribute("aria-hidden", "true")
      if (!option.selected) check.style.visibility = "hidden"
      item.append(label, check)
      item.addEventListener("click", () => {
        closeBranchPicker(true)
        void selectBranch(picker, option.value)
      })
      menu.append(item)
    })
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault()
        closeBranchPicker(true)
        return
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        moveProjectPickerFocus(menu, event.key === "ArrowDown" ? 1 : -1)
        return
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault()
        const options = Array.from(
          menu.querySelectorAll("button[role='option']:not(:disabled)")
        )
        const option = event.key === "Home"
          ? options[0]
          : options[options.length - 1]
        option?.focus()
      }
    })
    document.body.append(menu)
    openBranchPicker = { picker, menu }
    trigger.setAttribute("aria-expanded", "true")
    positionProjectPickerMenu(trigger, menu)
    const selected = menu.querySelector(
      "button[role='option'][aria-selected='true']:not(:disabled)"
    )
    const first = menu.querySelector("button[role='option']:not(:disabled)")
    ;(selected ?? first)?.focus()
  }

  const toggleBranchPicker = picker => {
    if (openBranchPicker?.picker === picker) {
      closeBranchPicker(true)
      return
    }
    openBranchPickerMenu(picker)
  }

  const renderBranchPicker = composerId => {
    const presentation = getBranchPickerPresentation(
      getBranchPickerState(composerId)
    )
    getBranchPickerElements(composerId).forEach(picker => {
      const trigger = picker.querySelector(
        "button[" + branchPickerTriggerAttribute + "]"
      )
      const label = picker.querySelector(
        ".agent-vibes-branch-picker-trigger-label"
      )
      if (
        !(trigger instanceof HTMLButtonElement) ||
        !(label instanceof HTMLElement)
      ) {
        return
      }
      label.textContent = presentation.label
      trigger.disabled = presentation.disabled
      trigger.title = presentation.title
      if (presentation.disabled && openBranchPicker?.picker === picker) {
        closeBranchPicker()
      }
    })
  }

  const loadBranchPicker = (composerId, force = false) => {
    const state = getBranchPickerState(composerId)
    if (!workspaceControlConfig?.controlToken || !projectControlOrigin) {
      state.error = "Project control is not configured"
      renderBranchPicker(composerId)
      return
    }
    if (
      !force &&
      state.data &&
      Date.now() - state.loadedAt < branchPickerRefreshMs
    ) {
      renderBranchPicker(composerId)
      return
    }
    if (state.request) return

    state.error = null
    state.request = requestProjectControl(
      "/api/agent-input/branches/" + encodeURIComponent(composerId)
    )
      .then(data => {
        state.data = data
        state.loadedAt = Date.now()
      })
      .catch(error => {
        state.error = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        state.request = null
        renderBranchPicker(composerId)
      })
  }

  const selectBranch = async (picker, branch) => {
    const composerId = picker.dataset.composerId
    if (!composerId || !branch) return

    const trigger = picker.querySelector(
      "button[" + branchPickerTriggerAttribute + "]"
    )
    if (trigger instanceof HTMLButtonElement) trigger.disabled = true
    const state = getBranchPickerState(composerId)
    state.actionError = null
    let failed = false
    try {
      const result = await requestProjectControl(
        "/api/agent-input/branches/" + encodeURIComponent(composerId),
        {
          method: "PUT",
          body: JSON.stringify({ branch }),
        }
      )
      if (result && result.ok === false) {
        failed = true
        state.actionError =
          typeof result.message === "string" && result.message
            ? result.message
            : "Failed to switch branch"
      }
    } catch (error) {
      failed = true
      state.actionError = error instanceof Error ? error.message : String(error)
    }
    // Reload to reflect the new HEAD on success; on failure the checkout was a
    // no-op, so keep the cached branch list and surface actionError instead of
    // wiping it with a fresh request.
    if (failed) {
      renderBranchPicker(composerId)
    } else {
      loadBranchPicker(composerId, true)
    }
  }

  const ensureBranchPicker = (dock, composerId) => {
    let picker = dock.querySelector("[" + branchPickerAttribute + "]")
    if (!(picker instanceof HTMLElement)) {
      picker = document.createElement("div")
      picker.setAttribute(branchPickerAttribute, "")
      const trigger = document.createElement("button")
      trigger.type = "button"
      trigger.setAttribute(branchPickerTriggerAttribute, "")
      trigger.setAttribute("aria-label", "Branch")
      trigger.setAttribute("aria-haspopup", "listbox")
      trigger.setAttribute("aria-expanded", "false")
      const icon = document.createElement("span")
      icon.className = "codicon codicon-git-branch"
      icon.setAttribute("aria-hidden", "true")
      const label = document.createElement("span")
      label.className = "agent-vibes-branch-picker-trigger-label"
      const chevron = document.createElement("span")
      chevron.className = "codicon codicon-chevron-down"
      chevron.setAttribute("aria-hidden", "true")
      trigger.append(icon, label, chevron)
      trigger.addEventListener("click", event => {
        event.stopPropagation()
        toggleBranchPicker(picker)
      })
      trigger.addEventListener("keydown", event => {
        if (event.key !== "ArrowDown") return
        event.preventDefault()
        openBranchPickerMenu(picker)
      })
      picker.append(trigger)
    }

    // The branch pill trails the project pill inside the dock.
    if (dock.lastElementChild !== picker) {
      dock.append(picker)
    }

    if (picker.dataset.composerId !== composerId) {
      picker.dataset.composerId = composerId
    }
    renderBranchPicker(composerId)
    loadBranchPicker(composerId)
  }

  const ensureDockPickers = (input, composerId) => {
    const dock = ensurePickerDock(input)
    ensureProjectPicker(dock, composerId)
    ensureBranchPicker(dock, composerId)
  }

  const primeNativeRoots = () => {
    if (!agentInputDockEnabled) return
    document.querySelectorAll(nativeRootSelector).forEach(root => {
      if (!(root instanceof HTMLElement)) return
      const composerId = root.getAttribute("data-composer-id")
      if (!composerId) return
      getRootState(root, composerId)
    })
  }

  const scan = () => {
    try {
      const roots = Array.from(
        document.querySelectorAll(nativeRootSelector)
      ).filter(root => root instanceof HTMLElement)
      const records = []

      roots.forEach(root => {
        const composerId = root.getAttribute("data-composer-id")
        if (!composerId) return
        const location = getNativeLocation(root)
        const surface = getNativeSurface(root)
        if (agentInputDockEnabled) {
          getRootState(root, composerId)
        }
        const input = findReadyInput(root)
        // When an input is already docked for this composer, a different
        // .full-input-box appearing in the native root is an inline
        // message-editing input created by Cursor (e.g. ArrowUp to edit a
        // previous message). Skip it to avoid stealing focus from the
        // message-editing UI.
        if (
          input &&
          mounted &&
          mounted.composerId === composerId &&
          mounted.input !== input
        ) {
          return
        }
        if (input) {
          if (workspaceControlEnabled) {
            ensureDockPickers(input, composerId)
          }
          records.push({
            composerId,
            root,
            input,
            location,
            surface,
          })
        }
      })

      if (!agentInputDockEnabled) return

      const preferredComposerId =
        getPreferredPaneComposerId() ?? getPreferredSelectedComposerId()
      if (mounted && !mounted.sourceRoot.isConnected) {
        const orphanedComposerId = mounted.composerId
        releaseMountedInput(false)
        states.delete(orphanedComposerId)
        if (activeComposerId === orphanedComposerId) {
          activeComposerId = null
        }
      }

      if (
        mounted &&
        preferredComposerId &&
        mounted.composerId !== preferredComposerId
      ) {
        restoreDockedComposer()
      }

      if (
        mounted &&
        mounted.sourceRoot.isConnected &&
        !records.some(
          record =>
            record.composerId === mounted.composerId &&
            record.input === mounted.input
        )
      ) {
        records.push({
          composerId: mounted.composerId,
          root: mounted.sourceRoot,
          input: mounted.input,
          location: getNativeLocation(mounted.sourceRoot),
          surface: getNativeSurface(mounted.sourceRoot),
        })
      }

      const hasReadyInput = records.length > 0
      setPanelAvailable(hasReadyInput)
      if (!hasReadyInput) {
        if (mounted) releaseMountedInput(false)
        activeComposerId = null
        return
      }

      const activeRecord = selectActiveRecord(
        records,
        preferredComposerId
      )
      if (!activeRecord) return
      activeComposerId = activeRecord.composerId

      if (
        mounted &&
        mounted.composerId === activeRecord.composerId &&
        mounted.input !== activeRecord.input
      ) {
        releaseMountedInput(false)
      } else if (
        mounted &&
        mounted.composerId !== activeRecord.composerId
      ) {
        restoreDockedComposer()
      }

      let state = getRootState(
        activeRecord.root,
        activeRecord.composerId
      )
      const panelActive = isOwnedPanelActive()
      const panelVisible = isPanelPartVisible()

      if (!panelActive || !panelVisible) {
        if (mounted?.composerId === activeRecord.composerId) {
          restoreDockedComposer()
          state = getRootState(
            activeRecord.root,
            activeRecord.composerId
          )
        } else if (state.placement === "bottom") {
          state = dispatch(activeRecord.composerId, {
            type: "PANEL_HIDDEN",
          })
        }
        return
      }

      if (state.placement !== "bottom") {
        dispatch(activeRecord.composerId, {
          type: "MOVE",
          placement: "bottom",
        })
      }

      const parts = getPanelParts()
      if (!parts) return
      const input =
        mounted?.composerId === activeRecord.composerId
          ? mounted.input
          : activeRecord.input
      dockInput({ ...activeRecord, input }, parts)
    } finally {
      observer?.takeRecords()
    }
  }

  const scheduleScan = () => {
    if (scanScheduled) return
    scanScheduled = true
    const run = () => {
      scanScheduled = false
      scan()
    }
    if (typeof queueMicrotask === "function") {
      queueMicrotask(run)
    } else {
      Promise.resolve().then(run)
    }
  }

  const nodeTouchesRuntime = node => {
    if (!(node instanceof Element)) return false
    if (
      isPanelToggleElement(node) ||
      node.querySelector(panelToggleSelector) instanceof Element ||
      node.matches(auxiliaryToggleSelector) ||
      node.querySelector(auxiliaryToggleSelector) instanceof Element ||
      node.matches(agentsToggleSelector) ||
      node.querySelector(agentsToggleSelector) instanceof Element ||
      node.matches(ownedPanelCompositeSelector) ||
      node.querySelector(ownedPanelCompositeSelector) instanceof Element ||
      node.matches("[" + ownedPanelActionAttribute + "]")
    ) {
      return true
    }
    if (
      node.matches(
        nativeRootSelector +
          "," +
          inputSelector +
          ",.smooth-height,.aislash-editor-input,.pane-body,.part.panel," +
          auxiliaryPartSelector +
          ",.editor-group-container"
      ) ||
      node.querySelector(
        nativeRootSelector +
          "," +
          inputSelector +
          ",.smooth-height,.aislash-editor-input,.pane-body,.part.panel," +
          auxiliaryPartSelector +
          ",.editor-group-container"
      )
    ) {
      return true
    }
    const actions = node.matches(".part.panel .composite-bar [role='tab']")
      ? [node]
      : Array.from(
          node.querySelectorAll(".part.panel .composite-bar [role='tab']")
        )
    return actions.length > 0
  }

  const mutationTouchesRuntime = record => {
    const target = record.target
    if (record.type === "attributes") {
      return (
        target instanceof Element &&
        (target.matches(nativeRootSelector) ||
          Boolean(target.closest(".part.panel")) ||
          isPanelToggleElement(target) ||
          isAuxiliaryToggleElement(target) ||
          target.matches(agentsToggleSelector) ||
          target.closest(agentsToggleSelector) instanceof Element ||
          target.matches(ownedPanelCompositeSelector) ||
          target.closest(ownedPanelCompositeSelector) instanceof Element ||
          target.matches(".part.panel .composite-bar [role='tab']"))
      )
    }
    const changedStructure = [
      ...record.addedNodes,
      ...record.removedNodes,
    ].some(nodeTouchesRuntime)
    if (changedStructure) return true
    if (
      mounted &&
      target instanceof Node &&
      (target === mounted.input || mounted.input.contains(target))
    ) {
      return false
    }
    if (
      target instanceof Element &&
      (target.closest(".part.panel .composite-bar") ||
        target.closest(
          "[" + panelBodyAttribute + "],[" + panelHostAttribute + "]"
        ))
    ) {
      return true
    }
    return false
  }

  const install = () => {
    if (document.getElementById(styleId)) return
    const style = document.createElement("style")
    style.id = styleId
    const dockSurfaceStyles = agentInputDockEnabled
      ?       "[" + panelUnavailableAttribute + "]{display:none!important}" +
      ".part.panel:has(" + ownedPanelCompositeSelector + ") .composite-bar [role='tab'][aria-selected='true'] .active-item-indicator," +
      "[" + ownedPanelActionAttribute + "] .active-item-indicator{display:none!important}" +
      ".part.panel:has(" + ownedPanelCompositeSelector + ") .composite-bar [role='tab'][aria-selected='true'] .badge," +
      "[" + ownedPanelActionAttribute + "] .badge{display:none!important}" +
      ".part.panel:has(" + ownedPanelCompositeSelector + ") .composite-bar [role='tab'][aria-selected='true'] .action-label," +
      "[" + ownedPanelActionAttribute + "] .action-label{border-bottom-color:transparent!important;box-shadow:none!important}" +
      ownedPanelCompositeSelector + " .pane-body>*:not([" + panelHostAttribute + "]){display:none!important}" +
      ownedPanelCompositeSelector + " .pane-body::before," +
      ownedPanelCompositeSelector + " .pane-body::after{display:none!important;content:none!important}" +
      "[" + panelBodyAttribute + "]{position:relative!important;overflow:hidden!important}" +
      "[" + panelBodyAttribute + "][" + panelMountedAttribute + "] .monaco-list{display:none!important}" +
      "[" + panelHostAttribute + "]{position:absolute;inset:0;display:flex;flex-direction:column;align-items:stretch;box-sizing:border-box;width:100%;height:100%;min-height:0;padding:8px 12px}" +
      "[" + panelHostAttribute + "]>" + inputSelector + "{display:flex!important;flex:1 1 auto!important;flex-direction:column!important;width:100%!important;height:100%!important;min-height:0!important;max-width:none!important;max-height:none!important;margin:0!important}"
      : ""
    const workspaceControlStyles = workspaceControlEnabled
      ? "[" + pickerDockAttribute + "]{position:static;display:flex;align-items:center;box-sizing:border-box;flex:0 0 auto;width:100%;max-width:100%;min-width:0;margin:0;padding:4px 0 8px;background:transparent}" +
      "[" + projectPickerAttribute + "],[" + branchPickerAttribute + "]{display:flex;align-items:center;box-sizing:border-box;flex:0 1 auto;min-width:0;max-width:100%;margin:0;padding:0}" +
      "button[" + projectPickerTriggerAttribute + "]{display:inline-flex;align-items:center;box-sizing:border-box;max-width:240px;height:22px;min-width:0;padding:0 6px 0 0;border:none!important;border-radius:6px;background:transparent!important;color:var(--vscode-descriptionForeground);font:inherit;font-size:12px;line-height:22px;outline:none;box-shadow:none!important;gap:4px;cursor:pointer}" +
      "button[" + projectPickerTriggerAttribute + "]:hover:not(:disabled),button[" + projectPickerTriggerAttribute + "][aria-expanded='true']{background:var(--vscode-toolbar-hoverBackground)!important}" +
      "button[" + projectPickerTriggerAttribute + "]:disabled{cursor:default;opacity:.68}" +
      "button[" + projectPickerTriggerAttribute + "]:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}" +
      "button[" + projectPickerTriggerAttribute + "] .agent-vibes-project-picker-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "button[" + projectPickerTriggerAttribute + "] .codicon{flex:0 0 auto;font-size:12px;opacity:.7}" +
      "[" + projectPickerMenuAttribute + "]{position:fixed;z-index:2600;box-sizing:border-box;min-width:220px;max-width:320px;max-height:280px;padding:4px;overflow-x:hidden;overflow-y:auto;border:1px solid var(--vscode-menu-border,var(--vscode-widget-border));border-radius:6px;background:var(--vscode-menu-background,var(--vscode-editorWidget-background));color:var(--vscode-menu-foreground,var(--vscode-foreground));box-shadow:0 4px 16px var(--vscode-widget-shadow);font-family:-apple-system,BlinkMacSystemFont,'Segoe WPC','Segoe UI',sans-serif;font-size:13px}" +
      "[" + projectPickerMenuAttribute + "] button[role='option']{display:flex;align-items:center;box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:none;border-radius:4px;background:transparent;color:inherit;font:inherit;text-align:left;gap:8px;outline:none;cursor:pointer}" +
      "[" + projectPickerMenuAttribute + "] button[role='option']:hover:not(:disabled),[" + projectPickerMenuAttribute + "] button[role='option']:focus-visible{background:var(--vscode-list-hoverBackground)}" +
      "[" + projectPickerMenuAttribute + "] button[role='option']:disabled{opacity:.55;cursor:default}" +
      "[" + projectPickerMenuAttribute + "] .agent-vibes-project-picker-option-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "[" + projectPickerMenuAttribute + "] .codicon{flex:0 0 auto;font-size:13px}" +
      "button[" + branchPickerTriggerAttribute + "]{display:inline-flex;align-items:center;box-sizing:border-box;max-width:180px;height:22px;min-width:0;padding:0 6px;border:none!important;border-radius:6px;background:transparent!important;color:var(--vscode-descriptionForeground);font:inherit;font-size:12px;line-height:22px;outline:none;box-shadow:none!important;gap:4px;cursor:pointer}" +
      "button[" + branchPickerTriggerAttribute + "]:hover:not(:disabled),button[" + branchPickerTriggerAttribute + "][aria-expanded='true']{background:var(--vscode-toolbar-hoverBackground)!important}" +
      "button[" + branchPickerTriggerAttribute + "]:disabled{cursor:default;opacity:.68}" +
      "button[" + branchPickerTriggerAttribute + "]:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}" +
      "button[" + branchPickerTriggerAttribute + "] .agent-vibes-branch-picker-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "button[" + branchPickerTriggerAttribute + "] .codicon{flex:0 0 auto;font-size:12px;opacity:.7}" +
      "[" + branchPickerMenuAttribute + "]{position:fixed;z-index:2600;box-sizing:border-box;min-width:220px;max-width:320px;max-height:280px;padding:4px;overflow-x:hidden;overflow-y:auto;border:1px solid var(--vscode-menu-border,var(--vscode-widget-border));border-radius:6px;background:var(--vscode-menu-background,var(--vscode-editorWidget-background));color:var(--vscode-menu-foreground,var(--vscode-foreground));box-shadow:0 4px 16px var(--vscode-widget-shadow);font-family:-apple-system,BlinkMacSystemFont,'Segoe WPC','Segoe UI',sans-serif;font-size:13px}" +
      "[" + branchPickerMenuAttribute + "] button[role='option']{display:flex;align-items:center;box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:none;border-radius:4px;background:transparent;color:inherit;font:inherit;text-align:left;gap:8px;outline:none;cursor:pointer}" +
      "[" + branchPickerMenuAttribute + "] button[role='option']:hover:not(:disabled),[" + branchPickerMenuAttribute + "] button[role='option']:focus-visible{background:var(--vscode-list-hoverBackground)}" +
      "[" + branchPickerMenuAttribute + "] button[role='option']:disabled{opacity:.55;cursor:default}" +
      "[" + branchPickerMenuAttribute + "] .agent-vibes-branch-picker-option-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "[" + branchPickerMenuAttribute + "] .codicon{flex:0 0 auto;font-size:13px}"
      : ""
    const dockPanelStyles = agentInputDockEnabled
      ? "[" + panelHostAttribute + "] [" + fillShellAttribute + "]{display:flex!important;flex:1 1 auto!important;flex-direction:column!important;width:100%!important;min-width:0!important;min-height:0!important}" +
      "[" + panelHostAttribute + "] [" + fillEditorAttribute + "]{display:flex!important;flex:1 1 auto!important;flex-direction:column!important;width:100%!important;height:auto!important;min-height:0!important;max-height:none!important}" +
      "[" + panelHostAttribute + "] [" + fillScrollAttribute + "]{display:flex!important;flex:1 1 auto!important;flex-direction:column!important;width:100%!important;min-height:0!important}" +
      "[" + panelHostAttribute + "] [" + fillGridAttribute + "]{flex:1 1 auto!important;width:100%!important;min-height:0!important}" +
      "[" + panelHostAttribute + "] [" + fillEditableAttribute + "]{box-sizing:border-box!important;height:100%!important;min-height:100%!important;width:100%!important;min-width:0!important}" +
      "[" + panelHostAttribute + "] .ai-input-full-input-box-bottom-container{flex:0 0 auto!important;height:auto!important;min-height:0!important;width:100%!important}" +
      "[" + panelHostAttribute + "] .ai-input-full-input-box-bottom-container>*{flex:0 0 auto!important;height:auto!important;min-height:0!important}" +
      ""
      : ""
    style.textContent =
      dockSurfaceStyles + workspaceControlStyles + dockPanelStyles
    document.head.appendChild(style)

    if (agentInputDockEnabled) rememberOwnedPanelAction()
    primeNativeRoots()
    observer = new MutationObserver(mutations => {
      if (!mutations.some(mutationTouchesRuntime)) return
      primeNativeRoots()
      if (agentInputDockEnabled) {
        const available =
          Boolean(document.querySelector(nativeRootSelector + " " + inputSelector)) ||
          Boolean(mounted)
        setPanelAvailable(available)
      }
      scheduleScan()
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-selected",
        "aria-checked",
        "aria-hidden",
        "data-composer-id",
        "data-composer-location",
      ],
    })
    document.addEventListener(
      "click",
      event => {
        const target = event.target
        if (
          openProjectPicker &&
          target instanceof Node &&
          !openProjectPicker.picker.contains(target) &&
          !openProjectPicker.menu.contains(target)
        ) {
          closeProjectPicker()
        }
        if (
          openBranchPicker &&
          target instanceof Node &&
          !openBranchPicker.picker.contains(target) &&
          !openBranchPicker.menu.contains(target)
        ) {
          closeBranchPicker()
        }
        if (!agentInputDockEnabled) return
        if (
          target instanceof Element &&
          (target.closest(".part.panel") ||
            isPanelToggleElement(target))
        ) {
          scheduleScan()
        }
      },
      true
    )
    window.addEventListener("resize", () => {
      closeProjectPicker()
      closeBranchPicker()
      scheduleScan()
    })
    window.addEventListener("blur", () => {
      closeProjectPicker()
      closeBranchPicker()
    })
    scan()
  }

  if (document.head && document.body) {
    install()
  } else {
    document.addEventListener("DOMContentLoaded", install, { once: true })
  }
})()
`
  )
}

function findMatchingBrace(
  content: string,
  openBraceIndex: number
): number | null {
  let depth = 0
  let mode: "code" | "single" | "double" | "template" | "line" | "block" =
    "code"
  let escaped = false

  for (let index = openBraceIndex; index < content.length; index++) {
    const character = content[index]
    const nextCharacter = content[index + 1]

    if (mode === "line") {
      if (character === "\n" || character === "\r") mode = "code"
      continue
    }
    if (mode === "block") {
      if (character === "*" && nextCharacter === "/") {
        mode = "code"
        index++
      }
      continue
    }
    if (mode === "single" || mode === "double" || mode === "template") {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === "\\") {
        escaped = true
        continue
      }
      if (
        (mode === "single" && character === "'") ||
        (mode === "double" && character === '"') ||
        (mode === "template" && character === "`")
      ) {
        mode = "code"
      }
      continue
    }

    if (character === "/" && nextCharacter === "/") {
      mode = "line"
      index++
      continue
    }
    if (character === "/" && nextCharacter === "*") {
      mode = "block"
      index++
      continue
    }
    if (character === "'") {
      mode = "single"
      continue
    }
    if (character === '"') {
      mode = "double"
      continue
    }
    if (character === "`") {
      mode = "template"
      continue
    }
    if (character === "{") {
      depth++
      continue
    }
    if (character === "}") {
      depth--
      if (depth === 0) return index
    }
  }

  return null
}

type MarkedRuntimeRange = {
  start: number
  end: number
}

function findMarkedRuntimeRanges(
  content: string,
  marker: string
): MarkedRuntimeRange[] | null {
  const markerComment = `/*${marker}*/`
  const ranges: MarkedRuntimeRange[] = []
  let markerStart = content.indexOf(markerComment)

  while (markerStart >= 0) {
    const markerEnd = markerStart + markerComment.length
    const runtimePrefixPattern = /\s*;\(\(\)\s*=>\s*\{/uy
    runtimePrefixPattern.lastIndex = markerEnd
    const runtimePrefix = runtimePrefixPattern.exec(content)
    if (!runtimePrefix) return null

    const bodyStart = runtimePrefixPattern.lastIndex - 1
    const bodyEnd = findMatchingBrace(content, bodyStart)
    if (bodyEnd === null) return null

    const invocationPattern = /\s*\)\(\)\s*/uy
    invocationPattern.lastIndex = bodyEnd + 1
    const invocation = invocationPattern.exec(content)
    if (!invocation) return null

    const runtimeEnd = invocationPattern.lastIndex
    ranges.push({ start: markerStart, end: runtimeEnd })
    markerStart = content.indexOf(markerComment, runtimeEnd)
  }

  return ranges
}

function canRemoveMarkedRuntime(content: string, marker: string): boolean {
  return findMarkedRuntimeRanges(content, marker) !== null
}

function removeMarkedRuntime(content: string, marker: string): string | null {
  const ranges = findMarkedRuntimeRanges(content, marker)
  if (ranges === null) return null
  if (ranges.length === 0) return content

  const chunks: string[] = []
  let cursor = 0
  for (const range of ranges) {
    chunks.push(content.slice(cursor, range.start))
    cursor = range.end
  }
  chunks.push(content.slice(cursor))
  return chunks.join("")
}

const CURSOR_AGENT_INPUT_RUNTIME_BOUNDARY_MARKERS: readonly string[] = [
  CURSOR_AGENT_INPUT_RUNTIME_PATCH_MARKER,
  ...CURSOR_AGENT_INPUT_RUNTIME_LEGACY_MARKERS,
  ...CURSOR_AGENT_INPUT_DOCK_LEGACY_MARKERS,
]

const CURSOR_AGENT_INPUT_SHARED_RUNTIME_BOUNDARY_MARKERS: readonly string[] = [
  CURSOR_AGENT_INPUT_RUNTIME_PATCH_MARKER,
  ...CURSOR_AGENT_INPUT_RUNTIME_LEGACY_MARKERS,
]

const CURSOR_AGENT_INPUT_RUNTIME_BOUNDARY_PATTERN_SOURCE =
  CURSOR_AGENT_INPUT_RUNTIME_BOUNDARY_MARKERS.map((marker) =>
    marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  ).join("|")

function findCursorAgentInputDockMarkers(content: string): Set<string> {
  return new Set(
    content.match(
      new RegExp(CURSOR_AGENT_INPUT_DOCK_MARKER_PATTERN_SOURCE, "gu")
    ) ?? []
  )
}

function findCursorAgentInputRuntimeBoundaryMarkers(
  content: string
): Set<string> {
  const markers = new Set(
    content.match(
      new RegExp(CURSOR_AGENT_INPUT_RUNTIME_BOUNDARY_PATTERN_SOURCE, "gu")
    ) ?? []
  )
  const sharedRuntimeMarkers = new Set(
    CURSOR_AGENT_INPUT_SHARED_RUNTIME_BOUNDARY_MARKERS.filter((marker) =>
      markers.has(marker)
    )
  )
  return sharedRuntimeMarkers.size > 0 ? sharedRuntimeMarkers : markers
}

function canRewriteCursorAgentInputRuntime(content: string): boolean {
  const boundaryMarkers = findCursorAgentInputRuntimeBoundaryMarkers(content)
  const hasCurrentBoundary = boundaryMarkers.has(
    CURSOR_AGENT_INPUT_RUNTIME_PATCH_MARKER
  )
  if (
    !hasCurrentBoundary &&
    boundaryMarkers.size === 0 &&
    (content.includes(CURSOR_AGENT_INPUT_DOCK_PATCH_MARKER) ||
      content.includes(CURSOR_WORKSPACE_CONTROL_PATCH_MARKER))
  ) {
    return false
  }

  for (const marker of boundaryMarkers) {
    if (!canRemoveMarkedRuntime(content, marker)) return false
  }
  return content.length > 0
}

export function getCursorAgentInputDockDetails(
  content: string
): CursorAgentInputDockDetails {
  const markers = findCursorAgentInputDockMarkers(content)
  const hasCurrentMarker = markers.has(CURSOR_AGENT_INPUT_DOCK_PATCH_MARKER)
  const hasCurrentBoundary = content.includes(
    CURSOR_AGENT_INPUT_RUNTIME_PATCH_MARKER
  )
  const legacyMarkers = CURSOR_AGENT_INPUT_DOCK_LEGACY_MARKERS.filter(
    (marker) => markers.has(marker)
  )
  const applied =
    hasCurrentMarker && hasCurrentBoundary && legacyMarkers.length === 0

  return {
    applied,
    partial: !applied && (hasCurrentMarker || legacyMarkers.length > 0),
    canApply: canRewriteCursorAgentInputRuntime(content),
    legacyMarkers: [...legacyMarkers],
  }
}

export function getCursorWorkspaceControlDetails(
  content: string
): CursorAgentInputDockDetails {
  const hasMarker = content.includes(CURSOR_WORKSPACE_CONTROL_PATCH_MARKER)
  const hasCurrentBoundary = content.includes(
    CURSOR_AGENT_INPUT_RUNTIME_PATCH_MARKER
  )
  const applied = hasMarker && hasCurrentBoundary

  return {
    applied,
    partial: hasMarker && !applied,
    canApply: canRewriteCursorAgentInputRuntime(content),
    legacyMarkers: [],
  }
}

export function hasCursorAgentInputDockPatch(content: string): boolean {
  return findCursorAgentInputDockMarkers(content).size > 0
}

export function hasCursorWorkspaceControlPatch(content: string): boolean {
  return content.includes(CURSOR_WORKSPACE_CONTROL_PATCH_MARKER)
}

export function removeCursorAgentInputRuntimePatchContent(
  content: string
): string | null {
  let nextContent = content
  for (const marker of findCursorAgentInputRuntimeBoundaryMarkers(content)) {
    const cleanedContent = removeMarkedRuntime(nextContent, marker)
    if (cleanedContent === null) return null
    nextContent = cleanedContent
  }
  return nextContent
}

function rewriteCursorAgentInputRuntime(
  content: string,
  agentInputDockEnabled: boolean,
  workspaceControlEnabled: boolean,
  runtimeConfig: WorkspaceControlRuntimeConfig | null
): string | null {
  if (!canRewriteCursorAgentInputRuntime(content)) return null
  if (workspaceControlEnabled && runtimeConfig === null) return null

  const nextContent = removeCursorAgentInputRuntimePatchContent(content)
  if (nextContent === null) return null
  if (!agentInputDockEnabled && !workspaceControlEnabled) return nextContent

  return (
    buildCursorAgentInputRuntimePatchInsertion(
      agentInputDockEnabled,
      workspaceControlEnabled,
      runtimeConfig
    ) + nextContent
  )
}

export function patchCursorAgentInputDockContent(
  content: string
): string | null {
  const details = getCursorAgentInputDockDetails(content)
  if (details.applied && details.canApply) return content
  if (!details.canApply) return null

  return rewriteCursorAgentInputRuntime(
    content,
    true,
    hasCursorWorkspaceControlPatch(content),
    readWorkspaceControlRuntimeConfig(content)
  )
}

export function removeCursorAgentInputDockPatchContent(
  content: string
): string | null {
  if (!hasCursorAgentInputDockPatch(content)) return content

  return rewriteCursorAgentInputRuntime(
    content,
    false,
    hasCursorWorkspaceControlPatch(content),
    readWorkspaceControlRuntimeConfig(content)
  )
}

export function patchCursorWorkspaceControlContent(
  content: string,
  runtimeConfig: WorkspaceControlRuntimeConfig
): string | null {
  const details = getCursorWorkspaceControlDetails(content)
  if (
    details.applied &&
    details.canApply &&
    JSON.stringify(readWorkspaceControlRuntimeConfig(content)) ===
      JSON.stringify(runtimeConfig)
  ) {
    return content
  }
  if (!details.canApply) return null

  return rewriteCursorAgentInputRuntime(
    content,
    getCursorAgentInputDockDetails(content).applied ||
      CURSOR_AGENT_INPUT_DOCK_LEGACY_MARKERS.some((marker) =>
        content.includes(marker)
      ),
    true,
    runtimeConfig
  )
}

export function removeCursorWorkspaceControlPatchContent(
  content: string
): string | null {
  if (!hasCursorWorkspaceControlPatch(content)) return content

  const dockDetails = getCursorAgentInputDockDetails(content)
  return rewriteCursorAgentInputRuntime(
    content,
    dockDetails.applied || dockDetails.legacyMarkers.length > 0,
    false,
    null
  )
}
