import "reflect-metadata"
import { UnauthorizedException } from "@nestjs/common"
import { SELF_DECLARED_DEPS_METADATA } from "@nestjs/common/constants"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import {
  WorkspacePreferenceController,
  isLoopbackControlAddress,
  parseControlBearerToken,
} from "../src/protocol/cursor/controllers/workspace-preference.controller"
import { PersistenceService } from "../src/persistence"
import {
  SqliteWorkspacePreferenceRepository,
  WorkspacePreferenceService,
} from "../src/protocol/cursor/session/workspace-preference.service"
import {
  WorkspacePreferenceRegistry,
  type WorkspacePreferenceRecord,
  type WorkspacePreferenceRepository,
  promoteWorkspaceRoot,
} from "../src/protocol/cursor/session/workspace-preference"

const projectContext = {
  rootPath: "/workspace/alpha",
  directories: ["/workspace/alpha", "/workspace/beta", "/workspace/gamma"],
  files: [],
  workspaceFolders: [
    {
      uri: "file:///workspace/alpha",
      path: "/workspace/alpha",
      name: "alpha",
    },
    {
      uri: "file:///workspace/beta",
      path: "/workspace/beta",
      name: "beta",
    },
    {
      uri: "file:///workspace/gamma",
      path: "/workspace/gamma",
      name: "gamma",
    },
  ],
}

void test("promotes a selected workspace without dropping sibling roots", () => {
  const promoted = promoteWorkspaceRoot(projectContext, "/workspace/beta")

  assert.ok(promoted)
  assert.equal(promoted.rootPath, "/workspace/beta")
  assert.deepEqual(promoted.directories, [
    "/workspace/beta",
    "/workspace/alpha",
    "/workspace/gamma",
  ])
  assert.deepEqual(
    promoted.workspaceFolders?.map((folder) => folder.name),
    ["beta", "alpha", "gamma"]
  )
  assert.equal(promoted.workspaceFolders?.[0]?.uri, "file:///workspace/beta")
})

void test("rejects paths outside the IDE workspace folder list", () => {
  assert.equal(
    promoteWorkspaceRoot(projectContext, "/workspace/not-open"),
    null
  )
})

void test("supports legacy single-root project contexts", () => {
  const legacyContext = {
    rootPath: "/workspace/alpha",
    directories: ["/workspace/alpha"],
    files: [],
  }

  assert.equal(
    promoteWorkspaceRoot(legacyContext, "/workspace/alpha"),
    legacyContext
  )
  assert.equal(promoteWorkspaceRoot(legacyContext, "/workspace/beta"), null)
})

class MemoryPreferenceRepository implements WorkspacePreferenceRepository {
  readonly records = new Map<string, WorkspacePreferenceRecord>()

  get(composerId: string): WorkspacePreferenceRecord | undefined {
    return this.records.get(composerId)
  }

  upsert(record: WorkspacePreferenceRecord): void {
    this.records.set(record.composerId, record)
  }
}

const registeredFolders = projectContext.workspaceFolders.map((folder) => ({
  ...folder,
}))

void test("accepts selections only from host-registered workspace folders", () => {
  const repository = new MemoryPreferenceRepository()
  const registry = new WorkspacePreferenceRegistry(repository)

  assert.equal(
    registry.synchronizeWorkspace("install-token", {
      instanceId: "window-one",
      workspaceKey: "workspace-one",
      folders: registeredFolders,
    }),
    true
  )
  assert.equal(
    registry.selectWorkspace("install-token", {
      composerId: "conversation-one",
      workspaceKey: "workspace-one",
      folderUri: "file:///workspace/beta",
    }),
    true
  )
  assert.equal(
    registry.selectWorkspace("install-token", {
      composerId: "conversation-one",
      workspaceKey: "workspace-one",
      folderUri: "file:///workspace/not-open",
    }),
    false
  )
  assert.equal(
    repository.get("conversation-one")?.folderPath,
    "/workspace/beta"
  )
})

void test("fails closed when a new composer cannot be assigned to one window", () => {
  const repository = new MemoryPreferenceRepository()
  const registry = new WorkspacePreferenceRegistry(repository)
  registry.synchronizeWorkspace("install-token", {
    instanceId: "window-one",
    workspaceKey: "workspace-one",
    folders: registeredFolders,
  })
  registry.synchronizeWorkspace("install-token", {
    instanceId: "window-two",
    workspaceKey: "workspace-two",
    folders: [
      {
        uri: "file:///workspace/other",
        path: "/workspace/other",
        name: "other",
      },
    ],
  })

  assert.deepEqual(registry.getPickerState("install-token", "new-composer"), {
    kind: "ambiguous",
    selectedFolderUri: undefined,
  })
})

