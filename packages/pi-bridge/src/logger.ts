/**
 * Ring-buffer logger for pi-bridge.
 * Captures all operational logs so the frontend debug panel can display them.
 */

export type LogEntry = {
  time: string
  level: "info" | "warn" | "error" | "debug"
  scope: string
  message: string
  data?: unknown
}

const MAX_ENTRIES = 500
const buffer: LogEntry[] = []

function push(level: LogEntry["level"], scope: string, message: string, data?: unknown) {
  const entry: LogEntry = {
    time: new Date().toISOString(),
    level,
    scope,
    message,
    ...(data !== undefined ? { data: safeSerialize(data) } : {}),
  }
  buffer.push(entry)
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES)
  // Also print to console for sidecar stdout
  const prefix = `[${entry.time.slice(11, 23)}][${level.toUpperCase()}][${scope}]`
  if (level === "error") console.error(prefix, message, data ?? "")
  else if (level === "warn") console.warn(prefix, message, data ?? "")
  else console.log(prefix, message, data ?? "")
}

function safeSerialize(data: unknown): unknown {
  if (data === null || data === undefined) return data
  if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") return data
  try {
    const json = JSON.stringify(data)
    if (json.length > 2000) return json.slice(0, 2000) + "...(truncated)"
    return JSON.parse(json)
  } catch {
    return String(data)
  }
}

export const log = {
  info: (scope: string, message: string, data?: unknown) => push("info", scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => push("warn", scope, message, data),
  error: (scope: string, message: string, data?: unknown) => push("error", scope, message, data),
  debug: (scope: string, message: string, data?: unknown) => push("debug", scope, message, data),
}

export function getLogs(limit = 200): LogEntry[] {
  return buffer.slice(-limit)
}

export function clearLogs() {
  buffer.length = 0
}
