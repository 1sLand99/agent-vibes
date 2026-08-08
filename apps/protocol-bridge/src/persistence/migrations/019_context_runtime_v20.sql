-- Migration 019: install the v20 durable context-runtime control plane.
--
-- Runtime progress and Cursor summary delivery were previously reconstructed
-- from process memory and compaction history. Those are not recoverable facts:
-- after a restart they can restart a completed task or redeliver an already
-- emitted report. This cutover discards v19 sessions and gives both lifecycles
-- explicit owner-scoped, revisioned durable state.

PRAGMA defer_foreign_keys = ON;

DELETE FROM sessions;

CREATE TABLE session_context_runtime_operations (
  conversation_id TEXT NOT NULL
    REFERENCES sessions(conversation_id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL CHECK(
    length(owner_key) > 0
    AND owner_key = trim(owner_key)
    AND instr(owner_key, char(0)) = 0
  ),
  operation_id TEXT NOT NULL CHECK(
    length(operation_id) > 0
    AND operation_id = trim(operation_id)
    AND instr(operation_id, char(0)) = 0
  ),
  operation_kind TEXT NOT NULL CHECK(operation_kind = 'turn'),
  top_level_turn_id TEXT NOT NULL CHECK(
    length(top_level_turn_id) > 0
    AND top_level_turn_id = trim(top_level_turn_id)
    AND instr(top_level_turn_id, char(0)) = 0
  ),
  origin TEXT NOT NULL CHECK(
    origin IN ('chat', 'control', 'tool_result', 'shell_result', 'recovery')
  ),
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
  started_at INTEGER NOT NULL CHECK(started_at > 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= started_at),
  attempt INTEGER NOT NULL CHECK(attempt >= 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  stream_id TEXT CHECK(
    stream_id IS NULL OR (
      length(stream_id) > 0
      AND stream_id = trim(stream_id)
      AND instr(stream_id, char(0)) = 0
    )
  ),
  backend TEXT,
  model TEXT,
  backend_model TEXT,
  terminal_at INTEGER CHECK(
    (terminal_at IS NULL AND phase NOT IN ('completed', 'failed', 'aborted'))
    OR
    (terminal_at IS NOT NULL AND phase IN ('completed', 'failed', 'aborted'))
  ),
  PRIMARY KEY (conversation_id, owner_key, operation_id)
);
CREATE UNIQUE INDEX idx_context_runtime_active_operation
  ON session_context_runtime_operations(conversation_id, owner_key)
  WHERE terminal_at IS NULL;
CREATE INDEX idx_context_runtime_operation_history
  ON session_context_runtime_operations(
    conversation_id,
    owner_key,
    started_at DESC
  );
CREATE INDEX idx_context_runtime_top_level_turn
  ON session_context_runtime_operations(
    conversation_id,
    owner_key,
    top_level_turn_id,
    started_at DESC
  );

CREATE TABLE session_context_runtime_events (
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

CREATE TABLE session_context_summary_deliveries (
  conversation_id TEXT NOT NULL
    REFERENCES sessions(conversation_id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL CHECK(
    length(owner_key) > 0
    AND owner_key = trim(owner_key)
    AND instr(owner_key, char(0)) = 0
  ),
  delivery_id TEXT NOT NULL CHECK(
    length(delivery_id) > 0
    AND delivery_id = trim(delivery_id)
    AND instr(delivery_id, char(0)) = 0
  ),
  compaction_id TEXT NOT NULL CHECK(
    length(compaction_id) > 0
    AND compaction_id = trim(compaction_id)
    AND instr(compaction_id, char(0)) = 0
  ),
  epoch INTEGER NOT NULL CHECK(epoch >= 0),
  summary TEXT NOT NULL CHECK(length(trim(summary)) > 0),
  state TEXT NOT NULL CHECK(
    state IN ('pending', 'dispatching', 'delivered', 'interrupted')
  ),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  PRIMARY KEY (conversation_id, owner_key, delivery_id),
  UNIQUE (conversation_id, owner_key, compaction_id, epoch)
);
CREATE INDEX idx_context_summary_pending
  ON session_context_summary_deliveries(
    conversation_id,
    owner_key,
    created_at
  )
  WHERE state = 'pending';

UPDATE session_schema_meta
   SET value = '20'
 WHERE key = 'session_graph_version';
