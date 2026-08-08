-- Migration 021: install the authoritative asynchronous user-interaction
-- lifecycle.
--
-- v21 recorded an async ask only as the last transition of a turn runtime
-- operation. That made the interaction disappear as soon as a continuation
-- advanced the operation, while the immutable tool_result still projected the
-- old `AskQuestionResult.async` value. Replayed ConversationAction frames could
-- therefore reopen the UI or fail the whole Run.
--
-- The old shape has no durable resolution or continuation identity to migrate.
-- Cut over destructively so every retained session obeys the v22 state
-- machine; there is no compatibility reader or dual writer.

PRAGMA defer_foreign_keys = ON;

DELETE FROM sessions;

CREATE TABLE session_async_user_interactions (
  conversation_id TEXT NOT NULL
    REFERENCES sessions(conversation_id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL CHECK(
    length(tool_call_id) > 0
    AND tool_call_id = trim(tool_call_id)
    AND instr(tool_call_id, char(0)) = 0
  ),
  interaction_kind TEXT NOT NULL CHECK(interaction_kind = 'ask_question'),
  operation_id TEXT NOT NULL CHECK(
    length(operation_id) > 0
    AND operation_id = trim(operation_id)
    AND instr(operation_id, char(0)) = 0
  ),
  top_level_turn_id TEXT NOT NULL CHECK(
    length(top_level_turn_id) > 0
    AND top_level_turn_id = trim(top_level_turn_id)
    AND instr(top_level_turn_id, char(0)) = 0
  ),
  stream_id TEXT CHECK(
    stream_id IS NULL OR (
      length(stream_id) > 0
      AND stream_id = trim(stream_id)
      AND instr(stream_id, char(0)) = 0
    )
  ),
  source_message_uuid TEXT NOT NULL CHECK(
    length(source_message_uuid) > 0
    AND source_message_uuid = trim(source_message_uuid)
    AND instr(source_message_uuid, char(0)) = 0
  ),
  original_args_json TEXT NOT NULL CHECK(
    json_valid(original_args_json)
    AND json_type(original_args_json) = 'object'
  ),
  state TEXT NOT NULL CHECK(
    state IN (
      'pending',
      'resolved',
      'continuing',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  resolution_case TEXT CHECK(
    resolution_case IS NULL
    OR resolution_case IN ('success', 'rejected', 'error')
  ),
  resolution_json TEXT CHECK(
    resolution_json IS NULL
    OR (
      json_valid(resolution_json)
      AND json_type(resolution_json) = 'object'
    )
  ),
  resolution_fingerprint TEXT CHECK(
    resolution_fingerprint IS NULL OR (
      length(resolution_fingerprint) = 64
      AND resolution_fingerprint = lower(resolution_fingerprint)
      AND resolution_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  continuation_payload TEXT,
  continuation_source_uuid TEXT CHECK(
    continuation_source_uuid IS NULL OR (
      length(continuation_source_uuid) > 0
      AND continuation_source_uuid = trim(continuation_source_uuid)
      AND instr(continuation_source_uuid, char(0)) = 0
    )
  ),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  resolved_at INTEGER,
  continuation_started_at INTEGER,
  terminal_at INTEGER,
  terminal_reason TEXT CHECK(
    terminal_reason IS NULL OR (
      length(terminal_reason) > 0
      AND terminal_reason = trim(terminal_reason)
      AND instr(terminal_reason, char(0)) = 0
    )
  ),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY (conversation_id, tool_call_id),
  UNIQUE (conversation_id, source_message_uuid),
  UNIQUE (conversation_id, continuation_source_uuid),
  FOREIGN KEY (conversation_id, source_message_uuid)
    REFERENCES session_messages(conversation_id, uuid) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, continuation_source_uuid)
    REFERENCES session_messages(conversation_id, uuid) ON DELETE CASCADE,
  CHECK(
    (
      state = 'pending'
      AND resolution_case IS NULL
      AND resolution_json IS NULL
      AND resolution_fingerprint IS NULL
      AND continuation_payload IS NULL
      AND resolved_at IS NULL
      AND continuation_source_uuid IS NULL
      AND continuation_started_at IS NULL
      AND terminal_at IS NULL
      AND terminal_reason IS NULL
    )
    OR
    (
      state = 'resolved'
      AND resolution_case IS NOT NULL
      AND resolution_json IS NOT NULL
      AND resolution_fingerprint IS NOT NULL
      AND continuation_payload IS NOT NULL
      AND resolved_at IS NOT NULL
      AND continuation_source_uuid IS NULL
      AND continuation_started_at IS NULL
      AND terminal_at IS NULL
      AND terminal_reason IS NULL
    )
    OR
    (
      state = 'continuing'
      AND resolution_case IS NOT NULL
      AND resolution_json IS NOT NULL
      AND resolution_fingerprint IS NOT NULL
      AND continuation_payload IS NOT NULL
      AND resolved_at IS NOT NULL
      AND continuation_source_uuid IS NOT NULL
      AND continuation_started_at IS NOT NULL
      AND terminal_at IS NULL
      AND terminal_reason IS NULL
    )
    OR
    (
      state IN ('completed', 'failed')
      AND resolution_case IS NOT NULL
      AND resolution_json IS NOT NULL
      AND resolution_fingerprint IS NOT NULL
      AND continuation_payload IS NOT NULL
      AND resolved_at IS NOT NULL
      AND continuation_source_uuid IS NOT NULL
      AND continuation_started_at IS NOT NULL
      AND terminal_at IS NOT NULL
      AND terminal_reason IS NOT NULL
    )
    OR
    (
      state = 'cancelled'
      AND terminal_at IS NOT NULL
      AND terminal_reason IS NOT NULL
      AND (
        (
          resolution_case IS NULL
          AND resolution_json IS NULL
          AND resolution_fingerprint IS NULL
          AND continuation_payload IS NULL
          AND resolved_at IS NULL
          AND continuation_source_uuid IS NULL
          AND continuation_started_at IS NULL
        )
        OR
        (
          resolution_case IS NOT NULL
          AND resolution_json IS NOT NULL
          AND resolution_fingerprint IS NOT NULL
          AND continuation_payload IS NOT NULL
          AND resolved_at IS NOT NULL
          AND (
            (
              continuation_source_uuid IS NULL
              AND continuation_started_at IS NULL
            )
            OR
            (
              continuation_source_uuid IS NOT NULL
              AND continuation_started_at IS NOT NULL
            )
          )
        )
      )
    )
  )
);

CREATE INDEX idx_async_user_interactions_active
  ON session_async_user_interactions(conversation_id, state, created_at)
  WHERE state IN ('pending', 'resolved', 'continuing');

CREATE INDEX idx_async_user_interactions_recovery
  ON session_async_user_interactions(state, updated_at)
  WHERE state IN ('resolved', 'continuing');

UPDATE session_schema_meta
   SET value = '22'
 WHERE key = 'session_graph_version';
