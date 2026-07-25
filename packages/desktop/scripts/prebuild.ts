#!/usr/bin/env bun
import { $ } from "bun"
import { existsSync } from "node:fs"
import path from "node:path"

import { resolveChannel } from "./utils"

// Ensure packaging works from a clean clone without guessing git channel/version.
if (!process.env.OPENCODE_CHANNEL) process.env.OPENCODE_CHANNEL = "prod"
if (!process.env.OPENCODE_VERSION) {
  const pkg = await Bun.file("./package.json").json()
  process.env.OPENCODE_VERSION = pkg.version || "0.0.0"
}

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

const buildNode = path.resolve("../opencode/script/build-node.ts")
if (!existsSync(buildNode)) {
  throw new Error(
    `Missing ${buildNode}. Desktop packaging requires packages/opencode/script/build-node.ts. Pull the latest main branch.`,
  )
}

await $`cd ../opencode && bun script/build-node.ts`
