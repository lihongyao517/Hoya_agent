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

// Ensure Pi kernel is built when HOYA_KERNEL=pi (default).
const piRoot = process.env.HOYA_PI_ROOT || path.resolve("../../../pi")
const piEntry = path.join(piRoot, "packages/coding-agent/dist/index.js")
if (!existsSync(piEntry)) {
  console.log(`[prebuild] Pi dist missing at ${piEntry}, attempting offline build...`)
  if (existsSync(path.join(piRoot, "package.json"))) {
    await $`npm --prefix ${piRoot} run build:offline`.nothrow()
  }
}
if (!existsSync(piEntry)) {
  console.warn(
    `[prebuild] Pi kernel not found. Build it manually:\n` +
      `  cd ${piRoot}\n` +
      `  npm install --ignore-scripts\n` +
      `  npm run hydrate:model-data\n` +
      `  npm run build:offline`,
  )
}

// Keep OpenCode node build as optional fallback for non-pi kernels.
const buildNode = path.resolve("../opencode/script/build-node.ts")
if (process.env.HOYA_KERNEL === "opencode" && existsSync(buildNode)) {
  await $`cd ../opencode && bun script/build-node.ts`
}
