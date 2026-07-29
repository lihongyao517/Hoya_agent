import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"

export type CustomProviderConfig = {
  npm?: string
  name?: string
  env?: string[]
  options?: {
    baseURL?: string
    headers?: Record<string, string>
    apiKey?: string
  }
  models?: Record<string, { name?: string; cost?: { input?: number; output?: number } }>
}

export type BridgeConfig = {
  $schema?: string
  username?: string
  kernel?: string
  model?: string
  provider?: Record<string, CustomProviderConfig>
  disabled_providers?: string[]
  bot?: BotConfig
  [key: string]: unknown
}

export type BotConnectionConfig = {
  id: string
  provider: "qq" | "feishu" | "lark" | "weixin"
  enabled: boolean
  label?: string
  model?: { providerID: string; modelID: string }
  toolApprovalMode?: string
  workspaceRoot?: string
  appID?: string
  appSecret?: string
  appSecretEnv?: string
  verificationToken?: string
  webhookPath?: string
  webhookPort?: number
  requireMention?: boolean
  sandbox?: boolean
  accountID?: string
  token?: string
  tokenEnv?: string
  apiBase?: string
  allowAll?: boolean
  allowUsers?: string[]
  allowGroups?: string[]
  sessionMappings?: Array<{
    remoteID: string
    sessionID?: string
    chatType?: string
    userID?: string
    updatedAt?: string
  }>
  status?: string
  lastError?: string
  createdAt?: string
  updatedAt?: string
}

export type BotConfig = {
  enabled?: boolean
  maxSteps?: number
  debounceMs?: number
  queueCap?: number
  queueMode?: string
  queueDrop?: string
  ignoreSelfMessages?: boolean
  allowAll?: boolean
  allowUsers?: Record<string, string[]>
  allowGroups?: Record<string, string[]>
  approvers?: Record<string, string[]>
  admins?: Record<string, string[]>
  selfUserIds?: Record<string, string[]>
  pairing?: { enabled?: boolean; requestTtlMinutes?: number; maxPendingPerPlatform?: number }
  routes?: Array<{
    connectionId?: string
    platform?: string
    chatType?: string
    chatId?: string
    userId?: string
    threadId?: string
    workspaceRoot?: string
    model?: { providerID: string; modelID: string }
    toolApprovalMode?: string
  }>
  connections?: BotConnectionConfig[]
}

function homeDir() {
  return process.env.HOYA_HOME || process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".hoya")
}

function configPath() {
  return path.join(homeDir(), "hoya.json")
}

function authPath() {
  return path.join(homeDir(), "pi-agent", "auth.json")
}

let cache: BridgeConfig | undefined

export function invalidateConfigCache() {
  cache = undefined
}

export async function loadConfig(forceReload = false): Promise<BridgeConfig> {
  if (cache && !forceReload) return cache
  try {
    const raw = await fs.readFile(configPath(), "utf8")
    cache = JSON.parse(raw) as BridgeConfig
  } catch {
    cache = {
      $schema: "https://hoyaagent.local/config.json",
      username: "hoya",
      kernel: "pi",
      provider: {},
      disabled_providers: [],
    }
  }
  if (!cache.provider) cache.provider = {}
  if (!cache.disabled_providers) cache.disabled_providers = []
  if (!cache.bot) cache.bot = { enabled: false, connections: [] }
  if (!cache.bot.connections) cache.bot.connections = []
  return cache
}

export async function saveConfig(next: BridgeConfig) {
  cache = next
  await fs.mkdir(homeDir(), { recursive: true })
  await fs.writeFile(configPath(), JSON.stringify(next, null, 2), "utf8")
  return cache
}

export async function mergeConfig(patch: BridgeConfig) {
  const current = await loadConfig()
  const patchedProviders = Object.keys(patch.provider ?? {})
  const disabled = patch.disabled_providers ?? current.disabled_providers ?? []
  const next: BridgeConfig = {
    ...current,
    ...patch,
    provider: {
      ...(current.provider ?? {}),
      ...(patch.provider ?? {}),
    },
    disabled_providers: patchedProviders.length > 0 ? disabled.filter((id) => !patchedProviders.includes(id)) : disabled,
  }
  return saveConfig(next)
}

export async function enableProvider(providerID: string) {
  const current = await loadConfig()
  if (!current.disabled_providers?.includes(providerID)) return current
  return saveConfig({
    ...current,
    disabled_providers: current.disabled_providers.filter((id) => id !== providerID),
  })
}

export async function loadAuthFile(): Promise<Record<string, { type: string; key?: string }>> {
  try {
    return JSON.parse(await fs.readFile(authPath(), "utf8"))
  } catch {
    return {}
  }
}

export async function saveAuthProvider(providerID: string, key: string) {
  const dir = path.dirname(authPath())
  await fs.mkdir(dir, { recursive: true })
  const data = await loadAuthFile()
  data[providerID] = { type: "api_key", key }
  await fs.writeFile(authPath(), JSON.stringify(data, null, 2), "utf8")
}

export async function removeAuthProvider(providerID: string) {
  const data = await loadAuthFile()
  delete data[providerID]
  await fs.mkdir(path.dirname(authPath()), { recursive: true })
  await fs.writeFile(authPath(), JSON.stringify(data, null, 2), "utf8")
}

function modelsPath() {
  return path.join(homeDir(), "pi-agent", "models.json")
}

/** Write Pi-compatible models.json from Hoya custom providers so ModelRuntime can resolve them. */
export async function syncPiModelsJson(config?: BridgeConfig) {
  const cfg = config ?? (await loadConfig())
  const auth = await loadAuthFile()
  const providers: Record<string, any> = {}

  for (const [providerID, conf] of Object.entries(cfg.provider ?? {})) {
    if (cfg.disabled_providers?.includes(providerID)) continue
    const baseUrl = conf.options?.baseURL?.trim()
    if (!baseUrl) continue
    const apiKey =
      (typeof conf.options?.apiKey === "string" && conf.options.apiKey.trim()) ||
      (typeof auth[providerID]?.key === "string" && auth[providerID].key!.trim()) ||
      undefined
    const models = Object.entries(conf.models ?? {}).map(([modelID, meta]) => ({
      id: modelID,
      name: meta?.name || modelID,
      reasoning: true,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 8192,
      cost: {
        input: meta?.cost?.input ?? 0,
        output: meta?.cost?.output ?? 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    }))
    if (models.length === 0) continue
    providers[providerID] = {
      name: conf.name || providerID,
      baseUrl,
      api: "openai-completions",
      ...(apiKey ? { apiKey } : {}),
      ...(conf.options?.headers ? { headers: conf.options.headers } : {}),
      models,
    }
  }

  const file = modelsPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ providers }, null, 2), "utf8")
  return file
}

export { authPath, configPath, homeDir, modelsPath }
