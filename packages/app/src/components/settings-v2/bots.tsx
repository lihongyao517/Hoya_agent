import { For, Show, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useServerSDK } from "@/context/server-sdk"
import { authTokenFromCredentials } from "@/utils/server"

type BotProvider = "qq" | "feishu" | "lark" | "weixin"

type BotConnection = {
  id: string
  provider: BotProvider
  label?: string
  enabled: boolean
  model?: { providerID: string; modelID: string }
  toolApprovalMode?: string
  workspaceRoot?: string
  appID?: string
  appSecret?: string
  appSecretEnv?: string
  verificationToken?: string
  webhookPort?: number
  webhookPath?: string
  requireMention?: boolean
  sandbox?: boolean
  accountID?: string
  token?: string
  tokenEnv?: string
  apiBase?: string
  allowAll?: boolean
  allowUsers?: string[]
  allowGroups?: string[]
  sessionMappings?: Array<{ remoteID: string; sessionID?: string; chatType?: string; userID?: string; updatedAt?: string }>
}

type BotConfig = {
  enabled?: boolean
  maxSteps?: number
  debounceMs?: number
  queueCap?: number
  queueMode?: "queue" | "replace" | "reject" | string
  queueDrop?: "oldest" | "newest" | string
  ignoreSelfMessages?: boolean
  allowAll?: boolean
  allowUsers?: Record<string, string[]>
  allowGroups?: Record<string, string[]>
  approvers?: Record<string, string[]>
  admins?: Record<string, string[]>
  selfUserIds?: Record<string, string[]>
  pairing?: { enabled?: boolean; requestTtlMinutes?: number; maxPendingPerPlatform?: number }
  routes?: BotRoute[]
  connections?: BotConnection[]
}

type BotRoute = {
  connectionId?: string
  platform?: string
  chatType?: string
  chatId?: string
  userId?: string
  threadId?: string
  workspaceRoot?: string
  model?: { providerID: string; modelID: string }
  toolApprovalMode?: string
}

type BotStatus = {
  running?: boolean
  status?: string
  startedAt?: string
  connections?: Array<{ id: string; provider?: string; domain?: string; status: string; lastError?: string }>
}

const providers = ["qq", "feishu", "lark", "weixin"] as const

const emptyConnection = (provider: BotProvider): BotConnection => ({
  id: provider === "lark" ? "lark-main" : `${provider}-main`,
  provider,
  label: providerLabel(provider),
  enabled: true,
  requireMention: provider === "feishu" || provider === "lark",
  allowAll: false,
  allowUsers: [],
  allowGroups: [],
  appSecretEnv: provider === "qq" ? "QQ_BOT_APP_SECRET" : provider === "lark" ? "LARK_BOT_APP_SECRET" : provider === "feishu" ? "FEISHU_BOT_APP_SECRET" : undefined,
  tokenEnv: provider === "weixin" ? "WEIXIN_BOT_TOKEN" : undefined,
  apiBase: provider === "weixin" ? "https://ilinkai.weixin.qq.com" : undefined,
})

