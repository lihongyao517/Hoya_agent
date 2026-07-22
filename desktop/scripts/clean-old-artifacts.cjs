const fs = require('node:fs')
const path = require('node:path')
const { version: packageVersion } = require('../package.json')

const rootArtifactPattern = /^Hoya-Agent-(?:Setup|Portable)-(.+)-(?:x64|ia32|arm64)\.exe(?:\.blockmap)?$/i

function cleanOldArtifacts(artifactsDirectory, currentVersion = packageVersion) {
  const artifactsDir = path.resolve(artifactsDirectory)
  if (!fs.existsSync(artifactsDir)) return { exists: false, removed: [] }

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
    for (const entry of fs.readdirSync(retiredSquirrelDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) removed.push(path.relative(artifactsDir, path.join(entry.parentPath, entry.name)))
    }
    fs.rmSync(retiredSquirrelDir, { recursive: true, force: true })
    removed.push('squirrel-windows')
  }

  const latestMetadata = path.join(artifactsDir, 'latest.yml')
  if (fs.existsSync(latestMetadata)) {
    const metadataVersion = fs.readFileSync(latestMetadata, 'utf8').match(/^version:\s*["']?([^"'\r\n]+)["']?/m)?.[1]?.trim()
    if (metadataVersion !== currentVersion) {
      fs.unlinkSync(latestMetadata)
      removed.push('latest.yml')
    }
  }

  return { exists: true, removed }
}

if (require.main === module) {
  const artifactsDir = path.resolve(__dirname, '..', '..', 'artifacts', 'desktop')
  const result = cleanOldArtifacts(artifactsDir)
  if (!result.exists) {
    console.log(`[hoya-desktop] artifact directory does not exist: ${artifactsDir}`)
  } else if (result.removed.length === 0) {
    console.log(`[hoya-desktop] no old artifacts found; keeping version ${packageVersion}`)
  } else {
    console.log(`[hoya-desktop] removed old artifacts:\n${result.removed.map((name) => `- ${name}`).join('\n')}`)
  }
}

module.exports = { cleanOldArtifacts }
