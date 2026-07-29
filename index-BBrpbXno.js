import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
import http__default from "node:http";
import { pathToFileURL, fileURLToPath, URL as URL$1 } from "node:url";
import path from "node:path";
import os from "node:os";
import { existsSync, promises } from "node:fs";
import { randomBytes } from "node:crypto";
function id(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
function projectIdForDirectory(directory) {
  let hash = 0;
  for (let i = 0; i < directory.length; i++) hash = hash * 31 + directory.charCodeAt(i) >>> 0;
  return hash.toString(16).padStart(16, "0");
}
const listeners = /* @__PURE__ */ new Set();
let seq = 0;
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(directory, type, properties = {}) {
  const event = {
    directory,
    payload: {
      id: `evt_${++seq}`,
      type,
      properties
    }
  };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("[pi-bridge] event listener error", error);
    }
  }
}
function connectedEvent() {
  return {
    directory: "",
    payload: {
      id: `evt_${++seq}`,
      type: "server.connected",
      properties: {}
    }
  };
}
const events = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  connectedEvent,
  emit,
  subscribe
}, Symbol.toStringTag, { value: "Module" }));
const candidates$1 = () => {
  const env = process.env.HOYA_PI_ROOT || process.env.PI_ROOT;
  const list = [
    env,
    path.resolve(process.cwd(), "../../pi"),
    path.resolve(process.cwd(), "../../../pi"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../pi"),
    "D:/程序/hoyaagent/pi",
    "D:\\程序\\hoyaagent\\pi"
  ].filter((value) => Boolean(value));
  return [...new Set(list.map((value) => path.resolve(value)))];
};
function resolvePiRoot() {
  for (const root of candidates$1()) {
    const entry = path.join(root, "packages/coding-agent/dist/index.js");
    if (existsSync(entry)) return root;
  }
  throw new Error(
    "Pi coding-agent dist not found. Build Pi first:\n  cd D:\\程序\\hoyaagent\\pi\n  npm install --ignore-scripts\n  npm run hydrate:model-data\n  npm run build:offline\nOr set HOYA_PI_ROOT to the pi monorepo path."
  );
}
async function loadPiCodingAgent() {
  const root = resolvePiRoot();
  const entry = path.join(root, "packages/coding-agent/dist/index.js");
  const mod = await import(pathToFileURL(entry).href);
  return { root, mod };
}
function homeDir() {
  return process.env.HOYA_HOME || process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".hoya");
}
function configPath() {
  return path.join(homeDir(), "hoya.json");
}
function authPath() {
  return path.join(homeDir(), "pi-agent", "auth.json");
}
let cache;
function invalidateConfigCache() {
  cache = void 0;
}
async function loadConfig(forceReload = false) {
  if (cache && !forceReload) return cache;
  try {
    const raw = await promises.readFile(configPath(), "utf8");
    cache = JSON.parse(raw);
  } catch {
    cache = {
      $schema: "https://hoyaagent.local/config.json",
      username: "hoya",
      kernel: "pi",
      provider: {},
      disabled_providers: []
    };
  }
  if (!cache.provider) cache.provider = {};
  if (!cache.disabled_providers) cache.disabled_providers = [];
  if (!cache.bot) cache.bot = { enabled: false, connections: [] };
  if (!cache.bot.connections) cache.bot.connections = [];
  return cache;
}
async function saveConfig(next) {
  cache = next;
  await promises.mkdir(homeDir(), { recursive: true });
  await promises.writeFile(configPath(), JSON.stringify(next, null, 2), "utf8");
  return cache;
}
async function mergeConfig(patch) {
  const current = await loadConfig();
  const patchedProviders = Object.keys(patch.provider ?? {});
  const disabled = patch.disabled_providers ?? current.disabled_providers ?? [];
  const next = {
    ...current,
    ...patch,
    provider: {
      ...current.provider ?? {},
      ...patch.provider ?? {}
    },
    disabled_providers: patchedProviders.length > 0 ? disabled.filter((id2) => !patchedProviders.includes(id2)) : disabled
  };
  return saveConfig(next);
}
async function enableProvider(providerID) {
  const current = await loadConfig();
  if (!current.disabled_providers?.includes(providerID)) return current;
  return saveConfig({
    ...current,
    disabled_providers: current.disabled_providers.filter((id2) => id2 !== providerID)
  });
}
async function loadAuthFile() {
  try {
    return JSON.parse(await promises.readFile(authPath(), "utf8"));
  } catch {
    return {};
  }
}
async function saveAuthProvider(providerID, key) {
  const dir = path.dirname(authPath());
  await promises.mkdir(dir, { recursive: true });
  const data = await loadAuthFile();
  data[providerID] = { type: "api_key", key };
  await promises.writeFile(authPath(), JSON.stringify(data, null, 2), "utf8");
}
async function removeAuthProvider(providerID) {
  const data = await loadAuthFile();
  delete data[providerID];
  await promises.mkdir(path.dirname(authPath()), { recursive: true });
  await promises.writeFile(authPath(), JSON.stringify(data, null, 2), "utf8");
}
function modelsPath() {
  return path.join(homeDir(), "pi-agent", "models.json");
}
async function syncPiModelsJson(config) {
  const cfg = config ?? await loadConfig();
  const auth = await loadAuthFile();
  const providers = {};
  for (const [providerID, conf] of Object.entries(cfg.provider ?? {})) {
    if (cfg.disabled_providers?.includes(providerID)) continue;
    const baseUrl = conf.options?.baseURL?.trim();
    if (!baseUrl) continue;
    const apiKey = typeof conf.options?.apiKey === "string" && conf.options.apiKey.trim() || typeof auth[providerID]?.key === "string" && auth[providerID].key.trim() || void 0;
    const models = Object.entries(conf.models ?? {}).map(([modelID, meta]) => ({
      id: modelID,
      name: meta?.name || modelID,
      reasoning: true,
      input: ["text"],
      contextWindow: 128e3,
      maxTokens: 8192,
      cost: {
        input: meta?.cost?.input ?? 0,
        output: meta?.cost?.output ?? 0,
        cacheRead: 0,
        cacheWrite: 0
      }
    }));
    if (models.length === 0) continue;
    providers[providerID] = {
      name: conf.name || providerID,
      baseUrl,
      api: "openai-completions",
      ...apiKey ? { apiKey } : {},
      ...conf.options?.headers ? { headers: conf.options.headers } : {},
      models
    };
  }
  const file = modelsPath();
  await promises.mkdir(path.dirname(file), { recursive: true });
  await promises.writeFile(file, JSON.stringify({ providers }, null, 2), "utf8");
  return file;
}
const configStore = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  authPath,
  configPath,
  enableProvider,
  homeDir,
  invalidateConfigCache,
  loadAuthFile,
  loadConfig,
  mergeConfig,
  modelsPath,
  removeAuthProvider,
  saveAuthProvider,
  saveConfig,
  syncPiModelsJson
}, Symbol.toStringTag, { value: "Module" }));
const MAX_ENTRIES = 500;
const buffer = [];
function push(level, scope, message, data) {
  const entry = {
    time: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    scope,
    message,
    ...data !== void 0 ? { data: safeSerialize(data) } : {}
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  const prefix = `[${entry.time.slice(11, 23)}][${level.toUpperCase()}][${scope}]`;
  if (level === "error") console.error(prefix, message, data ?? "");
  else if (level === "warn") console.warn(prefix, message, data ?? "");
  else console.log(prefix, message, data ?? "");
}
function safeSerialize(data) {
  if (data === null || data === void 0) return data;
  if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") return data;
  try {
    const json2 = JSON.stringify(data);
    if (json2.length > 2e3) return json2.slice(0, 2e3) + "...(truncated)";
    return JSON.parse(json2);
  } catch {
    return String(data);
  }
}
const log = {
  info: (scope, message, data) => push("info", scope, message, data),
  warn: (scope, message, data) => push("warn", scope, message, data),
  error: (scope, message, data) => push("error", scope, message, data),
  debug: (scope, message, data) => push("debug", scope, message, data)
};
function getLogs(limit = 200) {
  return buffer.slice(-limit);
}
function clearLogs() {
  buffer.length = 0;
}
const sessions = /* @__PURE__ */ new Map();
let modelRuntime;
let piMod;
let agentDir = "";
function sessionIndexPath() {
  return path.join(agentDir, "sessions-index.json");
}
function sessionMessagesPath(sessionID) {
  return path.join(agentDir, "sessions", `${sessionID}.messages.json`);
}
async function persistSessionIndex() {
  try {
    const fs = await import("node:fs/promises");
    const list = [...sessions.values()].map((s) => ({
      id: s.id,
      slug: s.slug,
      projectID: s.projectID,
      directory: s.directory,
      title: s.title,
      version: s.version,
      agent: s.agent,
      model: s.model,
      time: s.time
    }));
    await fs.mkdir(path.dirname(sessionIndexPath()), { recursive: true });
    await fs.writeFile(sessionIndexPath(), JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.warn("[pi-bridge] persistSessionIndex failed:", err);
  }
}
async function persistSessionMessages(session) {
  try {
    const fs = await import("node:fs/promises");
    const file = sessionMessagesPath(session.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(session.messages, null, 2), "utf8");
  } catch (err) {
    console.warn("[pi-bridge] persistSessionMessages failed:", err);
  }
}
async function restoreSessionIndex() {
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(sessionIndexPath(), "utf8");
    const list = JSON.parse(raw);
    for (const meta of list) {
      if (sessions.has(meta.id)) continue;
      let messages = [];
      try {
        const msgRaw = await fs.readFile(sessionMessagesPath(meta.id), "utf8");
        messages = JSON.parse(msgRaw);
      } catch {
      }
      const bridge = {
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
        pi: void 0,
        agentDir
      };
      sessions.set(meta.id, bridge);
    }
    if (list.length > 0) {
      console.log(`[pi-bridge] restored ${list.length} sessions from disk`);
    }
  } catch {
  }
}
function allSessions() {
  return [...sessions.values()];
}
function getSession(id2) {
  return sessions.get(id2);
}
function defaultDirectory() {
  return process.env.HOYA_WORKSPACE || process.cwd();
}
function getAgentDir() {
  return agentDir;
}
async function initKernel() {
  const home = process.env.HOYA_HOME || process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".hoya");
  agentDir = path.join(home, "pi-agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CONFIG_DIR = home;
  log.info("kernel", `initKernel start, home=${home}, agentDir=${agentDir}`);
  const proxyTimeout = setTimeout(() => {
    proxyConfigured = true;
    log.warn("proxy", "setup timed out after 5s, skipping");
  }, 5e3);
  setupProxy().finally(() => clearTimeout(proxyTimeout));
  const fs = await import("node:fs/promises");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(path.join(agentDir, "sessions"), { recursive: true });
  await restoreSessionIndex();
  await syncPiModelsJson();
  log.info("kernel", "syncPiModelsJson done");
  const loaded = await loadPiCodingAgent();
  piMod = loaded.mod;
  log.info("kernel", `Pi loaded from ${loaded.root}, exports: ${Object.keys(piMod).join(", ")}`);
  modelRuntime = await createModelRuntime();
  log.info("kernel", "ModelRuntime created");
  await injectAuthKeys();
  log.info("kernel", "initKernel complete");
  return { root: loaded.root, agentDir };
}
let proxyConfigured = false;
async function setupProxy() {
  if (proxyConfigured) return;
  proxyConfigured = true;
  try {
    await setupProxyInner();
  } catch (e) {
    log.warn("proxy", `setupProxy failed (continuing without proxy): ${e}`);
  }
}
async function setupProxyInner() {
  let proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (!proxyUrl) {
    try {
      const { execSync } = await import("node:child_process");
      const output = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
        { encoding: "utf8", timeout: 2e3, windowsHide: true }
      );
      const serverMatch = output.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
      if (serverMatch) {
        const proxy = serverMatch[1].trim();
        proxyUrl = proxy.includes("://") ? proxy : `http://${proxy}`;
      }
    } catch {
      const net = await import("node:net");
      for (const port of [7897, 7890, 1080]) {
        const ok = await new Promise((resolve) => {
          const sock = net.default.connect(port, "127.0.0.1", () => {
            sock.destroy();
            resolve(true);
          });
          sock.on("error", () => resolve(false));
          sock.setTimeout(500, () => {
            sock.destroy();
            resolve(false);
          });
        });
        if (ok) {
          proxyUrl = `http://127.0.0.1:${port}`;
          break;
        }
      }
    }
  }
  if (!proxyUrl) {
    log.info("proxy", "No system proxy detected, using direct connections");
    return;
  }
  log.info("proxy", `Using proxy: ${proxyUrl}`);
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.https_proxy = proxyUrl;
  try {
    const { createRequire } = await import("node:module");
    const nodeRequire = createRequire(import.meta.url);
    const undici = nodeRequire("undici");
    if (undici.ProxyAgent && undici.setGlobalDispatcher) {
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl));
      log.info("proxy", "undici ProxyAgent set as global dispatcher");
    }
  } catch (e) {
    log.warn("proxy", `undici setup failed: ${e}`);
  }
  try {
    const httpMod = await import("node:http");
    const httpsMod = await import("node:https");
    const tlsMod = await import("node:tls");
    const netMod = await import("node:net");
    const { URL: NodeURL } = await import("node:url");
    const parsed = new NodeURL(proxyUrl);
    const proxyHost = parsed.hostname;
    const proxyPort = parseInt(parsed.port) || 8080;
    class ProxyHttpsAgent extends httpsMod.default.Agent {
      createConnection(options, callback) {
        const targetHost = options.host || options.hostname || "localhost";
        const targetPort = options.port || 443;
        const connectReq = httpMod.default.request({
          host: proxyHost,
          port: proxyPort,
          method: "CONNECT",
          path: `${targetHost}:${targetPort}`
        });
        connectReq.on("connect", (res, socket) => {
          if (res.statusCode !== 200) {
            socket.destroy();
            callback(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
            return;
          }
          const tlsSocket = tlsMod.default.connect({
            socket,
            servername: targetHost,
            ...options
          });
          callback(null, tlsSocket);
        });
        connectReq.on("error", (err) => callback(err));
        connectReq.setTimeout(1e4, () => {
          connectReq.destroy();
          callback(new Error("Proxy CONNECT timeout"));
        });
        connectReq.end();
      }
    }
    const agent = new ProxyHttpsAgent({ keepAlive: true, maxSockets: 10 });
    httpsMod.default.globalAgent = agent;
    log.info("proxy", `https.globalAgent set to CONNECT tunnel via ${proxyHost}:${proxyPort}`);
  } catch (e) {
    log.warn("proxy", `https.globalAgent setup failed: ${e}`);
  }
  try {
    const { URL: NodeURL } = await import("node:url");
    const httpMod = await import("node:http");
    const httpsMod = await import("node:https");
    const tlsMod = await import("node:tls");
    const parsed = new NodeURL(proxyUrl);
    const proxyHost = parsed.hostname;
    const proxyPort = parseInt(parsed.port) || 8080;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url || "";
      if (reqUrl.includes("127.0.0.1") || reqUrl.includes("localhost") || reqUrl.includes("::1")) {
        return originalFetch(input, init);
      }
      if (!reqUrl.startsWith("https://")) {
        return originalFetch(input, init);
      }
      try {
        const target = new NodeURL(reqUrl);
        const targetHost = target.hostname;
        const targetPort = parseInt(target.port) || 443;
        const socket = await new Promise((resolve, reject) => {
          const req = httpMod.default.request({ host: proxyHost, port: proxyPort, method: "CONNECT", path: `${targetHost}:${targetPort}` });
          req.on("connect", (res, sock) => {
            if (res.statusCode === 200) resolve(sock);
            else {
              sock.destroy();
              reject(new Error(`CONNECT ${res.statusCode}`));
            }
          });
          req.on("error", reject);
          req.setTimeout(1e4, () => {
            req.destroy();
            reject(new Error("CONNECT timeout"));
          });
          req.end();
        });
        return await new Promise((resolve, reject) => {
          const headers = {};
          if (init?.headers) {
            if (typeof init.headers?.forEach === "function") init.headers.forEach((v, k) => {
              headers[k] = v;
            });
            else Object.assign(headers, init.headers);
          }
          const req = httpsMod.default.request({
            hostname: targetHost,
            port: targetPort,
            path: target.pathname + target.search,
            method: init?.method || "GET",
            headers,
            createConnection: () => tlsMod.default.connect({ socket, servername: targetHost })
          }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const rh = new Headers();
              for (const [k, v] of Object.entries(res.headers)) {
                if (v) rh.set(k, Array.isArray(v) ? v.join(", ") : v);
              }
              resolve(new Response(Buffer.concat(chunks), { status: res.statusCode || 200, headers: rh }));
            });
          });
          req.on("error", reject);
          req.setTimeout(12e4, () => {
            req.destroy();
            reject(new Error("timeout"));
          });
          if (init?.body) req.write(init.body);
          req.end();
        });
      } catch (err) {
        log.error("proxy", `fetch tunnel failed: ${err}`);
        return originalFetch(input, init);
      }
    };
    log.info("proxy", "globalThis.fetch also patched with CONNECT tunnel");
  } catch (e) {
    log.warn("proxy", `fetch patch failed: ${e}`);
  }
}
async function createModelRuntime() {
  if (!piMod.ModelRuntime?.create) throw new Error("Pi ModelRuntime.create missing");
  return piMod.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json")
  });
}
async function injectAuthKeys() {
  if (!modelRuntime) return;
  const auth = await loadAuthFile();
  for (const [providerID, entry] of Object.entries(auth)) {
    const key = typeof entry?.key === "string" ? entry.key.trim() : "";
    if (!key || key.length > 512 || key.includes("\n")) continue;
    if (typeof modelRuntime.setRuntimeApiKey === "function") {
      try {
        await modelRuntime.setRuntimeApiKey(providerID, key);
      } catch (error) {
        console.warn("[pi-bridge] setRuntimeApiKey failed", providerID, error);
      }
    }
  }
}
async function reloadModelRuntime() {
  await syncPiModelsJson();
  modelRuntime = await createModelRuntime();
  await injectAuthKeys();
  if (typeof modelRuntime.reloadConfig === "function") {
    try {
      await modelRuntime.reloadConfig();
    } catch {
    }
  }
}
function modelCost(model) {
  const input = Number(model?.cost?.input ?? model?.pricing?.prompt ?? model?.costInput ?? NaN);
  const output = Number(model?.cost?.output ?? model?.pricing?.completion ?? model?.costOutput ?? NaN);
  if (Number.isFinite(input) || Number.isFinite(output)) {
    return {
      input: Number.isFinite(input) ? input : 0,
      output: Number.isFinite(output) ? output : 0
    };
  }
  const id2 = String(model?.id || model?.modelId || "");
  if (/:free$/i.test(id2) || /\bfree\b/i.test(String(model?.name || ""))) {
    return { input: 0, output: 0 };
  }
  return void 0;
}
function toModelInfo(providerID, model) {
  const modelID = String(model.id || model.modelId || "");
  const cost = modelCost(model);
  return {
    id: modelID,
    providerID,
    name: String(model.name || modelID),
    status: "active",
    tags: cost && cost.input === 0 ? ["free"] : [],
    limit: {
      context: model?.limit?.context ?? model?.context ?? 128e3,
      output: model?.limit?.output ?? model?.maxTokens ?? 8192
    },
    capabilities: model?.capabilities ?? { reasoning: true, input: {} },
    options: {},
    headers: {},
    release_date: model?.releaseDate || model?.release_date || "",
    ...cost ? { cost } : {}
  };
}
async function listProviders() {
  if (!modelRuntime) await initKernel();
  const config = await loadConfig();
  const auth = await loadAuthFile();
  log.info("provider", `listProviders: auth keys for [${Object.keys(auth).join(", ")}]`);
  const providers = [];
  let models = [];
  try {
    if (typeof modelRuntime.getModels === "function") models = [...modelRuntime.getModels()];
    if (models.length === 0 && typeof modelRuntime.getAvailable === "function") {
      models = [...await modelRuntime.getAvailable()];
    }
    if (models.length === 0 && typeof modelRuntime.getAvailableSnapshot === "function") {
      models = [...modelRuntime.getAvailableSnapshot()];
    }
  } catch (error) {
    console.warn("[pi-bridge] list models failed", error);
  }
  const providerSet = new Set(models.map((m) => m.provider || m.providerID || "unknown"));
  log.info("provider", `modelRuntime returned ${models.length} models from providers: [${[...providerSet].join(", ")}]`);
  const byProvider = /* @__PURE__ */ new Map();
  for (const model of models) {
    const provider = model.provider || model.providerID || "unknown";
    const list = byProvider.get(provider) ?? [];
    list.push(model);
    byProvider.set(provider, list);
  }
  if (byProvider.size === 0) {
    byProvider.set("openai", [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
    byProvider.set("anthropic", [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" }]);
    byProvider.set("google", [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" }]);
    byProvider.set("openrouter", [
      { id: "openrouter/auto", name: "OpenRouter Auto", provider: "openrouter" },
      { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B (free)", provider: "openrouter", cost: { input: 0, output: 0 } },
      { id: "google/gemma-3-27b-it:free", name: "Gemma 3 27B (free)", provider: "openrouter", cost: { input: 0, output: 0 } },
      { id: "qwen/qwen3-4b:free", name: "Qwen3 4B (free)", provider: "openrouter", cost: { input: 0, output: 0 } }
    ]);
  }
  if (byProvider.has("openrouter")) {
    const list = byProvider.get("openrouter");
    const freeSeeds = [
      { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B (free)", provider: "openrouter", cost: { input: 0, output: 0 } },
      { id: "google/gemma-3-27b-it:free", name: "Gemma 3 27B (free)", provider: "openrouter", cost: { input: 0, output: 0 } },
      { id: "qwen/qwen3-4b:free", name: "Qwen3 4B (free)", provider: "openrouter", cost: { input: 0, output: 0 } },
      { id: "mistralai/mistral-small-3.1-24b-instruct:free", name: "Mistral Small 3.1 (free)", provider: "openrouter", cost: { input: 0, output: 0 } }
    ];
    for (const seed of freeSeeds) {
      if (!list.some((m) => (m.id || m.modelId) === seed.id)) list.push(seed);
    }
  }
  const connected = /* @__PURE__ */ new Set();
  for (const [providerID, list] of byProvider) {
    if (config.disabled_providers?.includes(providerID)) continue;
    const modelsMap = {};
    for (const model of list) {
      const info = toModelInfo(providerID, model);
      if (!info.id) continue;
      modelsMap[info.id] = info;
    }
    const hasAuth = Boolean(auth[providerID]?.key) || typeof modelRuntime.hasConfiguredAuth === "function" && modelRuntime.hasConfiguredAuth(providerID) || Boolean(process.env[`${providerID.toUpperCase().replace(/-/g, "_")}_API_KEY`]) || Boolean(process.env[`${providerID.toUpperCase().replace(/-/g, "_")}_TOKEN`]);
    if (hasAuth) connected.add(providerID);
    providers.push({
      id: providerID,
      name: providerID,
      source: hasAuth ? "api" : "pi",
      env: [],
      options: {},
      models: modelsMap
    });
  }
  for (const [providerID, conf] of Object.entries(config.provider ?? {})) {
    if (config.disabled_providers?.includes(providerID)) continue;
    const modelsMap = {};
    for (const [modelID, meta] of Object.entries(conf.models ?? {})) {
      modelsMap[modelID] = {
        id: modelID,
        providerID,
        name: meta?.name || modelID,
        status: "active",
        tags: meta?.cost?.input === 0 ? ["free"] : [],
        limit: { context: 128e3, output: 8192 },
        capabilities: { reasoning: true, input: {} },
        options: {},
        headers: {},
        release_date: "",
        ...meta?.cost ? { cost: meta.cost } : {}
      };
    }
    const hasAuth = Boolean(auth[providerID]?.key) || Boolean(conf.options?.apiKey);
    if (hasAuth) connected.add(providerID);
    const existing = providers.find((p) => p.id === providerID);
    if (existing) {
      existing.models = { ...existing.models, ...modelsMap };
      existing.name = conf.name || existing.name;
      existing.source = hasAuth ? "custom" : existing.source;
    } else {
      providers.push({
        id: providerID,
        name: conf.name || providerID,
        source: "custom",
        env: conf.env ?? [],
        options: {},
        models: modelsMap
      });
    }
  }
  log.info("provider", `listProviders result: ${providers.length} providers, connected=[${[...connected].join(", ")}], models per provider: ${providers.map((p) => `${p.id}(${Object.keys(p.models).length})`).join(", ")}`);
  return {
    all: providers,
    connected: [...connected],
    default: Object.fromEntries(providers.map((p) => [p.id, Object.keys(p.models)[0]]).filter(([, m]) => m))
  };
}
async function setProviderAuth(providerID, key) {
  if (!modelRuntime) await initKernel();
  await saveAuthProvider(providerID, key);
  await enableProvider(providerID);
  await reloadModelRuntime();
}
async function updateBridgeConfig(patch) {
  const next = await mergeConfig(patch);
  for (const [providerID, conf] of Object.entries(next.provider ?? {})) {
    const key = conf?.options?.apiKey;
    if (typeof key === "string" && key.trim()) {
      await saveAuthProvider(providerID, key.trim());
    }
  }
  await reloadModelRuntime();
  return next;
}
async function createSession(input) {
  if (!piMod) await initKernel();
  const directory = path.resolve(input.directory || defaultDirectory());
  const sessionID = input.id || id("ses");
  const existing = sessions.get(sessionID);
  if (existing) {
    if (input.title) existing.title = input.title;
    if (input.model) existing.model = input.model;
    existing.time.updated = Date.now();
    return existing;
  }
  const now = Date.now();
  const projectID = projectIdForDirectory(directory);
  const sessionDir = path.join(agentDir, "sessions", projectID);
  const sessionManager = (typeof piMod.SessionManager?.create === "function" ? piMod.SessionManager.create(directory, sessionDir) : void 0) ?? (typeof piMod.SessionManager?.inMemory === "function" ? piMod.SessionManager.inMemory() : void 0);
  let model;
  if (input.model && typeof modelRuntime?.getModel === "function") {
    model = modelRuntime.getModel(input.model.providerID, input.model.modelID);
    if (!model) {
      await reloadModelRuntime();
      model = modelRuntime.getModel(input.model.providerID, input.model.modelID);
    }
  }
  if (typeof piMod.createAgentSession !== "function") {
    throw new Error("Pi createAgentSession export missing. Rebuild packages/coding-agent.");
  }
  const created = await piMod.createAgentSession({
    cwd: directory,
    agentDir,
    modelRuntime,
    model,
    sessionManager
  });
  const resolvedModel = (() => {
    if (input.model?.providerID && input.model?.modelID) return input.model;
    const m = created.session?.model || created.session?.agent?.state?.model;
    if (m?.provider && m?.id && m.provider !== "unknown") {
      return { providerID: String(m.provider), modelID: String(m.id) };
    }
    return void 0;
  })();
  const bridge = {
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
    agentDir
  };
  bridge.unsub = created.session.subscribe((event) => handlePiEvent(bridge, event));
  sessions.set(sessionID, bridge);
  emit(directory, "session.created", { info: publicSession(bridge) });
  emit(directory, "session.updated", { info: publicSession(bridge) });
  void persistSessionIndex();
  return bridge;
}
function publicSession(session) {
  return {
    id: session.id,
    slug: session.slug,
    projectID: session.projectID,
    directory: session.directory,
    title: session.title,
    version: session.version,
    parentID: void 0,
    agent: session.agent,
    model: session.model ? { id: session.model.modelID, providerID: session.model.providerID } : void 0,
    time: session.time,
    revert: session.revert
  };
}
async function ensureSession(sessionID, directory) {
  const existing = sessions.get(sessionID);
  if (existing) {
    if (!existing.pi && piMod) {
      try {
        const dir = path.resolve(existing.directory || directory || defaultDirectory());
        const projectID = existing.projectID || projectIdForDirectory(dir);
        const sessionDir = path.join(agentDir, "sessions", projectID);
        const sessionManager = (typeof piMod.SessionManager?.create === "function" ? piMod.SessionManager.create(dir, sessionDir) : void 0) ?? (typeof piMod.SessionManager?.inMemory === "function" ? piMod.SessionManager.inMemory() : void 0);
        let model;
        if (existing.model && typeof modelRuntime?.getModel === "function") {
          model = modelRuntime.getModel(existing.model.providerID, existing.model.modelID);
        }
        const created = await piMod.createAgentSession({
          cwd: dir,
          agentDir,
          modelRuntime,
          model,
          sessionManager
        });
        existing.pi = created.session;
        existing.unsub = created.session.subscribe((event) => handlePiEvent(existing, event));
        console.log(`[pi-bridge] re-attached Pi runtime to restored session ${sessionID}`);
      } catch (err) {
        console.warn(`[pi-bridge] failed to re-attach Pi runtime to session ${sessionID}:`, err);
      }
    }
    return existing;
  }
  return createSession({ id: sessionID, directory });
}
async function promptSession(sessionID, input) {
  log.info("prompt", `promptSession called: session=${sessionID}, model=${JSON.stringify(input.model)}, parts=${input.parts?.length ?? 0}`);
  const session = await ensureSession(sessionID, input.directory);
  log.info("prompt", `session resolved: id=${session.id}, status=${session.status}, hasPi=${Boolean(session.pi)}, model=${JSON.stringify(session.model)}`);
  const text = (input.parts ?? []).filter((part) => part.type === "text" || typeof part.text === "string").map((part) => String(part.text ?? "")).join("\n").trim();
  if (!text) throw new Error("Empty prompt");
  log.info("prompt", `text extracted (${text.length} chars): "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);
  if (session.status === "busy") {
    throw new Error("Session is already processing a message. Wait for it to finish or abort.");
  }
  const desiredModel = input.model || session.model;
  if (desiredModel) {
    log.info("prompt", `applying model: ${desiredModel.providerID}/${desiredModel.modelID}`);
    await applySessionModel(session, desiredModel);
    log.info("prompt", `model applied successfully`);
  }
  if (!session.model?.providerID || !session.model?.modelID) {
    log.error("prompt", "No model selected after applySessionModel");
    throw new Error("No model selected. Choose a provider/model first.");
  }
  if (!session.pi) {
    log.error("prompt", "Pi session not ready (session.pi is null)");
    throw new Error("Pi session not ready");
  }
  const userMessageID = input.messageID || id("msg");
  const userMessage = {
    info: {
      id: userMessageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: input.agent || session.agent || "build",
      model: session.model
    },
    parts: [{ id: id("part"), type: "text", text, sessionID, messageID: userMessageID }]
  };
  session.messages.push(userMessage);
  session.status = "busy";
  session.time.updated = Date.now();
  emit(session.directory, "message.updated", { info: userMessage.info, parts: userMessage.parts });
  emit(session.directory, "session.status", { sessionID, status: { type: "busy" } });
  emit(session.directory, "session.updated", { info: publicSession(session) });
  const assistantID = id("msg");
  const assistant = {
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
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    },
    parts: []
  };
  session.messages.push(assistant);
  emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts });
  let lastActivity = Date.now();
  let timedOut = false;
  const INACTIVITY_MS = 9e4;
  const activityTimer = setInterval(() => {
    if (Date.now() - lastActivity > INACTIVITY_MS && session.status === "busy") {
      timedOut = true;
      console.error(`[pi-bridge] prompt timed out (no activity for ${INACTIVITY_MS / 1e3}s), aborting session ${sessionID}`);
      void session.pi?.abort?.();
    }
  }, 5e3);
  session.unsub;
  const activityTracker = (event) => {
    lastActivity = Date.now();
  };
  const trackUnsub = session.pi?.subscribe?.(activityTracker);
  log.info("prompt", `calling session.pi.prompt() for session ${sessionID}`);
  void session.pi.prompt(text).catch((error) => {
    const errMsg = timedOut ? `Request timed out (no response for ${INACTIVITY_MS / 1e3}s). Check your API key and network connection.` : error instanceof Error ? error.message : String(error);
    log.error("prompt", `prompt FAILED for session ${sessionID}: ${errMsg}`, error);
    console.error(`[pi-bridge] prompt failed for session ${sessionID}:`, errMsg);
    assistant.info.error = errMsg;
    session.status = "idle";
    emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts });
    emit(session.directory, "session.status", { sessionID, status: { type: "idle" } });
    emit(session.directory, "session.error", {
      sessionID,
      error: { name: "PiError", message: errMsg }
    });
  }).finally(() => {
    clearInterval(activityTimer);
    trackUnsub?.();
    log.info("prompt", `prompt completed for session ${sessionID}, harvesting results`);
    harvestAssistantText(session, assistant);
    harvestAssistantThinking(session, assistant);
    session.status = "idle";
    session.time.updated = Date.now();
    assistant.info.time.completed = Date.now();
    emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts });
    emit(session.directory, "session.status", { sessionID, status: { type: "idle" } });
    emit(session.directory, "session.idle", { sessionID });
    emit(session.directory, "session.updated", { info: publicSession(session) });
    void persistSessionIndex();
    void persistSessionMessages(session);
  });
  return { messageID: userMessageID, assistantID };
}
async function revertSession(sessionID, messageID, directory) {
  const session = await ensureSession(sessionID, directory);
  const index = session.messages.findIndex((message) => message.info.id >= messageID);
  if (index >= 0) session.messages.splice(index);
  session.revert = { messageID };
  session.status = "idle";
  session.time.updated = Date.now();
  emit(session.directory, "session.updated", { info: publicSession(session) });
  emit(session.directory, "session.status", { sessionID, status: { type: "idle" } });
  void persistSessionIndex();
  void persistSessionMessages(session);
  return publicSession(session);
}
async function unrevertSession(sessionID, directory) {
  const session = await ensureSession(sessionID, directory);
  delete session.revert;
  session.time.updated = Date.now();
  emit(session.directory, "session.updated", { info: publicSession(session) });
  return publicSession(session);
}
function harvestAssistantText(session, assistant) {
  try {
    const msgs = session.pi?.agent?.state?.messages ?? [];
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;
    const text = extractText(lastAssistant);
    if (text) {
      let textPart = assistant.parts.find((p) => p.type === "text");
      if (!textPart) {
        textPart = {
          id: id("part"),
          type: "text",
          text: "",
          sessionID: session.id,
          messageID: assistant.info.id
        };
        assistant.parts.push(textPart);
      }
      if (text.length >= String(textPart.text || "").length) {
        textPart.text = text;
      }
      emit(session.directory, "message.part.updated", { part: { ...textPart } });
    }
    if (lastAssistant.errorMessage || lastAssistant.error) {
      assistant.info.error = lastAssistant.errorMessage || lastAssistant.error;
    }
  } catch {
  }
}
function harvestAssistantThinking(session, assistant) {
  try {
    const msgs = session.pi?.agent?.state?.messages ?? [];
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;
    const thinking = extractThinking(lastAssistant);
    if (thinking) {
      let reasoningPart = assistant.parts.find((p) => p.type === "reasoning");
      if (!reasoningPart) {
        reasoningPart = {
          id: id("part"),
          type: "reasoning",
          text: "",
          sessionID: session.id,
          messageID: assistant.info.id
        };
        assistant.parts.push(reasoningPart);
      }
      if (thinking.length >= String(reasoningPart.text || "").length) {
        reasoningPart.text = thinking;
      }
      emit(session.directory, "message.part.updated", { part: { ...reasoningPart } });
    }
  } catch {
  }
}
async function applySessionModel(session, model) {
  if (!modelRuntime) await initKernel();
  log.info("model", `applySessionModel: resolving ${model.providerID}/${model.modelID}`);
  let resolved = typeof modelRuntime.getModel === "function" ? modelRuntime.getModel(model.providerID, model.modelID) : void 0;
  if (!resolved) {
    log.warn("model", `model ${model.providerID}/${model.modelID} not found, reloading runtime...`);
    console.log(`[pi-bridge] model ${model.providerID}/${model.modelID} not found, reloading runtime...`);
    await reloadModelRuntime();
    resolved = typeof modelRuntime.getModel === "function" ? modelRuntime.getModel(model.providerID, model.modelID) : void 0;
  }
  if (!resolved) {
    log.error("model", `model NOT FOUND after reload: ${model.providerID}/${model.modelID}`);
    console.error(`[pi-bridge] model not found after reload: ${model.providerID}/${model.modelID}`);
    throw new Error(
      `Model not found: ${model.providerID}/${model.modelID}. Re-save the custom provider or pick another model.`
    );
  }
  log.info("model", `model resolved: ${JSON.stringify({ id: resolved.id, name: resolved.name, provider: resolved.provider, api: resolved.api, baseUrl: resolved.baseUrl, contextWindow: resolved.contextWindow, maxTokens: resolved.maxTokens })}`);
  if (session.pi && typeof session.pi.setModel === "function") {
    try {
      await session.pi.setModel(resolved);
      log.info("model", `setModel called on Pi session`);
    } catch (err) {
      log.error("model", `setModel failed: ${err}`);
      console.error(`[pi-bridge] setModel failed for ${model.providerID}/${model.modelID}:`, err);
      throw err;
    }
  }
  session.model = model;
}
async function abortSession(sessionID) {
  const session = sessions.get(sessionID);
  if (!session?.pi) return;
  await session.pi.abort();
  session.status = "idle";
  emit(session.directory, "session.status", { sessionID, status: { type: "idle" } });
  emit(session.directory, "session.idle", { sessionID });
}
function updateSession(sessionID, patch) {
  const session = sessions.get(sessionID);
  if (!session) return;
  if (patch.title) session.title = patch.title;
  session.time.updated = Date.now();
  emit(session.directory, "session.updated", { info: publicSession(session) });
  void persistSessionIndex();
  return session;
}
function deleteSession(sessionID) {
  const session = sessions.get(sessionID);
  if (!session) return;
  session.unsub?.();
  void session.pi?.abort?.();
  sessions.delete(sessionID);
  emit(session.directory, "session.deleted", { info: publicSession(session) });
  void persistSessionIndex();
  import("node:fs/promises").then((fs) => fs.unlink(sessionMessagesPath(sessionID)).catch(() => {
  })).catch(() => {
  });
}
function handlePiEvent(session, event) {
  const type = event?.type || event?.event || "";
  const ame = event?.assistantMessageEvent;
  const ameType = ame?.type || "";
  if (type === "error" || type === "stream_error" || ameType === "error" || !type && !ame) {
    log.error("pi-event", `FULL EVENT: ${JSON.stringify(event).slice(0, 1e3)}`);
  } else {
    log.debug("pi-event", `session=${session.id} type=${type}${ameType ? ` ame=${ameType}` : ""}`);
  }
  const assistant = [...session.messages].reverse().find((m) => m.info.role === "assistant" && !m.info.time.completed);
  if (!assistant) return;
  if (type === "error" || type === "stream_error" || ameType === "error") {
    const errMsg = event?.error || event?.message || event?.reason || ame?.error || "Unknown stream error";
    log.error("pi-event", `Stream error for session ${session.id}: ${typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg).slice(0, 500)}`);
    assistant.info.error = String(errMsg);
    assistant.parts.push({
      id: id("part"),
      type: "text",
      text: `⚠️ Pi stream error: ${typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg).slice(0, 300)}`,
      sessionID: session.id,
      messageID: assistant.info.id
    });
    emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts });
    return;
  }
  if (type === "message_start") {
    emit(session.directory, "message.updated", { info: assistant.info });
    return;
  }
  if (type === "message_update" && ame) {
    if (ameType === "thinking_start" || ameType === "thinking_delta" || ameType === "thinking_end") {
      let reasoningPart = assistant.parts.find((p) => p.type === "reasoning");
      if (!reasoningPart) {
        reasoningPart = {
          id: id("part"),
          type: "reasoning",
          text: "",
          sessionID: session.id,
          messageID: assistant.info.id
        };
        assistant.parts.push(reasoningPart);
        emit(session.directory, "message.part.updated", { part: { ...reasoningPart } });
      }
      if (ameType === "thinking_delta" && typeof ame.delta === "string" && ame.delta.length > 0) {
        reasoningPart.text = String(reasoningPart.text || "") + ame.delta;
        emit(session.directory, "message.part.updated", { part: { ...reasoningPart }, time: Date.now() });
        emit(session.directory, "message.part.delta", {
          sessionID: session.id,
          messageID: assistant.info.id,
          partID: reasoningPart.id,
          field: "text",
          delta: ame.delta
        });
      }
      if (ameType === "thinking_end" && typeof ame.content === "string" && ame.content.length > 0) {
        if (ame.content.length >= String(reasoningPart.text || "").length) {
          reasoningPart.text = ame.content;
        }
        emit(session.directory, "message.part.updated", { part: { ...reasoningPart } });
      }
      emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts });
      return;
    }
    if (ameType === "text_delta" || ameType === "text_start" || ameType === "text_end") {
      const delta = typeof ame.delta === "string" ? ame.delta : "";
      if (delta.length > 0) {
        let textPart = assistant.parts.find((p) => p.type === "text");
        if (!textPart) {
          textPart = {
            id: id("part"),
            type: "text",
            text: "",
            sessionID: session.id,
            messageID: assistant.info.id
          };
          assistant.parts.push(textPart);
        }
        textPart.text = String(textPart.text || "") + delta;
        emit(session.directory, "message.part.updated", { part: { ...textPart }, time: Date.now() });
        emit(session.directory, "message.part.delta", {
          sessionID: session.id,
          messageID: assistant.info.id,
          partID: textPart.id,
          field: "text",
          delta
        });
        emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts });
      }
      return;
    }
  }
  if (type === "message_delta" || type === "text_delta" || type === "message_update" && !ame) {
    const delta = event?.delta || event?.text || (typeof event?.message?.content === "string" ? event.message.content : void 0) || extractText(event?.message || event?.assistantMessage);
    if (typeof delta === "string" && delta.length > 0) {
      let textPart = assistant.parts.find((p) => p.type === "text");
      if (!textPart) {
        textPart = {
          id: id("part"),
          type: "text",
          text: "",
          sessionID: session.id,
          messageID: assistant.info.id
        };
        assistant.parts.push(textPart);
      }
      textPart.text = String(textPart.text || "") + delta;
      emit(session.directory, "message.part.updated", { part: { ...textPart }, time: Date.now() });
      emit(session.directory, "message.part.delta", {
        sessionID: session.id,
        messageID: assistant.info.id,
        partID: textPart.id,
        field: "text",
        delta
      });
      emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts });
    }
  }
  if (type === "message_end" || type === "turn_end" || type === "agent_end") {
    harvestAssistantText(session, assistant);
    harvestAssistantThinking(session, assistant);
    emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts });
    if (type === "agent_end") {
      const hasContent = assistant.parts.some((p) => p.type === "text" && p.text || p.type === "reasoning" && p.text || p.type === "tool");
      if (!hasContent) {
        const piError = session.pi?.agent?.state?.error;
        const lastMsg = [...session.pi?.agent?.state?.messages ?? []].reverse().find((m) => m.role === "assistant");
        log.error("prompt", `Empty response at agent_end:`, {
          piError,
          stopReason: lastMsg?.stopReason,
          errorMessage: lastMsg?.errorMessage,
          model: session.pi?.agent?.state?.model || session.pi?.model
        });
        const errorMsg = piError || lastMsg?.errorMessage || lastMsg?.error || "模型返回了空响应。请检查 API Key 是否有效、模型是否可用、网络是否正常。";
        assistant.info.error = String(errorMsg);
        assistant.parts.push({
          id: id("part"),
          type: "text",
          text: `⚠️ ${errorMsg}`,
          sessionID: session.id,
          messageID: assistant.info.id
        });
        emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts });
      }
    }
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
        title: String(event.toolName || event.name || "tool"),
        time: { start: Date.now() }
      },
      sessionID: session.id,
      messageID: assistant.info.id
    };
    assistant.parts.push(toolPart);
    emit(session.directory, "message.part.updated", { part: toolPart });
    emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts });
  }
  if (type === "tool_execution_end" || type === "tool_end" || type === "tool_execution_update") {
    const callID = event.toolCallId || event.id;
    const toolPart = [...assistant.parts].reverse().find((p) => p.type === "tool" && (!callID || p.callID === callID));
    if (toolPart) {
      const output = stringifyTool(event.result ?? event.output ?? event.partialResult ?? event.update);
      const isComplete = type === "tool_execution_end" || type === "tool_end";
      const isError = Boolean(event.isError || event.error);
      toolPart.state = {
        ...toolPart.state,
        // Match OpenCode's ToolState union exactly. The UI uses this shape to
        // display write/edit input (including source code) and command output.
        ...isComplete ? isError ? {
          status: "error",
          error: output || String(event.error || "Tool execution failed"),
          time: { start: toolPart.state?.time?.start || Date.now(), end: Date.now() }
        } : {
          status: "completed",
          output,
          title: String(event.toolName || event.name || toolPart.tool),
          metadata: {},
          time: { start: toolPart.state?.time?.start || Date.now(), end: Date.now() }
        } : {
          status: "running",
          title: String(event.toolName || event.name || toolPart.tool),
          metadata: output ? { partialOutput: output } : toolPart.state?.metadata,
          time: { start: toolPart.state?.time?.start || Date.now() }
        }
      };
      emit(session.directory, "message.part.updated", { part: toolPart });
      emit(session.directory, "message.updated", { info: assistant.info, parts: assistant.parts });
    }
  }
  if (type === "agent_start") {
    session.status = "busy";
    emit(session.directory, "session.status", { sessionID: session.id, status: { type: "busy" } });
  }
}
function extractText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter((c) => c?.type === "text").map((c) => c.text).join("");
  }
  return "";
}
function extractThinking(message) {
  if (!message) return "";
  if (Array.isArray(message.content)) {
    return message.content.filter((c) => c?.type === "thinking").map((c) => c.thinking || c.text || "").join("");
  }
  return "";
}
function stringifyTool(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
const sessionStore = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  abortSession,
  allSessions,
  createSession,
  defaultDirectory,
  deleteSession,
  ensureSession,
  getAgentDir,
  getSession,
  initKernel,
  listProviders,
  promptSession,
  publicSession,
  revertSession,
  setProviderAuth,
  unrevertSession,
  updateBridgeConfig,
  updateSession
}, Symbol.toStringTag, { value: "Module" }));
function normalizeBaseURL(baseURL) {
  return baseURL.trim().replace(/\/+$/, "");
}
function candidates(baseURL) {
  const base = normalizeBaseURL(baseURL);
  const list = [`${base}/models`];
  if (base.endsWith("/v1")) list.push(`${base.slice(0, -3)}/models`);
  else list.push(`${base}/v1/models`);
  return [...new Set(list)];
}
function parseModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const row of rows) {
    const id2 = String(row?.id || row?.name || "").trim();
    if (!id2 || seen.has(id2)) continue;
    seen.add(id2);
    out.push({
      id: id2,
      name: String(row?.name || row?.id || id2)
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
async function discoverOpenAIModels(input) {
  if (!input.baseURL?.trim()) throw new Error("baseURL is required");
  const headers = {
    accept: "application/json",
    ...input.headers ?? {}
  };
  if (input.apiKey?.trim()) headers.authorization = `Bearer ${input.apiKey.trim()}`;
  let lastError = "failed to fetch models";
  for (const url of candidates(input.baseURL)) {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        lastError = `${url} → ${response.status} ${response.statusText}`;
        continue;
      }
      const json2 = await response.json();
      const models = parseModels(json2);
      if (models.length === 0) {
        lastError = `${url} returned no models`;
        continue;
      }
      return { url, models };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
}
async function verifyProviderKey(input) {
  const { providerID, key } = input;
  const known = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
    google: "https://generativelanguage.googleapis.com/v1beta",
    openrouter: "https://openrouter.ai/api/v1",
    groq: "https://api.groq.com/openai/v1",
    xai: "https://api.x.ai/v1",
    deepseek: "https://api.deepseek.com/v1",
    moonshotai: "https://api.moonshot.cn/v1",
    kimi: "https://api.moonshot.cn/v1",
    mistral: "https://api.mistral.ai/v1",
    fireworks: "https://api.fireworks.ai/inference/v1",
    together: "https://api.together.xyz/v1",
    nvidia: "https://integrate.api.nvidia.com/v1",
    cerebras: "https://api.cerebras.ai/v1",
    github: "https://api.githubcopilot.com"
  };
  let baseURL = input.baseURL;
  if (!baseURL) {
    const config = await loadConfig();
    baseURL = config?.provider?.[providerID]?.options?.baseURL ?? known[providerID];
  }
  if (!baseURL) {
    return;
  }
  try {
    await discoverOpenAIModels({ baseURL, apiKey: key });
    return;
  } catch {
  }
  const probeURL = baseURL.replace(/\/$/, "") + "/chat/completions";
  const response = await fetch(probeURL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }], max_tokens: 1 })
  });
  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "");
    throw new Error(`API key rejected (${response.status}): ${body.slice(0, 200)}`);
  }
}
const adapters = /* @__PURE__ */ new Map();
const activeTurns = /* @__PURE__ */ new Map();
let running = false;
let startedAt = "";
class BotRuntime {
  async handleInbound(msg) {
    const config = await loadConfig();
    const conn = config.bot?.connections?.find((item) => item.id === msg.connectionID);
    const adapter = adapters.get(msg.connectionID);
    if (!conn || !adapter) return;
    if (!allowed(conn, config.bot?.allowAll === true, msg)) {
      await adapter.send(msg, "抱歉，您没有使用此 bot 的权限。请在 HoyaAgent 设置里加入白名单，或开启允许所有人。");
      return;
    }
    if (msg.text.trim() === "/status") {
      await adapter.send(msg, `HoyaAgent bot 已连接：${msg.connectionID}`);
      return;
    }
    if (msg.text.trim() === "/new") {
      await rememberSession(conn, msg, "");
      await adapter.send(msg, "已为本聊天创建新的 Hoya 会话。");
      return;
    }
    const key = `${msg.connectionID}\0${msg.chatID}`;
    const previous = activeTurns.get(key) ?? Promise.resolve();
    const next = previous.catch(() => void 0).then(() => runTurn(conn, adapter, msg));
    activeTurns.set(key, next.finally(() => activeTurns.get(key) === next && activeTurns.delete(key)));
  }
}
async function startBotRuntime() {
  await stopBotRuntime();
  const config = await loadConfig();
  if (!config.bot?.enabled) return botStatus();
  running = true;
  startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const runtime = new BotRuntime();
  for (const conn of config.bot.connections ?? []) {
    if (!conn.enabled) continue;
    const adapter = createAdapter(conn);
    if (!adapter) continue;
    adapters.set(conn.id, adapter);
    try {
      await adapter.start(runtime);
      adapter.status = "running";
    } catch (error) {
      adapter.status = "error";
      adapter.lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return botStatus();
}
async function stopBotRuntime() {
  await Promise.all([...adapters.values()].map((adapter) => adapter.stop().catch(() => void 0)));
  adapters.clear();
  running = false;
  startedAt = "";
  return botStatus();
}
function botStatus() {
  return {
    running,
    status: running ? "running" : "stopped",
    connections: [...adapters.values()].map((adapter) => ({
      id: adapter.id,
      provider: adapter.provider,
      domain: adapter.domain,
      status: adapter.status,
      lastError: adapter.lastError ?? ""
    })),
    startedAt
  };
}
async function saveBotConfig(patch) {
  const current = await loadConfig();
  const next = await mergeConfig({
    bot: {
      ...current.bot ?? {},
      ...patch,
      connections: patch.connections ?? current.bot?.connections ?? []
    }
  });
  await startBotRuntime();
  return next.bot;
}
async function botWebhook(provider, id2, body, runtime = new BotRuntime()) {
  const config = await loadConfig();
  const conn = config.bot?.connections?.find((item) => item.id === id2 || item.provider === provider);
  if (!conn || !conn.enabled) return { ok: false, status: 404, body: { error: "bot connection not found" } };
  if (conn.provider === "feishu" || conn.provider === "lark") return handleFeishuWebhook(conn, body, runtime);
  return { ok: false, status: 400, body: { error: "webhook provider unsupported" } };
}
function createAdapter(conn) {
  if (conn.provider === "qq") return newQQAdapter(conn);
  if (conn.provider === "weixin") return newWeixinAdapter(conn);
  if (conn.provider === "feishu" || conn.provider === "lark") return newFeishuAdapter(conn);
}
async function runTurn(conn, adapter, msg) {
  const sessionID = await sessionFor(conn, msg);
  const session = await createSession({
    id: sessionID || void 0,
    directory: conn.workspaceRoot || defaultDirectory(),
    title: `${labelFor(conn)} ${msg.userName || msg.userID || msg.chatID}`,
    model: conn.model
  });
  await rememberSession(conn, msg, session.id);
  const assistantID = (await promptSession(session.id, {
    directory: session.directory,
    model: conn.model,
    parts: [{ type: "text", text: msg.text }]
  })).assistantID;
  const text = await waitAssistantText(session.id, assistantID);
  await adapter.send(msg, text || "（没有收到模型回复）");
}
async function waitAssistantText(sessionID, assistantID) {
  for (let i = 0; i < 900; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1e3));
    const msg = getSession(sessionID)?.messages.find((item) => item.info.id === assistantID);
    if (msg?.info.error) return `出错了：${String(msg.info.error)}`;
    if (msg?.info.time.completed) return messageText(msg);
  }
  return "任务还在执行中，请稍后发送 /status 查看。";
}
function messageText(msg) {
  return msg.parts.map((part) => typeof part.text === "string" ? part.text : "").join("\n").trim();
}
async function sessionFor(conn, msg) {
  return conn.sessionMappings?.find((item) => item.remoteID === msg.chatID)?.sessionID ?? "";
}
async function rememberSession(conn, msg, sessionID) {
  const config = await loadConfig();
  const connections = (config.bot?.connections ?? []).map((item) => {
    if (item.id !== conn.id) return item;
    const existing = item.sessionMappings?.filter((mapping) => mapping.remoteID !== msg.chatID) ?? [];
    return {
      ...item,
      sessionMappings: sessionID ? [...existing, { remoteID: msg.chatID, sessionID, chatType: msg.chatType, userID: msg.userID, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }] : existing,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  });
  await mergeConfig({ bot: { ...config.bot ?? {}, connections } });
}
function allowed(conn, globalAllowAll, msg) {
  if (globalAllowAll || conn.allowAll) return true;
  const users = new Set(conn.allowUsers ?? []);
  const groups = new Set(conn.allowGroups ?? []);
  if (users.has(msg.userID)) return true;
  return msg.chatType !== "dm" && groups.has(msg.chatID);
}
function labelFor(conn) {
  return conn.label || conn.provider.toUpperCase();
}
function secret(conn) {
  return (conn.appSecret || (conn.appSecretEnv ? process.env[conn.appSecretEnv] : "") || "").trim();
}
function token(conn) {
  return (conn.token || (conn.tokenEnv ? process.env[conn.tokenEnv] : "") || "").trim();
}
function randomID(prefix) {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}
function newFeishuAdapter(conn) {
  return {
    id: conn.id,
    provider: conn.provider,
    domain: conn.provider === "lark" ? "lark" : "feishu",
    status: "configured",
    async start() {
      if (!conn.appID || !secret(conn)) throw new Error("飞书/Lark app_id 或 app_secret 未配置");
    },
    async stop() {
    },
    async send(msg, text) {
      const content = JSON.stringify(markdownCard(text));
      const base = conn.provider === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
      const tenantToken = await feishuTenantToken(base, conn);
      const res = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: { authorization: `Bearer ${tenantToken}`, "content-type": "application/json" },
        body: JSON.stringify({ receive_id: msg.chatID, msg_type: "interactive", content })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.code) throw new Error(`飞书发送失败：${data.msg || res.statusText}`);
      return { messageID: data.data?.message_id };
    }
  };
}
async function feishuTenantToken(base, conn) {
  const res = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: conn.appID, app_secret: secret(conn) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code) throw new Error(`获取飞书 token 失败：${data.msg || res.statusText}`);
  return data.tenant_access_token;
}
function markdownCard(text) {
  return { schema: "2.0", body: { elements: [{ tag: "markdown", content: text }] } };
}
async function handleFeishuWebhook(conn, body, runtime) {
  const payload = body;
  if (payload.type === "url_verification") {
    if (conn.verificationToken && payload.token !== conn.verificationToken) return { ok: false, status: 403, body: { error: "forbidden" } };
    return { ok: true, status: 200, body: { challenge: payload.challenge } };
  }
  if (conn.verificationToken && payload.header?.token && payload.header.token !== conn.verificationToken) return { ok: false, status: 403, body: { error: "forbidden" } };
  if (payload.header?.event_type !== "im.message.receive_v1") return { ok: true, status: 200, body: { ok: true } };
  const event = payload.event ?? {};
  const content = JSON.parse(event.message?.content || "{}");
  const text = String(content.text || "").trim();
  if (!text) return { ok: true, status: 200, body: { ok: true } };
  if ((event.message?.chat_type === "group" || event.message?.chat_type === "topic_group") && conn.requireMention !== false) {
    const mentions = event.message?.mentions ?? [];
    if (mentions.length === 0) return { ok: true, status: 200, body: { ok: true } };
  }
  void runtime.handleInbound({
    platform: conn.provider,
    connectionID: conn.id,
    chatType: event.message?.chat_type === "group" || event.message?.chat_type === "topic_group" ? "group" : "dm",
    chatID: event.message?.chat_id || "",
    userID: event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || "",
    text,
    messageID: event.message?.message_id
  });
  return { ok: true, status: 200, body: { ok: true } };
}
function newWeixinAdapter(conn) {
  let stopped = false;
  let syncBuf = "";
  const contextTokens = /* @__PURE__ */ new Map();
  const base = () => (conn.apiBase || "https://ilinkai.weixin.qq.com").replace(/\/$/, "");
  return {
    id: conn.id,
    provider: "weixin",
    domain: "weixin",
    status: "configured",
    async start(runtime) {
      if (!token(conn)) throw new Error("微信 token 未配置");
      stopped = false;
      void (async () => {
        while (!stopped) {
          try {
            const updates = await weixinUpdates(base(), token(conn), syncBuf);
            syncBuf = updates.get_updates_buf || syncBuf;
            for (const item of [...updates.updates ?? [], ...updates.msgs ?? []]) {
              const msg = normalizeWeixin(item, conn.accountID || "default");
              if (msg) void runtime.handleInbound({ ...msg, connectionID: conn.id });
            }
          } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
          }
          await new Promise((resolve) => setTimeout(resolve, 1e3));
        }
      })();
    },
    async stop() {
      stopped = true;
    },
    async send(msg, text) {
      const payload = {
        base_info: { channel_version: "2.2.0" },
        msg: {
          from_user_id: "",
          to_user_id: msg.chatID,
          client_id: randomID("hoya"),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }]
        }
      };
      if (contextTokens.has(msg.chatID)) payload.msg.context_token = contextTokens.get(msg.chatID);
      const data = await weixinPost(base(), "/ilink/bot/sendmessage", token(conn), payload);
      if (data.ret || data.errcode) throw new Error(`微信发送失败：${data.errmsg || data.errcode}`);
      return { messageID: String(data.message_id || "") };
    }
  };
}
async function weixinUpdates(base, tok, syncBuf) {
  return weixinPost(base, "/ilink/bot/getupdates", tok, { get_updates_buf: syncBuf, base_info: { channel_version: "2.2.0" } });
}
async function weixinPost(base, endpoint, tok, payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${base}${endpoint}`, { method: "POST", headers: weixinHeaders(tok, body), body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`微信 HTTP ${res.status}`);
  return data;
}
function weixinHeaders(tok, body) {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${tok}`,
    "Content-Length": String(Buffer.byteLength(body)),
    "X-WECHAT-UIN": randomBytes(4).readUInt32BE(0).toString(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(2 << 16 | 2 << 8)
  };
}
function normalizeWeixin(raw, accountID) {
  const message = raw.message ?? raw;
  const text = message.text || message.item_list?.map((item) => item.text_item?.text || "").join("\n");
  const userID = message.from?.user_id || message.from_user_id;
  if (!text || !userID || userID === accountID) return;
  const chatID = message.chat_id || message.room_id || message.chat_room_id || userID;
  return { platform: "weixin", chatType: message.chat_type === "group" || message.room_id ? "group" : "dm", chatID, userID, userName: message.from?.user_name || userID, text, messageID: String(message.message_id || "") };
}
function newQQAdapter(conn) {
  let ws;
  let accessToken = "";
  let tokenExpires = 0;
  let seq2 = 0;
  return {
    id: conn.id,
    provider: "qq",
    domain: "qq",
    status: "configured",
    async start(runtime) {
      if (!conn.appID || !secret(conn)) throw new Error("QQ app_id 或 app_secret 未配置");
      accessToken = await qqToken(conn);
      tokenExpires = Date.now() + 30 * 6e4;
      const gateway = await qqGateway(conn, accessToken);
      ws = new WebSocket(gateway, { headers: { Authorization: `QQBot ${accessToken}`, "X-Union-Appid": conn.appID } });
      ws.on("message", (data) => {
        const payload = JSON.parse(String(data));
        if (payload.s) seq2 = payload.s;
        if (payload.op === 10) {
          setInterval(() => ws?.send(JSON.stringify({ op: 1, d: seq2 || null })), Math.max(5e3, payload.d?.heartbeat_interval || 45e3));
          ws?.send(JSON.stringify({ op: 2, d: { token: `QQBot ${accessToken}`, intents: 1 << 0 | 1 << 1 | 1 << 9 | 1 << 10 | 1 << 12 | 1 << 25 | 1 << 26, shard: [0, 1], properties: { $os: "windows", $browser: "hoyaagent", $device: "hoyaagent" } } }));
          return;
        }
        const msg = normalizeQQ(payload, conn.id);
        if (msg) void runtime.handleInbound(msg);
      });
    },
    async stop() {
      ws?.close();
    },
    async send(msg, text) {
      if (!accessToken || Date.now() > tokenExpires) accessToken = await qqToken(conn);
      const chunks = splitBytes(text, 1500);
      let messageID = "";
      for (const chunk of chunks) {
        const data = await qqSend(conn, accessToken, msg, chunk);
        messageID = data.id || messageID;
      }
      return { messageID };
    }
  };
}
async function qqToken(conn) {
  const res = await fetch("https://bots.qq.com/app/getAppAccessToken", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: conn.appID, clientSecret: secret(conn) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`QQ token 获取失败：${data.message || res.statusText}`);
  return data.access_token;
}
async function qqGateway(conn, tok) {
  const base = conn.sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com";
  const res = await fetch(`${base}/gateway`, { headers: { Authorization: `QQBot ${tok}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error("QQ gateway 获取失败");
  return data.url;
}
function normalizeQQ(payload, connectionID) {
  if (payload.op !== 0 || !payload.d) return;
  const d = payload.d;
  const userID = d.author?.user_openid || d.author?.member_openid || d.author?.union_openid || d.author?.id || "";
  const base = { platform: "qq", connectionID, userID, userName: d.author?.username, text: d.content || "", messageID: d.id };
  if (payload.t === "C2C_MESSAGE_CREATE") return { ...base, chatType: "dm", chatID: userID };
  if (payload.t === "GROUP_AT_MESSAGE_CREATE") return { ...base, chatType: "group", chatID: d.group_openid };
  if (payload.t === "AT_MESSAGE_CREATE") return { ...base, chatType: "guild", chatID: d.channel_id };
  if (payload.t === "DIRECT_MESSAGE_CREATE") return { ...base, chatType: "direct", chatID: d.guild_id };
}
async function qqSend(conn, tok, msg, text) {
  const base = conn.sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com";
  const target = msg.chatType === "group" ? `/v2/groups/${encodeURIComponent(msg.chatID)}/messages` : msg.chatType === "guild" || msg.chatType === "thread" ? `/v2/channels/${encodeURIComponent(msg.chatID)}/messages` : msg.chatType === "direct" ? `/v2/dms/${encodeURIComponent(msg.chatID)}/messages` : `/v2/users/${encodeURIComponent(msg.chatID)}/messages`;
  const res = await fetch(`${base}${target}`, { method: "POST", headers: { authorization: `QQBot ${tok}`, "content-type": "application/json", "X-Union-Appid": conn.appID || "" }, body: JSON.stringify({ content: text, msg_type: 0, msg_id: msg.messageID }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`QQ 发送失败：${JSON.stringify(data).slice(0, 200)}`);
  return data;
}
function splitBytes(text, max) {
  const chunks = [];
  let rest = text || " ";
  while (Buffer.byteLength(rest) > max) {
    let cut = 0;
    for (const char of rest) {
      if (Buffer.byteLength(rest.slice(0, cut + char.length)) > max) break;
      cut += char.length;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  return chunks;
}
async function startWeixinInstall() {
  const data = await (await fetch("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3", { headers: { "iLink-App-Id": "bot", "iLink-App-ClientVersion": String(2 << 16 | 2 << 8) } })).json();
  const installID = randomID("wx");
  await promises.mkdir(path.join(homeDir(), "bot-installs"), { recursive: true });
  await promises.writeFile(path.join(homeDir(), "bot-installs", `${installID}.json`), JSON.stringify({ qrcode: data.qrcode, baseURL: "https://ilinkai.weixin.qq.com", expiresAt: Date.now() + 12e4 }, null, 2));
  return { ok: true, installID, url: data.qrcode_img_content || data.qrcode, deviceCode: data.qrcode, interval: 3, expireIn: 120 };
}
async function pollWeixinInstall(installID) {
  const file = path.join(homeDir(), "bot-installs", `${installID}.json`);
  const session = JSON.parse(await promises.readFile(file, "utf8"));
  const data = await (await fetch(`${session.baseURL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`, { headers: { "iLink-App-Id": "bot", "iLink-App-ClientVersion": String(2 << 16 | 2 << 8) } })).json();
  if (data.status !== "confirmed") return { done: false, status: data.status || "wait" };
  const config = await loadConfig();
  const conn = { id: "weixin-weixin", provider: "weixin", label: "微信", enabled: true, status: "connected", accountID: String(data.ilink_bot_id), token: String(data.bot_token), apiBase: String(data.baseurl || session.baseURL), allowUsers: [String(data.ilink_user_id)].filter(Boolean), createdAt: (/* @__PURE__ */ new Date()).toISOString(), updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  const connections = [...(config.bot?.connections ?? []).filter((item) => item.id !== conn.id), conn];
  await saveBotConfig({ enabled: true, connections });
  await promises.unlink(file).catch(() => void 0);
  return { done: true, status: "connected", connection: conn };
}
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*"
  });
  res.end(data);
}
function readBody(req) {
  return new Promise(async (resolve) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (chunks.length === 0) return resolve({});
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
    } catch {
      resolve({});
    }
  });
}
function decodeDirectory(value) {
  if (typeof value !== "string" || !value) return;
  let current = value;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}
function directoryOf(req, url, body) {
  return decodeDirectory(body?.location?.directory) || decodeDirectory(body?.directory) || decodeDirectory(url.searchParams.get("location[directory]")) || decodeDirectory(url.searchParams.get("directory")) || decodeDirectory(req.headers["x-opencode-directory"]) || defaultDirectory();
}
function checkAuth(req, username, password) {
  if (!password) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const [user, pass] = decoded.split(":");
    return user === username && pass === password;
  } catch {
    return false;
  }
}
function sseWrite(res, event) {
  res.write(`event: message
data: ${JSON.stringify(event)}

`);
}
async function listen(options) {
  const hostname = options.hostname || "127.0.0.1";
  const username = options.username || "opencode";
  const password = options.password || "";
  await initKernel();
  const server = http__default.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "*"
        });
        return res.end();
      }
      const host = req.headers.host || `${hostname}:${options.port}`;
      const url = new URL$1(req.url || "/", `http://${host}`);
      const pathname = url.pathname;
      if (pathname !== "/debug/logs" && pathname !== "/global/event" && pathname !== "/event" && pathname !== "/api/event") {
        log.debug("http", `${req.method} ${pathname}`);
      }
      const isHealth = pathname === "/api/health" || pathname === "/global/health";
      if (!isHealth && !checkAuth(req, username, password)) {
        return json(res, 401, { error: "unauthorized" });
      }
      if ((pathname === "/global/health" || pathname === "/api/health") && req.method === "GET") {
        return json(res, 200, { healthy: true, version: "1.18.4-pi", kernel: "pi" });
      }
      if ((pathname === "/global/event" || pathname === "/event" || pathname === "/api/event") && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "access-control-allow-origin": "*"
        });
        sseWrite(res, connectedEvent());
        const unsub = subscribe((event) => sseWrite(res, event));
        const heartbeat = setInterval(() => res.write(`: heartbeat

`), 15e3);
        req.on("close", () => {
          clearInterval(heartbeat);
          unsub();
        });
        return;
      }
      if (pathname === "/path" && req.method === "GET") {
        const directory = directoryOf(req, url);
        const home = process.env.HOYA_HOME || path.join(os.homedir(), ".hoya");
        return json(res, 200, {
          home,
          state: home,
          config: path.join(home, "hoya.jsonc"),
          worktree: directory,
          directory
        });
      }
      if (pathname === "/project" && req.method === "GET") {
        const directory = directoryOf(req, url);
        const now = Date.now();
        return json(res, 200, [
          {
            id: Buffer.from(directory).toString("hex").slice(0, 32),
            worktree: directory,
            name: path.basename(directory) || directory,
            time: { created: now, updated: now }
          }
        ]);
      }
      if (pathname === "/project/current" && req.method === "GET") {
        const directory = directoryOf(req, url);
        const now = Date.now();
        return json(res, 200, {
          id: Buffer.from(directory).toString("hex").slice(0, 32),
          worktree: directory,
          name: path.basename(directory) || directory,
          time: { created: now, updated: now }
        });
      }
      if ((pathname === "/config" || pathname === "/global/config") && req.method === "GET") {
        const config = await loadConfig(true);
        return json(res, 200, {
          $schema: "https://hoyaagent.local/config.json",
          username: "hoya",
          kernel: "pi",
          ...config
        });
      }
      if ((pathname === "/config" || pathname === "/global/config" || pathname === "/global/config/update") && (req.method === "POST" || req.method === "PATCH")) {
        const body = await readBody(req);
        const patch = body?.config && typeof body.config === "object" ? body.config : body;
        const next = await updateBridgeConfig(patch ?? {});
        const { emit: emitEvent } = await Promise.resolve().then(() => events);
        emitEvent("", "global.disposed", {});
        emitEvent(defaultDirectory(), "global.disposed", {});
        return json(res, 200, next);
      }
      if (pathname === "/bot/status" && req.method === "GET") return json(res, 200, botStatus());
      if (pathname === "/bot/config" && req.method === "GET") return json(res, 200, (await loadConfig(true)).bot ?? {});
      if (pathname === "/bot/config" && (req.method === "POST" || req.method === "PATCH")) {
        return json(res, 200, await saveBotConfig(await readBody(req)));
      }
      if (pathname === "/bot/start" && req.method === "POST") return json(res, 200, await startBotRuntime());
      if (pathname === "/bot/stop" && req.method === "POST") return json(res, 200, await stopBotRuntime());
      if (pathname === "/bot/weixin/install" && req.method === "POST") return json(res, 200, await startWeixinInstall());
      if (pathname.startsWith("/bot/weixin/install/") && req.method === "GET") {
        return json(res, 200, await pollWeixinInstall(decodeURIComponent(pathname.slice("/bot/weixin/install/".length))));
      }
      if (pathname.startsWith("/bot/webhook/") && req.method === "POST") {
        const [, , , provider, id2 = provider] = pathname.split("/");
        const result = await botWebhook(provider, decodeURIComponent(id2), await readBody(req));
        return json(res, result.status, result.body);
      }
      if (pathname === "/provider/discover" && req.method === "POST") {
        const body = await readBody(req);
        try {
          const result = await discoverOpenAIModels({
            baseURL: body.baseURL || body.baseUrl || body.url,
            apiKey: body.apiKey || body.key,
            headers: body.headers
          });
          return json(res, 200, result);
        } catch (error) {
          return json(res, 400, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      if (pathname === "/provider/verify" && req.method === "POST") {
        const body = await readBody(req);
        try {
          await verifyProviderKey({
            providerID: body.providerID ?? body.provider ?? "",
            key: body.key ?? body.apiKey ?? "",
            baseURL: body.baseURL
          });
          return json(res, 200, { success: true });
        } catch (error) {
          return json(res, 400, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      if ((pathname === "/agent" || pathname === "/app/agents") && req.method === "GET") {
        return json(res, 200, [
          { name: "build", mode: "primary", description: "Pi coding agent", permission: [], options: {} }
        ]);
      }
      if (pathname === "/provider" && req.method === "GET") {
        return json(res, 200, await listProviders());
      }
      if (pathname === "/provider/auth" && req.method === "GET") {
        const providers = await listProviders();
        const auth = {};
        for (const provider of providers.all) {
          auth[provider.id] = [{ type: "api", label: "API key" }];
        }
        return json(res, 200, auth);
      }
      if (pathname.startsWith("/auth/") && req.method === "PUT") {
        const providerID = decodeURIComponent(pathname.slice("/auth/".length));
        const body = await readBody(req);
        const key = body?.auth?.key || body?.key || body?.apiKey;
        if (!key) return json(res, 400, { error: "missing api key" });
        await setProviderAuth(providerID, key);
        const { emit: emitEvent } = await Promise.resolve().then(() => events);
        emitEvent("", "global.disposed", {});
        emitEvent(defaultDirectory(), "global.disposed", {});
        return json(res, 200, { success: true });
      }
      if (pathname.startsWith("/auth/") && req.method === "DELETE") {
        const providerID = decodeURIComponent(pathname.slice("/auth/".length));
        const { removeAuthProvider: removeAuthProvider2 } = await Promise.resolve().then(() => configStore);
        await removeAuthProvider2(providerID);
        return json(res, 200, true);
      }
      if (pathname === "/session/status" && req.method === "GET") {
        const directory = directoryOf(req, url);
        const status = {};
        for (const session of allSessions().filter((s) => s.directory === directory || !directory)) {
          status[session.id] = { type: session.status === "busy" ? "busy" : "idle" };
        }
        return json(res, 200, status);
      }
      if (pathname === "/session" && req.method === "GET") {
        const list = allSessions().map(publicSession);
        return json(res, 200, list);
      }
      if (pathname === "/session" && req.method === "POST") {
        const body = await readBody(req);
        const directory = directoryOf(req, url, body);
        const session = await createSession({
          directory,
          title: body.title,
          parentID: body.parentID,
          id: body.id,
          model: body.model
        });
        return json(res, 200, publicSession(session));
      }
      const sessionMatch = pathname.match(/^\/session\/([^/]+)(.*)$/);
      if (sessionMatch) {
        const sessionID = decodeURIComponent(sessionMatch[1]);
        const rest = sessionMatch[2] || "";
        const directory = directoryOf(req, url);
        if (rest === "" && req.method === "GET") {
          const session = await ensureSession(sessionID, directory);
          return json(res, 200, publicSession(session));
        }
        if (rest === "" && req.method === "PATCH") {
          const body = await readBody(req);
          await ensureSession(sessionID, directory);
          const session = updateSession(sessionID, body);
          if (!session) return json(res, 404, { error: "session not found" });
          return json(res, 200, publicSession(session));
        }
        if (rest === "" && req.method === "DELETE") {
          deleteSession(sessionID);
          return json(res, 200, true);
        }
        if (rest === "/message" && req.method === "GET") {
          const session = await ensureSession(sessionID, directory);
          return json(res, 200, session.messages);
        }
        if ((rest === "/message" || rest === "/prompt_async") && req.method === "POST") {
          const body = await readBody(req);
          const promptDirectory = directoryOf(req, url, body);
          const result = await promptSession(sessionID, {
            messageID: body.messageID,
            parts: body.parts,
            agent: body.agent,
            model: body.model,
            directory: promptDirectory
          });
          if (rest === "/prompt_async") return json(res, 200, true);
          return json(res, 200, result);
        }
        if (rest === "/revert" && req.method === "POST") {
          const body = await readBody(req);
          if (!body.messageID) return json(res, 400, { error: "missing messageID" });
          return json(res, 200, await revertSession(sessionID, String(body.messageID), directoryOf(req, url, body)));
        }
        if (rest === "/unrevert" && req.method === "POST") {
          return json(res, 200, await unrevertSession(sessionID, directory));
        }
        if (rest === "/abort" && req.method === "POST") {
          if (getSession(sessionID)) await abortSession(sessionID);
          return json(res, 200, true);
        }
        if (rest === "/todo" && req.method === "GET") return json(res, 200, []);
        if (rest === "/diff" && req.method === "GET") return json(res, 200, []);
        if (rest === "/status" && req.method === "GET") {
          const session = getSession(sessionID);
          return json(res, 200, { type: session?.status === "busy" ? "busy" : "idle" });
        }
      }
      if (pathname === "/api/session" && req.method === "GET") {
        const list = allSessions().map(publicSession);
        return json(res, 200, { data: list, cursor: {} });
      }
      if (pathname === "/api/session" && req.method === "POST") {
        const body = await readBody(req);
        const directory = directoryOf(req, url, body);
        const model = body.model?.modelID ? body.model : body.model?.id ? { providerID: body.model.providerID, modelID: body.model.id } : void 0;
        const session = await createSession({ directory, id: body.id, model });
        return json(res, 200, { data: publicSession(session) });
      }
      if (pathname === "/api/session/active" && req.method === "GET") {
        return json(
          res,
          200,
          Object.fromEntries(allSessions().filter((s) => s.status !== "idle").map((s) => [s.id, { type: "running" }]))
        );
      }
      const apiSessionMatch = pathname.match(/^\/api\/session\/([^/]+)(.*)$/);
      if (apiSessionMatch) {
        const sessionID = decodeURIComponent(apiSessionMatch[1]);
        const rest = apiSessionMatch[2] || "";
        const directory = directoryOf(req, url);
        if (rest === "" && req.method === "GET") {
          const session = await ensureSession(sessionID, directory);
          return json(res, 200, { data: publicSession(session) });
        }
        if (rest === "/abort" && req.method === "POST") {
          if (getSession(sessionID)) await abortSession(sessionID);
          return json(res, 200, true);
        }
        if (rest === "/revert/stage" && req.method === "POST") {
          const body = await readBody(req);
          if (!body.messageID) return json(res, 400, { error: "missing messageID" });
          return json(res, 200, { data: await revertSession(sessionID, String(body.messageID), directoryOf(req, url, body)) });
        }
        if (rest === "/revert/clear" && req.method === "POST") {
          return json(res, 200, { data: await unrevertSession(sessionID, directory) });
        }
        if (rest === "/revert/commit" && req.method === "POST") {
          const session = await ensureSession(sessionID, directory);
          return json(res, 200, { data: publicSession(session) });
        }
      }
      if (pathname === "/api/provider" && req.method === "GET") {
        return json(res, 200, await listProviders());
      }
      if (pathname === "/api/agent" && req.method === "GET") {
        return json(res, 200, { data: [{ name: "build", mode: "primary", description: "Pi coding agent", permission: [], options: {} }] });
      }
      if (pathname === "/global/dispose" && req.method === "POST") {
        await initKernel();
        const { emit: emit2 } = await Promise.resolve().then(() => events);
        emit2("", "global.disposed", {});
        emit2(defaultDirectory(), "global.disposed", {});
        return json(res, 200, true);
      }
      if (pathname === "/permission" && req.method === "GET") return json(res, 200, []);
      if (pathname === "/question" && req.method === "GET") return json(res, 200, []);
      if (pathname === "/vcs" && req.method === "GET") return json(res, 200, { branch: null });
      if (pathname === "/command" && req.method === "GET") return json(res, 200, []);
      if (pathname === "/mcp" && req.method === "GET") return json(res, 200, { status: {} });
      if (pathname === "/experimental/capabilities" && req.method === "GET") {
        return json(res, 200, { features: [], server: { version: "1.18.4-pi", kernel: "pi" } });
      }
      if (pathname === "/experimental/resource" && req.method === "GET") return json(res, 200, []);
      if (pathname === "/experimental/tool" && req.method === "GET") return json(res, 200, []);
      if (pathname === "/experimental/tool/ids" && req.method === "GET") return json(res, 200, []);
      if (pathname === "/experimental/session" && req.method === "GET") {
        const list = allSessions().map(publicSession);
        return json(res, 200, list);
      }
      if (pathname.startsWith("/experimental/session/") && req.method === "GET") return json(res, 200, {});
      if (pathname === "/experimental/workspace" && req.method === "GET") return json(res, 200, []);
      if (pathname === "/experimental/workspace/adapter" && req.method === "GET") return json(res, 200, {});
      if (pathname === "/experimental/workspace/sync-list" && req.method === "GET") return json(res, 200, []);
      if (pathname === "/experimental/workspace/status" && req.method === "GET") return json(res, 200, {});
      if (pathname.startsWith("/experimental/workspace/") && req.method === "GET") return json(res, 200, {});
      if (pathname.startsWith("/experimental/project/") && req.method === "GET") return json(res, 200, {});
      if (pathname === "/experimental/console" && req.method === "GET") return json(res, 200, {});
      if (pathname.startsWith("/experimental/console/") && req.method === "GET") return json(res, 200, {});
      if (pathname === "/experimental/control-plane/move-session" && req.method === "POST") return json(res, 200, {});
      if (pathname === "/experimental/worktree" && req.method === "GET") return json(res, 200, []);
      if (pathname.startsWith("/experimental/worktree/") && req.method === "GET") return json(res, 200, {});
      if (pathname.startsWith("/experimental/")) return json(res, 200, {});
      if (pathname === "/policies" && req.method === "GET") return json(res, 200, []);
      if (pathname === "/debug/logs" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit")) || 200;
        return json(res, 200, { logs: getLogs(limit) });
      }
      if (pathname === "/debug/logs" && req.method === "DELETE") {
        clearLogs();
        return json(res, 200, { cleared: true });
      }
      if (pathname === "/debug/status" && req.method === "GET") {
        const { allSessions: allSess, getSession: getSess } = await Promise.resolve().then(() => sessionStore);
        const sessions2 = allSess();
        return json(res, 200, {
          kernel: "pi",
          version: "1.18.4-pi",
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          sessions: sessions2.map((s) => ({
            id: s.id,
            title: s.title,
            status: s.status,
            model: s.model,
            hasPi: Boolean(s.pi),
            messageCount: s.messages.length
          })),
          bot: botStatus()
        });
      }
      if (pathname === "/debug/sessions" && req.method === "DELETE") {
        const { allSessions: allSess, deleteSession: delSession } = await Promise.resolve().then(() => sessionStore);
        const ids = allSess().map((s) => s.id);
        for (const sid of ids) delSession(sid);
        log.info("debug", `Deleted all ${ids.length} sessions`);
        return json(res, 200, { deleted: ids.length });
      }
      if (pathname.startsWith("/debug/sessions/") && req.method === "DELETE") {
        const sid = decodeURIComponent(pathname.slice("/debug/sessions/".length));
        const { deleteSession: delSession } = await Promise.resolve().then(() => sessionStore);
        delSession(sid);
        log.info("debug", `Deleted session ${sid}`);
        return json(res, 200, { deleted: sid });
      }
      if (pathname === "/debug/test-api" && req.method === "POST") {
        const body = await readBody(req);
        const providerID = body.providerID || "nvida";
        const modelID = body.modelID || "z-ai/glm-5.2";
        try {
          const { loadAuthFile: loadAuthFile2 } = await Promise.resolve().then(() => configStore);
          const auth = await loadAuthFile2();
          const fs = await import("node:fs/promises");
          const nodePath = await import("node:path");
          const home = process.env.HOYA_HOME || nodePath.join(os.homedir(), ".hoya");
          const modelsJsonRaw = await fs.readFile(nodePath.join(home, "pi-agent", "models.json"), "utf8").catch(() => "{}");
          const modelsJson = JSON.parse(modelsJsonRaw);
          const providerConf = modelsJson?.providers?.[providerID];
          const apiKey = auth[providerID]?.key || providerConf?.apiKey || "";
          const baseUrl = providerConf?.baseUrl || "";
          log.info("debug", `test-api: provider=${providerID}, model=${modelID}, baseUrl=${baseUrl}, keyLen=${apiKey.length}`);
          if (!baseUrl) return json(res, 400, { error: `No baseUrl found for provider ${providerID}` });
          if (!apiKey) return json(res, 400, { error: `No API key found for provider ${providerID}` });
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15e3);
          const fetchStart = Date.now();
          const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: modelID, messages: [{ role: "user", content: "Say hi" }], max_tokens: 10, stream: false }),
            signal: controller.signal
          });
          clearTimeout(timeout);
          const elapsed = Date.now() - fetchStart;
          const responseBody = await response.text();
          log.info("debug", `test-api: status=${response.status}, elapsed=${elapsed}ms, body=${responseBody.slice(0, 500)}`);
          return json(res, 200, { status: response.status, elapsed, baseUrl, model: modelID, keyPreview: `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`, body: responseBody.slice(0, 1e3) });
        } catch (error) {
          log.error("debug", `test-api failed: ${error}`);
          return json(res, 200, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      return json(res, 404, { error: "not found", path: pathname });
    } catch (error) {
      log.error("http", `500 on ${req.method} ${req.url}: ${error instanceof Error ? error.message : String(error)}`);
      console.error("[pi-bridge]", error);
      return json(res, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, hostname, () => resolve());
  });
  console.log(`[pi-bridge] listening on http://${hostname}:${options.port} (kernel=pi)`);
  await startBotRuntime();
  return {
    url: `http://${hostname}:${options.port}`,
    server,
    async stop(close = true) {
      await stopBotRuntime();
      if (!close) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}
const Server = { listen };
export {
  Server,
  listen
};
