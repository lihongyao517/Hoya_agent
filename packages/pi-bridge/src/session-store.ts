import path from "node:path"
import os from "node:os"
import { existsSync } from "node:fs"
import { id, projectIdForDirectory } from "./ids"
import { emit } from "./events"
import { loadPiCodingAgent } from "./pi-loader"
import { enableProvider, loadAuthFile, loadConfig, mergeConfig, saveAuthProvider, syncPiModelsJson } from "./config-store"
import { log } from "./logger"

type AnySession = {
  subscribe: (listener: (event: any) => void) => () => void
  prompt: (text: string, options?: any) => Promise<void>
  abort: () => Promise<void>
  setSessionName?: (name: string) => void
  sessionFile?: string
  agent: {
    state: {
      messages: any[]
      isStreaming: boolean
      model?: { provider: string; id: string; name?: string }
      error?: string
    }
  }
  model?: { provider: string; id: string; name?: string }
}

export type BridgeMessage = {
  info: {
    id: string
    sessionID: string
    role: "user" | "assistant" | "system"
    time: { created: number; completed?: number }
    agent?: string
    model?: { providerID: string; modelID: string }
    error?: unknown
  }
  parts: Array<Record<string, unknown>>
}

export type BridgeSession = {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  version: string
  agent?: string
  model?: { providerID: string; modelID: string }
  time: { created: number; updated: number }
  status: "idle" | "busy" | "retry" | "compacting"
  revert?: { messageID: string }
  messages: BridgeMessage[]
  /** The exact Pi JSONL backing this UI session. Never recreate this on restore. */
  piSessionFile?: string
  pi?: AnySession
  unsub?: () => void
  /** Ordered renderer stream. Pi can deliver a whole SSE response in one tick. */
  streamTail?: Promise<void>
  agentDir: string
}

type ToolPartLike = { type?: string; tool?: string; callID?: string; state?: { metadata?: Record<string, unknown> } }

/**
 * Pi's composing event and its execution event are emitted by separate layers.
 * The first may only have a content index while the second has the final call
 * id, so use both identifiers to keep one visual tool row per real invocation.
 */
export function findPiToolPart(parts: ToolPartLike[], callID?: string, tool?: string, contentIndex?: number) {
  const reversed = [...parts].reverse()
  return reversed.find((part) => part.type === "tool" && callID && part.callID === callID)
    ?? reversed.find((part) =>
      part.type === "tool" &&
      typeof contentIndex === "number" &&
      part.state?.metadata?.piContentIndex === contentIndex,
    )
    ?? reversed.find((part) =>
      part.type === "tool" &&
      Boolean(tool) &&
      part.tool === tool &&
      (part.state?.metadata?.piPhase === "composing" || part.state?.metadata?.piPhase === "ready"),
    )
}

const sessions = new Map<string, BridgeSession>()
let modelRuntime: any
let piMod: any
let agentDir = ""

// --- Session persistence ---

function sessionIndexPath() {
  return path.join(agentDir, "sessions-index.json")
}

function sessionMessagesPath(sessionID: string) {
  return path.join(agentDir, "sessions", `${sessionID}.messages.json`)
}

const RENDER_STREAM_INTERVAL_MS = 12

function enqueueStream(session: BridgeSession, publish: () => void) {
  const previous = session.streamTail ?? Promise.resolve()
  session.streamTail = previous.then(
    () =>
      new Promise<void>((resolve) => {
        publish()
        setTimeout(resolve, RENDER_STREAM_INTERVAL_MS)
      }),
  )
  return session.streamTail
}

type PersistedSessionMeta = {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  version: string
  agent?: string
  model?: { providerID: string; modelID: string }
  time: { created: number; updated: number }
  piSessionFile?: string
}

async function persistSessionIndex() {
  try {
    const fs = await import("node:fs/promises")
    const list: PersistedSessionMeta[] = [...sessions.values()].map((s) => ({
      id: s.id,
      slug: s.slug,
      projectID: s.projectID,
      directory: s.directory,
      title: s.title,
      version: s.version,
      agent: s.agent,
      model: s.model,
      time: s.time,
      piSessionFile: s.piSessionFile,
    }))
    await fs.mkdir(path.dirname(sessionIndexPath()), { recursive: true })
    await fs.writeFile(sessionIndexPath(), JSON.stringify(list, null, 2), "utf8")
  } catch (err) {
    console.warn("[pi-bridge] persistSessionIndex failed:", err)
  }
}

async function persistSessionMessages(session: BridgeSession) {
  try {
    const fs = await import("node:fs/promises")
    const file = sessionMessagesPath(session.id)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(session.messages, null, 2), "utf8")
  } catch (err) {
    console.warn("[pi-bridge] persistSessionMessages failed:", err)
  }
}

async function restoreSessionIndex() {
  try {
    const fs = await import("node:fs/promises")
    const raw = await fs.readFile(sessionIndexPath(), "utf8")
    const list: PersistedSessionMeta[] = JSON.parse(raw)
    for (const meta of list) {
      if (sessions.has(meta.id)) continue
      // Load persisted messages if available
      let messages: BridgeMessage[] = []
      try {
        const msgRaw = await fs.readFile(sessionMessagesPath(meta.id), "utf8")
        messages = JSON.parse(msgRaw)
      } catch {
        // no messages file
      }
      const bridge: BridgeSession = {
        id: meta.id,
        slug: meta.slug,
        projectID: meta.projectID,
        directory: meta.directory,
        title: meta.title,
        version: meta.version,
        agent: meta.agent,
        model: meta.model,
        time: meta.time,
        status: "idle",
        messages,
        piSessionFile: meta.piSessionFile,
        pi: undefined,
        agentDir,
      }
      sessions.set(meta.id, bridge)
    }
    if (list.length > 0) {
      console.log(`[pi-bridge] restored ${list.length} sessions from disk`)
    }
  } catch {
    // No index file yet — first launch
  }
}

export function allSessions() {
  return [...sessions.values()]
}

export function getSession(id: string) {
  return sessions.get(id)
}

export function defaultDirectory() {
  return process.env.HOYA_WORKSPACE || process.cwd()
}

export function getAgentDir() {
  return agentDir
}

export async function initKernel() {
  const home = process.env.HOYA_HOME || process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".hoya")
  agentDir = path.join(home, "pi-agent")
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CONFIG_DIR = home
  const config = await loadConfig()
  process.env.HOYA_SHELL_MODE = typeof config.shell === "string" ? config.shell : "auto"

  log.info("kernel", `initKernel start, home=${home}, agentDir=${agentDir}`)

  // --- Proxy setup: non-blocking, must never delay startup ---
  const proxyTimeout = setTimeout(() => { proxyConfigured = true; log.warn("proxy", "setup timed out after 5s, skipping") }, 5000)
  setupProxy().finally(() => clearTimeout(proxyTimeout))

  const fs = await import("node:fs/promises")
  await fs.mkdir(agentDir, { recursive: true })
  await fs.mkdir(path.join(agentDir, "sessions"), { recursive: true })

  // Restore previously persisted sessions so conversation history survives restarts.
  await restoreSessionIndex()

  // Hoya stores custom providers in hoya.json; Pi only reads models.json.
  await syncPiModelsJson()
  log.info("kernel", "syncPiModelsJson done")

  const loaded = await loadPiCodingAgent()
  piMod = loaded.mod
  log.info("kernel", `Pi loaded from ${loaded.root}, exports: ${Object.keys(piMod).join(", ")}`)

  modelRuntime = await createModelRuntime()
  log.info("kernel", "ModelRuntime created")

  await injectAuthKeys()
  log.info("kernel", "initKernel complete")
  return { root: loaded.root, agentDir }
}

