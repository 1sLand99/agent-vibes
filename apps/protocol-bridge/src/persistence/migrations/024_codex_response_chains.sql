CREATE TABLE IF NOT EXISTS codex_response_chains (
  owner_hash TEXT NOT NULL,
  response_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner_hash, response_id)
);
CREATE INDEX IF NOT EXISTS codex_response_chains_expiry ON codex_response_chains(expires_at);
