import { discoverOpenAIModels } from "./discover-models"
import { loadConfig } from "./config-store"

export async function verifyProviderKey(input: {
  providerID: string
  key: string
  baseURL?: string
}): Promise<void> {
  const { providerID, key } = input
  // For known built-in providers, try a basic models list.
  const known: Record<string, string> = {
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
    github: "https://api.githubcopilot.com",
  }

  let baseURL = input.baseURL
  if (!baseURL) {
    // Try from config
    const config = await loadConfig()
    baseURL = config?.provider?.[providerID]?.options?.baseURL ?? known[providerID]
  }

  if (!baseURL) {
    // Can't verify without a known URL; skip gracefully.
    return
  }

  // Quick check: try /models endpoint (OpenAI compat protocol).
  try {
    await discoverOpenAIModels({ baseURL, apiKey: key })
    return
  } catch {
    // Models list failed; this isn't necessarily fatal — invalid key and some
    // providers return 401, others 403 or just don't expose /models.
  }

  // Fallback: try a simple API call (chat completions health probe).
  const probeURL = baseURL.replace(/\/$/, "") + "/chat/completions"
  const response = await fetch(probeURL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
  })
  // 401/403 = definitely bad key. 400/404 = endpoint exists but model unknown = key OK.
  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "")
    throw new Error(`API key rejected (${response.status}): ${body.slice(0, 200)}`)
  }
  // Anything else: probe may have reached a valid API; treat as OK.
}
