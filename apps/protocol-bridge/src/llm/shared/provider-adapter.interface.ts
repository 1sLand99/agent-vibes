/**
 * Unified Provider Adapter Interface.
 *
 * Each LLM provider (Codex, Claude, Gemini) implements this interface.
 * The Agent Runtime calls these methods without knowing provider-specific
 * transport details (WebSocket, SSE, previous_response_id, etc.).
 *
 * Event format: all adapters emit Claude-compatible SSE event strings,
 * which is the existing lingua franca of the protocol bridge.
 */

// ── Interface ────────────────────────────────────────────────────────

/**
 * ProviderAdapter abstracts a single LLM provider backend.
 *
 * All provider-specific transport logic (WebSocket management, auth,
 * connection pooling, previous_response_id, incremental append)
 * is encapsulated within the adapter implementation.
 *
 * The protocol bridge / agent runtime only interacts through this interface.
 */
export interface ProviderAdapter {
  /**
   * Release provider-specific resources for a conversation.
   * Called when a conversation ends or times out.
   */
  dispose(conversationId: string): void
}
