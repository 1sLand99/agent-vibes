-- Persist the project selected for each Cursor composer before a session exists.
-- No sessions foreign key is used because the selector is intentionally usable
-- before the first AgentRunRequest creates the conversation row.

CREATE TABLE workspace_preferences (
  composer_id TEXT PRIMARY KEY,
  workspace_key TEXT NOT NULL,
  folder_uri TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