let proxyConfigured = false
async function setupProxy() {
  if (proxyConfigured) return
  proxyConfigured = true
  try {
    await setupProxyInner()
  } catch (e) {
    log.warn("proxy", `setupProxy failed (continuing without proxy): ${e}`)
  }
}

async function setupProxyInner() {
  // Detect proxy: env vars first, then known local proxy
  let proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ""
  if (!proxyUrl) {
    // Try Windows registry (with strict timeout)
    try {
      const { execSync } = await import("node:child_process")
      const output = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
        { encoding: "utf8", timeout: 2000, windowsHide: true },
      )
      const serverMatch = output.match(/ProxyServer\s+REG_SZ\s+(.+)/i)
      if (serverMatch) {
        const proxy = serverMatch[1].trim()
        proxyUrl = proxy.includes("://") ? proxy : `http://${proxy}`
      }
    } catch {
      // Registry query failed or timed out - use common local proxy ports
      const net = await import("node:net")
      for (const port of [7897, 7890, 1080]) {
        const ok = await new Promise<boolean>((resolve) => {
          const sock = net.default.connect(port, "127.0.0.1", () => { sock.destroy(); resolve(true) })
          sock.on("error", () => resolve(false))
          sock.setTimeout(500, () => { sock.destroy(); resolve(false) })
        })
        if (ok) { proxyUrl = `http://127.0.0.1:${port}`; break }
      }
    }
  }

  if (!proxyUrl) {
    log.info("proxy", "No system proxy detected, using direct connections")
    return
  }

  log.info("proxy", `Using proxy: ${proxyUrl}`)
  process.env.HTTP_PROXY = proxyUrl
  process.env.HTTPS_PROXY = proxyUrl
  process.env.http_proxy = proxyUrl
  process.env.https_proxy = proxyUrl

  // Strategy 1: undici ProxyAgent (covers globalThis.fetch in Node 22+)
  try {
    const { createRequire } = await import("node:module")
    const nodeRequire = createRequire(import.meta.url)
    const undici = nodeRequire("undici")
    if (undici.ProxyAgent && undici.setGlobalDispatcher) {
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl))
      log.info("proxy", "undici ProxyAgent set as global dispatcher")
    }
  } catch (e) {
    log.warn("proxy", `undici setup failed: ${e}`)
  }

  // Strategy 2: Set https.globalAgent with CONNECT tunneling (covers OpenAI SDK if it uses https module)
  try {
    const httpMod = await import("node:http")
    const httpsMod = await import("node:https")
    const tlsMod = await import("node:tls")
    const netMod = await import("node:net")
    const { URL: NodeURL } = await import("node:url")
    const parsed = new NodeURL(proxyUrl)
    const proxyHost = parsed.hostname
    const proxyPort = parseInt(parsed.port) || 8080

    // Custom HTTPS agent that tunnels through the proxy
    class ProxyHttpsAgent extends httpsMod.default.Agent {
      createConnection(options: any, callback: any) {
        const targetHost = options.host || options.hostname || "localhost"
        const targetPort = options.port || 443
        const connectReq = httpMod.default.request({
          host: proxyHost,
          port: proxyPort,
          method: "CONNECT",
          path: `${targetHost}:${targetPort}`,
        })
        connectReq.on("connect", (res, socket) => {
          if (res.statusCode !== 200) {
            socket.destroy()
            callback(new Error(`Proxy CONNECT failed: ${res.statusCode}`))
            return
          }
          const tlsSocket = tlsMod.default.connect({
            socket,
            servername: targetHost,
            ...options,
          })
          callback(null, tlsSocket)
        })
        connectReq.on("error", (err) => callback(err))
        connectReq.setTimeout(10000, () => { connectReq.destroy(); callback(new Error("Proxy CONNECT timeout")) })
        connectReq.end()
      }
    }

    const agent = new ProxyHttpsAgent({ keepAlive: true, maxSockets: 10 })
    httpsMod.default.globalAgent = agent
    log.info("proxy", `https.globalAgent set to CONNECT tunnel via ${proxyHost}:${proxyPort}`)
  } catch (e) {
    log.warn("proxy", `https.globalAgent setup failed: ${e}`)
  }

  // Strategy 3: Also patch globalThis.fetch as last resort
  try {
    const { URL: NodeURL } = await import("node:url")
    const httpMod = await import("node:http")
    const httpsMod = await import("node:https")
    const tlsMod = await import("node:tls")
    const parsed = new NodeURL(proxyUrl)
    const proxyHost = parsed.hostname
    const proxyPort = parseInt(parsed.port) || 8080
    const originalFetch = globalThis.fetch

    globalThis.fetch = async (input: any, init?: any): Promise<Response> => {
      const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url || ""
      if (reqUrl.includes("127.0.0.1") || reqUrl.includes("localhost") || reqUrl.includes("::1")) {
        return originalFetch(input, init)
      }
      if (!reqUrl.startsWith("https://")) {
        return originalFetch(input, init)
      }
      try {
        const target = new NodeURL(reqUrl)
        const targetHost = target.hostname
        const targetPort = parseInt(target.port) || 443

        // CONNECT tunnel
        const socket = await new Promise<any>((resolve, reject) => {
          const req = httpMod.default.request({ host: proxyHost, port: proxyPort, method: "CONNECT", path: `${targetHost}:${targetPort}` })
          req.on("connect", (res, sock) => {
            if (res.statusCode === 200) resolve(sock)
            else { sock.destroy(); reject(new Error(`CONNECT ${res.statusCode}`)) }
          })
          req.on("error", reject)
          req.setTimeout(10000, () => { req.destroy(); reject(new Error("CONNECT timeout")) })
          req.end()
        })

        // HTTPS request over tunnel
        return await new Promise<Response>((resolve, reject) => {
          const headers: Record<string, string> = {}
          if (init?.headers) {
            if (typeof init.headers?.forEach === "function") init.headers.forEach((v: string, k: string) => { headers[k] = v })
            else Object.assign(headers, init.headers)
          }
          const req = httpsMod.default.request({
            hostname: targetHost, port: targetPort,
            path: target.pathname + target.search,
            method: init?.method || "GET", headers,
            createConnection: () => tlsMod.default.connect({ socket, servername: targetHost }),
          }, (res) => {
            const chunks: Buffer[] = []
            res.on("data", (c: Buffer) => chunks.push(c))
            res.on("end", () => {
              const rh = new Headers()
              for (const [k, v] of Object.entries(res.headers)) { if (v) rh.set(k, Array.isArray(v) ? v.join(", ") : v) }
              resolve(new Response(Buffer.concat(chunks), { status: res.statusCode || 200, headers: rh }))
            })
          })
          req.on("error", reject)
          req.setTimeout(120000, () => { req.destroy(); reject(new Error("timeout")) })
          if (init?.body) req.write(init.body)
          req.end()
        })
      } catch (err) {
        log.error("proxy", `fetch tunnel failed: ${err}`)
        return originalFetch(input, init)
      }
    }
    log.info("proxy", "globalThis.fetch also patched with CONNECT tunnel")
  } catch (e) {
    log.warn("proxy", `fetch patch failed: ${e}`)
  }
}

