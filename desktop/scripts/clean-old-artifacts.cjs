const fs = require('node:fs')
const path = require('node:path')
const { version: currentVersion } = require('../package.json')

const artifactsDir = path.resolve(__dirname, '..', '..', 'artifacts', 'desktop')
const artifactPattern = /^Hoya-Agent-(?:Setup|Portable)-(.+)-(?:x64|ia32|arm64)\.exe(?:\.blockmap)?$/i

if (!fs.existsSync(artifactsDir)) {
  console.log(`[hoya-desktop] artifact directory does not exist: ${artifactsDir}`)
  process.exit(0)
}

const removed = []
for (const entry of fs.readdirSync(artifactsDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue
  const match = artifactPattern.exec(entry.name)
  if (!match || match[1] === currentVersion) continue

  fs.unlinkSync(path.join(artifactsDir, entry.name))
  removed.push(entry.name)
}

if (removed.length === 0) {
  console.log(`[hoya-desktop] no old artifacts found; keeping version ${currentVersion}`)
} else {
  console.log(`[hoya-desktop] removed old artifacts:\n${removed.map((name) => `- ${name}`).join('\n')}`)
}
