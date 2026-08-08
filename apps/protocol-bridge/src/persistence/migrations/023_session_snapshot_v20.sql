-- Migration 023: persist ConversationStateStructure.is_root_project_conversation.
--
-- Snapshot v19 has no durable root-project flag. Existing sessions therefore
-- omit isRootProjectConversation; runtime decoding continues to accept only
-- the current snapshot shape.

UPDATE sessions
   SET config_json = json_set(
     config_json,
     '$.version', 20
   )
 WHERE json_valid(config_json)
   AND json_type(config_json) = 'object'
   AND json_extract(config_json, '$.version') = 19;
