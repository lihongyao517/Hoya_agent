import http from "node:http"
import { URL } from "node:url"
import path from "node:path"
import os from "node:os"
import {
  abortSession,
  allSessions,
  createSession,
  defaultDirectory,
  deleteSession,
  ensureSession,
  getSession,
  initKernel,
  listProviders,
  promptSession,
  publicSession,
  revertSession,
  setProviderAuth,
  unrevertSession,
  updateBridgeConfig,
  updateSession,
} from "./session-store"
import { connectedEvent, subscribe, type GlobalEvent } from "./events"
import { loadConfig } from "./config-store"
import { discoverOpenAIModels } from "./discover-models"
import { verifyProviderKey } from "./verify-api-key"
import { botStatus, botWebhook, pollWeixinInstall, saveBotConfig, startBotRuntime, startWeixinInstall, stopBotRuntime } from "./bot-runtime"

export type ListenOptions = {
  port: number
  hostname?: string
  username?: string
  password?: string
  cors?: string[]
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
  })
  res.end(data)
}

function text(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
  })
  res.end(body)
}

function readBody(req: http.IncomingMessage) {
  return new Promise<any>(async (resolve) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    if (chunks.length === 0) return resolve({})
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))
    } catch {
      resolve({})
    }
  })
}

function decodeDirectory(value: unknown) {
  if (typeof value !== "string" || !value) return
  let current = value
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(current)
      if (next === current) break
      current = next
    } catch {
      break
    }
  }
  return current
}

function directoryOf(req: http.IncomingMessage, url: URL, body?: any) {
  return (
    decodeDirectory(body?.location?.directory) ||
    decodeDirectory(body?.directory) ||
    decodeDirectory(url.searchParams.get("location[directory]")) ||
    decodeDirectory(url.searchParams.get("directory")) ||
    decodeDirectory(req.headers["x-opencode-directory"]) ||
    defaultDirectory()
  )
}

function checkAuth(req: http.IncomingMessage, username: string, password: string) {
  if (!password) return true
  const header = req.headers.authorization
  if (!header?.startsWith("Basic ")) return false
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8")
    const [user, pass] = decoded.split(":")
    return user === username && pass === password
  } catch {
    return false
  }
}

