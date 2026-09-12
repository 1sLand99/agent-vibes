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
  };
  window.${HOOK_FLAG} = state;
  const originalFetch = window.fetch;

  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const isTurn = url.includes("/f/conversation") && !url.includes("/prepare");
    const isPrepare = url.includes("/f/conversation/prepare");

    if ((isTurn || isPrepare) && state.hint && init && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        body.system_hints = [state.hint];
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
  window.${HOOK_FLAG}.arm = (hint, prompt) => {
    state.hint = hint;
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
    return "armed";
  };

  window.${HOOK_FLAG}.sendButton = () => {
    const button = document.querySelector('[data-testid="send-button"]');
    if (!button || button.disabled) return null;
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  };

  window.${HOOK_FLAG}.progress = () =>
    JSON.stringify({
      done: state.done,
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
    state.chunks = [];
  };

  return "installed";
})()
`