void test("binds a preference to the exact protocol conversation id on every parse", () => {
  const repository = new MemoryPreferenceRepository()
  const registry = new WorkspacePreferenceRegistry(repository)
  registry.synchronizeWorkspace("install-token", {
    instanceId: "window-one",
    workspaceKey: "workspace-one",
    folders: registeredFolders,
  })
  registry.selectWorkspace("install-token", {
    composerId: "conversation-one",
    workspaceKey: "workspace-one",
    folderUri: "file:///workspace/beta",
  })

  const unrelated = registry.applyToRequest("conversation-two", {
    projectContext,
  })
  assert.equal(unrelated.projectContext, projectContext)

  const firstParse = registry.applyToRequest("conversation-one", {
    projectContext,
  })
  const refreshedParse = registry.applyToRequest("conversation-one", {
    projectContext: {
      ...projectContext,
      workspaceFolders: projectContext.workspaceFolders.map((folder) => ({
        ...folder,
      })),
    },
  })

  assert.equal(firstParse.projectContext?.rootPath, "/workspace/beta")
  assert.equal(refreshedParse.projectContext?.rootPath, "/workspace/beta")
  assert.deepEqual(refreshedParse.projectContext?.directories, [
    "/workspace/beta",
    "/workspace/alpha",
    "/workspace/gamma",
  ])
})

void test("keeps a missing selected folder visible instead of switching projects", () => {
  const repository = new MemoryPreferenceRepository()
  const registry = new WorkspacePreferenceRegistry(repository)
  registry.synchronizeWorkspace("install-token", {
    instanceId: "window-one",
    workspaceKey: "workspace-one",
    folders: registeredFolders,
  })
  registry.selectWorkspace("install-token", {
    composerId: "conversation-one",
    workspaceKey: "workspace-one",
    folderUri: "file:///workspace/beta",
  })
  registry.synchronizeWorkspace("install-token", {
    instanceId: "window-one",
    workspaceKey: "workspace-one",
    folders: registeredFolders.filter(
      (folder) => folder.uri !== "file:///workspace/beta"
    ),
  })

  const state = registry.getPickerState("install-token", "conversation-one")
  assert.equal(state.kind, "ready")
  assert.equal(state.selectedFolderUri, "file:///workspace/beta")
  assert.equal(state.selectedFolderAvailable, false)
  assert.deepEqual(
    state.folders?.map((folder) => folder.uri),
    ["file:///workspace/alpha", "file:///workspace/gamma"]
  )
})

void test("accepts only loopback control requests with bearer tokens", () => {
  assert.equal(isLoopbackControlAddress("127.0.0.1"), true)
  assert.equal(isLoopbackControlAddress("::1"), true)
  assert.equal(isLoopbackControlAddress("::ffff:127.0.0.1"), true)
  assert.equal(isLoopbackControlAddress("192.168.1.10"), false)
  assert.equal(parseControlBearerToken("Bearer install-token"), "install-token")
  assert.equal(parseControlBearerToken("Basic install-token"), null)
  assert.equal(parseControlBearerToken(undefined), null)
})

void test("rejects control tokens that do not match the bridge installation", () => {
  const envName = "AGENT_VIBES_AGENT_INPUT_CONTROL_TOKEN"
  const previousToken = process.env[envName]
  const controller = new WorkspacePreferenceController({
    getPickerState: () => ({
      kind: "unavailable",
      selectedFolderUri: undefined,
    }),
  } as unknown as WorkspacePreferenceService)

  try {
    process.env[envName] = "install-token"
    assert.throws(
      () =>
        controller.getProjects(
          { ip: "127.0.0.1" } as never,
          "Bearer other-token",
          "conversation-one"
        ),
      UnauthorizedException
    )

    delete process.env[envName]
    assert.throws(
      () =>
        controller.getProjects(
          { ip: "127.0.0.1" } as never,
          "Bearer install-token",
          "conversation-one"
        ),
      UnauthorizedException
    )
  } finally {
    if (previousToken === undefined) delete process.env[envName]
    else process.env[envName] = previousToken
  }
})

void test("persists composer preferences across registry instances", () => {
  const database = new DatabaseSync(":memory:")
  database.exec(`
    CREATE TABLE workspace_preferences (
      composer_id TEXT PRIMARY KEY,
      workspace_key TEXT NOT NULL,
      folder_uri TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  const persistence = { database }
  const firstRepository = new SqliteWorkspacePreferenceRepository(persistence)
  firstRepository.upsert({
    composerId: "conversation-one",
    workspaceKey: "workspace-one",
    folderUri: "file:///workspace/beta",
    folderPath: "/workspace/beta",
    updatedAt: 123,
  })

  const restoredRepository = new SqliteWorkspacePreferenceRepository(
    persistence
  )
  assert.deepEqual(restoredRepository.get("conversation-one"), {
    composerId: "conversation-one",
    workspaceKey: "workspace-one",
    folderUri: "file:///workspace/beta",
    folderPath: "/workspace/beta",
    updatedAt: 123,
  })
  database.close()
})

void test("declares the persistence service as the Nest injection token", () => {
  const dependencies = Reflect.getMetadata(
    SELF_DECLARED_DEPS_METADATA,
    WorkspacePreferenceService
  ) as Array<{ index: number; param: unknown }> | undefined

  assert.equal(
    dependencies?.find(({ index }) => index === 0)?.param,
    PersistenceService
  )
})