function sseWrite(res: http.ServerResponse, event: GlobalEvent) {
  res.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`)
}

export async function listen(options: ListenOptions) {
  const hostname = options.hostname || "127.0.0.1"
  const username = options.username || "opencode"
  const password = options.password || ""

  await initKernel()

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "*",
        })
        return res.end()
      }

      const host = req.headers.host || `${hostname}:${options.port}`
      const url = new URL(req.url || "/", `http://${host}`)
      const pathname = url.pathname

      const isHealth = pathname === "/api/health" || pathname === "/global/health"
      if (!isHealth && !checkAuth(req, username, password)) {
        return json(res, 401, { error: "unauthorized" })
      }

      // Health
      if ((pathname === "/global/health" || pathname === "/api/health") && req.method === "GET") {
        return json(res, 200, { healthy: true, version: "1.18.4-pi", kernel: "pi" })
      }

      // SSE events
      if ((pathname === "/global/event" || pathname === "/event" || pathname === "/api/event") && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        })
        sseWrite(res, connectedEvent())
        const unsub = subscribe((event) => sseWrite(res, event))
        const heartbeat = setInterval(() => res.write(`: heartbeat\n\n`), 15000)
        req.on("close", () => {
          clearInterval(heartbeat)
          unsub()
        })
        return
      }

      // Path
      if (pathname === "/path" && req.method === "GET") {
        const directory = directoryOf(req, url)
        const home = process.env.HOYA_HOME || path.join(os.homedir(), ".hoya")
        return json(res, 200, {
          home,
          state: home,
          config: path.join(home, "hoya.jsonc"),
          worktree: directory,
          directory,
        })
      }

      // Project
      if (pathname === "/project" && req.method === "GET") {
        const directory = directoryOf(req, url)
        return json(res, 200, [
          {
            id: Buffer.from(directory).toString("hex").slice(0, 32),
            worktree: directory,
            name: path.basename(directory) || directory,
          },
        ])
      }
      if (pathname === "/project/current" && req.method === "GET") {
        const directory = directoryOf(req, url)
        return json(res, 200, {
          id: Buffer.from(directory).toString("hex").slice(0, 32),
          worktree: directory,
          name: path.basename(directory) || directory,
        })
      }

      // Config
      if ((pathname === "/config" || pathname === "/global/config") && req.method === "GET") {
        const config = await loadConfig()
        return json(res, 200, {
          $schema: "https://hoyaagent.local/config.json",
          username: "hoya",
          kernel: "pi",
          ...config,
        })
      }
      if (
        (pathname === "/config" || pathname === "/global/config" || pathname === "/global/config/update") &&
        (req.method === "POST" || req.method === "PATCH")
      ) {
        const body = await readBody(req)
        const patch = body?.config && typeof body.config === "object" ? body.config : body
        const next = await updateBridgeConfig(patch ?? {})
        return json(res, 200, next)
      }

      // Multi-channel mobile bot gateway (QQ / Feishu / Lark / WeChat)
      if (pathname === "/bot/status" && req.method === "GET") return json(res, 200, botStatus())
      if (pathname === "/bot/config" && req.method === "GET") return json(res, 200, (await loadConfig()).bot ?? {})
      if (pathname === "/bot/config" && (req.method === "POST" || req.method === "PATCH")) {
        return json(res, 200, await saveBotConfig(await readBody(req)))
      }
      if (pathname === "/bot/start" && req.method === "POST") return json(res, 200, await startBotRuntime())
      if (pathname === "/bot/stop" && req.method === "POST") return json(res, 200, await stopBotRuntime())
      if (pathname === "/bot/weixin/install" && req.method === "POST") return json(res, 200, await startWeixinInstall())
      if (pathname.startsWith("/bot/weixin/install/") && req.method === "GET") {
        return json(res, 200, await pollWeixinInstall(decodeURIComponent(pathname.slice("/bot/weixin/install/".length))))
      }
      if (pathname.startsWith("/bot/webhook/") && req.method === "POST") {
        const [, , , provider, id = provider] = pathname.split("/")
        const result = await botWebhook(provider, decodeURIComponent(id), await readBody(req))
        return json(res, result.status, result.body)
      }

      // Discover OpenAI-compatible models (custom provider one-click fetch)
      if (pathname === "/provider/discover" && req.method === "POST") {
        const body = await readBody(req)
        try {
          const result = await discoverOpenAIModels({
            baseURL: body.baseURL || body.baseUrl || body.url,
            apiKey: body.apiKey || body.key,
            headers: body.headers,
          })
          return json(res, 200, result)
        } catch (error) {
          return json(res, 400, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      // Verify provider API key connectivity.
      if (pathname === "/provider/verify" && req.method === "POST") {
        const body = await readBody(req)
        try {
          await verifyProviderKey({
            providerID: body.providerID ?? body.provider ?? "",
            key: body.key ?? body.apiKey ?? "",
            baseURL: body.baseURL,
          })
          return json(res, 200, { success: true })
        } catch (error) {
          return json(res, 400, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      // Agents
      if ((pathname === "/agent" || pathname === "/app/agents") && req.method === "GET") {
        return json(res, 200, [
          { name: "build", mode: "primary", description: "Pi coding agent", permission: [], options: {} },
        ])
      }

      // Provider
      if (pathname === "/provider" && req.method === "GET") {
        return json(res, 200, await listProviders())
      }
      if (pathname === "/provider/auth" && req.method === "GET") {
        const providers = await listProviders()
        const auth: Record<string, any> = {}
        for (const provider of providers.all) {
          auth[provider.id] = [{ type: "api", label: "API key" }]
        }
        return json(res, 200, auth)
      }
      if (pathname.startsWith("/auth/") && req.method === "PUT") {
        const providerID = decodeURIComponent(pathname.slice("/auth/".length))
        const body = await readBody(req)
        const key = body?.auth?.key || body?.key || body?.apiKey
        if (!key) return json(res, 400, { error: "missing api key" })
        await setProviderAuth(providerID, key)
        return json(res, 200, { success: true })
      }
      if (pathname.startsWith("/auth/") && req.method === "DELETE") {
        const providerID = decodeURIComponent(pathname.slice("/auth/".length))
        const { removeAuthProvider } = await import("./config-store")
        await removeAuthProvider(providerID)
        return json(res, 200, true)
      }

      // Session status
      if (pathname === "/session/status" && req.method === "GET") {
        const directory = directoryOf(req, url)
        const status: Record<string, any> = {}
        for (const session of allSessions().filter((s) => s.directory === directory || !directory)) {
          status[session.id] = { type: session.status === "busy" ? "busy" : "idle" }
        }
        return json(res, 200, status)
      }

      // Sessions collection
      if (pathname === "/session" && req.method === "GET") {
        const directory = directoryOf(req, url)
        const list = allSessions()
          .filter((s) => !directory || s.directory === directory)
          .map(publicSession)
        return json(res, 200, list)
      }
      if (pathname === "/session" && req.method === "POST") {
        const body = await readBody(req)
        const directory = directoryOf(req, url, body)
        const session = await createSession({
          directory,
          title: body.title,
          parentID: body.parentID,
          id: body.id,
          model: body.model,
        })
        return json(res, 200, publicSession(session))
      }

      // Session by id
      const sessionMatch = pathname.match(/^\/session\/([^/]+)(.*)$/)
      if (sessionMatch) {
        const sessionID = decodeURIComponent(sessionMatch[1])
        const rest = sessionMatch[2] || ""

        // UI often navigates with a client-generated session id before POST /session.
        // Lazily materialize missing sessions so GET/PATCH/message do not 404.
        const directory = directoryOf(req, url)

        if (rest === "" && req.method === "GET") {
          const session = await ensureSession(sessionID, directory)
          return json(res, 200, publicSession(session))
        }
        if (rest === "" && req.method === "PATCH") {
          const body = await readBody(req)
          await ensureSession(sessionID, directory)
          const session = updateSession(sessionID, body)
          if (!session) return json(res, 404, { error: "session not found" })
          return json(res, 200, publicSession(session))
        }
        if (rest === "" && req.method === "DELETE") {
          deleteSession(sessionID)
          return json(res, 200, true)
        }
        if (rest === "/message" && req.method === "GET") {
          const session = await ensureSession(sessionID, directory)
          return json(res, 200, session.messages)
        }
        if ((rest === "/message" || rest === "/prompt_async") && req.method === "POST") {
          const body = await readBody(req)
          const promptDirectory = directoryOf(req, url, body)
          const result = await promptSession(sessionID, {
            messageID: body.messageID,
            parts: body.parts,
            agent: body.agent,
            model: body.model,
            directory: promptDirectory,
          })
          // prompt_async returns quickly; message endpoint historically returned message
          if (rest === "/prompt_async") return json(res, 200, true)
          return json(res, 200, result)
        }
        if (rest === "/revert" && req.method === "POST") {
          const body = await readBody(req)
          if (!body.messageID) return json(res, 400, { error: "missing messageID" })
          return json(res, 200, await revertSession(sessionID, String(body.messageID), directoryOf(req, url, body)))
        }
        if (rest === "/unrevert" && req.method === "POST") {
          return json(res, 200, await unrevertSession(sessionID, directory))
        }
        if (rest === "/abort" && req.method === "POST") {
          if (getSession(sessionID)) await abortSession(sessionID)
          return json(res, 200, true)
        }
        // Common session subroutes the UI may hit; return safe empties.
        if (rest === "/todo" && req.method === "GET") return json(res, 200, [])
        if (rest === "/diff" && req.method === "GET") return json(res, 200, [])
        if (rest === "/status" && req.method === "GET") {
          const session = getSession(sessionID)
          return json(res, 200, { type: session?.status === "busy" ? "busy" : "idle" })
        }
      }

      // V2 aliases used by some UI paths
      if (pathname === "/api/session" && req.method === "GET") {
        const list = allSessions().map(publicSession)
        return json(res, 200, { data: list, cursor: {} })
      }
      if (pathname === "/api/session" && req.method === "POST") {
        const body = await readBody(req)
        const directory = directoryOf(req, url, body)
        const model = body.model?.modelID ? body.model : body.model?.id ? { providerID: body.model.providerID, modelID: body.model.id } : undefined
        const session = await createSession({ directory, id: body.id, model })
        return json(res, 200, { data: publicSession(session) })
      }
      if (pathname === "/api/session/active" && req.method === "GET") {
        return json(
          res,
          200,
          Object.fromEntries(allSessions().filter((s) => s.status !== "idle").map((s) => [s.id, { type: "running" }])),
        )
      }
      const apiSessionMatch = pathname.match(/^\/api\/session\/([^/]+)(.*)$/)
      if (apiSessionMatch) {
        const sessionID = decodeURIComponent(apiSessionMatch[1])
        const rest = apiSessionMatch[2] || ""
        const directory = directoryOf(req, url)
        if (rest === "" && req.method === "GET") {
          const session = await ensureSession(sessionID, directory)
          return json(res, 200, { data: publicSession(session) })
        }
        if (rest === "/abort" && req.method === "POST") {
          if (getSession(sessionID)) await abortSession(sessionID)
          return json(res, 200, true)
        }
        if (rest === "/revert/stage" && req.method === "POST") {
          const body = await readBody(req)
          if (!body.messageID) return json(res, 400, { error: "missing messageID" })
          return json(res, 200, { data: await revertSession(sessionID, String(body.messageID), directoryOf(req, url, body)) })
        }
        if (rest === "/revert/clear" && req.method === "POST") {
          return json(res, 200, { data: await unrevertSession(sessionID, directory) })
        }
        if (rest === "/revert/commit" && req.method === "POST") {
          const session = await ensureSession(sessionID, directory)
          return json(res, 200, { data: publicSession(session) })
        }
      }
      if (pathname === "/api/provider" && req.method === "GET") {
        return json(res, 200, await listProviders())
      }
      if (pathname === "/api/agent" && req.method === "GET") {
        return json(res, 200, { data: [{ name: "build", mode: "primary", description: "Pi coding agent", permission: [], options: {} }] })
      }

      // Global dispose (credential reload)
      if (pathname === "/global/dispose" && req.method === "POST") {
        await initKernel()
        // Tell UI to refetch providers/sessions after credentials change.
        const { emit } = await import("./events")
        emit("", "global.disposed", {})
        emit(defaultDirectory(), "global.disposed", {})
        return json(res, 200, true)
      }

      // Permission/question empty lists so bootstrap doesn't fail hard
      if (pathname === "/permission" && req.method === "GET") return json(res, 200, [])
      if (pathname === "/question" && req.method === "GET") return json(res, 200, [])
      if (pathname === "/vcs" && req.method === "GET") return json(res, 200, { branch: null })
      if (pathname === "/command" && req.method === "GET") return json(res, 200, [])
      if (pathname === "/mcp" && req.method === "GET") return json(res, 200, { status: {} })

      // Experimental endpoints — return safe defaults so SDK calls don't 404.
      if (pathname === "/experimental/capabilities" && req.method === "GET") {
        return json(res, 200, { features: [], server: { version: "1.18.4-pi", kernel: "pi" } })
      }
      if (pathname === "/experimental/resource" && req.method === "GET") return json(res, 200, [])
      if (pathname === "/experimental/tool" && req.method === "GET") return json(res, 200, [])
      if (pathname === "/experimental/tool/ids" && req.method === "GET") return json(res, 200, [])
      if (pathname === "/experimental/session" && req.method === "GET") {
        const list = allSessions().map(publicSession)
        return json(res, 200, { data: list, cursor: {} })
      }
      if (pathname.startsWith("/experimental/session/") && req.method === "GET") return json(res, 200, {})
      if (pathname === "/experimental/workspace" && req.method === "GET") return json(res, 200, [])
      if (pathname === "/experimental/workspace/adapter" && req.method === "GET") return json(res, 200, {})
      if (pathname === "/experimental/workspace/sync-list" && req.method === "GET") return json(res, 200, [])
      if (pathname === "/experimental/workspace/status" && req.method === "GET") return json(res, 200, {})
      if (pathname.startsWith("/experimental/workspace/") && req.method === "GET") return json(res, 200, {})
      if (pathname.startsWith("/experimental/project/") && req.method === "GET") return json(res, 200, {})
      if (pathname === "/experimental/console" && req.method === "GET") return json(res, 200, {})
      if (pathname.startsWith("/experimental/console/") && req.method === "GET") return json(res, 200, {})
      if (pathname === "/experimental/control-plane/move-session" && req.method === "POST") return json(res, 200, {})
      if (pathname === "/experimental/worktree" && req.method === "GET") return json(res, 200, [])
      if (pathname.startsWith("/experimental/worktree/") && req.method === "GET") return json(res, 200, {})
      if (pathname.startsWith("/experimental/")) return json(res, 200, {})
      if (pathname === "/policies" && req.method === "GET") return json(res, 200, [])

      return json(res, 404, { error: "not found", path: pathname })
    } catch (error) {
      console.error("[pi-bridge]", error)
      return json(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, hostname, () => resolve())
  })

  console.log(`[pi-bridge] listening on http://${hostname}:${options.port} (kernel=pi)`)
  await startBotRuntime()

  return {
    url: `http://${hostname}:${options.port}`,
    server,
    async stop(close = true) {
      await stopBotRuntime()
      if (!close) return
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

export const Server = { listen }
