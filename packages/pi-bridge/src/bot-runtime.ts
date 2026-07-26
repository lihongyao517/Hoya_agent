import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { createSession, defaultDirectory, getSession, promptSession, type BridgeMessage } from "./session-store"
import { homeDir, loadConfig, mergeConfig, type BotConfig, type BotConnectionConfig } from "./config-store"

type BotInboundMessage = {
  platform: BotConnectionConfig["provider"]
  connectionID: string
  chatType: "dm" | "group" | "guild" | "direct" | "thread"
  chatID: string
  userID: string
  userName?: string
  text: string
  messageID?: string
  replyToMsgID?: string
}

type Adapter = {
  id: string
  provider: BotConnectionConfig["provider"]
  domain: string
  start: (runtime: BotRuntime) => Promise<void>
  stop: () => Promise<void>
  send: (msg: BotInboundMessage, text: string) => Promise<{ messageID?: string }>
  status: "configured" | "running" | "stopped" | "error"
  lastError?: string
}

const adapters = new Map<string, Adapter>()
const activeTurns = new Map<string, Promise<void>>()
let running = false
let startedAt = ""

export class BotRuntime {
  async handleInbound(msg: BotInboundMessage) {
    const config = await loadConfig()
    const conn = config.bot?.connections?.find((item) => item.id === msg.connectionID)
    const adapter = adapters.get(msg.connectionID)
    if (!conn || !adapter) return
    if (!allowed(conn, config.bot?.allowAll === true, msg)) {
      await adapter.send(msg, "抱歉，您没有使用此 bot 的权限。请在 HoyaAgent 设置里加入白名单，或开启允许所有人。")
      return
    }
    if (msg.text.trim() === "/status") {
      await adapter.send(msg, `HoyaAgent bot 已连接：${msg.connectionID}`)
      return
    }
    if (msg.text.trim() === "/new") {
      await rememberSession(conn, msg, "")
      await adapter.send(msg, "已为本聊天创建新的 Hoya 会话。")
      return
    }
    const key = `${msg.connectionID}\u0000${msg.chatID}`
    const previous = activeTurns.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => runTurn(conn, adapter, msg))
    activeTurns.set(key, next.finally(() => activeTurns.get(key) === next && activeTurns.delete(key)))
  }
}

