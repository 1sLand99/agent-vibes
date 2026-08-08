-- Migration 014: durable conversation graph and provider-native recovery.
--
-- This is intentionally destructive. Earlier session schemas persisted a
-- mixture of transcript rows, mutable context JSON and in-memory-only turn
-- state. Those records cannot be converted without guessing their graph or
-- provider semantics. Clear every session-owned table and install session
-- graph schema v17 as one atomic migration; there is no legacy reader or dual
-- writer.

-- The retired graph has intentional cycles between messages and sub-agent
-- runs/executions. No DROP ordering can satisfy those immediate foreign keys
-- while rows exist. The migration runner owns the surrounding transaction;
-- defer its legacy constraints until this complete authoritative replacement
-- has installed an empty, internally consistent v17 graph.
PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS summaries;
DROP TABLE IF EXISTS cursor_sessions;
DROP TABLE IF EXISTS session_schema_meta;
DROP TABLE IF EXISTS session_cursor_wire_blobs;
DROP TABLE IF EXISTS session_cursor_wire_frames;
DROP TABLE IF EXISTS session_exec_terminal_routes;
DROP TABLE IF EXISTS session_exec_dispatches;
DROP TABLE IF EXISTS session_provider_active_heads;
DROP TABLE IF EXISTS session_claude_projection_mutations;
DROP TABLE IF EXISTS session_subagent_run_executions;
DROP TABLE IF EXISTS session_subagent_branch_heads;
DROP TABLE IF EXISTS session_subagent_runs;
DROP TABLE IF EXISTS session_codex_rollout_items;
DROP TABLE IF EXISTS session_claude_projection_records;
DROP TABLE IF EXISTS session_memory_events;
DROP TABLE IF EXISTS session_snip_boundaries;
DROP TABLE IF EXISTS session_context_projection_heads;
DROP TABLE IF EXISTS session_context_projection_records;
DROP TABLE IF EXISTS session_message_revisions;
DROP TABLE IF EXISTS session_context_state;
DROP TABLE IF EXISTS session_read_paths;
DROP TABLE IF EXISTS session_message_blobs;
DROP TABLE IF EXISTS session_todos;
DROP TABLE IF EXISTS session_file_states;
DROP TABLE IF EXISTS turn_events;
DROP TABLE IF EXISTS tool_call_ledger;
DROP TABLE IF EXISTS session_messages;
DROP TABLE IF EXISTS sessions;

CREATE TABLE sessions (
  conversation_id TEXT PRIMARY KEY CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  model TEXT NOT NULL,
  config_json TEXT NOT NULL
);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity_at);

