import { HOOK_FLAG, PAGE_HOOK_SOURCE } from "./chatgpt-web-page-hook"

/**
 * The hook is the only place the outgoing request is touched, and every field
 * it adds was arrived at by finding out what fails when it is missing. These
 * run the real source against a stand-in page, so the rules stay pinned:
 * fields are added to the app's own body, never a body of our own.
 */

interface HookState {
  arm: (
    hint: string,
    prompt: string,
    model?: string | null,
    thinkingEffort?: string | null
  ) => string
  release: () => void
}

function installHook(): {
  hook: HookState
  send: (url: string, body: unknown) => Promise<Record<string, unknown>>
} {
  const seen: { body?: string } = {}
  const scope = {
    window: {
      fetch: (_input: unknown, init: { body?: string }) => {
        seen.body = init.body
        return Promise.resolve({ status: 200, body: null })
      },
    } as Record<string, unknown>,
    document: { querySelector: () => null },
    TextDecoder: class {},
  }
  const windowObject = scope.window as {
    fetch: (input: unknown, init: unknown) => Promise<unknown>
  } & Record<string, unknown>

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(
    "window",
    "document",
    "TextDecoder",
    // Parenthesised because the source starts on its own line, and a bare
    // `return` followed by a newline returns before ever reaching it.
    `return (${PAGE_HOOK_SOURCE})`
  ) as (w: unknown, d: unknown, t: unknown) => unknown
  run(scope.window, scope.document, scope.TextDecoder)

  return {
    hook: windowObject[HOOK_FLAG] as HookState,
    send: async (url: string, body: unknown) => {
      await windowObject.fetch(url, {
        method: "POST",
        body: JSON.stringify(body),
      })
      return JSON.parse(seen.body ?? "{}") as Record<string, unknown>
    },
  }
}

const appBody = () => ({
  action: "next",
  model: "gpt-5-6",
  thinking_effort: "standard",
  messages: [{ id: "aaa", metadata: {} }],
})

describe("the ChatGPT page hook", () => {
  const TURN = "https://chatgpt.com/backend-api/f/conversation"

  it("sends the model and depth the turn asked for", () => {
    const { hook, send } = installHook()
    hook.arm("plugin:asdk_app_x", "hi", "gpt-5-6-thinking", "extended")
    return send(TURN, appBody()).then((body) => {
      expect(body.model).toBe("gpt-5-6-thinking")
      expect(body.thinking_effort).toBe("extended")
      expect(body.system_hints).toEqual(["plugin:asdk_app_x"])
    })
  })

  it("leaves the app's own choice alone when the turn expressed none", async () => {
    // A model with no depths, or a request that asked for nothing, must not
    // turn into an invented value — the page already put a valid one there.
    const { hook, send } = installHook()
    hook.arm("plugin:asdk_app_x", "hi", null, null)
    const body = await send(TURN, appBody())
    expect(body.model).toBe("gpt-5-6")
    expect(body.thinking_effort).toBe("standard")
  })

  it("keeps everything else the app put in the body", async () => {
    const { hook, send } = installHook()
    hook.arm("plugin:asdk_app_x", "hi", "gpt-6-pro", "standard")
    const body = await send(TURN, appBody())
    expect(body.action).toBe("next")
    expect((body.messages as { id: string }[])[0]!.id).toBe("aaa")
  })

  it("touches nothing once the turn is released", async () => {
    const { hook, send } = installHook()
    hook.arm("plugin:asdk_app_x", "hi", "gpt-5-6-thinking", "max")
    hook.release()
    const body = await send(TURN, appBody())
    expect(body.model).toBe("gpt-5-6")
    expect(body.system_hints).toBeUndefined()
  })

  it("leaves requests that are not a turn alone", async () => {
    const { hook, send } = installHook()
    hook.arm("plugin:asdk_app_x", "hi", "gpt-5-6-thinking", "max")
    const body = await send("https://chatgpt.com/backend-api/me", appBody())
    expect(body.model).toBe("gpt-5-6")
    expect(body.system_hints).toBeUndefined()
  })
})