export async function startBotRuntime() {
  await stopBotRuntime()
  const config = await loadConfig()
  if (!config.bot?.enabled) return botStatus()
  running = true
  startedAt = new Date().toISOString()
  const runtime = new BotRuntime()
  for (const conn of config.bot.connections ?? []) {
    if (!conn.enabled) continue
    const adapter = createAdapter(conn)
    if (!adapter) continue
    adapters.set(conn.id, adapter)
    try {
      await adapter.start(runtime)
      adapter.status = "running"
    } catch (error) {
      adapter.status = "error"
      adapter.lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return botStatus()
}

export async function stopBotRuntime() {
  await Promise.all([...adapters.values()].map((adapter) => adapter.stop().catch(() => undefined)))
  adapters.clear()
  running = false
  startedAt = ""
  return botStatus()
}

export function botStatus() {
  return {
    running,
    status: running ? "running" : "stopped",
    connections: [...adapters.values()].map((adapter) => ({
      id: adapter.id,
      provider: adapter.provider,
      domain: adapter.domain,
      status: adapter.status,
      lastError: adapter.lastError ?? "",
    })),
    startedAt,
  }
}

export async function saveBotConfig(patch: BotConfig) {
  const current = await loadConfig()
  const next = await mergeConfig({
    bot: {
      ...(current.bot ?? {}),
      ...patch,
      connections: patch.connections ?? current.bot?.connections ?? [],
    },
  })
  await startBotRuntime()
  return next.bot
}

export async function botWebhook(provider: string, id: string, body: unknown, runtime = new BotRuntime()) {
  const config = await loadConfig()
  const conn = config.bot?.connections?.find((item) => item.id === id || item.provider === provider)
  if (!conn || !conn.enabled) return { ok: false, status: 404, body: { error: "bot connection not found" } }
  if (conn.provider === "feishu" || conn.provider === "lark") return handleFeishuWebhook(conn, body, runtime)
  return { ok: false, status: 400, body: { error: "webhook provider unsupported" } }
}

function createAdapter(conn: BotConnectionConfig): Adapter | undefined {
  if (conn.provider === "qq") return newQQAdapter(conn)
  if (conn.provider === "weixin") return newWeixinAdapter(conn)
  if (conn.provider === "feishu" || conn.provider === "lark") return newFeishuAdapter(conn)
}

async function runTurn(conn: BotConnectionConfig, adapter: Adapter, msg: BotInboundMessage) {
  const sessionID = await sessionFor(conn, msg)
  const session = await createSession({
    id: sessionID || undefined,
    directory: conn.workspaceRoot || defaultDirectory(),
    title: `${labelFor(conn)} ${msg.userName || msg.userID || msg.chatID}`,
    model: conn.model,
  })
  await rememberSession(conn, msg, session.id)
  const assistantID = (await promptSession(session.id, {
    directory: session.directory,
    model: conn.model,
    parts: [{ type: "text", text: msg.text }],
  })).assistantID
  const text = await waitAssistantText(session.id, assistantID)
  await adapter.send(msg, text || "（没有收到模型回复）")
}

async function waitAssistantText(sessionID: string, assistantID: string) {
  for (let i = 0; i < 900; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const msg = getSession(sessionID)?.messages.find((item) => item.info.id === assistantID) as BridgeMessage | undefined
    if (msg?.info.error) return `出错了：${String(msg.info.error)}`
    if (msg?.info.time.completed) return messageText(msg)
  }
  return "任务还在执行中，请稍后发送 /status 查看。"
}

function messageText(msg: BridgeMessage) {
  return msg.parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n").trim()
}

async function sessionFor(conn: BotConnectionConfig, msg: BotInboundMessage) {
  return conn.sessionMappings?.find((item) => item.remoteID === msg.chatID)?.sessionID ?? ""
}

async function rememberSession(conn: BotConnectionConfig, msg: BotInboundMessage, sessionID: string) {
  const config = await loadConfig()
  const connections = (config.bot?.connections ?? []).map((item) => {
    if (item.id !== conn.id) return item
    const existing = item.sessionMappings?.filter((mapping) => mapping.remoteID !== msg.chatID) ?? []
    return {
      ...item,
      sessionMappings: sessionID
        ? [...existing, { remoteID: msg.chatID, sessionID, chatType: msg.chatType, userID: msg.userID, updatedAt: new Date().toISOString() }]
        : existing,
      updatedAt: new Date().toISOString(),
    }
  })
  await mergeConfig({ bot: { ...(config.bot ?? {}), connections } })
}

function allowed(conn: BotConnectionConfig, globalAllowAll: boolean, msg: BotInboundMessage) {
  if (globalAllowAll || conn.allowAll) return true
  const users = new Set(conn.allowUsers ?? [])
  const groups = new Set(conn.allowGroups ?? [])
  if (users.has(msg.userID)) return true
  return msg.chatType !== "dm" && groups.has(msg.chatID)
}

function labelFor(conn: BotConnectionConfig) {
  return conn.label || conn.provider.toUpperCase()
}

function secret(conn: BotConnectionConfig) {
  return (conn.appSecret || (conn.appSecretEnv ? process.env[conn.appSecretEnv] : "") || "").trim()
}

function token(conn: BotConnectionConfig) {
  return (conn.token || (conn.tokenEnv ? process.env[conn.tokenEnv] : "") || "").trim()
}

function randomID(prefix: string) {
  return `${prefix}-${randomBytes(12).toString("hex")}`
}

function newFeishuAdapter(conn: BotConnectionConfig): Adapter {
  return {
    id: conn.id,
    provider: conn.provider,
    domain: conn.provider === "lark" ? "lark" : "feishu",
    status: "configured",
    async start() {
      if (!conn.appID || !secret(conn)) throw new Error("飞书/Lark app_id 或 app_secret 未配置")
    },
    async stop() {},
    async send(msg, text) {
      const content = JSON.stringify(markdownCard(text))
      const base = conn.provider === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn"
      const tenantToken = await feishuTenantToken(base, conn)
      const res = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: { authorization: `Bearer ${tenantToken}`, "content-type": "application/json" },
        body: JSON.stringify({ receive_id: msg.chatID, msg_type: "interactive", content }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.code) throw new Error(`飞书发送失败：${data.msg || res.statusText}`)
      return { messageID: data.data?.message_id }
    },
  }
}

async function feishuTenantToken(base: string, conn: BotConnectionConfig) {
  const res = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: conn.appID, app_secret: secret(conn) }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.code) throw new Error(`获取飞书 token 失败：${data.msg || res.statusText}`)
  return data.tenant_access_token as string
}

