-- Migration 017: install the authoritative v18 session graph.
--
-- Background shell execution previously lived in a process-local stream map.
-- Its Cursor task identity and terminal delivery therefore disappeared across
-- a bridge restart. v18 makes that lifecycle a normalized graph entity. This
-- is a one-way cutover: existing sessions are intentionally cleared rather
-- than guessed into a durable identity they never stored.

PRAGMA defer_foreign_keys = ON;

DELETE FROM sessions;

CREATE TABLE session_background_commands (
  conversation_id TEXT NOT NULL CHECK(
    length(conversation_id) > 0
    AND conversation_id = trim(conversation_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(conversation_id, char(0)) = 0
  ),
  command_id TEXT NOT NULL CHECK(
    length(command_id) > 0
    AND command_id = trim(command_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(command_id, char(0)) = 0
  ),
  origin_tool_call_id TEXT NOT NULL CHECK(
    length(origin_tool_call_id) > 0
    AND origin_tool_call_id = trim(origin_tool_call_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
    AND instr(origin_tool_call_id, char(0)) = 0
  ),
  exec_ids_json TEXT NOT NULL CHECK(
    json_valid(exec_ids_json) = 1
    AND json_type(exec_ids_json) = 'array'
  ),
  command TEXT NOT NULL CHECK(instr(command, char(0)) = 0),
  cwd TEXT NOT NULL CHECK(instr(cwd, char(0)) = 0),
  pid INTEGER CHECK(pid IS NULL OR (typeof(pid) = 'integer' AND pid >= 0)),
  terminals_folder TEXT CHECK(
    terminals_folder IS NULL OR (
      length(terminals_folder) > 0
      AND instr(terminals_folder, char(0)) = 0
    )
  ),
  status TEXT NOT NULL CHECK(status IN (
    'running', 'completed', 'failed', 'aborted'
  )),
  stdout TEXT NOT NULL CHECK(instr(stdout, char(0)) = 0),
  stderr TEXT NOT NULL CHECK(instr(stderr, char(0)) = 0),
  exit_code INTEGER CHECK(exit_code IS NULL OR typeof(exit_code) = 'integer'),
  ms_to_wait INTEGER CHECK(
    ms_to_wait IS NULL OR (typeof(ms_to_wait) = 'integer' AND ms_to_wait >= 0)
  ),
  background_reason INTEGER CHECK(
    background_reason IS NULL OR typeof(background_reason) = 'integer'
  ),
  last_terminal_file_length INTEGER CHECK(
    last_terminal_file_length IS NULL OR (
      typeof(last_terminal_file_length) = 'integer'
      AND last_terminal_file_length >= 0
    )
  ),
  started_at INTEGER NOT NULL CHECK(
    typeof(started_at) = 'integer' AND started_at > 0
  ),
  updated_at INTEGER NOT NULL CHECK(
    typeof(updated_at) = 'integer' AND updated_at >= started_at
  ),
  completed_at INTEGER CHECK(
    completed_at IS NULL OR (
      typeof(completed_at) = 'integer' AND completed_at >= started_at
    )
  ),
  completion_task_id TEXT CHECK(
    completion_task_id IS NULL OR (
      length(completion_task_id) > 0
      AND completion_task_id = trim(completion_task_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
      AND instr(completion_task_id, char(0)) = 0
    )
  ),
  completion_tool_call_id TEXT CHECK(
    completion_tool_call_id IS NULL OR (
      length(completion_tool_call_id) > 0
      AND completion_tool_call_id = trim(completion_tool_call_id, ' ' || char(9) || char(10) || char(11) || char(12) || char(13) || char(160) || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196) || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202) || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279))
      AND instr(completion_tool_call_id, char(0)) = 0
    )
  ),
  completion_status INTEGER CHECK(
    completion_status IS NULL OR completion_status IN (0, 1, 2, 3)
  ),
  completion_reason INTEGER CHECK(
    completion_reason IS NULL OR completion_reason IN (0, 1, 2)
  ),
  output_path TEXT CHECK(
    output_path IS NULL OR (
      length(output_path) > 0
      AND instr(output_path, char(0)) = 0
    )
  ),
  delivery_state TEXT NOT NULL DEFAULT 'none' CHECK(
    delivery_state IN ('none', 'pending', 'delivered')
  ),
  delivery_source_uuid TEXT,
  delivered_at INTEGER CHECK(
    delivered_at IS NULL OR (
      typeof(delivered_at) = 'integer' AND delivered_at >= started_at
    )
  ),
  PRIMARY KEY (conversation_id, command_id),
  UNIQUE (conversation_id, origin_tool_call_id),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, origin_tool_call_id)
    REFERENCES tool_call_ledger(conversation_id, tool_use_id) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id, delivery_source_uuid)
    REFERENCES session_messages(conversation_id, uuid) ON DELETE RESTRICT,
  CHECK(
    (status = 'running' AND completed_at IS NULL)
    OR (status <> 'running' AND completed_at IS NOT NULL)
  ),
  CHECK(
    (delivery_state = 'none'
      AND completion_task_id IS NULL
      AND delivery_source_uuid IS NULL
      AND delivered_at IS NULL)
    OR (delivery_state = 'pending'
      AND completion_task_id IS NOT NULL
      AND delivery_source_uuid IS NULL
      AND delivered_at IS NULL)
    OR (delivery_state = 'delivered'
      AND completion_task_id IS NOT NULL
      AND delivery_source_uuid IS NOT NULL
      AND delivered_at IS NOT NULL)
  )
);

CREATE TRIGGER session_background_commands_exec_ids_insert
BEFORE INSERT ON session_background_commands
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM json_each(NEW.exec_ids_json) AS exec_id
   WHERE exec_id.type <> 'integer' OR exec_id.value <= 0
)
OR (
  SELECT COUNT(DISTINCT exec_id.value)
    FROM json_each(NEW.exec_ids_json) AS exec_id
) <> json_array_length(NEW.exec_ids_json)
BEGIN
  SELECT RAISE(
    ABORT,
    'session_background_commands exec ids require unique positive integers'
  );
END;

CREATE TRIGGER session_background_commands_exec_ids_update
BEFORE UPDATE OF exec_ids_json ON session_background_commands
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM json_each(NEW.exec_ids_json) AS exec_id
   WHERE exec_id.type <> 'integer' OR exec_id.value <= 0
)
OR (
  SELECT COUNT(DISTINCT exec_id.value)
    FROM json_each(NEW.exec_ids_json) AS exec_id
) <> json_array_length(NEW.exec_ids_json)
BEGIN
  SELECT RAISE(
    ABORT,
    'session_background_commands exec ids require unique positive integers'
  );
END;

CREATE INDEX idx_background_command_tool_call
  ON session_background_commands(conversation_id, origin_tool_call_id);
CREATE INDEX idx_background_command_delivery
  ON session_background_commands(conversation_id, delivery_state, updated_at);

UPDATE session_schema_meta
   SET value = '18'
 WHERE key = 'session_graph_version';
