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
  [key: string]: unknown
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

export async function loadConfig(): Promise<BridgeConfig> {
  if (cache) return cache
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
  const next: BridgeConfig = {
    ...current,
    ...patch,
    provider: {
      ...(current.provider ?? {}),
      ...(patch.provider ?? {}),
    },
    disabled_providers: patch.disabled_providers ?? current.disabled_providers ?? [],
  }
  return saveConfig(next)
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

export { authPath, configPath, homeDir }