function markdownCard(text: string) {
  return { schema: "2.0", body: { elements: [{ tag: "markdown", content: text }] } }
}

async function handleFeishuWebhook(conn: BotConnectionConfig, body: unknown, runtime: BotRuntime) {
  const payload = body as any
  if (payload.type === "url_verification") {
    if (conn.verificationToken && payload.token !== conn.verificationToken) return { ok: false, status: 403, body: { error: "forbidden" } }
    return { ok: true, status: 200, body: { challenge: payload.challenge } }
  }
  if (conn.verificationToken && payload.header?.token && payload.header.token !== conn.verificationToken) return { ok: false, status: 403, body: { error: "forbidden" } }
  if (payload.header?.event_type !== "im.message.receive_v1") return { ok: true, status: 200, body: { ok: true } }
  const event = payload.event ?? {}
  const content = JSON.parse(event.message?.content || "{}")
  const text = String(content.text || "").trim()
  if (!text) return { ok: true, status: 200, body: { ok: true } }
  if ((event.message?.chat_type === "group" || event.message?.chat_type === "topic_group") && conn.requireMention !== false) {
    const mentions = event.message?.mentions ?? []
    if (mentions.length === 0) return { ok: true, status: 200, body: { ok: true } }
  }
  void runtime.handleInbound({
    platform: conn.provider,
    connectionID: conn.id,
    chatType: event.message?.chat_type === "group" || event.message?.chat_type === "topic_group" ? "group" : "dm",
    chatID: event.message?.chat_id || "",
    userID: event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || "",
    text,
    messageID: event.message?.message_id,
  })
  return { ok: true, status: 200, body: { ok: true } }
}

function newWeixinAdapter(conn: BotConnectionConfig): Adapter {
  let stopped = false
  let syncBuf = ""
  const contextTokens = new Map<string, string>()
  const base = () => (conn.apiBase || "https://ilinkai.weixin.qq.com").replace(/\/$/, "")
  return {
    id: conn.id,
    provider: "weixin",
    domain: "weixin",
    status: "configured",
    async start(runtime) {
      if (!token(conn)) throw new Error("微信 token 未配置")
      stopped = false
      void (async () => {
        while (!stopped) {
          try {
            const updates = await weixinUpdates(base(), token(conn), syncBuf)
            syncBuf = updates.get_updates_buf || syncBuf
            for (const item of [...(updates.updates ?? []), ...(updates.msgs ?? [])]) {
              const msg = normalizeWeixin(item, conn.accountID || "default")
              if (msg) void runtime.handleInbound({ ...msg, connectionID: conn.id })
            }
          } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error)
          }
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      })()
    },
    async stop() {
      stopped = true
    },
    async send(msg, text) {
      const payload: any = {
        base_info: { channel_version: "2.2.0" },
        msg: {
          from_user_id: "",
          to_user_id: msg.chatID,
          client_id: randomID("hoya"),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
        },
      }
      if (contextTokens.has(msg.chatID)) payload.msg.context_token = contextTokens.get(msg.chatID)
      const data = await weixinPost(base(), "/ilink/bot/sendmessage", token(conn), payload)
      if (data.ret || data.errcode) throw new Error(`微信发送失败：${data.errmsg || data.errcode}`)
      return { messageID: String(data.message_id || "") }
    },
  }
}

