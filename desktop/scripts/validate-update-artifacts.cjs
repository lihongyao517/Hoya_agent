const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const YAML = require('yaml')
const { version: packageVersion } = require('../package.json')

function assertRelease(condition, message) {
  if (!condition) throw new Error(message)
}

function sha512(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64')
}

function validateUpdateArtifacts(artifactDirectory, expectedVersion = packageVersion) {
  const directory = path.resolve(artifactDirectory)
  const metadataPath = path.join(directory, 'latest.yml')
  assertRelease(fs.existsSync(metadataPath), `Missing update metadata: ${metadataPath}`)

  const metadata = YAML.parse(fs.readFileSync(metadataPath, 'utf8'))
  assertRelease(String(metadata?.version || '') === expectedVersion, `latest.yml version must be ${expectedVersion}`)

  const installerName = path.basename(String(metadata?.path || ''))
  const expectedInstaller = `Hoya-Agent-Setup-${expectedVersion}-x64.exe`
  assertRelease(installerName === expectedInstaller, `latest.yml path must be ${expectedInstaller}`)

  const installerPath = path.join(directory, installerName)
  const blockmapPath = `${installerPath}.blockmap`
  const portablePath = path.join(directory, `Hoya-Agent-Portable-${expectedVersion}-x64.exe`)
  for (const requiredPath of [installerPath, blockmapPath, portablePath]) {
    assertRelease(fs.existsSync(requiredPath), `Missing release asset: ${requiredPath}`)
  }

  const fileEntry = Array.isArray(metadata.files)
    ? metadata.files.find((entry) => path.basename(String(entry?.url || '')) === installerName)
    : null
  assertRelease(fileEntry, `latest.yml files does not contain ${installerName}`)

  const installerSize = fs.statSync(installerPath).size
  const installerHash = sha512(installerPath)
  assertRelease(Number(metadata.size ?? fileEntry.size) === installerSize, 'latest.yml installer size does not match the installer')
  assertRelease(String(metadata.sha512 || '') === installerHash, 'latest.yml top-level SHA-512 does not match the installer')
  assertRelease(Number(fileEntry.size) === installerSize, 'latest.yml file entry size does not match the installer')
  assertRelease(String(fileEntry.sha512 || '') === installerHash, 'latest.yml file entry SHA-512 does not match the installer')
  assertRelease(fs.statSync(blockmapPath).size > 0, 'installer blockmap must not be empty')

  return { version: expectedVersion, installerPath, blockmapPath, portablePath }
}

if (require.main === module) {
  const directory = process.argv[2] || path.resolve(__dirname, '..', '..', 'artifacts', 'desktop')
  const result = validateUpdateArtifacts(directory)
  process.stdout.write(`Validated update assets for Hoya Agent ${result.version}.\n`)
}

module.exports = { sha512, validateUpdateArtifacts }