-- The durable transcript is a graph. `provider_message_id` is deliberately
-- not unique: one streamed provider message can produce multiple local
-- fragments/content blocks.
CREATE TABLE session_messages (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  seq INTEGER NOT NULL,
  uuid TEXT NOT NULL UNIQUE CHECK(
    length(uuid) > 0
    AND uuid = trim(uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(uuid, char(0)) = 0
  ),
  parent_uuid TEXT CHECK(parent_uuid IS NULL OR (
    length(parent_uuid) > 0
    AND parent_uuid = trim(parent_uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(parent_uuid, char(0)) = 0
  )),
  logical_parent_uuid TEXT CHECK(logical_parent_uuid IS NULL OR (
    length(logical_parent_uuid) > 0
    AND logical_parent_uuid = trim(logical_parent_uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(logical_parent_uuid, char(0)) = 0
  )),
  source_tool_assistant_uuid TEXT CHECK(source_tool_assistant_uuid IS NULL OR (
    length(source_tool_assistant_uuid) > 0
    AND source_tool_assistant_uuid = trim(source_tool_assistant_uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(source_tool_assistant_uuid, char(0)) = 0
  )),
  -- Only logical accepted projection ownership is durable here. Transport
  -- backends/accounts are audit metadata, never graph provider identities.
  provider TEXT CHECK(provider IS NULL OR provider IN ('claude', 'codex')),
  provider_message_id TEXT CHECK(provider_message_id IS NULL OR (
    length(provider_message_id) > 0
    AND provider_message_id = trim(provider_message_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(provider_message_id, char(0)) = 0
  )),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  is_meta INTEGER NOT NULL DEFAULT 0 CHECK(is_meta IN (0, 1)),
  block_occurrence INTEGER NOT NULL DEFAULT 0 CHECK(block_occurrence >= 0),
  turn_id TEXT CHECK(turn_id IS NULL OR (
    length(turn_id) > 0
    AND turn_id = trim(turn_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(turn_id, char(0)) = 0
  )),
  thread_id TEXT CHECK(thread_id IS NULL OR (
    length(thread_id) > 0
    AND thread_id = trim(thread_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(thread_id, char(0)) = 0
  )),
  branch_id TEXT CHECK(branch_id IS NULL OR (
    length(branch_id) > 0
    AND branch_id = trim(branch_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(branch_id, char(0)) = 0
  )),
  agent_id TEXT CHECK(agent_id IS NULL OR (
    length(agent_id) > 0
    AND agent_id = trim(agent_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(agent_id, char(0)) = 0
  )),
  is_sidechain INTEGER NOT NULL DEFAULT 0 CHECK(is_sidechain IN (0, 1)),
  fork_source_uuid TEXT CHECK(fork_source_uuid IS NULL OR (
    length(fork_source_uuid) > 0
    AND fork_source_uuid = trim(fork_source_uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(fork_source_uuid, char(0)) = 0
  )),
  fork_lineage_json TEXT,
  timestamp INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY (conversation_id, seq),
  UNIQUE (conversation_id, uuid),
  -- Branch-head ownership needs this exact composite key: a head cannot point
  -- at a graph UUID owned by another sub-agent, even through a raw writer.
  UNIQUE (conversation_id, agent_id, uuid),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE,
  -- Non-sidechain graph rows never carry a local child branch identity. A
  -- sidechain has all static branch coordinates plus an owned execution lease.
  CHECK(
    (is_sidechain = 0
      AND thread_id IS NULL
      AND branch_id IS NULL
      AND agent_id IS NULL
      AND fork_source_uuid IS NULL
      AND fork_lineage_json IS NULL)
    OR
    (is_sidechain = 1
      AND turn_id IS NOT NULL
      AND thread_id IS NOT NULL
      AND branch_id IS NOT NULL
      AND agent_id IS NOT NULL
      AND fork_source_uuid IS NOT NULL
      AND fork_lineage_json IS NOT NULL
      AND json_valid(fork_lineage_json)
      AND json_type(fork_lineage_json) = 'array'
      AND json_array_length(fork_lineage_json) > 0
      AND json_extract(fork_lineage_json, '$[#-1]') = fork_source_uuid)
  ),
  -- The static branch belongs to exactly one durable run. SQLite MATCH SIMPLE
  -- leaves this FK inactive for main rows because their branch fields are NULL.
  FOREIGN KEY (
    conversation_id, agent_id, thread_id, branch_id,
    fork_source_uuid, fork_lineage_json
  ) REFERENCES session_subagent_runs(
    conversation_id, agent_id, thread_id, branch_id,
    fork_source_uuid, fork_lineage_json
  ) ON DELETE RESTRICT,
  -- The current run row may later point at another execution after handoff;
  -- graph rows retain the exact historical lease through this relation.
  FOREIGN KEY (conversation_id, agent_id, turn_id)
    REFERENCES session_subagent_run_executions(
      conversation_id, agent_id, execution_turn_id
    ) ON DELETE RESTRICT
);
CREATE INDEX idx_session_messages_uuid ON session_messages(uuid);
CREATE INDEX idx_session_messages_conv_seq
  ON session_messages(conversation_id, seq);
CREATE INDEX idx_session_messages_parent
  ON session_messages(conversation_id, parent_uuid);
CREATE INDEX idx_session_messages_logical_parent
  ON session_messages(conversation_id, logical_parent_uuid);
CREATE INDEX idx_session_messages_provider_message
  ON session_messages(conversation_id, provider, provider_message_id);
CREATE INDEX idx_session_messages_turn
  ON session_messages(conversation_id, turn_id, seq);
CREATE INDEX idx_session_messages_fork_source
  ON session_messages(conversation_id, fork_source_uuid);
-- Sidechain prompt reconstruction and branch-local revision projection are
-- always scoped by this durable local thread, never by an in-memory cache.
CREATE INDEX idx_session_messages_sidechain_thread
  ON session_messages(conversation_id, thread_id, seq)
  WHERE is_sidechain = 1;

-- Branch lineage is part of the durable sidechain identity. SQLite cannot
-- express every JSON member constraint in a table CHECK, so enforce exactly
-- the same nonempty/full-JS-trim/NUL contract on both raw write paths.
CREATE TRIGGER session_messages_fork_lineage_identity_insert
BEFORE INSERT ON session_messages
FOR EACH ROW
WHEN NEW.is_sidechain = 1
  AND json_valid(NEW.fork_lineage_json)
  AND (
    EXISTS (
      SELECT 1
        FROM json_each(NEW.fork_lineage_json) AS lineage
       WHERE lineage.type <> 'text'
          OR lineage.value = ''
          OR lineage.value <> trim(lineage.value, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
          OR instr(lineage.value, char(0)) <> 0
    )
    OR (
      SELECT COUNT(DISTINCT lineage.value)
        FROM json_each(NEW.fork_lineage_json) AS lineage
    ) <> json_array_length(NEW.fork_lineage_json)
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'session_messages fork lineage requires unique canonical identities'
  );
END;

CREATE TRIGGER session_messages_fork_lineage_identity_update
BEFORE UPDATE OF fork_lineage_json, fork_source_uuid ON session_messages
FOR EACH ROW
WHEN NEW.is_sidechain = 1
  AND json_valid(NEW.fork_lineage_json)
  AND (
    EXISTS (
      SELECT 1
        FROM json_each(NEW.fork_lineage_json) AS lineage
       WHERE lineage.type <> 'text'
          OR lineage.value = ''
          OR lineage.value <> trim(lineage.value, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
          OR instr(lineage.value, char(0)) <> 0
    )
    OR (
      SELECT COUNT(DISTINCT lineage.value)
        FROM json_each(NEW.fork_lineage_json) AS lineage
    ) <> json_array_length(NEW.fork_lineage_json)
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'session_messages fork lineage requires unique canonical identities'
  );
END;

-- Provider-neutral append-only Snip boundaries. A Snip is a projection
-- transform over immutable graph rows; `after_graph_uuid` reconstructs its
-- order from graph sequence even when a compact provider layout omits the
-- anchored message.
CREATE TABLE session_snip_boundaries (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  seq INTEGER NOT NULL,
  boundary_id TEXT NOT NULL CHECK(
    length(boundary_id) > 0
    AND boundary_id = trim(boundary_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(boundary_id, char(0)) = 0
  ),
  after_graph_uuid TEXT NOT NULL CHECK(
    length(after_graph_uuid) > 0
    AND after_graph_uuid = trim(after_graph_uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(after_graph_uuid, char(0)) = 0
  ),
  removed_record_ids_json TEXT NOT NULL CHECK(
    json_valid(removed_record_ids_json)
    AND json_type(removed_record_ids_json) = 'array'
    AND json_array_length(removed_record_ids_json) > 0
  ),
  trigger TEXT NOT NULL CHECK(trigger IN ('user', 'model')),
  reason TEXT,
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  PRIMARY KEY (conversation_id, seq),
  UNIQUE (conversation_id, boundary_id),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_session_snip_boundaries_anchor
  ON session_snip_boundaries(conversation_id, after_graph_uuid, seq);

CREATE TRIGGER session_snip_boundaries_removed_ids_insert
BEFORE INSERT ON session_snip_boundaries
FOR EACH ROW
WHEN json_valid(NEW.removed_record_ids_json)
  AND (
    EXISTS (
      SELECT 1
        FROM json_each(NEW.removed_record_ids_json) AS removed
       WHERE removed.type <> 'text'
          OR removed.value = ''
          OR removed.value <> trim(removed.value, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
          OR instr(removed.value, char(0)) <> 0
    )
    OR (
      SELECT COUNT(DISTINCT removed.value)
        FROM json_each(NEW.removed_record_ids_json) AS removed
    ) <> json_array_length(NEW.removed_record_ids_json)
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'session_snip_boundaries removed record ids require unique canonical identities'
  );
END;

CREATE TRIGGER session_snip_boundaries_removed_ids_update
BEFORE UPDATE OF removed_record_ids_json ON session_snip_boundaries
FOR EACH ROW
WHEN json_valid(NEW.removed_record_ids_json)
  AND (
    EXISTS (
      SELECT 1
        FROM json_each(NEW.removed_record_ids_json) AS removed
       WHERE removed.type <> 'text'
          OR removed.value = ''
          OR removed.value <> trim(removed.value, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
          OR instr(removed.value, char(0)) <> 0
    )
    OR (
      SELECT COUNT(DISTINCT removed.value)
        FROM json_each(NEW.removed_record_ids_json) AS removed
    ) <> json_array_length(NEW.removed_record_ids_json)
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'session_snip_boundaries removed record ids require unique canonical identities'
  );
END;

-- Explicit lifecycle memory is an append-only event stream, independent of
-- compaction summaries and session config.  Each revision retains the exact
-- terminal graph fragment that supplied its source result/control delivery,
-- so recovery never guesses a relationship from rendered report text or a
-- task invocation.
CREATE TABLE session_memory_events (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  seq INTEGER NOT NULL,
  source_event_id TEXT NOT NULL CHECK(
    length(source_event_id) > 0
    AND source_event_id = trim(source_event_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(source_event_id, char(0)) = 0
  ),
  revision INTEGER NOT NULL CHECK(revision > 0),
  kind TEXT NOT NULL CHECK(kind IN ('sub_agent')),
  source_tool_use_id TEXT NOT NULL CHECK(
    length(source_tool_use_id) > 0
    AND source_tool_use_id = trim(source_tool_use_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(source_tool_use_id, char(0)) = 0
  ),
  source_record_uuid TEXT NOT NULL CHECK(
    length(source_record_uuid) > 0
    AND source_record_uuid = trim(source_record_uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(source_record_uuid, char(0)) = 0
  ),
  source_kind TEXT NOT NULL CHECK(source_kind IN (
    'tool_result', 'control_notification'
  )),
  payload_json TEXT NOT NULL,
  weight INTEGER NOT NULL CHECK(weight >= 0),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  PRIMARY KEY (conversation_id, seq),
  UNIQUE (conversation_id, source_event_id, revision),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE,
  -- Both terminal source identities must belong to this memory event's own
  -- conversation. A globally unique graph UUID is insufficient: accepting it
  -- alone would permit a raw row to point at another conversation's result.
  FOREIGN KEY (conversation_id, source_record_uuid)
    REFERENCES session_messages(conversation_id, uuid) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, source_tool_use_id)
    REFERENCES tool_call_ledger(conversation_id, tool_use_id) ON DELETE CASCADE
);
CREATE INDEX idx_session_memory_events_identity
  ON session_memory_events(conversation_id, source_event_id, revision);
CREATE INDEX idx_session_memory_events_source
  ON session_memory_events(conversation_id, source_tool_use_id, seq);

-- A revision can refresh the structured lifecycle payload, but a durable
-- event id has exactly one accepted terminal-delivery owner. Enforce that at
-- the storage boundary as well as in SessionMemoryEventStore so a raw writer
-- cannot rebind a memory fact to another task/result/control record.
CREATE TRIGGER session_memory_events_provenance_immutable
BEFORE INSERT ON session_memory_events
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM session_memory_events AS existing
   WHERE existing.conversation_id = NEW.conversation_id
     AND existing.source_event_id = NEW.source_event_id
     AND (
       existing.source_tool_use_id <> NEW.source_tool_use_id
       OR existing.source_record_uuid <> NEW.source_record_uuid
       OR existing.source_kind <> NEW.source_kind
     )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'session_memory_events provenance is immutable per source event'
  );
END;

-- Memory rows are an event log, not mutable state. A later lifecycle change
-- always appends a revision, so even a raw writer cannot edit payload, weight,
-- or terminal provenance in place.
CREATE TRIGGER session_memory_events_append_only
BEFORE UPDATE ON session_memory_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'session_memory_events are append-only');
END;

-- Original fragments are immutable. Later stop/usage/signature metadata is
-- represented as an ordered revision rather than an UPDATE of the transcript.
CREATE TABLE session_message_revisions (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  message_uuid TEXT NOT NULL CHECK(
    length(message_uuid) > 0
    AND message_uuid = trim(message_uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(message_uuid, char(0)) = 0
  ),
  revision_seq INTEGER NOT NULL,
  revision_kind TEXT NOT NULL CHECK(
    length(revision_kind) > 0
    AND revision_kind = trim(revision_kind, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(revision_kind, char(0)) = 0
  ),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, message_uuid, revision_seq),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_session_message_revisions_message
  ON session_message_revisions(conversation_id, message_uuid, revision_seq);

-- Provider-neutral compaction is an immutable projection generation, never a
-- mutable context JSON snapshot. Each explicit projection owner has its own
-- compact generations and exactly one generic head. Provider-native layouts
-- live in their own stores and never select or replace this generic head.
CREATE TABLE session_context_projection_records (
  conversation_id TEXT NOT NULL REFERENCES sessions(conversation_id) ON DELETE CASCADE CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  owner_key TEXT NOT NULL CHECK(
    length(owner_key) > 0
    AND owner_key = trim(owner_key, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(owner_key, char(0)) = 0
  ),
  generation INTEGER NOT NULL CHECK(generation > 0),
  seq INTEGER NOT NULL CHECK(seq > 0),
  record_id TEXT NOT NULL CHECK(
    length(record_id) > 0
    AND record_id = trim(record_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(record_id, char(0)) = 0
  ),
  record_kind TEXT NOT NULL CHECK(record_kind IN ('projection_layout', 'synthetic_record')),
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  PRIMARY KEY (conversation_id, owner_key, generation, seq),
  UNIQUE (conversation_id, owner_key, generation, record_id)
);
CREATE INDEX idx_context_projection_records_generation
  ON session_context_projection_records(
    conversation_id, owner_key, generation, seq
  );

CREATE TABLE session_context_projection_heads (
  conversation_id TEXT NOT NULL REFERENCES sessions(conversation_id) ON DELETE CASCADE CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  owner_key TEXT NOT NULL CHECK(
    length(owner_key) > 0
    AND owner_key = trim(owner_key, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(owner_key, char(0)) = 0
  ),
  generation INTEGER NOT NULL CHECK(generation > 0),
  layout_record_id TEXT NOT NULL CHECK(
    length(layout_record_id) > 0
    AND layout_record_id = trim(layout_record_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(layout_record_id, char(0)) = 0
  ),
  graph_watermark_uuid TEXT NOT NULL CHECK(
    length(graph_watermark_uuid) > 0
    AND graph_watermark_uuid = trim(graph_watermark_uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(graph_watermark_uuid, char(0)) = 0
  ),
  active_compaction_id TEXT NOT NULL CHECK(
    length(active_compaction_id) > 0
    AND active_compaction_id = trim(active_compaction_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(active_compaction_id, char(0)) = 0
  ),
  updated_at INTEGER NOT NULL CHECK(updated_at > 0),
  PRIMARY KEY (conversation_id, owner_key),
  -- The selected layout must be a generation owned by this exact projection
  -- owner, not merely an immutable record from the same conversation.
  FOREIGN KEY (conversation_id, owner_key, generation, layout_record_id)
    REFERENCES session_context_projection_records(
      conversation_id, owner_key, generation, record_id
    ) ON DELETE RESTRICT,
  -- The mounted graph watermark belongs to this exact conversation. A global
  -- UUID reference alone would allow a corrupted head to point at another
  -- conversation's graph and rely on recovery to discover it later.
  FOREIGN KEY (conversation_id, graph_watermark_uuid)
    REFERENCES session_messages(conversation_id, uuid) ON DELETE RESTRICT
);
CREATE INDEX idx_context_projection_heads_generation
  ON session_context_projection_heads(conversation_id, owner_key, generation);

-- Tool protocol ownership remains independent from the transcript graph.
CREATE TABLE tool_call_ledger (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  tool_use_id TEXT NOT NULL CHECK(
    length(tool_use_id) > 0
    AND tool_use_id = trim(tool_use_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(tool_use_id, char(0)) = 0
  ),
  -- Imported Cursor conversation history predates any bridge runtime turn.
  -- Such rows retain a NULL turn_id and explicit source instead of a
  -- fabricated bootstrap turn identity.
  turn_id TEXT CHECK(turn_id IS NULL OR (
    length(turn_id) > 0
    AND turn_id = trim(turn_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(turn_id, char(0)) = 0
  )),
  origin TEXT NOT NULL CHECK(origin IN ('runtime', 'cursor_history')),
  tool_name TEXT NOT NULL CHECK(
    length(tool_name) > 0
    AND tool_name = trim(tool_name, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(tool_name, char(0)) = 0
  ),
  state TEXT NOT NULL CHECK(state IN ('open', 'closed', 'aborted')),
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  abort_reason TEXT,
  open_message_seq INTEGER NOT NULL,
  close_message_seq INTEGER,
  PRIMARY KEY (conversation_id, tool_use_id),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_ledger_turn ON tool_call_ledger(conversation_id, turn_id);
CREATE INDEX idx_ledger_open
  ON tool_call_ledger(conversation_id, state)
  WHERE state = 'open';

-- Turn audit is append-only and intentionally not used as a transcript
-- commit gate: fragments may arrive before a terminal turn state.
CREATE TABLE turn_events (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  owner_key TEXT NOT NULL CHECK(
    length(owner_key) > 0
    AND owner_key = trim(owner_key, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(owner_key, char(0)) = 0
  ),
  turn_id TEXT NOT NULL CHECK(
    length(turn_id) > 0
    AND turn_id = trim(turn_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(turn_id, char(0)) = 0
  ),
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  event_kind TEXT NOT NULL CHECK(
    length(event_kind) > 0
    AND event_kind = trim(event_kind, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(event_kind, char(0)) = 0
  ),
  event_json TEXT NOT NULL,
  PRIMARY KEY (conversation_id, turn_id, seq),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_turn_events_turn ON turn_events(conversation_id, owner_key, turn_id);

CREATE TABLE session_file_states (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  path TEXT NOT NULL CHECK(
    length(path) > 0
    AND path = trim(path, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(path, char(0)) = 0
  ),
  before_content BLOB NOT NULL,
  after_content BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, path),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);

CREATE TABLE session_todos (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  id TEXT NOT NULL CHECK(
    length(id) > 0
    AND id = trim(id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(id, char(0)) = 0
  ),
  content TEXT NOT NULL CHECK(length(trim(content)) > 0),
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'in_progress', 'completed', 'cancelled'
  )),
  created_at INTEGER NOT NULL CHECK(
    typeof(created_at) = 'integer' AND created_at > 0
  ),
  updated_at INTEGER NOT NULL CHECK(
    typeof(updated_at) = 'integer' AND updated_at >= created_at
  ),
  dependencies_json TEXT NOT NULL CHECK(
    json_valid(dependencies_json)
    AND json_type(dependencies_json) = 'array'
  ),
  PRIMARY KEY (conversation_id, id),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);

-- `json_each` cannot appear in a table CHECK. Keep the array shape in the
-- table contract and reject malformed dependency members at both raw-write
-- entry points, so a durable todo never needs recovery-time normalization.
CREATE TRIGGER session_todos_dependencies_insert
BEFORE INSERT ON session_todos
FOR EACH ROW
WHEN json_valid(NEW.dependencies_json)
  AND EXISTS (
    SELECT 1
      FROM json_each(NEW.dependencies_json)
     WHERE type <> 'text'
        OR value = ''
        OR value <> trim(value, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
        OR instr(value, char(0)) <> 0
  )
BEGIN
  SELECT RAISE(ABORT, 'session_todos dependencies must be non-empty strings');
END;

CREATE TRIGGER session_todos_dependencies_update
BEFORE UPDATE OF dependencies_json ON session_todos
FOR EACH ROW
WHEN json_valid(NEW.dependencies_json)
  AND EXISTS (
    SELECT 1
      FROM json_each(NEW.dependencies_json)
     WHERE type <> 'text'
        OR value = ''
        OR value <> trim(value, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
        OR instr(value, char(0)) <> 0
  )
BEGIN
  SELECT RAISE(ABORT, 'session_todos dependencies must be non-empty strings');
END;

CREATE TABLE session_message_blobs (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  blob_id TEXT NOT NULL CHECK(
    length(blob_id) > 0
    AND blob_id = trim(blob_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(blob_id, char(0)) = 0
  ),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, blob_id),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);

CREATE TABLE session_read_paths (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  path TEXT NOT NULL CHECK(
    length(path) > 0
    AND path = trim(path, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(path, char(0)) = 0
  ),
  read_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, path),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);

-- Cursor protocol data is stored as exact bytes. It is never reconstructed
-- from JSON or injected into a model prompt.
CREATE TABLE session_cursor_wire_frames (
  -- The first AgentRun frame is captured after its conversation id is decoded
  -- but before a local runtime session is created. Exact wire evidence must
  -- therefore remain conversation-scoped instead of depending on sessions.
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  stream_epoch TEXT NOT NULL CHECK(
    length(stream_epoch) > 0
    AND stream_epoch = trim(stream_epoch, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(stream_epoch, char(0)) = 0
  ),
  seq INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  frame_kind TEXT NOT NULL CHECK(
    length(frame_kind) > 0
    AND frame_kind = trim(frame_kind, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(frame_kind, char(0)) = 0
  ),
  payload BLOB NOT NULL,
  captured_at INTEGER NOT NULL CHECK(captured_at > 0),
  PRIMARY KEY (conversation_id, stream_epoch, seq)
);
CREATE INDEX idx_cursor_wire_frames_conversation
  ON session_cursor_wire_frames(conversation_id, captured_at);

CREATE TABLE session_cursor_wire_blobs (
  -- UploadConversationBlobs is legal before the first AgentService/Run.
  -- This is therefore a Cursor-conversation store, not a child of the local
  -- runtime `sessions` row. Session deletion removes its rows explicitly.
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  -- Canonical base64url key for the exact opaque Cursor `bytes id`.
  blob_id TEXT NOT NULL CHECK(
    length(blob_id) > 0
    AND blob_id = trim(blob_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(blob_id, char(0)) = 0
  ),
  blob_kind TEXT NOT NULL CHECK(
    length(blob_kind) > 0
    AND blob_kind = trim(blob_kind, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(blob_kind, char(0)) = 0
  ),
  payload BLOB NOT NULL,
  captured_at INTEGER NOT NULL CHECK(captured_at > 0),
  PRIMARY KEY (conversation_id, blob_id)
);

-- Exact identity correlation for Cursor client-executed tools. IDs are not
-- interchangeable; every nullable field retains the source domain that
-- supplied it.
CREATE TABLE session_exec_dispatches (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  stream_epoch TEXT NOT NULL CHECK(
    length(stream_epoch) > 0
    AND stream_epoch = trim(stream_epoch, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(stream_epoch, char(0)) = 0
  ),
  -- Numeric control-slot identity; unique only within a Cursor stream.
  exec_id INTEGER NOT NULL CHECK(exec_id > 0),
  -- Exact ExecServerMessage.exec_id / ExecClientMessage.exec_id value.
  protocol_exec_id TEXT NOT NULL CHECK(
    length(protocol_exec_id) > 0
    AND protocol_exec_id = trim(protocol_exec_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(protocol_exec_id, char(0)) = 0
  ),
  turn_id TEXT CHECK(turn_id IS NULL OR (
    length(turn_id) > 0
    AND turn_id = trim(turn_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(turn_id, char(0)) = 0
  )),
  tool_call_id TEXT CHECK(tool_call_id IS NULL OR (
    length(tool_call_id) > 0
    AND tool_call_id = trim(tool_call_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(tool_call_id, char(0)) = 0
  )),
  call_id TEXT CHECK(call_id IS NULL OR (
    length(call_id) > 0
    AND call_id = trim(call_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(call_id, char(0)) = 0
  )),
  model_call_id TEXT CHECK(model_call_id IS NULL OR (
    length(model_call_id) > 0
    AND model_call_id = trim(model_call_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(model_call_id, char(0)) = 0
  )),
  dispatch_kind TEXT NOT NULL CHECK(
    length(dispatch_kind) > 0
    AND dispatch_kind = trim(dispatch_kind, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(dispatch_kind, char(0)) = 0
  ),
  -- The durable outbox owns the exact server-frame lifecycle. A result can
  -- prove that a frame reached the client while `dispatching`, but never while
  -- it is still only queued locally.
  state TEXT NOT NULL CHECK(state IN ('queued', 'dispatching', 'dispatched', 'awaiting_interrupted_resolution', 'reattached', 'settled', 'cancelled')),
  frame_payload BLOB NOT NULL,
  label TEXT NOT NULL CHECK(length(label) > 0),
  queued_at INTEGER NOT NULL CHECK(queued_at > 0),
  dispatching_at INTEGER CHECK(dispatching_at IS NULL OR dispatching_at > 0),
  dispatched_at INTEGER CHECK(dispatched_at IS NULL OR dispatched_at > 0),
  reattached_at INTEGER CHECK(reattached_at IS NULL OR reattached_at > 0),
  settled_at INTEGER CHECK(settled_at IS NULL OR settled_at > 0),
  terminal_reason TEXT,
  PRIMARY KEY (conversation_id, stream_epoch, exec_id),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_exec_dispatch_tool_call
  ON session_exec_dispatches(conversation_id, tool_call_id);
CREATE INDEX idx_exec_dispatch_protocol
  ON session_exec_dispatches(
    conversation_id,
    stream_epoch,
    protocol_exec_id,
    exec_id
  );
CREATE INDEX idx_exec_dispatch_state
  ON session_exec_dispatches(conversation_id, state);

-- A sub-agent run is a first-class execution owned by exactly one parent
-- task tool call. This is the lifecycle authority for foreground and
-- background work alike; transcript files are export artifacts only.
--
-- `execution_turn_id` deliberately belongs to the child execution rather
-- than the parent task turn. A background run can outlive the parent turn,
-- so borrowing the parent's turn identity would let it append after that
-- turn has already reached its terminal state.
CREATE TABLE session_subagent_runs (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  agent_id TEXT NOT NULL CHECK(length(agent_id) > 0),
  parent_tool_call_id TEXT NOT NULL CHECK(length(parent_tool_call_id) > 0),
  execution_turn_id TEXT NOT NULL CHECK(length(execution_turn_id) > 0),
  thread_id TEXT NOT NULL CHECK(length(thread_id) > 0),
  branch_id TEXT NOT NULL CHECK(length(branch_id) > 0),
  -- Static local branch identity is owned by the durable run. It is not
  -- reconstructed from a live worker or inferred from a latest graph row.
  fork_source_uuid TEXT NOT NULL CHECK(length(fork_source_uuid) > 0),
  fork_lineage_json TEXT NOT NULL CHECK(
    json_valid(fork_lineage_json)
    AND json_type(fork_lineage_json) = 'array'
    AND json_array_length(fork_lineage_json) > 0
  ),
  -- Native Codex lineage is stored independently from the local graph branch
  -- and provider projection key. Child runs inherit the root session id while
  -- owning a distinct UUIDv7 thread id.
  codex_session_id TEXT NOT NULL CHECK(length(codex_session_id) > 0),
  codex_thread_id TEXT NOT NULL CHECK(length(codex_thread_id) > 0),
  codex_parent_thread_id TEXT NOT NULL CHECK(length(codex_parent_thread_id) > 0),
  codex_thread_source TEXT NOT NULL CHECK(codex_thread_source = 'subagent'),
  codex_subagent_header TEXT NOT NULL CHECK(codex_subagent_header = 'collab_spawn'),
  codex_subagent_kind TEXT NOT NULL CHECK(codex_subagent_kind = 'thread_spawn'),
  -- A child has one native thread across its requests and Remote Compact V2.
  -- Reserve every upstream window number atomically here so local work cannot
  -- collide or roll backward.
  codex_next_window_number INTEGER NOT NULL DEFAULT 0
    CHECK(codex_next_window_number >= 0),
  agent_type TEXT NOT NULL CHECK(length(agent_type) > 0),
  model TEXT NOT NULL CHECK(length(model) > 0),
  description TEXT NOT NULL CHECK(length(trim(description)) > 0),
  prompt TEXT NOT NULL CHECK(length(trim(prompt)) > 0),
  -- The full child request is an immutable versioned value. It is never
  -- reconstructed from a current SessionRecord, agent registry, tool mapper,
  -- workspace, or provider adapter after a restart.
  spawn_request_json TEXT NOT NULL CHECK(
    json_valid(spawn_request_json) = 1
    AND json_type(spawn_request_json) = 'object'
    AND COALESCE(json_type(spawn_request_json, '$.version') = 'integer', 0)
    AND COALESCE(json_extract(spawn_request_json, '$.version') = 3, 0)
    -- Claude Code leaves this unbounded when the agent does not declare a
    -- turn limit. There is no persisted bridge default: it is either JSON
    -- null or one explicit positive integer.
    AND COALESCE(
      json_type(spawn_request_json, '$.maxTurns') IN ('integer', 'null'),
      0
    )
    AND COALESCE(
      json_type(spawn_request_json, '$.maxTurns') = 'null'
      OR json_extract(spawn_request_json, '$.maxTurns') > 0,
      0
    )
    AND COALESCE(json_type(spawn_request_json, '$.toolContract') = 'object', 0)
    AND COALESCE(json_type(spawn_request_json, '$.toolContract.version') = 'integer', 0)
    AND COALESCE(json_extract(spawn_request_json, '$.toolContract.version') = 2, 0)
    AND COALESCE(json_type(spawn_request_json, '$.toolContract.fingerprint') = 'text', 0)
    AND COALESCE(json_type(spawn_request_json, '$.toolContract.tools') = 'array', 0)
    AND COALESCE(json_type(spawn_request_json, '$.toolContract.mcpRegistry') = 'array', 0)
    -- A child persists the complete, versioned scope authority. The legacy
    -- `{ primaryRoot, ideRoots, allowedRoots }` shape is intentionally not a
    -- storage format: source-separated grants and scope identities must
    -- survive recovery exactly.
    AND COALESCE(json_type(spawn_request_json, '$.workspace') = 'object', 0)
    AND COALESCE(json_type(spawn_request_json, '$.workspace.version') = 'integer', 0)
    AND COALESCE(json_extract(spawn_request_json, '$.workspace.version') = 1, 0)
    AND COALESCE(json_type(spawn_request_json, '$.workspace.workspaceIdentity') = 'text', 0)
    AND COALESCE(json_type(spawn_request_json, '$.workspace.scopeFingerprint') = 'text', 0)
    AND COALESCE(json_type(spawn_request_json, '$.workspace.primaryRoot') = 'text', 0)
    AND COALESCE(json_type(spawn_request_json, '$.workspace.ideRoots') = 'array', 0)
    AND COALESCE(json_type(spawn_request_json, '$.workspace.sessionAdditionalRoots') = 'array', 0)
    AND COALESCE(json_type(spawn_request_json, '$.workspace.configAdditionalRoots') = 'array', 0)
    AND COALESCE(json_type(spawn_request_json, '$.promptContext.projectContext') = 'object', 0)
  ),
  mode TEXT NOT NULL CHECK(mode IN ('foreground', 'background')),
  status TEXT NOT NULL CHECK(status IN (
    'running', 'completed', 'failed', 'killed', 'interrupted'
  )),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  started_at INTEGER NOT NULL CHECK(started_at >= created_at),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= started_at),
  final_text TEXT,
  error_message TEXT,
  terminal_turn_count INTEGER CHECK(
    terminal_turn_count IS NULL OR terminal_turn_count >= 0
  ),
  terminal_tool_call_count INTEGER CHECK(
    terminal_tool_call_count IS NULL OR terminal_tool_call_count >= 0
  ),
  terminal_modified_files_json TEXT CHECK(
    terminal_modified_files_json IS NULL
    OR (
      json_valid(terminal_modified_files_json)
      AND json_type(terminal_modified_files_json) = 'array'
    )
  ),
  terminal_evidence_json TEXT CHECK(
    terminal_evidence_json IS NULL
    OR (
      json_valid(terminal_evidence_json)
      AND json_type(terminal_evidence_json) = 'array'
    )
  ),
  delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(delivery_state IN ('pending', 'delivered')),
  delivered_at INTEGER CHECK(
    delivered_at IS NULL
    OR (terminal_at IS NOT NULL AND delivered_at >= terminal_at)
  ),
  PRIMARY KEY (conversation_id, agent_id),
  UNIQUE (conversation_id, parent_tool_call_id),
  UNIQUE (conversation_id, execution_turn_id),
  UNIQUE (conversation_id, thread_id),
  UNIQUE (conversation_id, branch_id),
  -- The full static branch tuple is a parent key for sidechain graph rows;
  -- execution_turn_id intentionally does not participate in this identity.
  UNIQUE (
    conversation_id, agent_id, thread_id, branch_id,
    fork_source_uuid, fork_lineage_json
  ),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE,
  -- A child run cannot be invented from a file name or a process-local
  -- registry entry. Its durable parent must be the real task tool-use.
  FOREIGN KEY (conversation_id, parent_tool_call_id)
    REFERENCES tool_call_ledger(conversation_id, tool_use_id) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id, fork_source_uuid)
    REFERENCES session_messages(conversation_id, uuid) ON DELETE RESTRICT,
  -- A child inherits the root session/thread lineage but must own a distinct
  -- native thread. Keep this invariant in SQLite as well as the TypeScript
  -- identity constructor so direct/raw writes cannot forge a detached child.
  CHECK(codex_session_id = codex_parent_thread_id),
  CHECK(codex_thread_id <> codex_parent_thread_id),
  CHECK(thread_id = branch_id),
  CHECK(thread_id = 'subagent:' || agent_id),
  -- Every durable graph/execution identifier is an exact opaque key. These
  -- checks reject raw whitespace/NUL corruption; recovery independently
  -- applies the same no-normalization contract before using a row.
  CHECK(
    agent_id = trim(agent_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND parent_tool_call_id = trim(parent_tool_call_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND execution_turn_id = trim(execution_turn_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND thread_id = trim(thread_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND branch_id = trim(branch_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND fork_source_uuid = trim(fork_source_uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND codex_session_id = trim(codex_session_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND codex_thread_id = trim(codex_thread_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND codex_parent_thread_id = trim(codex_parent_thread_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND agent_type = trim(agent_type, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND model = trim(model, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(agent_id, char(0)) = 0
    AND instr(parent_tool_call_id, char(0)) = 0
    AND instr(execution_turn_id, char(0)) = 0
    AND instr(thread_id, char(0)) = 0
    AND instr(branch_id, char(0)) = 0
    AND instr(fork_source_uuid, char(0)) = 0
    AND instr(codex_session_id, char(0)) = 0
    AND instr(codex_thread_id, char(0)) = 0
    AND instr(codex_parent_thread_id, char(0)) = 0
    AND instr(agent_type, char(0)) = 0
    AND instr(model, char(0)) = 0
  ),
  CHECK(
    (status = 'running'
      AND terminal_at IS NULL
      AND final_text IS NULL
      AND error_message IS NULL
      AND terminal_turn_count IS NULL
      AND terminal_tool_call_count IS NULL
      AND terminal_modified_files_json IS NULL
      AND terminal_evidence_json IS NULL
      AND delivery_state = 'pending'
      AND delivered_at IS NULL)
    OR
    (status = 'completed'
      AND terminal_at IS NOT NULL
      AND final_text IS NOT NULL
      AND length(trim(final_text)) > 0
      AND error_message IS NULL
      AND terminal_modified_files_json IS NOT NULL
      AND terminal_evidence_json IS NOT NULL)
    OR
    (status IN ('failed', 'killed', 'interrupted')
      AND terminal_at IS NOT NULL
      AND final_text IS NULL
      AND error_message IS NOT NULL
      AND length(trim(error_message)) > 0
      AND terminal_modified_files_json IS NOT NULL
      AND terminal_evidence_json IS NOT NULL)
  ),
  CHECK(
    (delivery_state = 'pending' AND delivered_at IS NULL)
    OR
    (delivery_state = 'delivered'
      AND delivered_at IS NOT NULL
      AND status <> 'running')
  )
);

-- `fork_lineage_json` is part of the static branch key, not display data.
-- Reject corrupt raw elements at the same storage boundary as the scalar
-- identities above; TypeScript recovery repeats this check and never trims.
CREATE TRIGGER session_subagent_runs_fork_lineage_identity_insert
BEFORE INSERT ON session_subagent_runs
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM json_each(NEW.fork_lineage_json) AS lineage
   WHERE lineage.type <> 'text'
      OR lineage.value = ''
      OR lineage.value <> trim(lineage.value, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
      OR instr(lineage.value, char(0)) <> 0
)
OR (
  SELECT COUNT(DISTINCT lineage.value)
    FROM json_each(NEW.fork_lineage_json) AS lineage
) <> json_array_length(NEW.fork_lineage_json)
BEGIN
  SELECT RAISE(
    ABORT,
    'session_subagent_runs fork lineage requires unique canonical identities'
  );
END;

CREATE TRIGGER session_subagent_runs_fork_lineage_identity_update
BEFORE UPDATE OF fork_lineage_json ON session_subagent_runs
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM json_each(NEW.fork_lineage_json) AS lineage
   WHERE lineage.type <> 'text'
      OR lineage.value = ''
      OR lineage.value <> trim(lineage.value, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
      OR instr(lineage.value, char(0)) <> 0
)
OR (
  SELECT COUNT(DISTINCT lineage.value)
    FROM json_each(NEW.fork_lineage_json) AS lineage
) <> json_array_length(NEW.fork_lineage_json)
BEGIN
  SELECT RAISE(
    ABORT,
    'session_subagent_runs fork lineage requires unique canonical identities'
  );
END;

-- The row CHECK above gates the immutable request and contract versions.
-- Client owner records live inside the tool array, so enforce their complete
-- v2 Exec request/terminal binding in SQLite as well.  The TypeScript
-- normalizer additionally verifies every exact object key, fingerprint and
-- schema digest; this trigger prevents a raw writer from retaining an old or
-- cross-wired client terminal in the durable graph before that code runs.
CREATE TRIGGER session_subagent_runs_exec_protocol_v2_insert
BEFORE INSERT ON session_subagent_runs
FOR EACH ROW
WHEN json_valid(NEW.spawn_request_json) = 1
 AND EXISTS (
  SELECT 1
    FROM json_each(NEW.spawn_request_json, '$.toolContract.tools') AS tool
   WHERE json_type(tool.value) <> 'object'
      OR json_type(tool.value, '$.executionOwners') <> 'object'
      OR COALESCE(
        json_type(tool.value, '$.executionOwners.foreground') IN ('object', 'null'),
        0
      ) = 0
      OR COALESCE(
        json_type(tool.value, '$.executionOwners.background') IN ('object', 'null'),
        0
      ) = 0
      OR EXISTS (
        SELECT 1
          FROM json_each(tool.value, '$.executionOwners') AS owner
         WHERE owner.key NOT IN ('foreground', 'background')
      )
      OR EXISTS (
        SELECT 1
          FROM json_each(tool.value, '$.executionOwners') AS owner
         WHERE owner.key IN ('foreground', 'background')
           AND json_type(owner.value) = 'object'
           AND json_extract(owner.value, '$.kind') IN ('cursor-client', 'mcp-client')
           AND (
             owner.key <> 'foreground'
             OR COALESCE(
               (
                 json_extract(owner.value, '$.kind') = 'cursor-client'
                 AND (
                   (
                     json_extract(owner.value, '$.cursorDefinitionKey') =
                       'CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2'
                     AND json_extract(owner.value, '$.execProtocol.requestCase') = 'writeArgs'
                     AND json_extract(owner.value, '$.execProtocol.terminal.transport') = 'single'
                     AND json_extract(owner.value, '$.execProtocol.terminal.resultCase') = 'writeResult'
                   )
                   OR
                   (
                     json_extract(owner.value, '$.cursorDefinitionKey') =
                       'CLIENT_SIDE_TOOL_V2_DELETE_FILE'
                     AND json_extract(owner.value, '$.execProtocol.requestCase') = 'deleteArgs'
                     AND json_extract(owner.value, '$.execProtocol.terminal.transport') = 'single'
                     AND json_extract(owner.value, '$.execProtocol.terminal.resultCase') = 'deleteResult'
                   )
                 )
               )
               OR
               (
                 json_extract(owner.value, '$.kind') = 'mcp-client'
                 AND json_extract(owner.value, '$.execProtocol.requestCase') = 'mcpArgs'
                 AND json_extract(owner.value, '$.execProtocol.terminal.transport') = 'single'
                 AND json_extract(owner.value, '$.execProtocol.terminal.resultCase') = 'mcpResult'
               ),
               0
             ) = 0
           )
      )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'session_subagent_runs requires exact v2 frozen client exec protocol owners'
  );
END;

CREATE TRIGGER session_subagent_runs_exec_protocol_v2_update
BEFORE UPDATE OF spawn_request_json ON session_subagent_runs
FOR EACH ROW
WHEN json_valid(NEW.spawn_request_json) = 1
 AND EXISTS (
  SELECT 1
    FROM json_each(NEW.spawn_request_json, '$.toolContract.tools') AS tool
   WHERE json_type(tool.value) <> 'object'
      OR json_type(tool.value, '$.executionOwners') <> 'object'
      OR COALESCE(
        json_type(tool.value, '$.executionOwners.foreground') IN ('object', 'null'),
        0
      ) = 0
      OR COALESCE(
        json_type(tool.value, '$.executionOwners.background') IN ('object', 'null'),
        0
      ) = 0
      OR EXISTS (
        SELECT 1
          FROM json_each(tool.value, '$.executionOwners') AS owner
         WHERE owner.key NOT IN ('foreground', 'background')
      )
      OR EXISTS (
        SELECT 1
          FROM json_each(tool.value, '$.executionOwners') AS owner
         WHERE owner.key IN ('foreground', 'background')
           AND json_type(owner.value) = 'object'
           AND json_extract(owner.value, '$.kind') IN ('cursor-client', 'mcp-client')
           AND (
             owner.key <> 'foreground'
             OR COALESCE(
               (
                 json_extract(owner.value, '$.kind') = 'cursor-client'
                 AND (
                   (
                     json_extract(owner.value, '$.cursorDefinitionKey') =
                       'CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2'
                     AND json_extract(owner.value, '$.execProtocol.requestCase') = 'writeArgs'
                     AND json_extract(owner.value, '$.execProtocol.terminal.transport') = 'single'
                     AND json_extract(owner.value, '$.execProtocol.terminal.resultCase') = 'writeResult'
                   )
                   OR
                   (
                     json_extract(owner.value, '$.cursorDefinitionKey') =
                       'CLIENT_SIDE_TOOL_V2_DELETE_FILE'
                     AND json_extract(owner.value, '$.execProtocol.requestCase') = 'deleteArgs'
                     AND json_extract(owner.value, '$.execProtocol.terminal.transport') = 'single'
                     AND json_extract(owner.value, '$.execProtocol.terminal.resultCase') = 'deleteResult'
                   )
                 )
               )
               OR
               (
                 json_extract(owner.value, '$.kind') = 'mcp-client'
                 AND json_extract(owner.value, '$.execProtocol.requestCase') = 'mcpArgs'
                 AND json_extract(owner.value, '$.execProtocol.terminal.transport') = 'single'
                 AND json_extract(owner.value, '$.execProtocol.terminal.resultCase') = 'mcpResult'
               ),
               0
             ) = 0
           )
      )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'session_subagent_runs requires exact v2 frozen client exec protocol owners'
  );
END;

-- A frozen child must retain the full source-separated workspace authority.
-- This is deliberately a second guard from the v2 tool-contract trigger:
-- tool protocol compatibility and filesystem authority have independent
-- persistence invariants. The TypeScript normalizer performs canonical-path,
-- fingerprint and URI validation; this storage guard makes old/partial scope
-- JSON, grants presented as IDE folders, and mismatched prompt roots fail
-- before recovery can see them.
CREATE TRIGGER session_subagent_runs_workspace_scope_v3_insert
BEFORE INSERT ON session_subagent_runs
FOR EACH ROW
WHEN json_valid(NEW.spawn_request_json) = 1
 AND (
   COALESCE(json_extract(NEW.spawn_request_json, '$.version') = 3, 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace') = 'object', 0) = 0
   OR COALESCE(json_extract(NEW.spawn_request_json, '$.workspace.version') = 1, 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace.workspaceIdentity') = 'text', 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace.scopeFingerprint') = 'text', 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace.primaryRoot') = 'text', 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace.ideRoots') = 'array', 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace.sessionAdditionalRoots') = 'array', 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace.configAdditionalRoots') = 'array', 0) = 0
   OR (SELECT COUNT(*) FROM json_each(NEW.spawn_request_json, '$.workspace')) <> 7
   OR EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.workspace') AS field
      WHERE field.key NOT IN (
        'version', 'workspaceIdentity', 'scopeFingerprint', 'primaryRoot',
        'ideRoots', 'sessionAdditionalRoots', 'configAdditionalRoots'
      )
   )
   OR NOT EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.workspace.ideRoots') AS ide
      WHERE ide.type = 'text'
        AND ide.value = json_extract(NEW.spawn_request_json, '$.workspace.primaryRoot')
   )
   OR EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.workspace.ideRoots') AS root
      WHERE root.type <> 'text'
   )
   OR EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.workspace.sessionAdditionalRoots') AS root
      WHERE root.type <> 'text'
   )
   OR EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.workspace.configAdditionalRoots') AS root
      WHERE root.type <> 'text'
   )
   OR COALESCE(json_type(NEW.spawn_request_json, '$.promptContext.projectContext') = 'object', 0) = 0
   OR json_extract(NEW.spawn_request_json, '$.promptContext.projectContext.rootPath')
      <> json_extract(NEW.spawn_request_json, '$.workspace.primaryRoot')
   OR COALESCE(json_type(NEW.spawn_request_json, '$.promptContext.projectContext.directories') = 'array', 0) = 0
   OR EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.promptContext.projectContext.directories') AS directory
      WHERE directory.type <> 'text'
   )
   OR json_extract(NEW.spawn_request_json, '$.promptContext.projectContext.directories') <> (
     SELECT json_group_array(expected.value)
       FROM (
         SELECT 0 AS position,
                json_extract(NEW.spawn_request_json, '$.workspace.primaryRoot') AS value
         UNION ALL
         SELECT CAST(ide.key AS INTEGER) + 1 AS position, ide.value
           FROM json_each(NEW.spawn_request_json, '$.workspace.ideRoots') AS ide
          WHERE ide.value <> json_extract(NEW.spawn_request_json, '$.workspace.primaryRoot')
         ORDER BY position
       ) AS expected
   )
   OR COALESCE(json_type(NEW.spawn_request_json, '$.promptContext.projectContext.files') = 'array', 0) = 0
   OR COALESCE(json_array_length(NEW.spawn_request_json, '$.promptContext.projectContext.files') = 0, 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.promptContext.projectContext.workspaceFolders') = 'array', 0) = 0
   OR EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.promptContext.projectContext.workspaceFolders') AS folder
      WHERE folder.type <> 'object'
   )
   OR (
     SELECT json_group_array(json_extract(folder.value, '$.path'))
       FROM json_each(NEW.spawn_request_json, '$.promptContext.projectContext.workspaceFolders') AS folder
   ) <> (
     SELECT json_group_array(expected.value)
       FROM (
         SELECT 0 AS position,
                json_extract(NEW.spawn_request_json, '$.workspace.primaryRoot') AS value
         UNION ALL
         SELECT CAST(ide.key AS INTEGER) + 1 AS position, ide.value
           FROM json_each(NEW.spawn_request_json, '$.workspace.ideRoots') AS ide
          WHERE ide.value <> json_extract(NEW.spawn_request_json, '$.workspace.primaryRoot')
         ORDER BY position
       ) AS expected
   )
 )
BEGIN
  SELECT RAISE(
    ABORT,
    'session_subagent_runs requires complete v3 frozen workspace scope'
  );
END;

CREATE TRIGGER session_subagent_runs_workspace_scope_v3_update
BEFORE UPDATE OF spawn_request_json ON session_subagent_runs
FOR EACH ROW
WHEN json_valid(NEW.spawn_request_json) = 1
 AND (
   COALESCE(json_extract(NEW.spawn_request_json, '$.version') = 3, 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace') = 'object', 0) = 0
   OR COALESCE(json_extract(NEW.spawn_request_json, '$.workspace.version') = 1, 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace.workspaceIdentity') = 'text', 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace.scopeFingerprint') = 'text', 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace.primaryRoot') = 'text', 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace.ideRoots') = 'array', 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace.sessionAdditionalRoots') = 'array', 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.workspace.configAdditionalRoots') = 'array', 0) = 0
   OR (SELECT COUNT(*) FROM json_each(NEW.spawn_request_json, '$.workspace')) <> 7
   OR EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.workspace') AS field
      WHERE field.key NOT IN (
        'version', 'workspaceIdentity', 'scopeFingerprint', 'primaryRoot',
        'ideRoots', 'sessionAdditionalRoots', 'configAdditionalRoots'
      )
   )
   OR NOT EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.workspace.ideRoots') AS ide
      WHERE ide.type = 'text'
        AND ide.value = json_extract(NEW.spawn_request_json, '$.workspace.primaryRoot')
   )
   OR EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.workspace.ideRoots') AS root
      WHERE root.type <> 'text'
   )
   OR EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.workspace.sessionAdditionalRoots') AS root
      WHERE root.type <> 'text'
   )
   OR EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.workspace.configAdditionalRoots') AS root
      WHERE root.type <> 'text'
   )
   OR COALESCE(json_type(NEW.spawn_request_json, '$.promptContext.projectContext') = 'object', 0) = 0
   OR json_extract(NEW.spawn_request_json, '$.promptContext.projectContext.rootPath')
      <> json_extract(NEW.spawn_request_json, '$.workspace.primaryRoot')
   OR COALESCE(json_type(NEW.spawn_request_json, '$.promptContext.projectContext.directories') = 'array', 0) = 0
   OR EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.promptContext.projectContext.directories') AS directory
      WHERE directory.type <> 'text'
   )
   OR json_extract(NEW.spawn_request_json, '$.promptContext.projectContext.directories') <> (
     SELECT json_group_array(expected.value)
       FROM (
         SELECT 0 AS position,
                json_extract(NEW.spawn_request_json, '$.workspace.primaryRoot') AS value
         UNION ALL
         SELECT CAST(ide.key AS INTEGER) + 1 AS position, ide.value
           FROM json_each(NEW.spawn_request_json, '$.workspace.ideRoots') AS ide
          WHERE ide.value <> json_extract(NEW.spawn_request_json, '$.workspace.primaryRoot')
         ORDER BY position
       ) AS expected
   )
   OR COALESCE(json_type(NEW.spawn_request_json, '$.promptContext.projectContext.files') = 'array', 0) = 0
   OR COALESCE(json_array_length(NEW.spawn_request_json, '$.promptContext.projectContext.files') = 0, 0) = 0
   OR COALESCE(json_type(NEW.spawn_request_json, '$.promptContext.projectContext.workspaceFolders') = 'array', 0) = 0
   OR EXISTS (
     SELECT 1
       FROM json_each(NEW.spawn_request_json, '$.promptContext.projectContext.workspaceFolders') AS folder
      WHERE folder.type <> 'object'
   )
   OR (
     SELECT json_group_array(json_extract(folder.value, '$.path'))
       FROM json_each(NEW.spawn_request_json, '$.promptContext.projectContext.workspaceFolders') AS folder
   ) <> (
     SELECT json_group_array(expected.value)
       FROM (
         SELECT 0 AS position,
                json_extract(NEW.spawn_request_json, '$.workspace.primaryRoot') AS value
         UNION ALL
         SELECT CAST(ide.key AS INTEGER) + 1 AS position, ide.value
           FROM json_each(NEW.spawn_request_json, '$.workspace.ideRoots') AS ide
          WHERE ide.value <> json_extract(NEW.spawn_request_json, '$.workspace.primaryRoot')
         ORDER BY position
       ) AS expected
   )
 )
BEGIN
  SELECT RAISE(
    ABORT,
    'session_subagent_runs requires complete v3 frozen workspace scope'
  );
END;

CREATE INDEX idx_subagent_runs_status_delivery
  ON session_subagent_runs(status, delivery_state, terminal_at);

-- One append-only sidechain has one durable chronological tail. The pointer
-- is deliberately separate from graph parent links: a tool_result must point
-- at the exact tool_use that owns it, while the head tracks the last accepted
-- branch fragment for the next ordinary message. `revision` is the CAS token
-- used by the branch writer inside the graph transaction.
CREATE TABLE session_subagent_branch_heads (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  agent_id TEXT NOT NULL CHECK(
    length(agent_id) > 0
    AND agent_id = trim(agent_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(agent_id, char(0)) = 0
  ),
  head_uuid TEXT NOT NULL CHECK(
    length(head_uuid) > 0
    AND head_uuid = trim(head_uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(head_uuid, char(0)) = 0
  ),
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY (conversation_id, agent_id),
  UNIQUE (conversation_id, head_uuid),
  FOREIGN KEY (conversation_id, agent_id)
    REFERENCES session_subagent_runs(conversation_id, agent_id)
    ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, agent_id, head_uuid)
    REFERENCES session_messages(conversation_id, agent_id, uuid)
    ON DELETE RESTRICT
);

-- One logical sub-agent can cross the official foreground → background
-- boundary. Each execution owns a distinct TurnHandle; the run row points at
-- the current execution while this append-only relation retains every prior
-- turn so sidechain graph rows can prove their exact owner after handoff.
CREATE TABLE session_subagent_run_executions (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  agent_id TEXT NOT NULL CHECK(
    length(agent_id) > 0
    AND agent_id = trim(agent_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(agent_id, char(0)) = 0
  ),
  execution_turn_id TEXT NOT NULL CHECK(
    length(execution_turn_id) > 0
    AND execution_turn_id = trim(execution_turn_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(execution_turn_id, char(0)) = 0
  ),
  mode TEXT NOT NULL CHECK(mode IN ('foreground', 'background')),
  status TEXT NOT NULL CHECK(status IN (
    'running', 'completed', 'failed', 'cancelled', 'backgrounded', 'interrupted'
  )),
  started_at INTEGER NOT NULL CHECK(started_at > 0),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= started_at),
  error_message TEXT,
  PRIMARY KEY (conversation_id, agent_id, execution_turn_id),
  UNIQUE (conversation_id, execution_turn_id),
  FOREIGN KEY (conversation_id, agent_id)
    REFERENCES session_subagent_runs(conversation_id, agent_id)
    ON DELETE CASCADE,
  CHECK(
    (status = 'running' AND terminal_at IS NULL AND error_message IS NULL)
    OR
    (status IN ('completed', 'backgrounded')
      AND terminal_at IS NOT NULL
      AND error_message IS NULL)
    OR
    (status IN ('failed', 'cancelled', 'interrupted')
      AND terminal_at IS NOT NULL
      AND error_message IS NOT NULL
      AND length(trim(error_message)) > 0)
  )
);
CREATE INDEX idx_subagent_run_executions_current
  ON session_subagent_run_executions(
    conversation_id, agent_id, status, started_at
  );

-- Claude and Codex retain provider-native recovery records. Payloads are
-- bytes so summaries, replacement text and raw rollout items can be replayed
-- without generic transcript rewriting.
--
-- Claude tool-result mutations are not a mutable replacement-state snapshot.
-- Every row is triggered by one exact accepted tool_result graph receipt and
-- targets one exact already-accepted Claude tool result. Trigger and target
-- are deliberately distinct: commands such as snip_messages can rewrite a
-- historical result only after their own current tool_result is committed.
-- Rows are consumed only by a provider active-head watermark. This lets cold
-- recovery replay a committed tail without deriving provider identity from
-- current session settings or widening the compacted graph layout.
CREATE TABLE session_claude_projection_mutations (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  owner_key TEXT NOT NULL CHECK(
    length(owner_key) > 0
    AND owner_key = trim(owner_key, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(owner_key, char(0)) = 0
  ),
  local_key TEXT NOT NULL CHECK(
    length(local_key) > 0
    AND local_key = trim(local_key, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(local_key, char(0)) = 0
  ),
  seq INTEGER NOT NULL CHECK(seq > 0),
  trigger_graph_uuid TEXT NOT NULL CHECK(
    length(trigger_graph_uuid) > 0
    AND trigger_graph_uuid = trim(trigger_graph_uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(trigger_graph_uuid, char(0)) = 0
  ),
  trigger_tool_use_id TEXT NOT NULL CHECK(
    length(trigger_tool_use_id) > 0
    AND trigger_tool_use_id = trim(trigger_tool_use_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(trigger_tool_use_id, char(0)) = 0
  ),
  target_tool_use_id TEXT NOT NULL CHECK(
    length(target_tool_use_id) > 0
    AND target_tool_use_id = trim(target_tool_use_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(target_tool_use_id, char(0)) = 0
  ),
  source_ordinal INTEGER NOT NULL CHECK(source_ordinal >= 0),
  mutation_kind TEXT NOT NULL CHECK(mutation_kind IN (
    'tool_result_seen', 'tool_result_replacement'
  )),
  payload_json TEXT NOT NULL CHECK(
    json_valid(payload_json)
    AND json_type(payload_json) = 'object'
    AND (
      (mutation_kind = 'tool_result_seen'
        AND json_extract(payload_json, '$.kind') = 'seen'
        AND json_extract(payload_json, '$.toolUseId') = target_tool_use_id)
      OR
      (mutation_kind = 'tool_result_replacement'
        AND json_extract(payload_json, '$.kind') = 'replacement'
        AND json_extract(payload_json, '$.toolUseId') = target_tool_use_id
        AND json_extract(payload_json, '$.record.kind') = 'tool-result'
        AND json_extract(payload_json, '$.record.toolUseId') = target_tool_use_id
        AND json_extract(payload_json, '$.record.replacement') = json_extract(payload_json, '$.replacement'))
    )
  ),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  PRIMARY KEY (conversation_id, owner_key, local_key, seq),
  UNIQUE (
    conversation_id, owner_key, local_key, trigger_graph_uuid, source_ordinal
  ),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, trigger_graph_uuid)
    REFERENCES session_messages(conversation_id, uuid) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id, trigger_tool_use_id)
    REFERENCES tool_call_ledger(conversation_id, tool_use_id) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id, target_tool_use_id)
    REFERENCES tool_call_ledger(conversation_id, tool_use_id) ON DELETE RESTRICT
);
CREATE INDEX idx_claude_projection_mutations_tail
  ON session_claude_projection_mutations(
    conversation_id, owner_key, local_key, seq
  );
CREATE INDEX idx_claude_projection_mutations_trigger_target
  ON session_claude_projection_mutations(
    conversation_id, trigger_graph_uuid, trigger_tool_use_id,
    target_tool_use_id, seq
  );

CREATE TRIGGER session_claude_projection_mutations_append_only
BEFORE UPDATE ON session_claude_projection_mutations
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'session_claude_projection_mutations are append-only'
  );
END;

-- A mutation batch is caused by the exact terminal receipt that just closed
-- its triggering tool call. This check deliberately does not equate trigger
-- and target: snip_messages is allowed to target earlier closed tool results.
CREATE TRIGGER session_claude_projection_mutations_trigger_receipt_insert
BEFORE INSERT ON session_claude_projection_mutations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
    FROM tool_call_ledger AS trigger_ledger
    JOIN session_messages AS trigger_result
      ON trigger_result.conversation_id = trigger_ledger.conversation_id
     AND trigger_result.seq = trigger_ledger.close_message_seq
    JOIN session_messages AS trigger_assistant
      ON trigger_assistant.conversation_id = trigger_result.conversation_id
     AND trigger_assistant.uuid = trigger_result.source_tool_assistant_uuid
   WHERE trigger_ledger.conversation_id = NEW.conversation_id
     AND trigger_ledger.tool_use_id = NEW.trigger_tool_use_id
     AND trigger_ledger.state = 'closed'
     AND trigger_ledger.close_message_seq IS NOT NULL
     AND trigger_result.uuid = NEW.trigger_graph_uuid
     AND trigger_result.role = 'user'
     AND trigger_assistant.role = 'assistant'
     AND trigger_assistant.provider = 'claude'
     AND EXISTS (
       SELECT 1
         FROM json_each(trigger_result.content_json) AS result_block
        WHERE json_extract(result_block.value, '$.type') = 'tool_result'
          AND json_extract(result_block.value, '$.tool_use_id') = NEW.trigger_tool_use_id
     )
     AND EXISTS (
       SELECT 1
         FROM json_each(trigger_assistant.content_json) AS tool_block
        WHERE json_extract(tool_block.value, '$.type') = 'tool_use'
          AND json_extract(tool_block.value, '$.id') = NEW.trigger_tool_use_id
     )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'session_claude_projection_mutations trigger must be an accepted Claude tool_result receipt'
  );
END;

-- Every target remains an accepted Claude tool pair in the same graph owner
-- as the triggering receipt. The full subagent owner key is verified by the
-- store; SQLite also rejects main/sidechain crossovers and mismatched durable
-- branch coordinates on direct writes.
CREATE TRIGGER session_claude_projection_mutations_target_receipt_insert
BEFORE INSERT ON session_claude_projection_mutations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
    FROM tool_call_ledger AS trigger_ledger
    JOIN session_messages AS trigger_result
      ON trigger_result.conversation_id = trigger_ledger.conversation_id
     AND trigger_result.seq = trigger_ledger.close_message_seq
    JOIN session_messages AS trigger_assistant
      ON trigger_assistant.conversation_id = trigger_result.conversation_id
     AND trigger_assistant.uuid = trigger_result.source_tool_assistant_uuid
    JOIN tool_call_ledger AS target_ledger
      ON target_ledger.conversation_id = NEW.conversation_id
     AND target_ledger.tool_use_id = NEW.target_tool_use_id
    JOIN session_messages AS target_result
      ON target_result.conversation_id = target_ledger.conversation_id
     AND target_result.seq = target_ledger.close_message_seq
    JOIN session_messages AS target_assistant
      ON target_assistant.conversation_id = target_result.conversation_id
     AND target_assistant.uuid = target_result.source_tool_assistant_uuid
   WHERE trigger_ledger.conversation_id = NEW.conversation_id
     AND trigger_ledger.tool_use_id = NEW.trigger_tool_use_id
     AND trigger_ledger.state = 'closed'
     AND trigger_ledger.close_message_seq IS NOT NULL
     AND trigger_result.uuid = NEW.trigger_graph_uuid
     AND target_ledger.state = 'closed'
     AND target_ledger.close_message_seq IS NOT NULL
     AND target_result.role = 'user'
     AND target_assistant.role = 'assistant'
     AND target_assistant.provider = 'claude'
     AND target_assistant.is_sidechain IS trigger_assistant.is_sidechain
     AND target_assistant.thread_id IS trigger_assistant.thread_id
     AND target_assistant.branch_id IS trigger_assistant.branch_id
     AND target_assistant.agent_id IS trigger_assistant.agent_id
     AND target_assistant.fork_source_uuid IS trigger_assistant.fork_source_uuid
     AND target_assistant.fork_lineage_json IS trigger_assistant.fork_lineage_json
     AND (
       (trigger_assistant.is_sidechain = 0 AND NEW.owner_key = 'main')
       OR
       (trigger_assistant.is_sidechain = 1 AND NEW.owner_key GLOB 'subagent:*')
     )
     AND EXISTS (
       SELECT 1
         FROM json_each(target_result.content_json) AS result_block
        WHERE json_extract(result_block.value, '$.type') = 'tool_result'
          AND json_extract(result_block.value, '$.tool_use_id') = NEW.target_tool_use_id
     )
     AND EXISTS (
       SELECT 1
         FROM json_each(target_assistant.content_json) AS tool_block
        WHERE json_extract(tool_block.value, '$.type') = 'tool_use'
          AND json_extract(tool_block.value, '$.id') = NEW.target_tool_use_id
     )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'session_claude_projection_mutations target must be an accepted Claude tool_result in the trigger owner'
  );
END;

CREATE TABLE session_claude_projection_records (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  owner_key TEXT NOT NULL CHECK(
    length(owner_key) > 0
    AND owner_key = trim(owner_key, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(owner_key, char(0)) = 0
  ),
  local_key TEXT NOT NULL CHECK(
    length(local_key) > 0
    AND local_key = trim(local_key, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(local_key, char(0)) = 0
  ),
  generation INTEGER NOT NULL CHECK(generation >= 0),
  seq INTEGER NOT NULL CHECK(seq > 0),
  record_id TEXT NOT NULL CHECK(
    length(record_id) > 0
    AND record_id = trim(record_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(record_id, char(0)) = 0
  ),
  record_kind TEXT NOT NULL CHECK(
    record_kind IN ('synthetic_record', 'compaction_recipe', 'projection_layout', 'projection_manifest')
  ),
  source_message_uuid TEXT CHECK(source_message_uuid IS NULL OR (
    length(source_message_uuid) > 0
    AND source_message_uuid = trim(source_message_uuid, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(source_message_uuid, char(0)) = 0
  )),
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, owner_key, local_key, generation, seq),
  UNIQUE (conversation_id, owner_key, local_key, record_id),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_claude_projection_source
  ON session_claude_projection_records(
    conversation_id,
    owner_key,
    local_key,
    source_message_uuid
  );

CREATE TABLE session_codex_rollout_items (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  owner_key TEXT NOT NULL CHECK(
    length(owner_key) > 0
    AND owner_key = trim(owner_key, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(owner_key, char(0)) = 0
  ),
  -- Local-only provider namespace. It is never a Codex thread/session id.
  local_key TEXT NOT NULL CHECK(
    length(local_key) > 0
    AND local_key = trim(local_key, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(local_key, char(0)) = 0
  ),
  -- Upstream-native thread identity used to validate cold replay.
  native_thread_id TEXT NOT NULL CHECK(
    length(native_thread_id) > 0
    AND native_thread_id = trim(native_thread_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(native_thread_id, char(0)) = 0
  ),
  seq INTEGER NOT NULL,
  item_id TEXT CHECK(item_id IS NULL OR (
    length(item_id) > 0
    AND item_id = trim(item_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(item_id, char(0)) = 0
  )),
  item_kind TEXT NOT NULL CHECK(
    length(item_kind) > 0
    AND item_kind = trim(item_kind, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(item_kind, char(0)) = 0
  ),
  window_id TEXT CHECK(window_id IS NULL OR (
    length(window_id) > 0
    AND window_id = trim(window_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(window_id, char(0)) = 0
  )),
  response_id TEXT CHECK(response_id IS NULL OR (
    length(response_id) > 0
    AND response_id = trim(response_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(response_id, char(0)) = 0
  )),
  parent_response_id TEXT CHECK(parent_response_id IS NULL OR (
    length(parent_response_id) > 0
    AND parent_response_id = trim(parent_response_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(parent_response_id, char(0)) = 0
  )),
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, owner_key, local_key, seq),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_codex_rollout_window
  ON session_codex_rollout_items(
    conversation_id,
    owner_key,
    local_key,
    window_id,
    seq
  );
CREATE INDEX idx_codex_rollout_response
  ON session_codex_rollout_items(
    conversation_id,
    owner_key,
    local_key,
    response_id,
    seq
  );

CREATE TABLE session_provider_active_heads (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  owner_key TEXT NOT NULL CHECK(
    length(owner_key) > 0
    AND owner_key = trim(owner_key, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(owner_key, char(0)) = 0
  ),
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
  -- Local-only provider namespace. It is never an upstream identity.
  local_key TEXT NOT NULL CHECK(
    length(local_key) > 0
    AND local_key = trim(local_key, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(local_key, char(0)) = 0
  ),
  -- Provider head revision is independent from the generic compact epoch.
  revision INTEGER NOT NULL CHECK(revision > 0),
  head_kind TEXT NOT NULL CHECK(
    length(head_kind) > 0
    AND head_kind = trim(head_kind, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(head_kind, char(0)) = 0
  ),
  head_id TEXT NOT NULL CHECK(
    length(head_id) > 0
    AND head_id = trim(head_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(head_id, char(0)) = 0
  ),
  metadata_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, owner_key, provider, local_key),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);

CREATE TABLE session_schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO session_schema_meta(key, value)
VALUES ('session_graph_version', '17');
