export type DiscoveredModel = {
  id: string
  name: string
}

function normalizeBaseURL(baseURL: string) {
  return baseURL.trim().replace(/\/+$/, "")
}

function candidates(baseURL: string) {
  const base = normalizeBaseURL(baseURL)
  const list = [`${base}/models`]
  if (base.endsWith("/v1")) list.push(`${base.slice(0, -3)}/models`)
  else list.push(`${base}/v1/models`)
  return [...new Set(list)]
}

function parseModels(payload: any): DiscoveredModel[] {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  const out: DiscoveredModel[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const id = String(row?.id || row?.name || "").trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: String(row?.name || row?.id || id),
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export async function discoverOpenAIModels(input: {
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
}) {
  if (!input.baseURL?.trim()) throw new Error("baseURL is required")
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(input.headers ?? {}),
  }
  if (input.apiKey?.trim()) headers.authorization = `Bearer ${input.apiKey.trim()}`

  let lastError = "failed to fetch models"
  for (const url of candidates(input.baseURL)) {
    try {
      const response = await fetch(url, { headers })
      if (!response.ok) {
        lastError = `${url} → ${response.status} ${response.statusText}`
        continue
      }
      const json = await response.json()
      const models = parseModels(json)
      if (models.length === 0) {
        lastError = `${url} returned no models`
        continue
      }
      return { url, models }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(lastError)
}
