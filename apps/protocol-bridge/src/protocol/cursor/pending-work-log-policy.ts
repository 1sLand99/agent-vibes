export interface PendingWorkLogState {
  description: string
  lastLoggedAt: number
}

export interface PendingWorkLogDecision {
  level: "log" | "debug" | "silent"
  state: PendingWorkLogState
}

export function decidePendingWorkLog(
  previous: PendingWorkLogState | undefined,
  description: string,
  now: number,
  reminderIntervalMs: number
): PendingWorkLogDecision {
  if (!previous || previous.description !== description) {
    return {
      level: "log",
      state: { description, lastLoggedAt: now },
    }
  }

  if (now - previous.lastLoggedAt >= reminderIntervalMs) {
    return {
      level: "debug",
      state: { description, lastLoggedAt: now },
    }
  }

  return { level: "silent", state: previous }
}