async function createModelRuntime() {
  if (!piMod.ModelRuntime?.create) throw new Error("Pi ModelRuntime.create missing")
  return piMod.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  })
}

async function injectAuthKeys() {
  if (!modelRuntime) return
  const auth = await loadAuthFile()
  for (const [providerID, entry] of Object.entries(auth)) {
    const key = typeof entry?.key === "string" ? entry.key.trim() : ""
    if (!key || key.length > 512 || key.includes("\n")) continue
    if (typeof modelRuntime.setRuntimeApiKey === "function") {
      try {
        await modelRuntime.setRuntimeApiKey(providerID, key)
      } catch (error) {
        console.warn("[pi-bridge] setRuntimeApiKey failed", providerID, error)
      }
    }
  }
}

async function reloadModelRuntime() {
  await syncPiModelsJson()
  modelRuntime = await createModelRuntime()
  await injectAuthKeys()
  if (typeof modelRuntime.reloadConfig === "function") {
    try {
      await modelRuntime.reloadConfig()
    } catch {
      // ignore
    }
  }
}

function modelCost(model: any) {
  const input = Number(model?.cost?.input ?? model?.pricing?.prompt ?? model?.costInput ?? NaN)
  const output = Number(model?.cost?.output ?? model?.pricing?.completion ?? model?.costOutput ?? NaN)
  if (Number.isFinite(input) || Number.isFinite(output)) {
    return {
      input: Number.isFinite(input) ? input : 0,
      output: Number.isFinite(output) ? output : 0,
    }
  }
  const id = String(model?.id || model?.modelId || "")
  // OpenRouter free suffix and common free markers.
  if (/:free$/i.test(id) || /\bfree\b/i.test(String(model?.name || ""))) {
    return { input: 0, output: 0 }
  }
  return undefined
}

function toModelInfo(providerID: string, model: any) {
  const modelID = String(model.id || model.modelId || "")
  const cost = modelCost(model)
  return {
    id: modelID,
    providerID,
    name: String(model.name || modelID),
    status: "active" as const,
    tags: cost && cost.input === 0 ? ["free"] : [],
    limit: {
      context: model?.limit?.context ?? model?.context ?? 128_000,
      output: model?.limit?.output ?? model?.maxTokens ?? 8192,
    },
    capabilities: model?.capabilities ?? { reasoning: true, input: {} },
    options: {},
    headers: {},
    release_date: model?.releaseDate || model?.release_date || "",
    ...(cost ? { cost } : {}),
  }
}

