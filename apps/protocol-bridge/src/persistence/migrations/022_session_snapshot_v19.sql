-- Migration 022: persist ConversationStateStructure.goal_state in session config.
--
-- Snapshot v18 has no durable goal authority. Existing sessions therefore carry
-- no active goal, so their only valid v19 projection omits goalState. Runtime
-- decoding continues to accept only the current snapshot shape.

UPDATE sessions
   SET config_json = json_set(
     config_json,
     '$.version', 19
   )
 WHERE json_valid(config_json)
   AND json_type(config_json) = 'object'
   AND json_extract(config_json, '$.version') = 18;
