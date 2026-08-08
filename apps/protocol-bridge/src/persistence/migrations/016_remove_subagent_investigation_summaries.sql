-- Migration 016: remove the retired provider-facing investigation summary
-- collection from durable child request snapshots.
--
-- The field was always compiled as an empty array. Tool results and session
-- memory already have distinct durable owners; retaining a second summary
-- collection made the persisted request contract imply a provider input that
-- no longer exists. This one-way rewrite leaves one exact V3 request shape.

UPDATE session_subagent_runs
   SET spawn_request_json = json_remove(
     spawn_request_json,
     '$.childContextAttachmentSnapshot.investigationSummaries'
   )
 WHERE json_valid(spawn_request_json) = 1
   AND json_type(
     spawn_request_json,
     '$.childContextAttachmentSnapshot.investigationSummaries'
   ) IS NOT NULL;
