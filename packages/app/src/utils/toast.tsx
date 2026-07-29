import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { Toast, showToast as showLegacyToast, type ToastOptions, type ToastVariant } from "@opencode-ai/ui/toast"
import { ToastV2, showToastV2 } from "@opencode-ai/ui/v2/toast-v2"

let v2 = false

export type ClientDebugLogEntry = {
  time: string
  level: "info" | "warn" | "error"
  scope: "renderer"
  message: string
  data?: unknown
}

const CLIENT_LOG_KEY = "hoyaagent.renderer-debug-logs"
export const CLIENT_DEBUG_LOG_EVENT = "hoyaagent:renderer-debug-log"
const CLIENT_LOG_LIMIT = 200

function safeData(value: unknown) {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number") return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

export function getClientDebugLogs(): ClientDebugLogEntry[] {
  if (typeof window === "undefined") return []
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(CLIENT_LOG_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function clearClientDebugLogs() {
  if (typeof window === "undefined") return
  window.sessionStorage.removeItem(CLIENT_LOG_KEY)
  window.dispatchEvent(new CustomEvent(CLIENT_DEBUG_LOG_EVENT))
}

export function logClientError(message: string, data?: unknown) {
  if (typeof window === "undefined") return
  const entry: ClientDebugLogEntry = {
    time: new Date().toISOString(),
    level: "error",
    scope: "renderer",
    message,
    ...(data === undefined ? {} : { data: safeData(data) }),
  }
  const logs = [...getClientDebugLogs(), entry].slice(-CLIENT_LOG_LIMIT)
  try {
    window.sessionStorage.setItem(CLIENT_LOG_KEY, JSON.stringify(logs))
  } catch {
    // Showing the original toast is more important than diagnostic persistence.
  }
  window.dispatchEvent(new CustomEvent(CLIENT_DEBUG_LOG_EVENT, { detail: entry }))
}

export function setV2Toast(value: boolean) {
  v2 = value
}

export function ToastRegion(props: { v2: boolean }) {
  if (props.v2) return <ToastV2.Region />
  return <Toast.Region />
}

export function showToast(options: ToastOptions | string) {
  if (typeof options !== "string") {
    const text = [options.title, options.description].filter((item): item is string => typeof item === "string").join(" — ")
    if (options.variant === "error" || /(?:failed|error|失败|错误|无法)/i.test(text)) {
      logClientError(text || "Renderer displayed an error toast", { variant: options.variant })
    }
  }
  if (!v2) return showLegacyToast(options)
  if (typeof options === "string") return showToastV2(options)

  return showToastV2({
    ...options,
    icon: resolveIcon(options.icon, options.variant),
    actions: options.actions?.map((action) => ({
      ...action,
      variant: action.onClick === "dismiss" ? "secondary" : "primary",
    })),
  })
}

function resolveIcon(icon: IconProps["name"] | undefined, variant: ToastVariant | undefined) {
  const name = icon ?? (variant === "success" ? "check" : undefined)
  if (!name) return
  return <Icon name={name} />
}
