import path from "node:path"
import os from "node:os"
import { id, projectIdForDirectory } from "./ids"
import { emit } from "./events"
import { loadPiCodingAgent } from "./pi-loader"
import { enableProvider, loadAuthFile, loadConfig, mergeConfig, saveAuthProvider, syncPiModelsJson } from "./config-store"

type AnySession = {
  subscribe: (listener: (event: any) => void) => () => void
  prompt: (text: string, options?: any) => Promise<void>
  abort: () => Promise<void>
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
  pi?: AnySession
  unsub?: () => void
  agentDir: string
}

const sessions = new Map<string, BridgeSession>()
let modelRuntime: any
let piMod: any
let agentDir = ""

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

  const fs = await import("node:fs/promises")
  await fs.mkdir(agentDir, { recursive: true })
  await fs.mkdir(path.join(agentDir, "sessions"), { recursive: true })

  // Hoya stores custom providers in hoya.json; Pi only reads models.json.
  await syncPiModelsJson()

  const loaded = await loadPiCodingAgent()
  piMod = loaded.mod
  modelRuntime = await createModelRuntime()
  await injectAuthKeys()
  return { root: loaded.root, agentDir }
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
    status: "active",
    tags: cost && cost.input === 0 ? ["free"] : [],
    // Provide defaults so the UI tooltip never crashes.
    limit: { context: model?.limit?.context ?? model?.context ?? 128_000 },
    capabilities: model?.capabilities ?? { reasoning: true, input: {} },
    ...(cost ? { cost } : {}),
  }
}

export async function listProviders() {
  if (!modelRuntime) await initKernel()
  const config = await loadConfig()
  const auth = await loadAuthFile()
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
        limit: { context: 128_000 },
        capabilities: { reasoning: true, input: {} },
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
        models: modelsMap,
      })
    }
  }

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

export async function updateBridgeConfig(patch: Record<string, any>) {
  const next = await mergeConfig(patch)
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

  const sessionDir = path.join(agentDir, "sessions", projectID)
  const sessionManager =
    (typeof piMod.SessionManager?.create === "function"
      ? piMod.SessionManager.create(directory, sessionDir)
      : undefined) ??
    (typeof piMod.SessionManager?.inMemory === "function" ? piMod.SessionManager.inMemory() : undefined)

  let model
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
    cwd: directory,
    agentDir,
    modelRuntime,
    model,
    sessionManager,
  })

  const resolvedModel = (() => {
    if (input.model?.providerID && input.model?.modelID) return input.model
    const m = created.session?.model || created.session?.agent?.state?.model
    if (m?.provider && m?.id && m.provider !== "unknown") {
      return { providerID: String(m.provider), modelID: String(m.id) }
    }
    return undefined
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
    pi: created.session,
    agentDir,
  }

  bridge.unsub = created.session.subscribe((event: any) => handlePiEvent(bridge, event))
  sessions.set(sessionID, bridge)

  emit(directory, "session.created", { info: publicSession(bridge) })
  emit(directory, "session.updated", { info: publicSession(bridge) })
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
    model: session.model,
    time: session.time,
    revert: session.revert,
  }
}

export async function ensureSession(sessionID: string, directory?: string) {
  const existing = sessions.get(sessionID)
  if (existing) return existing
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
  const session = await ensureSession(sessionID, input.directory)
  const text = (input.parts ?? [])
    .filter((part) => part.type === "text" || typeof part.text === "string")
    .map((part) => String(part.text ?? ""))
    .join("\n")
    .trim()

  if (!text) throw new Error("Empty prompt")

  const desiredModel = input.model || session.model
  if (desiredModel) {
    await applySessionModel(session, desiredModel)
  }
  if (!session.model?.providerID || !session.model?.modelID) {
    throw new Error("No model selected. Choose a provider/model first.")
  }
  if (!session.pi) throw new Error("Pi session not ready")

  const userMessageID = input.messageID || id("msg")
  const userMessage: BridgeMessage = {
    info: {
      id: userMessageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: input.agent || session.agent,
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
      agent: input.agent || session.agent,
      model: session.model,
    },
    parts: [],
  }
  session.messages.push(assistant)
  emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })

  // Run prompt without blocking HTTP (async style like prompt_async)
  void session.pi
    .prompt(text)
    .catch((error: unknown) => {
      assistant.info.error = error instanceof Error ? error.message : String(error)
      session.status = "idle"
      emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })
      emit(session.directory, "session.status", { sessionID, status: { type: "idle" } })
      emit(session.directory, "session.error", {
        sessionID,
        error: { name: "PiError", message: assistant.info.error },
      })
    })
    .finally(() => {
      // Pi may finish without emitting bridge-friendly deltas; harvest final text from agent state.
      harvestAssistantText(session, assistant)
      session.status = "idle"
      session.time.updated = Date.now()
      assistant.info.time.completed = Date.now()
      emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })
      emit(session.directory, "session.status", { sessionID, status: { type: "idle" } })
      emit(session.directory, "session.idle", { sessionID })
      emit(session.directory, "session.updated", { info: publicSession(session) })
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
      textPart.text = text
      emit(session.directory, "message.part.updated", { part: { ...textPart } })
    }
    if (lastAssistant.errorMessage || lastAssistant.error) {
      assistant.info.error = lastAssistant.errorMessage || lastAssistant.error
    }
  } catch {
    // ignore
  }
}