async function weixinUpdates(base: string, tok: string, syncBuf: string) {
  return weixinPost(base, "/ilink/bot/getupdates", tok, { get_updates_buf: syncBuf, base_info: { channel_version: "2.2.0" } })
}

async function weixinPost(base: string, endpoint: string, tok: string, payload: unknown) {
  const body = JSON.stringify(payload)
  const res = await fetch(`${base}${endpoint}`, { method: "POST", headers: weixinHeaders(tok, body), body })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`微信 HTTP ${res.status}`)
  return data
}

function weixinHeaders(tok: string, body: string) {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${tok}`,
    "Content-Length": String(Buffer.byteLength(body)),
    "X-WECHAT-UIN": randomBytes(4).readUInt32BE(0).toString(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String((2 << 16) | (2 << 8)),
  }
}

function normalizeWeixin(raw: any, accountID: string): Omit<BotInboundMessage, "connectionID"> | undefined {
  const message = raw.message ?? raw
  const text = message.text || message.item_list?.map((item: any) => item.text_item?.text || "").join("\n")
  const userID = message.from?.user_id || message.from_user_id
  if (!text || !userID || userID === accountID) return
  const chatID = message.chat_id || message.room_id || message.chat_room_id || userID
  return { platform: "weixin", chatType: message.chat_type === "group" || message.room_id ? "group" : "dm", chatID, userID, userName: message.from?.user_name || userID, text, messageID: String(message.message_id || "") }
}

function newQQAdapter(conn: BotConnectionConfig): Adapter {
  let ws: WebSocket | undefined
  let accessToken = ""
  let tokenExpires = 0
  let seq = 0
  return {
    id: conn.id,
    provider: "qq",
    domain: "qq",
    status: "configured",
    async start(runtime) {
      if (!conn.appID || !secret(conn)) throw new Error("QQ app_id 或 app_secret 未配置")
      accessToken = await qqToken(conn)
      tokenExpires = Date.now() + 30 * 60_000
      const gateway = await qqGateway(conn, accessToken)
      ws = new WebSocket(gateway, { headers: { Authorization: `QQBot ${accessToken}`, "X-Union-Appid": conn.appID } })
      ws.on("message", (data) => {
        const payload = JSON.parse(String(data))
        if (payload.s) seq = payload.s
        if (payload.op === 10) {
          setInterval(() => ws?.send(JSON.stringify({ op: 1, d: seq || null })), Math.max(5000, payload.d?.heartbeat_interval || 45000))
          ws?.send(JSON.stringify({ op: 2, d: { token: `QQBot ${accessToken}`, intents: 1 << 0 | 1 << 1 | 1 << 9 | 1 << 10 | 1 << 12 | 1 << 25 | 1 << 26, shard: [0, 1], properties: { $os: "windows", $browser: "hoyaagent", $device: "hoyaagent" } } }))
          return
        }
        const msg = normalizeQQ(payload, conn.id)
        if (msg) void runtime.handleInbound(msg)
      })
    },
    async stop() {
      ws?.close()
    },
    async send(msg, text) {
      if (!accessToken || Date.now() > tokenExpires) accessToken = await qqToken(conn)
      const chunks = splitBytes(text, 1500)
      let messageID = ""
      for (const chunk of chunks) {
        const data = await qqSend(conn, accessToken, msg, chunk)
        messageID = data.id || messageID
      }
      return { messageID }
    },
  }
}

async function qqToken(conn: BotConnectionConfig) {
  const res = await fetch("https://bots.qq.com/app/getAppAccessToken", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: conn.appID, clientSecret: secret(conn) }) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) throw new Error(`QQ token 获取失败：${data.message || res.statusText}`)
  return data.access_token as string
}

async function qqGateway(conn: BotConnectionConfig, tok: string) {
  const base = conn.sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com"
  const res = await fetch(`${base}/gateway`, { headers: { Authorization: `QQBot ${tok}` } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.url) throw new Error("QQ gateway 获取失败")
  return data.url as string
}

function normalizeQQ(payload: any, connectionID: string): BotInboundMessage | undefined {
  if (payload.op !== 0 || !payload.d) return
  const d = payload.d
  const userID = d.author?.user_openid || d.author?.member_openid || d.author?.union_openid || d.author?.id || ""
  const base = { platform: "qq" as const, connectionID, userID, userName: d.author?.username, text: d.content || "", messageID: d.id }
  if (payload.t === "C2C_MESSAGE_CREATE") return { ...base, chatType: "dm", chatID: userID }
  if (payload.t === "GROUP_AT_MESSAGE_CREATE") return { ...base, chatType: "group", chatID: d.group_openid }
  if (payload.t === "AT_MESSAGE_CREATE") return { ...base, chatType: "guild", chatID: d.channel_id }
  if (payload.t === "DIRECT_MESSAGE_CREATE") return { ...base, chatType: "direct", chatID: d.guild_id }
}

async function qqSend(conn: BotConnectionConfig, tok: string, msg: BotInboundMessage, text: string) {
  const base = conn.sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com"
  const target = msg.chatType === "group" ? `/v2/groups/${encodeURIComponent(msg.chatID)}/messages` : msg.chatType === "guild" || msg.chatType === "thread" ? `/v2/channels/${encodeURIComponent(msg.chatID)}/messages` : msg.chatType === "direct" ? `/v2/dms/${encodeURIComponent(msg.chatID)}/messages` : `/v2/users/${encodeURIComponent(msg.chatID)}/messages`
  const res = await fetch(`${base}${target}`, { method: "POST", headers: { authorization: `QQBot ${tok}`, "content-type": "application/json", "X-Union-Appid": conn.appID || "" }, body: JSON.stringify({ content: text, msg_type: 0, msg_id: msg.messageID }) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`QQ 发送失败：${JSON.stringify(data).slice(0, 200)}`)
  return data
}

function splitBytes(text: string, max: number) {
  const chunks: string[] = []
  let rest = text || " "
  while (Buffer.byteLength(rest) > max) {
    let cut = 0
    for (const char of rest) {
      if (Buffer.byteLength(rest.slice(0, cut + char.length)) > max) break
      cut += char.length
    }
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  chunks.push(rest)
  return chunks
}

export async function startWeixinInstall() {
  const data = await (await fetch("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3", { headers: { "iLink-App-Id": "bot", "iLink-App-ClientVersion": String((2 << 16) | (2 << 8)) } })).json()
  const installID = randomID("wx")
  await fs.mkdir(path.join(homeDir(), "bot-installs"), { recursive: true })
  await fs.writeFile(path.join(homeDir(), "bot-installs", `${installID}.json`), JSON.stringify({ qrcode: data.qrcode, baseURL: "https://ilinkai.weixin.qq.com", expiresAt: Date.now() + 120_000 }, null, 2))
  return { ok: true, installID, url: data.qrcode_img_content || data.qrcode, deviceCode: data.qrcode, interval: 3, expireIn: 120 }
}

export async function pollWeixinInstall(installID: string) {
  const file = path.join(homeDir(), "bot-installs", `${installID}.json`)
  const session = JSON.parse(await fs.readFile(file, "utf8"))
  const data = await (await fetch(`${session.baseURL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`, { headers: { "iLink-App-Id": "bot", "iLink-App-ClientVersion": String((2 << 16) | (2 << 8)) } })).json()
  if (data.status !== "confirmed") return { done: false, status: data.status || "wait" }
  const config = await loadConfig()
  const conn: BotConnectionConfig = { id: "weixin-weixin", provider: "weixin", label: "微信", enabled: true, status: "connected", accountID: String(data.ilink_bot_id), token: String(data.bot_token), apiBase: String(data.baseurl || session.baseURL), allowUsers: [String(data.ilink_user_id)].filter(Boolean), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const connections = [...(config.bot?.connections ?? []).filter((item) => item.id !== conn.id), conn]
  await saveBotConfig({ enabled: true, connections })
  await fs.unlink(file).catch(() => undefined)
  return { done: true, status: "connected", connection: conn }
}
