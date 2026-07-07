-- Migration 011: Persist context-state domain outside sessions.config_json.
--
-- sessions.config_json is configuration-class data only. Model-facing
-- context state, compaction metadata, transcript projection metadata, and
-- turn counters live in this domain-owned table instead of being mixed into
-- the session config row.

CREATE TABLE session_context_state (
  conversation_id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
