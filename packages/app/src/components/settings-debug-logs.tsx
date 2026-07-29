import { For, Show, createSignal, onMount, onCleanup, createMemo } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { authTokenFromCredentials } from "@/utils/server"
import { CLIENT_DEBUG_LOG_EVENT, clearClientDebugLogs, getClientDebugLogs, type ClientDebugLogEntry } from "@/utils/toast"

type LogEntry = {
  time: string
  level: "info" | "warn" | "error" | "debug"
  scope: string
  message: string
  data?: unknown
}

type DebugStatus = {
  kernel: string
  version: string
  uptime: number
  memory: { rss: number; heapUsed: number; heapTotal: number }
  sessions: Array<{
    id: string
    title: string
    status: string
    model?: { providerID: string; modelID: string }
    hasPi: boolean
    messageCount: number
  }>
  bot: { running?: boolean; status?: string }
}

export function SettingsDebugLogs() {
  const serverSDK = useServerSDK()
  const [logs, setLogs] = createSignal<LogEntry[]>([])
  const [clientLogs, setClientLogs] = createSignal<ClientDebugLogEntry[]>([])
  const [status, setStatus] = createSignal<DebugStatus | null>(null)
  const [error, setError] = createSignal("")
  const [autoRefresh, setAutoRefresh] = createSignal(true)
  const [filter, setFilter] = createSignal("")
  let timer: ReturnType<typeof setInterval> | undefined

  const serverURL = createMemo(() => serverSDK().url.replace(/\/$/, ""))
  const headers = () => {
    const password = serverSDK().server.http.password
    return {
      "content-type": "application/json",
      ...(password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({
              username: serverSDK().server.http.username,
              password,
            })}`,
          }
        : {}),
    }
  }

  const fetchLogs = async () => {
    try {
      const res = await fetch(`${serverURL()}/debug/logs?limit=300`, { headers: headers() })
      const body = await res.json()
      if (res.ok) {
        setLogs(body.logs || [])
        setClientLogs(getClientDebugLogs())
        setError("")
      } else {
        setError(body.error || `HTTP ${res.status}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${serverURL()}/debug/status`, { headers: headers() })
      const body = await res.json()
      if (res.ok) setStatus(body)
    } catch {
      // ignore
    }
  }

  const clearLogs = async () => {
    try {
      await fetch(`${serverURL()}/debug/logs`, { method: "DELETE", headers: headers() })
      setLogs([])
      clearClientDebugLogs()
      setClientLogs([])
    } catch {
      // ignore
    }
  }

  const [testResult, setTestResult] = createSignal("")
  const [testing, setTesting] = createSignal(false)
  const testApi = async () => {
    setTesting(true)
    setTestResult("测试中...")
    try {
      const res = await fetch(`${serverURL()}/debug/test-api`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({}),
      })
      const body = await res.json()
      setTestResult(JSON.stringify(body, null, 2))
    } catch (e) {
      setTestResult(`错误: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTesting(false)
      void fetchLogs()
    }
  }

  const refresh = () => {
    void fetchLogs()
    void fetchStatus()
  }

  const filteredLogs = createMemo(() => {
    const f = filter().toLowerCase()
    const combined: LogEntry[] = [...logs(), ...clientLogs()]
    if (!f) return combined.sort((a, b) => a.time.localeCompare(b.time))
    return combined.filter(
      (entry) =>
        entry.message.toLowerCase().includes(f) ||
        entry.scope.toLowerCase().includes(f) ||
        entry.level.toLowerCase().includes(f),
    )
  })

  onMount(() => {
    refresh()
    const onClientLog = () => setClientLogs(getClientDebugLogs())
    window.addEventListener(CLIENT_DEBUG_LOG_EVENT, onClientLog)
    timer = setInterval(() => {
      if (autoRefresh()) refresh()
    }, 3000)
    onCleanup(() => window.removeEventListener(CLIENT_DEBUG_LOG_EVENT, onClientLog))
    return () => clearInterval(timer)
  })

  const levelColor = (level: string) => {
    if (level === "error") return "color: #f87171;"
    if (level === "warn") return "color: #fbbf24;"
    if (level === "debug") return "color: #94a3b8;"
    return "color: #4ade80;"
  }

  const formatUptime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}m ${s}s`
  }

  const formatBytes = (bytes: number) => {
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${bytes} B`
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%", gap: "12px", padding: "16px" }}>
      <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
        <h2 style={{ margin: 0, "font-size": "16px", "font-weight": "600" }}>运行日志</h2>
        <button onClick={refresh} style={btnStyle}>刷新</button>
        <button onClick={clearLogs} style={btnStyle}>清空</button>
        <button onClick={testApi} disabled={testing()} style={{ ...btnStyle, background: testing() ? "#333" : "#1a4a1a" }}>
          {testing() ? "测试中..." : "测试 API"}
        </button>
        <button onClick={() => {
          const errors = logs().filter((l) => l.level === "error" || l.level === "warn")
          const promptLogs = logs().filter((l) => l.scope === "prompt" || l.scope === "model" || l.scope === "proxy" || l.scope === "pi-event")
          const summary = [
            `=== HoyaAgent 诊断 ===`,
            `时间: ${new Date().toISOString()}`,
            `状态: ${status() ? `运行${formatUptime(status()!.uptime)}, 会话${status()!.sessions.length}个` : "未知"}`,
            ``,
            `=== 错误/警告 (${errors.length}) ===`,
            ...errors.slice(-20).map((l) => `[${l.time.slice(11, 23)}][${l.level}][${l.scope}] ${l.message}${l.data ? " " + JSON.stringify(l.data).slice(0, 200) : ""}`),
            ``,
            `=== 关键流程日志 ===`,
            ...promptLogs.slice(-30).map((l) => `[${l.time.slice(11, 23)}][${l.level}][${l.scope}] ${l.message}${l.data ? " " + JSON.stringify(l.data).slice(0, 200) : ""}`),
          ].join("\n")
          navigator.clipboard.writeText(summary).then(() => setTestResult("已复制到剪贴板")).catch(() => setTestResult("复制失败"))
        }} style={{ ...btnStyle, background: "#1a2a4a" }}>复制诊断</button>
        <label style={{ display: "flex", "align-items": "center", gap: "4px", "font-size": "12px", cursor: "pointer" }}>
          <input type="checkbox" checked={autoRefresh()} onChange={(e) => setAutoRefresh(e.currentTarget.checked)} />
          自动刷新 (3s)
        </label>
        <input
          type="text"
          placeholder="过滤..."
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          style={{ "margin-left": "auto", padding: "4px 8px", "border-radius": "4px", border: "1px solid #333", background: "#1a1a2e", color: "#eee", "font-size": "12px", width: "120px" }}
        />
      </div>

      <Show when={testResult()}>
        <div style={{ padding: "8px", background: "#1a2a1a", "border-radius": "6px", "font-size": "11px", "font-family": "monospace", "white-space": "pre-wrap", "max-height": "200px", overflow: "auto" }}>
          {testResult()}
        </div>
      </Show>

      <Show when={error()}>
        <div style={{ padding: "8px", background: "#3b1111", "border-radius": "6px", color: "#f87171", "font-size": "12px" }}>
          连接错误: {error()}
        </div>
      </Show>

      <Show when={status()}>
        {(s) => (
          <div style={{ display: "flex", gap: "12px", "flex-wrap": "wrap", padding: "8px", background: "#1a1a2e", "border-radius": "8px", "font-size": "12px" }}>
            <span>内核: {s().kernel} v{s().version}</span>
            <span>运行: {formatUptime(s().uptime)}</span>
            <span>内存: {formatBytes(s().memory.heapUsed)} / {formatBytes(s().memory.heapTotal)}</span>
            <span>会话: {s().sessions.length} 个</span>
            <span>机器人: {s().bot?.running ? "运行中" : "停止"}</span>
          </div>
        )}
      </Show>

      <Show when={status()?.sessions?.length}>
        <details style={{ padding: "8px", background: "#1a1a2e", "border-radius": "8px", "font-size": "11px" }}>
          <summary style={{ "font-weight": "600", cursor: "pointer", display: "flex", "align-items": "center", gap: "8px" }}>
            会话列表 ({status()!.sessions.length})
            <button
              onClick={async (e) => { e.preventDefault(); e.stopPropagation(); await fetch(`${serverURL()}/debug/sessions`, { method: "DELETE", headers: headers() }); refresh() }}
              style={{ ...btnStyle, "font-size": "10px", padding: "2px 6px", background: "#4a1a1a" }}
            >清空全部会话</button>
          </summary>
          <div style={{ "max-height": "120px", "overflow-y": "auto", "margin-top": "4px" }}>
            <For each={status()!.sessions}>
              {(session) => (
                <div style={{ display: "flex", gap: "6px", padding: "2px 0", "border-bottom": "1px solid #222", "align-items": "center" }}>
                  <span style={{ color: "#818cf8" }}>{session.id.slice(0, 12)}</span>
                  <span style={{ color: session.status === "busy" ? "#fbbf24" : "#4ade80" }}>{session.status}</span>
                  <span style={{ flex: 1, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{session.model ? `${session.model.providerID}/${session.model.modelID}` : "无模型"}</span>
                  <span>Pi:{session.hasPi ? "✓" : "✗"}</span>
                  <button
                    onClick={async () => { await fetch(`${serverURL()}/debug/sessions/${session.id}`, { method: "DELETE", headers: headers() }); refresh() }}
                    style={{ color: "#f87171", background: "none", border: "none", cursor: "pointer", "font-size": "11px", padding: "0 4px" }}
                  >✕</button>
                </div>
              )}
            </For>
          </div>
        </details>
      </Show>

      <div style={{ flex: 1, overflow: "auto", "font-family": "monospace", "font-size": "11px", "line-height": "1.6", background: "#0d0d1a", "border-radius": "8px", padding: "8px" }}>
        <Show when={filteredLogs().length === 0}>
          <div style={{ color: "#666", padding: "16px", "text-align": "center" }}>暂无日志。发送一条消息后刷新查看。</div>
        </Show>
        <For each={filteredLogs()}>
          {(entry) => (
            <div style={{ "border-bottom": "1px solid #1a1a2e", padding: "2px 0" }}>
              <span style={{ color: "#666" }}>{entry.time.slice(11, 23)}</span>{" "}
              <span style={levelColor(entry.level)}>[{entry.level.toUpperCase()}]</span>{" "}
              <span style={{ color: "#818cf8" }}>[{entry.scope}]</span>{" "}
              <span style={{ color: "#e2e8f0" }}>{entry.message}</span>
              <Show when={entry.data}>
                <div style={{ color: "#64748b", "padding-left": "16px", "white-space": "pre-wrap" }}>
                  {typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data, null, 1)}
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

const btnStyle = {
  padding: "4px 10px",
  "border-radius": "4px",
  border: "1px solid #333",
  background: "#2a2a3e",
  color: "#eee",
  "font-size": "12px",
  cursor: "pointer",
}
