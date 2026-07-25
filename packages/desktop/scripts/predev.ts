import { $ } from "bun"
import { existsSync } from "node:fs"
import path from "node:path"

if (!process.env.OPENCODE_CHANNEL) process.env.OPENCODE_CHANNEL = "dev"
if (!process.env.OPENCODE_VERSION) {
  const pkg = await Bun.file("./package.json").json()
  process.env.OPENCODE_VERSION = pkg.version || "0.0.0"
}
if (!process.env.HOYA_KERNEL) process.env.HOYA_KERNEL = "pi"
if (!process.env.HOYA_PI_ROOT) process.env.HOYA_PI_ROOT = "D:/程序/hoyaagent/pi"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL}`

const piEntry = path.join(process.env.HOYA_PI_ROOT, "packages/coding-agent/dist/index.js")
if (!existsSync(piEntry)) {
  console.warn(
    `[predev] Pi kernel missing at ${piEntry}. Run:\n` +
      `  cd ${process.env.HOYA_PI_ROOT}\n` +
      `  npm install --ignore-scripts\n` +
      `  npm run hydrate:model-data\n` +
      `  npm run build:offline`,
  )
}

// OpenCode node build only when explicitly requested as fallback kernel.
const buildNode = path.resolve("../opencode/script/build-node.ts")
if (process.env.HOYA_KERNEL === "opencode" && existsSync(buildNode)) {
  await $`cd ../opencode && bun script/build-node.ts`
}
