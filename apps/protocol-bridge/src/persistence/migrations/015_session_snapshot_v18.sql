-- Migration 015: persist the exact v18 session configuration authority.
--
-- Snapshot v17 predates Cursor-managed read resources. Those sessions carried
-- no grant for such a resource, so their only valid v18 projection is the
-- empty authority set. This is a one-way data migration; runtime decoding
-- continues to accept only the current v18 snapshot shape.

UPDATE sessions
   SET config_json = json_set(
     config_json,
     '$.version', 18,
     '$.cursorManagedReadResources', json('[]')
   )
 WHERE json_valid(config_json)
   AND json_type(config_json) = 'object'
   AND json_extract(config_json, '$.version') = 17;