export async function listProviders() {
  if (!modelRuntime) await initKernel()
  const config = await loadConfig()
  const auth = await loadAuthFile()
  log.info("provider", `listProviders: auth keys for [${Object.keys(auth).join(", ")}]`)
  const providers: Array<{
    id: string
    name: string
    source: string
    env: string[]
    models: Record<string, any>
  }> = []

  let models: any[] = []
  try {
    if (typeof modelRuntime.getModels === "function") models = [...modelRuntime.getModels()]
    if (models.length === 0 && typeof modelRuntime.getAvailable === "function") {
      models = [...(await modelRuntime.getAvailable())]
    }
    if (models.length === 0 && typeof modelRuntime.getAvailableSnapshot === "function") {
      models = [...modelRuntime.getAvailableSnapshot()]
    }
  } catch (error) {
    console.warn("[pi-bridge] list models failed", error)
  }

  const providerSet = new Set(models.map((m) => m.provider || m.providerID || "unknown"))
  log.info("provider", `modelRuntime returned ${models.length} models from providers: [${[...providerSet].join(", ")}]`)

  const byProvider = new Map<string, any[]>()
  for (const model of models) {
    const provider = model.provider || model.providerID || "unknown"
    const list = byProvider.get(provider) ?? []
    list.push(model)
    byProvider.set(provider, list)
  }

  if (byProvider.size === 0) {
    byProvider.set("openai", [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }])
    byProvider.set("anthropic", [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" }])
    byProvider.set("google", [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" }])
    byProvider.set("openrouter", [
      { id: "openrouter/auto", name: "OpenRouter Auto", provider: "openrouter" },
      { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B (free)", provider: "openrouter", cost: { input: 0, output: 0 } },
      { id: "google/gemma-3-27b-it:free", name: "Gemma 3 27B (free)", provider: "openrouter", cost: { input: 0, output: 0 } },
      { id: "qwen/qwen3-4b:free", name: "Qwen3 4B (free)", provider: "openrouter", cost: { input: 0, output: 0 } },
    ])
  }

  // OpenRouter free models (OpenCode-style free picker) when catalog is present.
  if (byProvider.has("openrouter")) {
    const list = byProvider.get("openrouter")!
    const freeSeeds = [
      { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B (free)", provider: "openrouter", cost: { input: 0, output: 0 } },
      { id: "google/gemma-3-27b-it:free", name: "Gemma 3 27B (free)", provider: "openrouter", cost: { input: 0, output: 0 } },
      { id: "qwen/qwen3-4b:free", name: "Qwen3 4B (free)", provider: "openrouter", cost: { input: 0, output: 0 } },
      { id: "mistralai/mistral-small-3.1-24b-instruct:free", name: "Mistral Small 3.1 (free)", provider: "openrouter", cost: { input: 0, output: 0 } },
    ]
    for (const seed of freeSeeds) {
      if (!list.some((m) => (m.id || m.modelId) === seed.id)) list.push(seed)
    }
  }

  const connected = new Set<string>()
  for (const [providerID, list] of byProvider) {
    if (config.disabled_providers?.includes(providerID)) continue
    const modelsMap: Record<string, any> = {}
    for (const model of list) {
      const info = toModelInfo(providerID, model)
      if (!info.id) continue
      modelsMap[info.id] = info
    }
    const hasAuth =
      Boolean(auth[providerID]?.key) ||
      (typeof modelRuntime.hasConfiguredAuth === "function" && modelRuntime.hasConfiguredAuth(providerID)) ||
      Boolean(process.env[`${providerID.toUpperCase().replace(/-/g, "_")}_API_KEY`]) ||
      Boolean(process.env[`${providerID.toUpperCase().replace(/-/g, "_")}_TOKEN`])
    if (hasAuth) connected.add(providerID)
    providers.push({
      id: providerID,
      name: providerID,
      source: hasAuth ? "api" : "pi",
      env: [],
      options: {},
      models: modelsMap,
    })
  }

  // Custom OpenAI-compatible providers from hoya.json
  for (const [providerID, conf] of Object.entries(config.provider ?? {})) {
    if (config.disabled_providers?.includes(providerID)) continue
    const modelsMap: Record<string, any> = {}
    for (const [modelID, meta] of Object.entries(conf.models ?? {})) {
      modelsMap[modelID] = {
        id: modelID,
        providerID,
        name: meta?.name || modelID,
        status: "active",
        tags: meta?.cost?.input === 0 ? ["free"] : [],
        limit: { context: 128_000, output: 8192 },
        capabilities: { reasoning: true, input: {} },
        options: {},
        headers: {},
        release_date: "",
        ...(meta?.cost ? { cost: meta.cost } : {}),
      }
    }
    const hasAuth = Boolean(auth[providerID]?.key) || Boolean(conf.options?.apiKey)
    if (hasAuth) connected.add(providerID)
    const existing = providers.find((p) => p.id === providerID)
    if (existing) {
      existing.models = { ...existing.models, ...modelsMap }
      existing.name = conf.name || existing.name
      existing.source = hasAuth ? "custom" : existing.source
    } else {
      providers.push({
        id: providerID,
        name: conf.name || providerID,
        source: "custom",
        env: conf.env ?? [],
        options: {},
        models: modelsMap,
      })
    }
  }

  log.info("provider", `listProviders result: ${providers.length} providers, connected=[${[...connected].join(", ")}], models per provider: ${providers.map((p) => `${p.id}(${Object.keys(p.models).length})`).join(", ")}`)
  return {
    all: providers,
    connected: [...connected],
    default: Object.fromEntries(providers.map((p) => [p.id, Object.keys(p.models)[0]]).filter(([, m]) => m)),
  }
}

export async function setProviderAuth(providerID: string, key: string) {
  if (!modelRuntime) await initKernel()
  // Persist first so dispose/reinit keeps the key.
  await saveAuthProvider(providerID, key)
  await enableProvider(providerID)
  await reloadModelRuntime()
}

async function createPiRuntime(input: {
  directory: string
  projectID: string
  sessionID: string
  piSessionFile?: string
  model?: { providerID: string; modelID: string }
  title?: string
}) {
  const sessionDir = path.join(agentDir, "sessions", input.projectID)
  let sessionManager: any
  // Pi's JSONL is the source of truth for model context. Opening it is required
  // for a follow-up after an app restart; creating a new manager silently loses
  // the agent's native conversation history.
  if (input.piSessionFile && existsSync(input.piSessionFile) && typeof piMod.SessionManager?.open === "function") {
    sessionManager = piMod.SessionManager.open(input.piSessionFile, sessionDir, input.directory)
  } else if (typeof piMod.SessionManager?.create === "function") {
    sessionManager = piMod.SessionManager.create(input.directory, sessionDir, { id: input.sessionID })
  } else if (typeof piMod.SessionManager?.inMemory === "function") {
    sessionManager = piMod.SessionManager.inMemory()
  }

  let model: any
  if (input.model && typeof modelRuntime?.getModel === "function") {
    model = modelRuntime.getModel(input.model.providerID, input.model.modelID)
    if (!model) {
      await reloadModelRuntime()
      model = modelRuntime.getModel(input.model.providerID, input.model.modelID)
    }
  }
  if (typeof piMod.createAgentSession !== "function") {
    throw new Error("Pi createAgentSession export missing. Rebuild packages/coding-agent.")
  }
  const created = await piMod.createAgentSession({
    cwd: input.directory,
    agentDir,
    modelRuntime,
    model,
    sessionManager,
  })
  const piSessionFile = created.session?.sessionFile || sessionManager?.getSessionFile?.()
  if (input.title && input.title !== "New session") created.session?.setSessionName?.(input.title)

  // The selected provider/model is factual runtime identity. Some compatible
  // endpoints return a canned Claude persona unless this is made explicit.
  const runtimeModel = input.model || (() => {
    const value = created.session?.model || created.session?.agent?.state?.model
    return value?.provider && value?.id ? { providerID: String(value.provider), modelID: String(value.id) } : undefined
  })()
  const identity = runtimeModel
    ? `\n\nHoyaAgent runtime identity: you are the Pi coding agent using ${runtimeModel.providerID}/${runtimeModel.modelID}. Do not claim to be Claude, Anthropic, or another model/provider. If asked, state this exact runtime identity succinctly.`
    : "\n\nHoyaAgent runtime identity: you are the Pi coding agent. Do not claim to be Claude, Anthropic, or another model/provider."
  if (created.session?.agent?.state?.systemPrompt && !created.session.agent.state.systemPrompt.includes("HoyaAgent runtime identity:")) {
    created.session.agent.state.systemPrompt += identity
  }
  return { created, piSessionFile, model: runtimeModel }
}

export async function updateBridgeConfig(patch: Record<string, any>) {
  const next = await mergeConfig(patch)
  if (typeof next.shell === "string") {
    process.env.HOYA_SHELL_MODE = next.shell || "auto"
  }
  // If custom providers include api keys in options, also mirror into auth.
  for (const [providerID, conf] of Object.entries(next.provider ?? {})) {
    const key = conf?.options?.apiKey
    if (typeof key === "string" && key.trim()) {
      await saveAuthProvider(providerID, key.trim())
    }
  }
  await reloadModelRuntime()
  return next
}

export async function createSession(input: {
  directory?: string
  title?: string
  parentID?: string
  id?: string
  model?: { providerID: string; modelID: string }
}) {
  if (!piMod) await initKernel()
  const directory = path.resolve(input.directory || defaultDirectory())
  const sessionID = input.id || id("ses")
  const existing = sessions.get(sessionID)
  if (existing) {
    if (input.title) existing.title = input.title
    if (input.model) existing.model = input.model
    existing.time.updated = Date.now()
    return existing
  }
  const now = Date.now()
  const projectID = projectIdForDirectory(directory)

  const runtime = await createPiRuntime({
    directory,
    projectID,
    sessionID,
    model: input.model,
    title: input.title,
  })
  const created = runtime.created

  const resolvedModel = (() => {
    if (input.model?.providerID && input.model?.modelID) return input.model
    return runtime.model
  })()

  const bridge: BridgeSession = {
    id: sessionID,
    slug: sessionID.slice(-8),
    projectID,
    directory,
    title: input.title || "New session",
    version: "1.18.4-pi",
    agent: "build",
    model: resolvedModel,
    time: { created: now, updated: now },
    status: "idle",
    messages: [],
    piSessionFile: runtime.piSessionFile,
    pi: created.session,
    agentDir,
  }

  bridge.unsub = created.session.subscribe((event: any) => handlePiEvent(bridge, event))
  sessions.set(sessionID, bridge)

  emit(directory, "session.created", { info: publicSession(bridge) })
  emit(directory, "session.updated", { info: publicSession(bridge) })
  void persistSessionIndex()
  return bridge
}

export function publicSession(session: BridgeSession) {
  return {
    id: session.id,
    slug: session.slug,
    projectID: session.projectID,
    directory: session.directory,
    title: session.title,
    version: session.version,
    parentID: undefined,
    agent: session.agent,
    model: session.model
      ? { id: session.model.modelID, providerID: session.model.providerID }
      : undefined,
    time: session.time,
    revert: session.revert,
  }
}

export async function ensureSession(sessionID: string, directory?: string) {
  const existing = sessions.get(sessionID)
  if (existing) {
    // Lazily attach Pi runtime to restored sessions (persisted sessions have pi=undefined)
    if (!existing.pi && piMod) {
      try {
        const dir = path.resolve(existing.directory || directory || defaultDirectory())
        const projectID = existing.projectID || projectIdForDirectory(dir)
        const runtime = await createPiRuntime({
          directory: dir,
          projectID,
          sessionID: existing.id,
          piSessionFile: existing.piSessionFile,
          model: existing.model,
          title: existing.title,
        })
        const created = runtime.created
        existing.pi = created.session
        existing.piSessionFile = runtime.piSessionFile
        existing.unsub = created.session.subscribe((event: any) => handlePiEvent(existing, event))
        void persistSessionIndex()
        console.log(`[pi-bridge] re-attached Pi runtime to restored session ${sessionID} (${existing.piSessionFile ? "native history restored" : "new empty native history"})`)
      } catch (err) {
        console.warn(`[pi-bridge] failed to re-attach Pi runtime to session ${sessionID}:`, err)
      }
    }
    return existing
  }
  return createSession({ id: sessionID, directory })
}

export async function promptSession(
  sessionID: string,
  input: {
    messageID?: string
    parts?: Array<{ type?: string; text?: string; [key: string]: unknown }>
    agent?: string
    model?: { providerID: string; modelID: string }
    directory?: string
  },
) {
  log.info("prompt", `promptSession called: session=${sessionID}, model=${JSON.stringify(input.model)}, parts=${input.parts?.length ?? 0}`)

  const session = await ensureSession(sessionID, input.directory)
  log.info("prompt", `session resolved: id=${session.id}, status=${session.status}, hasPi=${Boolean(session.pi)}, model=${JSON.stringify(session.model)}`)

  const text = (input.parts ?? [])
    .filter((part) => part.type === "text" || typeof part.text === "string")
    .map((part) => String(part.text ?? ""))
    .join("\n")
    .trim()

  if (!text) throw new Error("Empty prompt")
  log.info("prompt", `text extracted (${text.length} chars): "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`)

  // Guard: reject if session is already busy (prevents concurrent prompt errors)
  if (session.status === "busy") {
    throw new Error("Session is already processing a message. Wait for it to finish or abort.")
  }

  const desiredModel = input.model || session.model
  if (desiredModel) {
    log.info("prompt", `applying model: ${desiredModel.providerID}/${desiredModel.modelID}`)
    await applySessionModel(session, desiredModel)
    log.info("prompt", `model applied successfully`)
  }
  if (!session.model?.providerID || !session.model?.modelID) {
    log.error("prompt", "No model selected after applySessionModel")
    throw new Error("No model selected. Choose a provider/model first.")
  }
  if (!session.pi) {
    log.error("prompt", "Pi session not ready (session.pi is null)")
    throw new Error("Pi session not ready")
  }

  const userMessageID = input.messageID || id("msg")
  session.streamTail = Promise.resolve()
  const userMessage: BridgeMessage = {
    info: {
      id: userMessageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: input.agent || session.agent || "build",
      model: session.model,
    },
    parts: [{ id: id("part"), type: "text", text, sessionID, messageID: userMessageID }],
  }
  session.messages.push(userMessage)
  session.status = "busy"
  session.time.updated = Date.now()
  emit(session.directory, "message.updated", { info: userMessage.info, parts: userMessage.parts })
  emit(session.directory, "session.status", { sessionID, status: { type: "busy" } })
  emit(session.directory, "session.updated", { info: publicSession(session) })

  const assistantID = id("msg")
  const assistant: BridgeMessage = {
    info: {
      id: assistantID,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      agent: input.agent || session.agent || "build",
      model: session.model,
      // Fields required by SDK AssistantMessage type:
      parentID: userMessageID,
      modelID: session.model?.modelID || "",
      providerID: session.model?.providerID || "",
      mode: "normal",
      path: { cwd: session.directory, root: session.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  }

  session.messages.push(assistant)
  emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })

  // Inactivity timeout: abort if no streaming events arrive within 90s
  let lastActivity = Date.now()
  let timedOut = false
  const INACTIVITY_MS = 90_000
  const activityTimer = setInterval(() => {
    if (Date.now() - lastActivity > INACTIVITY_MS && session.status === "busy") {
      timedOut = true
      console.error(`[pi-bridge] prompt timed out (no activity for ${INACTIVITY_MS / 1000}s), aborting session ${sessionID}`)
      void session.pi?.abort?.()
    }
  }, 5000)

  // Track activity from streaming events
  const origUnsub = session.unsub
  const activityTracker = (event: any) => {
    lastActivity = Date.now()
  }
  // Patch: listen for any event as activity signal
  const trackUnsub = session.pi?.subscribe?.(activityTracker)

  // Run prompt without blocking HTTP (async style like prompt_async)
  log.info("prompt", `calling session.pi.prompt() for session ${sessionID}`)
  void session.pi
    .prompt(text)
    .catch((error: unknown) => {
      const errMsg = timedOut
        ? `Request timed out (no response for ${INACTIVITY_MS / 1000}s). Check your API key and network connection.`
        : error instanceof Error ? error.message : String(error)
      log.error("prompt", `prompt FAILED for session ${sessionID}: ${errMsg}`, error)
      console.error(`[pi-bridge] prompt failed for session ${sessionID}:`, errMsg)
      assistant.info.error = errMsg
      session.status = "idle"
      emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })
      emit(session.directory, "session.status", { sessionID, status: { type: "idle" } })
      emit(session.directory, "session.error", {
        sessionID,
        error: { name: "PiError", message: errMsg },
      })
    })
    .finally(async () => {
      clearInterval(activityTimer)
      trackUnsub?.()
      // Remote providers sometimes deliver an entire SSE response in one event
      // loop tick. Do not publish the final snapshot until every queued delta
      // has been painted, or the UI will appear to jump directly to the end.
      await (session.streamTail ?? Promise.resolve())
      log.info("prompt", `prompt completed for session ${sessionID}, harvesting results`)
      // Pi may finish without emitting bridge-friendly deltas; harvest final text from agent state.
      harvestAssistantText(session, assistant)
      harvestAssistantThinking(session, assistant)
      session.status = "idle"
      session.time.updated = Date.now()
      assistant.info.time.completed = Date.now()
      emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })
      emit(session.directory, "session.status", { sessionID, status: { type: "idle" } })
      emit(session.directory, "session.idle", { sessionID })
      emit(session.directory, "session.updated", { info: publicSession(session) })
      void persistSessionIndex()
      void persistSessionMessages(session)
    })

  return { messageID: userMessageID, assistantID }
}

export async function revertSession(sessionID: string, messageID: string, directory?: string) {
  const session = await ensureSession(sessionID, directory)
  const index = session.messages.findIndex((message) => message.info.id >= messageID)
  if (index >= 0) session.messages.splice(index)
  session.revert = { messageID }
  session.status = "idle"
  session.time.updated = Date.now()
  emit(session.directory, "session.updated", { info: publicSession(session) })
  emit(session.directory, "session.status", { sessionID, status: { type: "idle" } })
  void persistSessionIndex()
  void persistSessionMessages(session)
  return publicSession(session)
}

export async function unrevertSession(sessionID: string, directory?: string) {
  const session = await ensureSession(sessionID, directory)
  delete session.revert
  session.time.updated = Date.now()
  emit(session.directory, "session.updated", { info: publicSession(session) })
  return publicSession(session)
}

function harvestAssistantText(session: BridgeSession, assistant: BridgeMessage) {
  try {
    const msgs = session.pi?.agent?.state?.messages ?? []
    const lastAssistant = [...msgs].reverse().find((m: any) => m.role === "assistant")
    if (!lastAssistant) return
    const text = extractText(lastAssistant)
    if (text) {
      let textPart = assistant.parts.find((p) => p.type === "text") as any
      if (!textPart) {
        textPart = {
          id: id("part"),
          type: "text",
          text: "",
          sessionID: session.id,
          messageID: assistant.info.id,
        }
        assistant.parts.push(textPart)
      }
      // Only overwrite if harvested text is longer (authoritative final state)
      if (text.length >= String(textPart.text || "").length) {
        textPart.text = text
      }
      emit(session.directory, "message.part.updated", { part: { ...textPart } })
    }
    if (lastAssistant.errorMessage || lastAssistant.error) {
      assistant.info.error = lastAssistant.errorMessage || lastAssistant.error
    }
  } catch {
    // ignore
  }
}

function harvestAssistantThinking(session: BridgeSession, assistant: BridgeMessage) {
  try {
    const msgs = session.pi?.agent?.state?.messages ?? []
    const lastAssistant = [...msgs].reverse().find((m: any) => m.role === "assistant")
    if (!lastAssistant) return
    const thinking = extractThinking(lastAssistant)
    if (thinking) {
      let reasoningPart = assistant.parts.find((p) => p.type === "reasoning") as any
      if (!reasoningPart) {
        reasoningPart = {
          id: id("part"),
          type: "reasoning",
          text: "",
          sessionID: session.id,
          messageID: assistant.info.id,
        }
        assistant.parts.push(reasoningPart)
      }
      if (thinking.length >= String(reasoningPart.text || "").length) {
        reasoningPart.text = thinking
      }
      emit(session.directory, "message.part.updated", { part: { ...reasoningPart } })
    }
  } catch {
    // ignore
  }
}

async function applySessionModel(session: BridgeSession, model: { providerID: string; modelID: string }) {
  if (!modelRuntime) await initKernel()
  log.info("model", `applySessionModel: resolving ${model.providerID}/${model.modelID}`)
  let resolved = typeof modelRuntime.getModel === "function" ? modelRuntime.getModel(model.providerID, model.modelID) : undefined
  if (!resolved) {
    // Custom provider may have been added after boot; refresh models.json + runtime once.
    log.warn("model", `model ${model.providerID}/${model.modelID} not found, reloading runtime...`)
    console.log(`[pi-bridge] model ${model.providerID}/${model.modelID} not found, reloading runtime...`)
    await reloadModelRuntime()
    resolved = typeof modelRuntime.getModel === "function" ? modelRuntime.getModel(model.providerID, model.modelID) : undefined
  }
  if (!resolved) {
    log.error("model", `model NOT FOUND after reload: ${model.providerID}/${model.modelID}`)
    console.error(`[pi-bridge] model not found after reload: ${model.providerID}/${model.modelID}`)
    throw new Error(
      `Model not found: ${model.providerID}/${model.modelID}. Re-save the custom provider or pick another model.`,
    )
  }
  log.info("model", `model resolved: ${JSON.stringify({ id: resolved.id, name: resolved.name, provider: resolved.provider, api: resolved.api, baseUrl: resolved.baseUrl, contextWindow: resolved.contextWindow, maxTokens: resolved.maxTokens })}`)
  if (session.pi && typeof (session.pi as any).setModel === "function") {
    try {
      await (session.pi as any).setModel(resolved)
      log.info("model", `setModel called on Pi session`)
    } catch (err) {
      log.error("model", `setModel failed: ${err}`)
      console.error(`[pi-bridge] setModel failed for ${model.providerID}/${model.modelID}:`, err)
      throw err
    }
  }
  session.model = model
}

export async function abortSession(sessionID: string) {
  const session = sessions.get(sessionID)
  if (!session?.pi) return
  await session.pi.abort()
  session.status = "idle"
  emit(session.directory, "session.status", { sessionID, status: { type: "idle" } })
  emit(session.directory, "session.idle", { sessionID })
}

export function updateSession(sessionID: string, patch: { title?: string }) {
  const session = sessions.get(sessionID)
  if (!session) return
  if (typeof patch.title === "string" && patch.title.trim()) {
    session.title = patch.title.trim()
    session.pi?.setSessionName?.(session.title)
  }
  session.time.updated = Date.now()
  emit(session.directory, "session.updated", { info: publicSession(session) })
  void persistSessionIndex()
  return session
}

export function deleteSession(sessionID: string) {
  const session = sessions.get(sessionID)
  if (!session) return
  session.unsub?.()
  void session.pi?.abort?.()
  sessions.delete(sessionID)
  emit(session.directory, "session.deleted", { info: publicSession(session) })
  void persistSessionIndex()
  // Remove persisted messages file so deleted session doesn't reappear on restart
  import("node:fs/promises")
    .then((fs) => {
      const removals = [fs.unlink(sessionMessagesPath(sessionID)).catch(() => {})]
      // A deletion from the UI must also delete the corresponding Pi history;
      // otherwise a later restore can resurrect the supposedly removed session.
      const history = session.piSessionFile
      const sessionsRoot = path.resolve(agentDir, "sessions") + path.sep
      if (history && path.resolve(history).startsWith(sessionsRoot)) removals.push(fs.unlink(history).catch(() => {}))
      return Promise.all(removals)
    })
    .catch(() => {})
}

export function normalizeToolInput(tool: string, value: unknown): Record<string, unknown> {
  const input = value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}
  // Pi uses `path`; the OpenCode renderers use `filePath` to link and label
  // reads/writes/edits. Keep both so generic tools still expose raw arguments.
  if (typeof input.path === "string" && input.filePath === undefined) input.filePath = input.path
  if (tool === "edit" && Array.isArray(input.edits) && input.edits.length === 1) {
    const edit = input.edits[0]
    if (edit && typeof edit === "object") {
      const item = edit as Record<string, unknown>
      input.oldString ??= item.oldText
      input.newString ??= item.newText
    }
  }
  return input
}

