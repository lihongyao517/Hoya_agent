import { $ } from "bun"
import { existsSync } from "node:fs"
import path from "node:path"

if (!process.env.OPENCODE_CHANNEL) process.env.OPENCODE_CHANNEL = "dev"
if (!process.env.OPENCODE_VERSION) {
  const pkg = await Bun.file("./package.json").json()
  process.env.OPENCODE_VERSION = pkg.version || "0.0.0"
}

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL}`

const buildNode = path.resolve("../opencode/script/build-node.ts")
if (!existsSync(buildNode)) {
  throw new Error(
    `Missing ${buildNode}. Desktop dev requires packages/opencode/script/build-node.ts. Pull the latest main branch.`,
  )
}

await $`cd ../opencode && bun script/build-node.ts`
