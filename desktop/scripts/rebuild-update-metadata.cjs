const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function yamlString(value) {
  return JSON.stringify(String(value))
}

function appBuilderPath() {
  const platformArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'ia32' : 'x64'
  return path.resolve(__dirname, '..', 'node_modules', 'app-builder-bin', 'win', platformArch, 'app-builder.exe')
}

function rebuildUpdateMetadata(installerArg, metadataArg) {
  if (!installerArg) throw new Error('Usage: node rebuild-update-metadata.cjs <signed-installer.exe> [latest.yml]')

  const installer = path.resolve(installerArg)
  const metadata = path.resolve(metadataArg || path.join(path.dirname(installer), 'latest.yml'))
  const blockmap = `${installer}.blockmap`
  if (!fs.existsSync(installer)) throw new Error(`Signed installer not found: ${installer}`)

  const result = spawnSync(appBuilderPath(), ['blockmap', '--input', installer, '--output', blockmap], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Unable to build blockmap')

  const updateInfo = JSON.parse(result.stdout.trim())
  const packageJson = require('../package.json')
  const fileName = path.basename(installer)
  const size = fs.statSync(installer).size
  const blockMapSize = fs.statSync(blockmap).size
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64')

  if (updateInfo.size !== size || updateInfo.sha512 !== sha512) {
    throw new Error('Blockmap metadata does not match the signed installer')
  }

  const yaml = [
    `version: ${yamlString(packageJson.version)}`,
    'files:',
    `  - url: ${yamlString(fileName)}`,
    `    sha512: ${yamlString(sha512)}`,
    `    size: ${size}`,
    `    blockMapSize: ${blockMapSize}`,
    `path: ${yamlString(fileName)}`,
    `sha512: ${yamlString(sha512)}`,
    `releaseDate: ${yamlString(new Date().toISOString())}`,
    '',
  ].join('\n')

  fs.writeFileSync(metadata, yaml, 'utf8')
  process.stdout.write(`Rebuilt ${path.basename(metadata)} and ${path.basename(blockmap)} from signed installer.\n`)
}

if (require.main === module) rebuildUpdateMetadata(process.argv[2], process.argv[3])

module.exports = { rebuildUpdateMetadata }
