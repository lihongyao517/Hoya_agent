const fs = require('node:fs')
const path = require('node:path')
const { version: currentVersion } = require('../package.json')

const artifactsDir = path.resolve(__dirname, '..', '..', 'artifacts', 'desktop')
const rootArtifactPattern = /^Hoya-Agent-(?:Setup|Portable)-(.+)-(?:x64|ia32|arm64)\.exe(?:\.blockmap)?$/i

if (!fs.existsSync(artifactsDir)) {
  console.log(`[hoya-desktop] artifact directory does not exist: ${artifactsDir}`)
  process.exit(0)
}

const removed = []
function removeOldFiles(directory, patterns) {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const match = patterns.map((pattern) => pattern.exec(entry.name)).find(Boolean)
    if (!match || match[1] === currentVersion) continue

    fs.unlinkSync(path.join(directory, entry.name))
    removed.push(path.relative(artifactsDir, path.join(directory, entry.name)))
  }
}

removeOldFiles(artifactsDir, [rootArtifactPattern])

const retiredSquirrelDir = path.join(artifactsDir, 'squirrel-windows')
if (fs.existsSync(retiredSquirrelDir)) {
  for (const entry of fs.readdirSync(retiredSquirrelDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    fs.unlinkSync(path.join(retiredSquirrelDir, entry.name))
    removed.push(path.join('squirrel-windows', entry.name))
  }
}

const latestMetadata = path.join(artifactsDir, 'latest.yml')
if (fs.existsSync(latestMetadata)) {
  const metadataVersion = fs.readFileSync(latestMetadata, 'utf8').match(/^version:\s*["']?([^"'\r\n]+)["']?/m)?.[1]?.trim()
  if (metadataVersion && metadataVersion !== currentVersion) {
    fs.unlinkSync(latestMetadata)
    removed.push('latest.yml')
  }
}

if (removed.length === 0) {
  console.log(`[hoya-desktop] no old artifacts found; keeping version ${currentVersion}`)
} else {
  console.log(`[hoya-desktop] removed old artifacts:\n${removed.map((name) => `- ${name}`).join('\n')}`)
}
