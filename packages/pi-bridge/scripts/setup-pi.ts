#!/usr/bin/env bun
import { $ } from "bun"
import { existsSync } from "node:fs"
import path from "node:path"

const root = process.env.HOYA_PI_ROOT || path.resolve(import.meta.dir, "../../../../pi")
const entry = path.join(root, "packages/coding-agent/dist/index.js")

console.log(`[setup:pi] root=${root}`)
if (!existsSync(path.join(root, "package.json"))) {
  console.error(`[setup:pi] Pi monorepo not found at ${root}`)
  console.error(`Set HOYA_PI_ROOT or place pi next to Hoya_agent.`)
  process.exit(1)
}

if (existsSync(entry)) {
  console.log(`[setup:pi] already built: ${entry}`)
  process.exit(0)
}

await $`npm install --ignore-scripts`.cwd(root)
await $`npm run hydrate:model-data`.cwd(root)
await $`npm run build:offline`.cwd(root)

if (!existsSync(entry)) {
  console.error(`[setup:pi] build finished but ${entry} is missing`)
  process.exit(1)
}

console.log(`[setup:pi] ready: ${entry}`)
