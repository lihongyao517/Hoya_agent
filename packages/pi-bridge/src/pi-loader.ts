import path from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

const candidates = () => {
  const env = process.env.HOYA_PI_ROOT || process.env.PI_ROOT
  const list = [
    env,
    path.resolve(process.cwd(), "../../pi"),
    path.resolve(process.cwd(), "../../../pi"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../pi"),
    "D:/程序/hoyaagent/pi",
    "D:\\程序\\hoyaagent\\pi",
  ].filter((value): value is string => Boolean(value))
  return [...new Set(list.map((value) => path.resolve(value)))]
}

export function resolvePiRoot() {
  for (const root of candidates()) {
    const entry = path.join(root, "packages/coding-agent/dist/index.js")
    if (existsSync(entry)) return root
  }
  throw new Error(
    "Pi coding-agent dist not found. Build Pi first:\n" +
      "  cd D:\\程序\\hoyaagent\\pi\n" +
      "  npm install --ignore-scripts\n" +
      "  npm run hydrate:model-data\n" +
      "  npm run build:offline\n" +
      "Or set HOYA_PI_ROOT to the pi monorepo path.",
  )
}

export async function loadPiCodingAgent() {
  const root = resolvePiRoot()
  const entry = path.join(root, "packages/coding-agent/dist/index.js")
  const mod = await import(pathToFileURL(entry).href)
  return { root, mod }
}
