/**
 * Canonical status vocabulary for Cursor tool-result projections.
 *
 * This is shared by the protobuf projector and synthetic bridge results so a
 * result cannot become unrepresentable merely because it crossed a different
 * transport boundary.
 */
export type CursorToolResultStatus =
  | "success"
  | "approved"
  | "failure"
  | "error"
  | "rejected"
  | "timeout"
  | "no_space"
  | "not_file"
  | "file_busy"
  | "permission_denied"
  | "spawn_error"
  | "sandbox_unsupported"
  | "file_not_found"
  | "invalid_file"
  | "tool_not_found"
  | "server_not_found"
  | "aborted"