async function applySessionModel(session: BridgeSession, model: { providerID: string; modelID: string }) {
  if (!modelRuntime) await initKernel()
  let resolved = typeof modelRuntime.getModel === "function" ? modelRuntime.getModel(model.providerID, model.modelID) : undefined
  if (!resolved) {
    // Custom provider may have been added after boot; refresh models.json + runtime once.
    await reloadModelRuntime()
    resolved = typeof modelRuntime.getModel === "function" ? modelRuntime.getModel(model.providerID, model.modelID) : undefined
  }
  if (!resolved) {
    throw new Error(
      `Model not found: ${model.providerID}/${model.modelID}. Re-save the custom provider or pick another model.`,
    )
  }
  if (session.pi && typeof (session.pi as any).setModel === "function") {
    await (session.pi as any).setModel(resolved)
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
  if (patch.title) session.title = patch.title
  session.time.updated = Date.now()
  emit(session.directory, "session.updated", { info: publicSession(session) })
  return session
}

export function deleteSession(sessionID: string) {
  const session = sessions.get(sessionID)
  if (!session) return
  session.unsub?.()
  void session.pi?.abort?.()
  sessions.delete(sessionID)
  emit(session.directory, "session.deleted", { info: publicSession(session) })
}

function handlePiEvent(session: BridgeSession, event: any) {
  const type = event?.type || event?.event || ""
  const assistant = [...session.messages].reverse().find((m) => m.info.role === "assistant" && !m.info.time.completed)
  if (!assistant) return

  // message_update with assistant text deltas
  if (
    type === "message_update" ||
    type === "message_delta" ||
    type === "message_start" ||
    event?.assistantMessageEvent ||
    event?.type === "text_delta"
  ) {
    const delta =
      event?.assistantMessageEvent?.delta ||
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
      }
      const evtType = event?.assistantMessageEvent?.type || event?.type
      if (evtType === "text_delta" || type === "message_update" || type === "message_delta") {
        textPart.text = String(textPart.text || "") + delta
      } else if (delta.length >= String(textPart.text || "").length) {
        textPart.text = delta
      } else {
        textPart.text = String(textPart.text || "") + delta
      }
      emit(session.directory, "message.part.updated", { part: { ...textPart }, time: Date.now() })
      emit(session.directory, "message.part.delta", {
        sessionID: session.id,
        messageID: assistant.info.id,
        partID: textPart.id,
        field: "text",
        delta,
      })
      emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })
    }
  }

  if (type === "message_end" || type === "turn_end" || type === "agent_end") {
    harvestAssistantText(session, assistant)
    emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })
  }

  if (type === "tool_execution_start" || type === "tool_start") {
    const toolPart = {
      id: id("part"),
      type: "tool",
      tool: event.toolName || event.name || "tool",
      callID: event.toolCallId || event.id || id("call"),
      state: {
        status: "running",
        input: event.args || event.input || {},
        time: { start: Date.now() },
      },
      sessionID: session.id,
      messageID: assistant.info.id,
    }
    assistant.parts.push(toolPart)
    emit(session.directory, "message.part.updated", { part: toolPart })
    emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts })
  }

  if (type === "tool_execution_end" || type === "tool_end" || type === "tool_execution_update") {
    const callID = event.toolCallId || event.id
    const toolPart = [...assistant.parts]
      .reverse()
      .find((p: any) => p.type === "tool" && (!callID || p.callID === callID)) as any
    if (toolPart) {
      toolPart.state = {
        ...toolPart.state,
        status: type.includes("end") ? "completed" : "running",
        output: stringifyTool(event.result ?? event.output ?? event.update),
        time: { start: toolPart.state?.time?.start || Date.now(), end: Date.now() },
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

function stringifyTool(value: unknown) {
  if (value == null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