export function SettingsBotsV2() {
  const serverSDK = useServerSDK()
  const [state, setState] = createStore<{
    config: BotConfig
    status: BotStatus
    message: string
    saving: boolean
    loading: boolean
    weixinInstall?: { installID: string; url: string; status?: string }
  }>({ config: defaultConfig(), status: {}, message: "", saving: false, loading: true })

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
  const api = (path: string) => `${serverURL()}${path}`
  const botURL = (conn: BotConnection) => api(`/bot/webhook/${conn.provider}/${encodeURIComponent(conn.id)}`)

  const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(api(path), { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`)
    return body as T
  }

  const load = async () => {
    setState("loading", true)
    try {
      const [config, status] = await Promise.all([request<BotConfig>("/bot/config"), request<BotStatus>("/bot/status")])
      setState("config", { ...defaultConfig(), ...config })
      setState("status", status)
      setState("message", "")
    } catch (error) {
      setState("message", error instanceof Error ? error.message : String(error))
    } finally {
      setState("loading", false)
    }
  }

  const save = async () => {
    setState("saving", true)
    setState("message", "")
    try {
      const config = await request<BotConfig>("/bot/config", {
        method: "POST",
        body: JSON.stringify(state.config),
      })
      const status = await request<BotStatus>("/bot/status")
      setState("config", config)
      setState("status", status)
      setState("message", "已保存并重启机器人运行时")
    } catch (error) {
      setState("message", error instanceof Error ? error.message : String(error))
    } finally {
      setState("saving", false)
    }
  }

  const start = async () => {
    await request<BotStatus>("/bot/start", { method: "POST" }).then((status) => setState("status", status))
  }

  const stop = async () => {
    await request<BotStatus>("/bot/stop", { method: "POST" }).then((status) => setState("status", status))
  }

  const add = (provider: BotProvider) => {
    setState("config", "connections", [...(state.config.connections ?? []), emptyConnection(provider)])
  }

  const remove = (id: string) => {
    setState("config", "connections", (state.config.connections ?? []).filter((item) => item.id !== id))
  }

  const addRoute = () => {
    setState("config", "routes", [
      ...(state.config.routes ?? []),
      { connectionId: "", platform: "", chatType: "", chatId: "", userId: "", threadId: "", workspaceRoot: "", toolApprovalMode: "" },
    ])
  }

  const removeRoute = (index: number) => {
    setState("config", "routes", (state.config.routes ?? []).filter((_, i) => i !== index))
  }

  const installWeixin = async () => {
    const result = await request<{ installID: string; url: string; status?: string }>("/bot/weixin/install", { method: "POST" })
    setState("weixinInstall", result)
  }

  const pollWeixin = async () => {
    if (!state.weixinInstall?.installID) return
    const result = await request<{ done?: boolean; status?: string }>(`/bot/weixin/install/${state.weixinInstall.installID}`)
    if (!result.done) {
      setState("weixinInstall", "status", result.status || "等待扫码")
      return
    }
    setState("weixinInstall", undefined)
    await load()
  }

  onMount(() => void load())

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">手机机器人</h2>
        <p class="settings-v2-bots-subtitle">按 Reasonix 的 QQ / 飞书 / Lark / 微信入口组织配置，消息会进入 HoyaAgent 的 Pi 会话。</p>
      </div>

      <div class="settings-v2-tab-body settings-v2-bots">
      <section class="settings-v2-section">
        <div class="settings-v2-bots-summary">
          <SummaryCard title="运行状态" value={state.status.running ? "运行中" : "已停止"} hint={state.status.startedAt || state.status.status || "未启动"} />
          <SummaryCard title="连接数" value={`${state.status.connections?.length ?? 0}`} hint="已配置且运行时可见的连接" />
          <SummaryCard title="访问策略" value={state.config.allowAll ? "开放" : "白名单"} hint="可在全局或单连接级别覆盖" />
        </div>
      </section>

      <section class="settings-v2-section">
        <div class="settings-v2-bots-card">
          <div class="settings-v2-bots-card-header">
            <div>
              <div class="settings-v2-bots-card-title">机器人网关</div>
              <div class="settings-v2-bots-card-description">保存后会重启运行时；飞书/Lark 使用本地 Webhook，QQ/微信使用网关连接。</div>
            </div>
            <div class="settings-v2-bots-actions">
              <ButtonV2 variant="neutral" size="normal" onClick={start}>启动</ButtonV2>
              <ButtonV2 variant="neutral" size="normal" onClick={stop}>停止</ButtonV2>
            </div>
          </div>
          <div class="settings-v2-bots-grid settings-v2-bots-grid--two">
            <Toggle label="启用机器人" checked={state.config.enabled} onChange={(value) => setState("config", "enabled", value)} />
            <Toggle label="全局允许所有人" checked={state.config.allowAll} onChange={(value) => setState("config", "allowAll", value)} />
            <Field label="消息合并延迟 ms" value={String(state.config.debounceMs ?? 800)} onInput={(value) => setState("config", "debounceMs", Number(value) || 0)} />
            <Field label="最大步骤数" value={String(state.config.maxSteps ?? 40)} onInput={(value) => setState("config", "maxSteps", Number(value) || 0)} />
          </div>
        </div>
      </section>

      <section class="settings-v2-section">
        <div class="settings-v2-bots-actions">
          <For each={providers}>
            {(provider) => (
              <ButtonV2 variant="neutral" size="normal" onClick={() => add(provider)}>
                <Icon name="plus" /> 添加 {providerLabel(provider)}
              </ButtonV2>
            )}
          </For>
          <ButtonV2 variant="neutral" size="normal" onClick={installWeixin}>微信扫码登录</ButtonV2>
          <Show when={state.weixinInstall}>
            <ButtonV2 variant="contrast" size="normal" onClick={pollWeixin}>我已扫码，检查状态</ButtonV2>
          </Show>
          <ButtonV2 variant="neutral" size="normal" disabled={state.loading} onClick={load}>刷新状态</ButtonV2>
        </div>
        <Show when={state.weixinInstall?.url}>
          <div class="settings-v2-bots-inline-card">
            微信二维码链接：<a class="text-accent underline" href={state.weixinInstall?.url} target="_blank">打开扫码</a>
            <div>状态：{state.weixinInstall?.status || "等待扫码"}</div>
          </div>
        </Show>
      </section>

      <section class="settings-v2-section">
        <Show when={(state.config.connections ?? []).length === 0}>
          <div class="settings-v2-bots-empty">还没有机器人连接。先添加 QQ、飞书、Lark 或微信。</div>
        </Show>
        <For each={state.config.connections ?? []}>
          {(conn, index) => (
            <div class="settings-v2-bots-card">
              <div class="settings-v2-bots-card-header">
                <div>
                  <div class="settings-v2-bots-card-title">{conn.label || providerLabel(conn.provider)}</div>
                  <div class="settings-v2-bots-card-description">{conn.id} · {connectionStatus(state.status.connections, conn.id)}</div>
                </div>
                <ButtonV2 variant="ghost-muted" size="normal" onClick={() => remove(conn.id)}>删除</ButtonV2>
              </div>

              <div class="settings-v2-bots-grid settings-v2-bots-grid--two">
                <Field label="连接 ID" value={conn.id} onInput={(value) => setState("config", "connections", index(), "id", value)} />
                <Field label="显示名" value={conn.label || ""} onInput={(value) => setState("config", "connections", index(), "label", value)} />
                <Field label="工作区路径" value={conn.workspaceRoot || ""} placeholder="留空使用默认工作区" onInput={(value) => setState("config", "connections", index(), "workspaceRoot", value)} />
                <Field label="模型 provider/model" value={formatModel(conn.model)} placeholder="例如 nvida/meta/llama-3.1-8b-instruct" onInput={(value) => setState("config", "connections", index(), "model", parseModel(value))} />
                <Select label="工具审批" value={conn.toolApprovalMode || ""} onChange={(value) => setState("config", "connections", index(), "toolApprovalMode", value)} options={[
                  ["", "继承全局"],
                  ["ask", "询问"],
                  ["allow", "自动允许"],
                  ["deny", "拒绝"],
                ]} />

                <Show when={conn.provider !== "weixin"}>
                  <Field label="App ID" value={conn.appID || ""} onInput={(value) => setState("config", "connections", index(), "appID", value)} />
                  <Field label="App Secret" value={conn.appSecret || ""} type="password" placeholder="也可使用 Secret 环境变量" onInput={(value) => setState("config", "connections", index(), "appSecret", value)} />
                  <Field label="Secret 环境变量" value={conn.appSecretEnv || ""} onInput={(value) => setState("config", "connections", index(), "appSecretEnv", value)} />
                </Show>

                <Show when={conn.provider === "feishu" || conn.provider === "lark"}>
                  <Field label="Verification Token" value={conn.verificationToken || ""} onInput={(value) => setState("config", "connections", index(), "verificationToken", value)} />
                  <Field label="Webhook Port" value={conn.webhookPort ? String(conn.webhookPort) : ""} onInput={(value) => setState("config", "connections", index(), "webhookPort", Number(value) || undefined)} />
                  <Field label="Webhook 地址" value={botURL(conn)} readonly />
                </Show>

                <Show when={conn.provider === "weixin"}>
                  <Field label="Account ID" value={conn.accountID || ""} onInput={(value) => setState("config", "connections", index(), "accountID", value)} />
                  <Field label="Token" value={conn.token || ""} type="password" onInput={(value) => setState("config", "connections", index(), "token", value)} />
                  <Field label="Token 环境变量" value={conn.tokenEnv || ""} onInput={(value) => setState("config", "connections", index(), "tokenEnv", value)} />
                  <Field label="API Base" value={conn.apiBase || ""} onInput={(value) => setState("config", "connections", index(), "apiBase", value)} />
                </Show>

                <Field label="允许用户 ID（逗号分隔）" value={(conn.allowUsers ?? []).join(",")} onInput={(value) => setState("config", "connections", index(), "allowUsers", splitList(value))} />
                <Field label="允许群/聊天 ID（逗号分隔）" value={(conn.allowGroups ?? []).join(",")} onInput={(value) => setState("config", "connections", index(), "allowGroups", splitList(value))} />
              </div>

              <div class="settings-v2-bots-toggle-row">
                <Toggle label="启用连接" checked={conn.enabled} onChange={(value) => setState("config", "connections", index(), "enabled", value)} />
                <Toggle label="本连接允许所有人" checked={conn.allowAll} onChange={(value) => setState("config", "connections", index(), "allowAll", value)} />
                <Show when={conn.provider === "qq"}>
                  <Toggle label="QQ 沙箱" checked={conn.sandbox} onChange={(value) => setState("config", "connections", index(), "sandbox", value)} />
                </Show>
                <Show when={conn.provider === "feishu" || conn.provider === "lark"}>
                  <Toggle label="群聊要求 @Bot" checked={conn.requireMention !== false} onChange={(value) => setState("config", "connections", index(), "requireMention", value)} />
                </Show>
              </div>

              <Show when={(conn.sessionMappings ?? []).length > 0}>
                  <div class="settings-v2-bots-inline-card">
                  <div class="settings-v2-bots-card-title">会话映射</div>
                  <For each={conn.sessionMappings ?? []}>
                    {(mapping) => (
                      <div class="settings-v2-bots-mapping-row">
                        <span>{mapping.remoteID}</span>
                        <span>{mapping.sessionID || "未绑定会话"}</span>
                        <span>{mapping.chatType || "chat"}</span>
                        <span>{mapping.updatedAt || ""}</span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </section>

      <section class="settings-v2-section">
        <details class="settings-v2-bots-card">
          <summary class="settings-v2-bots-summary-title">高级设置 · 访问、队列与路由</summary>
          <div class="settings-v2-bots-details">
            <div class="settings-v2-bots-inline-card">
              <div class="settings-v2-bots-card-title">谁可以使用</div>
              <div class="settings-v2-bots-grid settings-v2-bots-grid--three">
                <For each={["qq", "feishu", "weixin"]}>
                  {(platform) => (
                    <div class="settings-v2-bots-nested-card">
                      <div class="settings-v2-bots-card-title">{platformLabel(platform)}</div>
                      <TextArea label="用户 ID" value={joinList(state.config.allowUsers?.[platform])} onInput={(value) => setRecordList("allowUsers", platform, value, setState)} />
                      <TextArea label="群/聊天 ID" value={joinList(state.config.allowGroups?.[platform])} onInput={(value) => setRecordList("allowGroups", platform, value, setState)} />
                      <TextArea label="审批人" value={joinList(state.config.approvers?.[platform])} onInput={(value) => setRecordList("approvers", platform, value, setState)} />
                      <TextArea label="管理员" value={joinList(state.config.admins?.[platform])} onInput={(value) => setRecordList("admins", platform, value, setState)} />
                    </div>
                  )}
                </For>
              </div>
            </div>

            <div class="settings-v2-bots-inline-card">
              <div class="settings-v2-bots-card-title">运行时与消息队列</div>
              <div class="settings-v2-bots-grid settings-v2-bots-grid--three">
                <Field label="队列容量" value={String(state.config.queueCap ?? 8)} onInput={(value) => setState("config", "queueCap", Number(value) || 0)} />
                <Select label="新消息处理" value={state.config.queueMode || "queue"} onChange={(value) => setState("config", "queueMode", value)} options={[["queue", "排队"], ["replace", "替换等待消息"], ["reject", "直接拒绝"]]} />
                <Select label="队列满时" value={state.config.queueDrop || "oldest"} onChange={(value) => setState("config", "queueDrop", value)} options={[["oldest", "丢弃最旧"], ["newest", "丢弃最新"]]} />
                <Toggle label="忽略机器人自己发出的消息" checked={state.config.ignoreSelfMessages !== false} onChange={(value) => setState("config", "ignoreSelfMessages", value)} />
                <Toggle label="陌生私聊先配对" checked={state.config.pairing?.enabled} onChange={(value) => setState("config", "pairing", { ...(state.config.pairing ?? {}), enabled: value })} />
                <Field label="配对码有效期（分钟）" value={String(state.config.pairing?.requestTtlMinutes ?? 10)} onInput={(value) => setState("config", "pairing", { ...(state.config.pairing ?? {}), requestTtlMinutes: Number(value) || 0 })} />
                <Field label="每平台最大待批准数" value={String(state.config.pairing?.maxPendingPerPlatform ?? 20)} onInput={(value) => setState("config", "pairing", { ...(state.config.pairing ?? {}), maxPendingPerPlatform: Number(value) || 0 })} />
              </div>
              <div class="settings-v2-bots-grid settings-v2-bots-grid--three">
                <For each={["qq", "feishu", "weixin"]}>
                  {(platform) => <TextArea label={`自身 ${platformLabel(platform)} ID`} value={joinList(state.config.selfUserIds?.[platform])} onInput={(value) => setRecordList("selfUserIds", platform, value, setState)} />}
                </For>
              </div>
            </div>

            <div class="settings-v2-bots-inline-card">
              <div class="settings-v2-bots-card-header">
                <div>
                  <div class="settings-v2-bots-card-title">路由规则</div>
                  <div class="settings-v2-bots-card-description">按连接、平台、群聊或用户覆盖工作区、模型与审批模式。</div>
                </div>
                <ButtonV2 variant="neutral" size="normal" onClick={addRoute}>添加路由</ButtonV2>
              </div>
              <Show when={(state.config.routes ?? []).length === 0}>
                <div class="settings-v2-bots-message">没有路由规则，所有消息使用连接自身配置。</div>
              </Show>
              <For each={state.config.routes ?? []}>
                {(route, index) => (
                  <div class="settings-v2-bots-nested-card">
                    <div class="settings-v2-bots-card-header">
                      <span class="settings-v2-bots-card-title">路由 {index() + 1}</span>
                      <ButtonV2 variant="ghost-muted" size="normal" onClick={() => removeRoute(index())}>删除</ButtonV2>
                    </div>
                    <div class="settings-v2-bots-grid settings-v2-bots-grid--three">
                      <Select label="连接" value={route.connectionId || ""} onChange={(value) => setState("config", "routes", index(), "connectionId", value)} options={[["", "任意连接"], ...(state.config.connections ?? []).map((conn) => [conn.id, `${conn.label || providerLabel(conn.provider)} · ${conn.id}`] as [string, string])]} />
                      <Select label="平台" value={route.platform || ""} onChange={(value) => setState("config", "routes", index(), "platform", value)} options={[["", "任意平台"], ["qq", "QQ"], ["feishu", "飞书"], ["lark", "Lark"], ["weixin", "微信"]]} />
                      <Select label="聊天类型" value={route.chatType || ""} onChange={(value) => setState("config", "routes", index(), "chatType", value)} options={[["", "任意"], ["private", "私聊"], ["group", "群聊"], ["channel", "频道"]]} />
                      <Field label="Chat ID" value={route.chatId || ""} onInput={(value) => setState("config", "routes", index(), "chatId", value)} />
                      <Field label="User ID" value={route.userId || ""} onInput={(value) => setState("config", "routes", index(), "userId", value)} />
                      <Field label="Thread ID" value={route.threadId || ""} onInput={(value) => setState("config", "routes", index(), "threadId", value)} />
                      <Field label="工作区路径" value={route.workspaceRoot || ""} onInput={(value) => setState("config", "routes", index(), "workspaceRoot", value)} />
                      <Field label="模型 provider/model" value={formatModel(route.model)} onInput={(value) => setState("config", "routes", index(), "model", parseModel(value))} />
                      <Select label="工具审批" value={route.toolApprovalMode || ""} onChange={(value) => setState("config", "routes", index(), "toolApprovalMode", value)} options={[["", "继承"], ["ask", "询问"], ["allow", "自动允许"], ["deny", "拒绝"]]} />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </details>
      </section>

      <div class="settings-v2-bots-footer">
        <ButtonV2 variant="contrast" size="normal" disabled={state.saving} onClick={save}>{state.saving ? "保存中..." : "保存并重启机器人"}</ButtonV2>
        <span class="settings-v2-bots-message">{state.message}</span>
      </div>
      </div>
    </>
  )
}

function defaultConfig(): BotConfig {
  return {
    enabled: false,
    maxSteps: 40,
    debounceMs: 800,
    queueCap: 8,
    queueMode: "queue",
    queueDrop: "oldest",
    ignoreSelfMessages: true,
    allowAll: false,
    allowUsers: {},
    allowGroups: {},
    approvers: {},
    admins: {},
    selfUserIds: {},
    pairing: { enabled: false, requestTtlMinutes: 10, maxPendingPerPlatform: 20 },
    routes: [],
    connections: [],
  }
}

function SummaryCard(props: { title: string; value: string; hint: string }) {
  return (
    <div class="settings-v2-bots-summary-card">
      <div class="settings-v2-bots-summary-label">{props.title}</div>
      <div class="settings-v2-bots-summary-value">{props.value}</div>
      <div class="settings-v2-bots-summary-hint">{props.hint}</div>
    </div>
  )
}

function Toggle(props: { label: string; checked?: boolean; onChange: (value: boolean) => void }) {
  return (
    <div class="settings-v2-bots-toggle">
      <span>{props.label}</span>
      <Switch checked={props.checked} onChange={props.onChange} hideLabel>{props.label}</Switch>
    </div>
  )
}

function Field(props: { label: string; value: string; type?: string; readonly?: boolean; placeholder?: string; onInput?: (value: string) => void }) {
  return (
    <label class="settings-v2-bots-control">
      <span>{props.label}</span>
      <TextInputV2 type={props.type || "text"} appearance="base" value={props.value} readOnly={props.readonly} placeholder={props.placeholder} onInput={(event) => props.onInput?.(event.currentTarget.value)} />
    </label>
  )
}

function TextArea(props: { label: string; value: string; placeholder?: string; onInput: (value: string) => void }) {
  return (
    <label class="settings-v2-bots-control">
      <span>{props.label}</span>
      <textarea class="settings-v2-bots-textarea" value={props.value} placeholder={props.placeholder || "一行一个或逗号分隔"} onInput={(event) => props.onInput(event.currentTarget.value)} />
    </label>
  )
}

function Select(props: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return (
    <label class="settings-v2-bots-control">
      <span>{props.label}</span>
      <select class="settings-v2-bots-select" value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)}>
        <For each={props.options}>{([value, label]) => <option value={value}>{label}</option>}</For>
      </select>
    </label>
  )
}

function providerLabel(provider: BotProvider) {
  if (provider === "qq") return "QQ"
  if (provider === "feishu") return "飞书"
  if (provider === "lark") return "Lark"
  return "微信"
}

function splitList(value: string) {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
}

function joinList(value: string[] | undefined) {
  return (value ?? []).join("\n")
}

function setRecordList(key: "allowUsers" | "allowGroups" | "approvers" | "admins" | "selfUserIds", platform: string, value: string, setState: any) {
  setState("config", key, (current: Record<string, string[]> | undefined) => ({
    ...(current ?? {}),
    [platform]: splitList(value),
  }))
}

function platformLabel(platform: string) {
  if (platform === "qq") return "QQ"
  if (platform === "feishu") return "飞书/Lark"
  if (platform === "weixin") return "微信"
  return platform
}

function connectionStatus(list: BotStatus["connections"], id: string) {
  const item = list?.find((conn) => conn.id === id)
  if (!item) return "未运行"
  return item.lastError ? `${item.status}: ${item.lastError}` : item.status
}

function formatModel(model: BotConnection["model"]) {
  return model ? `${model.providerID}/${model.modelID}` : ""
}

function parseModel(value: string) {
  const trimmed = value.trim()
  const separator = trimmed.indexOf("/")
  if (separator <= 0) return undefined
  return { providerID: trimmed.slice(0, separator), modelID: trimmed.slice(separator + 1) }
}
