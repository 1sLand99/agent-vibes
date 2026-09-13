/**
 * Script injected into the ChatGPT page.
 *
 * It wraps `window.fetch` to do two things to the request the app is about to
 * send for a composer submission:
 *
 *   1. Attach a connector, exactly as selecting its chip would — the app's own
 *      sentinel, turnstile and integrity headers ride along untouched.
 *   2. Tee the response stream, so the caller gets the raw SSE while the page
 *      still renders normally.
 *
 * The mutation is deliberately minimal. Replacing the whole body — even with
 * one captured from a real request — does not activate the connector; only
 * adding these fields to the body the app itself produced does. Everything
 * else the app put there (message ids, the correlation with its own prepare
 * call, timestamps) has to survive untouched.
 */

/** Marker so a reload is detectable and a re-injection is idempotent. */
export const HOOK_FLAG = "__agentVibesHook"

export const PAGE_HOOK_SOURCE = `
(() => {
  if (window.${HOOK_FLAG}) return "already";
  const state = {
    hint: null,
    chunks: [],
    done: false,
    failed: null,
    active: false,
    model: null,
    thinkingEffort: null,
    // Set when the app's own turn request passes through, which is the only
    // trustworthy sign that the send landed.
    sent: false,
    /** The last conversation URL seen, so a missed send names its endpoint. */
    lastUrl: null,
  };
  window.${HOOK_FLAG} = state;
  const originalFetch = window.fetch;

  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    // The app posts a turn to /backend-api/conversation or to the /f/ variant
    // depending on which composer is on screen, so match either. Anything
    // narrower silently misses the send: no interception, no response to read,
    // and a turn that clicks a button at an empty box until it gives up.
    const path = url.split("?")[0] || "";
    const isPrepare =
      path.endsWith("/backend-api/conversation/prepare") ||
      path.endsWith("/backend-api/f/conversation/prepare");
    const isTurn =
      !isPrepare &&
      (path.endsWith("/backend-api/conversation") ||
        path.endsWith("/backend-api/f/conversation"));
    if (isTurn || isPrepare) state.lastUrl = url;

    if ((isTurn || isPrepare) && state.hint && init && typeof init.body === "string") {
      if (isTurn) state.sent = true;
      try {
        const body = JSON.parse(init.body);
        body.system_hints = [state.hint];
        // Only ever added, never invented: an unset field leaves whatever the
        // app itself chose, which is the tab's current model and depth.
        if (state.model) body.model = state.model;
        if (state.thinkingEffort) body.thinking_effort = state.thinkingEffort;
        const message = body.messages ? body.messages[0] : body.partial_query;
        if (message) {
          message.metadata = message.metadata || {};
          message.metadata.system_hints = [state.hint];
          message.metadata.serialization_metadata = {
            custom_symbol_offsets: [{
              id: state.hint,
              symbol: "ecosystemMention",
              startIndex: 0,
              endIndex: 12,
            }],
          };
        }
        init = Object.assign({}, init, { body: JSON.stringify(body) });
      } catch (error) {
        state.failed = "could not rewrite request: " + String(error);
      }
    }

    const response = originalFetch.call(this, input, init);
    if (!isTurn || !state.active) return response;

    return response.then((res) => {
      if (!res.body) {
        state.failed = "upstream returned status " + res.status;
        state.done = true;
        return res;
      }
      const [forPage, forUs] = res.body.tee();
      (async () => {
        const reader = forUs.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            state.chunks.push(decoder.decode(value, { stream: true }));
          }
        } catch (error) {
          state.failed = String(error);
        } finally {
          state.done = true;
        }
      })();
      return new Response(forPage, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    });
  };

  /**
   * Arm the hook and put the prompt in the composer. The send itself must come
   * from the browser's own input pipeline (CDP Input), because a synthetic
   * event does not drive the app's send handler.
   */
  window.${HOOK_FLAG}.arm = (hint, prompt, model, thinkingEffort) => {
    state.hint = hint;
    state.model = model || null;
    state.thinkingEffort = thinkingEffort || null;
    state.sent = false;
    state.chunks = [];
    state.done = false;
    state.failed = null;
    state.active = true;
    const composer = document.querySelector("#prompt-textarea");
    if (!composer) return "no-composer";
    composer.focus();
    // The composer is a rich-text node, so its text has to be inserted the way
    // typing would; assigning value or textContent leaves React's model stale
    // and the send button disabled.
    document.execCommand("selectAll", false, undefined);
    document.execCommand("insertText", false, prompt);
    // Saying "armed" without checking has meant a turn waiting on a send that
    // could never happen: a composer the app had already replaced keeps the
    // focus and the insert, and the one on screen stays empty.
    const landed = (composer.innerText || composer.value || "").trim();
    if (landed !== prompt.trim()) return "not-typed:" + landed.slice(0, 40);
    return "armed";
  };

  window.${HOOK_FLAG}.sendButton = () => {
    // The composer has worn several shapes — a plain chat box, and the one the
    // work/agent view puts up — so the test id is tried first and the button
    // beside the composer second.
    let button = document.querySelector('[data-testid="send-button"]');
    if (!button) {
      const composer = document.querySelector("#prompt-textarea");
      const form = composer && composer.closest("form");
      const candidates = form
        ? form.querySelectorAll('button[type="submit"],button[aria-label]')
        : [];
      for (const candidate of candidates) {
        const label = (candidate.getAttribute("aria-label") || "").toLowerCase();
        if (!candidate.disabled && /send|提交|发送/.test(label)) {
          button = candidate;
          break;
        }
      }
    }
    if (!button || button.disabled) return null;
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  };

  window.${HOOK_FLAG}.progress = () =>
    JSON.stringify({
      done: state.done,
      sent: state.sent,
      lastUrl: state.lastUrl,
      composer: (() => {
        const node = document.querySelector("#prompt-textarea");
        return node ? (node.innerText || "").slice(0, 60) : "(none)";
      })(),
      chunks: state.chunks.length,
      failed: state.failed,
    });

  window.${HOOK_FLAG}.drain = () => {
    const text = state.chunks.join("");
    state.chunks = [];
    return text;
  };

  window.${HOOK_FLAG}.release = () => {
    state.active = false;
    state.hint = null;
    state.model = null;
    state.thinkingEffort = null;
    state.sent = false;
    state.chunks = [];
  };

  return "installed";
})()
`
