-- Migration 018: install the v19 session graph Hook-context contract.
--
-- Subagent prompt snapshots now persist the Cursor session Hook context that
-- was frozen at spawn time. Older session rows never owned that value, so
-- they cannot be resumed without reconstructing durable model input from
-- current process state. This is a one-way cutover: discard the old session
-- graph and accept only the complete prompt snapshot going forward.

PRAGMA defer_foreign_keys = ON;

DELETE FROM sessions;

CREATE TRIGGER session_subagent_runs_hook_context_v3_insert
BEFORE INSERT ON session_subagent_runs
FOR EACH ROW
WHEN json_valid(NEW.spawn_request_json) = 1
AND json_type(NEW.spawn_request_json, '$.promptContext') = 'object'
AND COALESCE(
  json_type(
    NEW.spawn_request_json,
    '$.promptContext.hooksAdditionalContext'
  ) IN ('text', 'null'),
  0
) = 0
BEGIN
  SELECT RAISE(
    ABORT,
    'session_subagent_runs requires frozen Hook additional context'
  );
END;

CREATE TRIGGER session_subagent_runs_hook_context_v3_update
BEFORE UPDATE OF spawn_request_json ON session_subagent_runs
FOR EACH ROW
WHEN json_valid(NEW.spawn_request_json) = 1
AND json_type(NEW.spawn_request_json, '$.promptContext') = 'object'
AND COALESCE(
  json_type(
    NEW.spawn_request_json,
    '$.promptContext.hooksAdditionalContext'
  ) IN ('text', 'null'),
  0
) = 0
BEGIN
  SELECT RAISE(
    ABORT,
    'session_subagent_runs requires frozen Hook additional context'
  );
END;

UPDATE session_schema_meta
   SET value = '19'
 WHERE key = 'session_graph_version';