export function toolResultText(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const result = value as { content?: unknown; details?: unknown }
    if (Array.isArray(result.content)) {
      const text = result.content
        .filter((item): item is { type?: string; text?: unknown } => !!item && typeof item === "object")
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => String(item.text))
        .join("\n")
      if (text) return text
    }
  }
  return stringifyTool(value)
}

function piToolCall(event: any) {
  const index = event?.assistantMessageEvent?.contentIndex
  const content = event?.assistantMessageEvent?.partial?.content
  return typeof index === "number" && Array.isArray(content) ? content[index] : undefined
}

function handlePiEvent(session: BridgeSession, event: any) {
  const type = event?.type || event?.event || ""
  const ame = event?.assistantMessageEvent
  const ameType = ame?.type || ""
  if (type === "session_info_changed") {
    const title = typeof event.name === "string" ? event.name.trim() : ""
    if (title && title !== session.title) {
      session.title = title
      session.time.updated = Date.now()
      emit(session.directory, "session.updated", { info: publicSession(session) })
      void persistSessionIndex()
    }
    return
  }
  // Log full event for errors and unknown types to diagnose silent failures
  if (type === "error" || type === "stream_error" || ameType === "error" || (!type && !ame)) {
    log.error("pi-event", `FULL EVENT: ${JSON.stringify(event).slice(0, 1000)}`)
  } else {
    log.debug("pi-event", `session=${session.id} type=${type}${ameType ? ` ame=${ameType}` : ""}`)
  }
  const assistant = [...session.messages].reverse().find((m) => m.info.role === "assistant" && !m.info.time.completed)
  if (!assistant) return

  // Capture stream-level error events
  if (type === "error" || type === "stream_error" || ameType === "error") {
    const errMsg = event?.error || event?.message || event?.reason || ame?.error || "Unknown stream error"
    log.error("pi-event", `Stream error for session ${session.id}: ${typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg).slice(0, 500)}`)
    assistant.info.error = String(errMsg)
    assistant.parts.push({
      id: id("part"),
      type: "text",
      text: `⚠️ Pi stream error: ${typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg).slice(0, 300)}`,
      sessionID: session.id,
      messageID: assistant.info.id,
    })
    emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })
    return
  }

  // Pi emits message_update with assistantMessageEvent for streaming content.
  // assistantMessageEvent types: text_delta, thinking_start, thinking_delta, thinking_end,
  //                              tool_call_start, tool_call_delta, tool_call_end

  // On message_start, ensure the assistant message is in the frontend store
  if (type === "message_start") {
    emit(session.directory, "message.updated", { info: assistant.info })
    return
  }

  if (type === "message_update" && ame) {

    // Pi exposes tool calls while the model is still composing them. Preserve
    // those events as real parts, then update the same part when execution
    // starts/streams/ends. This makes every agent loop visible in the timeline.
    if (ameType === "toolcall_start" || ameType === "toolcall_delta" || ameType === "toolcall_end") {
      const call = piToolCall(event) ?? ame.toolCall
      const callID = String(call?.id || ame.toolCall?.id || `pi-${ame.contentIndex ?? id("call")}`)
      const tool = String(call?.name || ame.toolCall?.name || "tool")
      let toolPart = findPiToolPart(assistant.parts as ToolPartLike[], callID, tool, ame.contentIndex) as any
      if (!toolPart) {
        toolPart = {
          id: id("part"),
          type: "tool",
          tool,
          callID,
          state: {
            status: "running",
            input: normalizeToolInput(tool, call?.arguments),
            title: tool,
            metadata: { piPhase: "composing", piContentIndex: ame.contentIndex },
            time: { start: Date.now() },
          },
          sessionID: session.id,
          messageID: assistant.info.id,
        }
        assistant.parts.push(toolPart)
      } else {
        // The execution event carries Pi's canonical ID. Retain it so the
        // execution start/end events update this same rendered row.
        if (call?.id || ame.toolCall?.id) toolPart.callID = String(call?.id || ame.toolCall?.id)
        toolPart.tool = tool || toolPart.tool
        toolPart.state = {
          ...toolPart.state,
          input: normalizeToolInput(toolPart.tool, call?.arguments ?? toolPart.state?.input),
          title: toolPart.tool,
          metadata: {
            ...(toolPart.state?.metadata ?? {}),
            piContentIndex: ame.contentIndex ?? toolPart.state?.metadata?.piContentIndex,
            piPhase: ameType === "toolcall_end" ? "ready" : "composing",
          },
        }
      }
      emit(session.directory, "message.part.updated", { part: toolPart })
      return
    }

    // --- Reasoning / thinking stream ---
    if (ameType === "thinking_start" || ameType === "thinking_delta" || ameType === "thinking_end") {
      let reasoningPart = assistant.parts.find((p) => p.type === "reasoning") as any
      if (!reasoningPart) {
        reasoningPart = {
          id: id("part"),
          type: "reasoning",
          text: "",
          sessionID: session.id,
          messageID: assistant.info.id,
        }
        assistant.parts.push(reasoningPart)
        emit(session.directory, "message.part.updated", { part: { ...reasoningPart } })
      }
      if (ameType === "thinking_delta" && typeof ame.delta === "string" && ame.delta.length > 0) {
        reasoningPart.text = String(reasoningPart.text || "") + ame.delta
        enqueueStream(session, () =>
          emit(session.directory, "message.part.delta", {
            sessionID: session.id,
            messageID: assistant.info.id,
            partID: reasoningPart.id,
            field: "text",
            delta: ame.delta,
          }),
        )
      }
      if (ameType === "thinking_end" && typeof ame.content === "string" && ame.content.length > 0) {
        // Use final content if provided (authoritative over accumulated deltas)
        if (ame.content.length >= String(reasoningPart.text || "").length) {
          reasoningPart.text = ame.content
        }
        enqueueStream(session, () => emit(session.directory, "message.part.updated", { part: { ...reasoningPart } }))
      }
      return
    }

    // --- Text stream ---
    if (ameType === "text_delta" || ameType === "text_start" || ameType === "text_end") {
      const delta = typeof ame.delta === "string" ? ame.delta : ""
      if (delta.length > 0) {
        let textPart = assistant.parts.find((p) => p.type === "text") as any
        if (!textPart) {
          textPart = {
            id: id("part"),
            type: "text",
            text: "",
            sessionID: session.id,
            messageID: assistant.info.id,
          }
          assistant.parts.push(textPart)
          // Create the empty part once. Subsequent bytes are delta-only: the
          // frontend reducer appends deltas itself, so publishing both a full
          // update and a delta duplicates every streamed token.
          emit(session.directory, "message.part.updated", { part: { ...textPart }, time: Date.now() })
        }
        textPart.text = String(textPart.text || "") + delta
        enqueueStream(session, () =>
          emit(session.directory, "message.part.delta", {
            sessionID: session.id,
            messageID: assistant.info.id,
            partID: textPart.id,
            field: "text",
            delta,
          }),
        )
      }
      if (ameType === "text_end" && typeof ame.content === "string" && ame.content.length > 0) {
        let textPart = assistant.parts.find((p) => p.type === "text") as any
        if (!textPart) {
          textPart = { id: id("part"), type: "text", text: "", sessionID: session.id, messageID: assistant.info.id }
          assistant.parts.push(textPart)
        }
        textPart.text = ame.content
        enqueueStream(session, () => emit(session.directory, "message.part.updated", { part: { ...textPart }, time: Date.now() }))
      }
      return
    }
  }

  // Fallback: older/simpler event shapes (message_delta, text_delta at top level)
  if (
    type === "message_delta" ||
    type === "text_delta" ||
    (type === "message_update" && !ame)
  ) {
    const delta =
      event?.delta ||
      event?.text ||
      (typeof event?.message?.content === "string" ? event.message.content : undefined) ||
      extractText(event?.message || event?.assistantMessage)
    if (typeof delta === "string" && delta.length > 0) {
      let textPart = assistant.parts.find((p) => p.type === "text") as any
      if (!textPart) {
        textPart = {
          id: id("part"),
          type: "text",
          text: "",
          sessionID: session.id,
          messageID: assistant.info.id,
        }
        assistant.parts.push(textPart)
        emit(session.directory, "message.part.updated", { part: { ...textPart }, time: Date.now() })
      }
      textPart.text = String(textPart.text || "") + delta
      enqueueStream(session, () =>
        emit(session.directory, "message.part.delta", {
          sessionID: session.id,
          messageID: assistant.info.id,
          partID: textPart.id,
          field: "text",
          delta,
        }),
      )
    }
  }

  // Those events occur after every Pi tool loop, not only at completion. The
  // authoritative snapshot is emitted after prompt() settles and the paced
  // renderer queue drains below.
  if (false && (type === "message_end" || type === "turn_end" || type === "agent_end")) {
    harvestAssistantText(session, assistant)
    harvestAssistantThinking(session, assistant)
    emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })

    // Only detect an empty response at agent_end. Pi emits agent_end for every
    // agent loop, including loops which continue with tool results, so session
    // completion is owned exclusively by prompt().finally() below.
    if (type === "agent_end") {
      const hasContent = assistant.parts.some((p: any) => (p.type === "text" && p.text) || (p.type === "reasoning" && p.text) || p.type === "tool")
      if (!hasContent) {
        const piError = session.pi?.agent?.state?.error
        const lastMsg = [...(session.pi?.agent?.state?.messages ?? [])].reverse().find((m: any) => m.role === "assistant")
        log.error("prompt", `Empty response at agent_end:`, {
          piError,
          stopReason: lastMsg?.stopReason,
          errorMessage: lastMsg?.errorMessage,
          model: session.pi?.agent?.state?.model || session.pi?.model,
        })
        const errorMsg = piError || lastMsg?.errorMessage || lastMsg?.error || "模型返回了空响应。请检查 API Key 是否有效、模型是否可用、网络是否正常。"
        assistant.info.error = String(errorMsg)
        assistant.parts.push({
          id: id("part"),
          type: "text",
          text: `⚠️ ${errorMsg}`,
          sessionID: session.id,
          messageID: assistant.info.id,
        })
        emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })
      }
    }
  }

  if (type === "tool_execution_start" || type === "tool_start") {
    const callID = event.toolCallId || event.id || id("call")
    const tool = String(event.toolName || event.name || "tool")
    let toolPart = findPiToolPart(assistant.parts as ToolPartLike[], String(callID), tool) as any
    if (!toolPart) {
      toolPart = {
        id: id("part"),
        type: "tool",
        tool,
        callID,
        sessionID: session.id,
        messageID: assistant.info.id,
      }
      assistant.parts.push(toolPart)
    }
    toolPart.callID = String(callID)
    toolPart.tool = tool
    toolPart.state = {
      status: "running",
      input: normalizeToolInput(tool, event.args || event.input || toolPart.state?.input),
      title: tool,
      metadata: { ...(toolPart.state?.metadata ?? {}), piPhase: "executing" },
      time: { start: toolPart.state?.time?.start || Date.now() },
    }
    emit(session.directory, "message.part.updated", { part: toolPart })
  }

  if (type === "tool_execution_end" || type === "tool_end" || type === "tool_execution_update") {
    const callID = event.toolCallId || event.id
    const toolPart = [...assistant.parts]
      .reverse()
      .find((p: any) => p.type === "tool" && (!callID || p.callID === callID)) as any
    if (toolPart) {
      const output = toolResultText(event.result ?? event.output ?? event.partialResult ?? event.update)
      const isComplete = type === "tool_execution_end" || type === "tool_end"
      const isError = Boolean(event.isError || event.error)
      toolPart.state = {
        ...toolPart.state,
        // Match OpenCode's ToolState union exactly. The UI uses this shape to
        // display write/edit input (including source code) and command output.
        ...(isComplete
          ? isError
            ? {
                status: "error",
                input: normalizeToolInput(toolPart.tool, toolPart.state?.input),
                error: output || String(event.error || "Tool execution failed"),
                metadata: { ...(toolPart.state?.metadata ?? {}), piPhase: "failed" },
                time: { start: toolPart.state?.time?.start || Date.now(), end: Date.now() },
              }
            : {
                status: "completed",
                input: normalizeToolInput(toolPart.tool, toolPart.state?.input),
                output,
                title: String(event.toolName || event.name || toolPart.tool),
                metadata: { ...(toolPart.state?.metadata ?? {}), piPhase: "completed" },
                time: { start: toolPart.state?.time?.start || Date.now(), end: Date.now() },
              }
          : {
            status: "running",
              input: normalizeToolInput(toolPart.tool, event.args || event.input || toolPart.state?.input),
              title: String(event.toolName || event.name || toolPart.tool),
              metadata: output ? { partialOutput: output } : toolPart.state?.metadata,
              time: { start: toolPart.state?.time?.start || Date.now() },
            }),
      }
      emit(session.directory, "message.part.updated", { part: toolPart })
      emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })
    }
  }

  if (type === "agent_start") {
    session.status = "busy"
    emit(session.directory, "session.status", { sessionID: session.id, status: { type: "busy" } })
  }
}

function extractText(message: any): string {
  if (!message) return ""
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("")
  }
  return ""
}

function extractThinking(message: any): string {
  if (!message) return ""
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c: any) => c?.type === "thinking")
      .map((c: any) => c.thinking || c.text || "")
      .join("")
  }
  return ""
}

function stringifyTool(value: unknown) {
  if (value == null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
