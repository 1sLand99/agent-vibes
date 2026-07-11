export interface CursorTodoWriteProjection extends Record<string, unknown> {
  merge: false
  todos: Array<{
    id: string
    content: string
    status: unknown
    createdAt: number
    updatedAt: number
    dependencies: string[]
  }>
}

function pickString(
  input: Record<string, unknown>,
  keys: readonly string[]
): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return ""
}

/**
 * Codex exposes plan progress as `{ plan: [{ step, status }] }`, while
 * Cursor's agent protocol represents mutable progress through
 * UpdateTodosToolCall. Normalize once before both lifecycle frames so
 * toolCallStarted and toolCallCompleted describe the same todo set.
 */
export function projectCodexUpdatePlanToCursorTodos(
  input: Record<string, unknown>,
  now: number = Date.now()
): CursorTodoWriteProjection {
  const rawPlan = Array.isArray(input.plan) ? input.plan : []
  const todos = rawPlan.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return []
    const item = entry as Record<string, unknown>
    const content = pickString(item, ["step", "content", "title", "name"])
    if (!content) return []
    const rawDependencies =
      item.dependencies ?? item.depends_on ?? item.dependsOn

    return [
      {
        id:
          pickString(item, ["id", "todo_id", "todoId"]) || `plan_${index + 1}`,
        content,
        status: item.status ?? "pending",
        createdAt: now,
        updatedAt: now,
        dependencies: Array.isArray(rawDependencies)
          ? rawDependencies.filter(
              (dependency): dependency is string =>
                typeof dependency === "string" && dependency.length > 0
            )
          : [],
      },
    ]
  })

  return { merge: false, todos }
}
