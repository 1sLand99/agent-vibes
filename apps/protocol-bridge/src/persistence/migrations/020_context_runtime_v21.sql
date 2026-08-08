-- Migration 020: extend the durable turn lifecycle for queued user
-- interactions.
--
-- Cursor completes the provider sampling step for an asynchronous AskQuestion
-- before the user submits its answer through a later ConversationAction. The
-- Run remains attached in `waiting_for_tools`; preserve that transition reason
-- as a first-class runtime event while retaining every existing operation and
-- event.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE session_context_runtime_events_v21 (
  conversation_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq > 0),
  phase TEXT NOT NULL CHECK(
    phase IN (
      'received',
      'context_preparing',
      'compacting',
      'context_rebuilding',
      'context_ready',
      'request_streaming',
      'waiting_for_tools',
      'continuing_after_tool',
      'retrying',
      'finalizing',
      'completed',
      'failed',
      'aborted'
    )
  ),
  reason TEXT NOT NULL CHECK(
    reason IN (
      'new_chat_turn',
      'control_continuation',
      'context_preparation_started',
      'context_compaction_started',
      'context_compaction_applied',
      'context_rebuild_started',
      'context_prepared',
      'backend_stream_started',
      'reactive_context_retry',
      'provider_physical_retry',
      'backend_switch',
      'assistant_tool_batch',
      'tool_result_continuation',
      'shell_result_continuation',
      'empty_stream_retry',
      'thinking_only_recovery',
      'max_output_tokens_escalate',
      'max_output_tokens_recovery',
      'max_output_tokens_exhausted',
      'partial_stream_finalized',
      'assistant_final',
      'async_user_interaction_pending',
      'friendly_final',
      'superseded_stream',
      'stream_aborted',
      'stream_error'
    )
  ),
  occurred_at INTEGER NOT NULL CHECK(occurred_at > 0),
  attempt INTEGER NOT NULL CHECK(attempt >= 0),
  backend TEXT,
  model TEXT,
  details_json TEXT CHECK(
    details_json IS NULL OR json_type(details_json) = 'object'
  ),
  PRIMARY KEY (conversation_id, owner_key, operation_id, seq),
  FOREIGN KEY (conversation_id, owner_key, operation_id)
    REFERENCES session_context_runtime_operations(
      conversation_id,
      owner_key,
      operation_id
    ) ON DELETE CASCADE
);

INSERT INTO session_context_runtime_events_v21 (
  conversation_id,
  owner_key,
  operation_id,
  seq,
  phase,
  reason,
  occurred_at,
  attempt,
  backend,
  model,
  details_json
)
SELECT
  conversation_id,
  owner_key,
  operation_id,
  seq,
  phase,
  reason,
  occurred_at,
  attempt,
  backend,
  model,
  details_json
FROM session_context_runtime_events;

DROP TABLE session_context_runtime_events;
ALTER TABLE session_context_runtime_events_v21
  RENAME TO session_context_runtime_events;

UPDATE session_schema_meta
   SET value = '21'
 WHERE key = 'session_graph_version';
