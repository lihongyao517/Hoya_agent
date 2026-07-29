import * as http from "node:http"
import * as tls from "node:tls"

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

const parentPort = getParentPort()
let listener: Listener | undefined

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    prepareSidecarEnv(command.password, command.userDataPath)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    const { Server } = await import("virtual:opencode-server")

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "opencode",
      password: command.password,
      cors: ["oc://renderer"],
    })
    parentPort.postMessage({ type: "ready" })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    await listener?.stop()
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  const piRoot =
    process.env.HOYA_PI_ROOT ||
    process.env.PI_ROOT ||
    // Common local layout: .../hoyaagent/Hoya_agent + sibling pi/
    "D:/程序/hoyaagent/pi"

  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
    HOYA_HOME: process.env.HOYA_HOME ?? userDataPath,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR ?? userDataPath,
    // Point Pi coding-agent config under Hoya home.
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? `${userDataPath.replace(/\\/g, "/")}/pi-agent`,
    PI_CONFIG_DIR: process.env.PI_CONFIG_DIR ?? userDataPath,
    HOYA_PI_ROOT: piRoot,
    HOYA_KERNEL: process.env.HOYA_KERNEL ?? "pi",
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    // If no proxy env vars are set, try to detect Windows system proxy
    if (!process.env.HTTP_PROXY && !process.env.http_proxy && !process.env.HTTPS_PROXY && !process.env.https_proxy) {
      try {
        const { execSync } = require("node:child_process")
        const output = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable & reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
          { encoding: "utf8", timeout: 3000 },
        )
        const enableMatch = output.match(/ProxyEnable\s+REG_DWORD\s+0x(\d+)/i)
        const serverMatch = output.match(/ProxyServer\s+REG_SZ\s+(.+)/i)
        if (enableMatch && parseInt(enableMatch[1], 16) === 1 && serverMatch) {
          const proxy = serverMatch[1].trim()
          const proxyUrl = proxy.includes("://") ? proxy : `http://${proxy}`
          process.env.HTTP_PROXY = proxyUrl
          process.env.HTTPS_PROXY = proxyUrl
          process.env.http_proxy = proxyUrl
          process.env.https_proxy = proxyUrl
          console.log(`[sidecar] detected Windows system proxy: ${proxyUrl}`)
        }
      } catch {
        // Registry query failed, continue without proxy
      }
    }

    // Set up proxy for http/https modules (Electron API)
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv?.()

    // Set up proxy for global fetch() / undici
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    if (proxyUrl) {
      try {
        const { ProxyAgent, setGlobalDispatcher } = require("undici")
        setGlobalDispatcher(new ProxyAgent(proxyUrl))
        console.log(`[sidecar] undici global dispatcher set to proxy: ${proxyUrl}`)
      } catch (undiciErr) {
        console.warn("[sidecar] failed to set undici proxy (fetch may not use proxy):", undiciErr)
      }
    }
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
