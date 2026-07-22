const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')
const { sha512, validateUpdateArtifacts } = require('../scripts/validate-update-artifacts.cjs')
const packageJson = require('../package.json')

function createArtifacts(version = '9.8.7') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hoya-update-'))
  const installerName = `Hoya-Agent-Setup-${version}-x64.exe`
  const installerPath = path.join(directory, installerName)
  const blockmapPath = `${installerPath}.blockmap`
  fs.writeFileSync(installerPath, 'installer')
  fs.writeFileSync(blockmapPath, 'blockmap')
  fs.writeFileSync(path.join(directory, `Hoya-Agent-Portable-${version}-x64.exe`), 'portable')
  fs.writeFileSync(path.join(directory, 'latest.yml'), YAML.stringify({
    version,
    files: [{
      url: installerName,
      sha512: sha512(installerPath),
      size: fs.statSync(installerPath).size,
    }],
    path: installerName,
    sha512: sha512(installerPath),
    releaseDate: new Date(0).toISOString(),
  }))
  return { directory, installerPath }
}

test('accepts a complete and internally consistent update set', (t) => {
  const fixture = createArtifacts()
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }))
  assert.equal(validateUpdateArtifacts(fixture.directory, '9.8.7').version, '9.8.7')
})

test('rejects installer content that no longer matches latest.yml', (t) => {
  const fixture = createArtifacts()
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }))
  fs.appendFileSync(fixture.installerPath, '-changed')
  assert.throws(
    () => validateUpdateArtifacts(fixture.directory, '9.8.7'),
    /size does not match|SHA-512 does not match/,
  )
})

test('installer recreates the desktop shortcut on every upgrade', () => {
  assert.equal(packageJson.build.nsis.createDesktopShortcut, 'always')
})
