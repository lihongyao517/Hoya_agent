const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { cleanOldArtifacts } = require('../scripts/clean-old-artifacts.cjs')

test('keeps only current-version release files', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hoya-clean-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const files = [
    'Hoya-Agent-Setup-1.2.1-x64.exe',
    'Hoya-Agent-Setup-1.2.1-x64.exe.blockmap',
    'Hoya-Agent-Portable-1.2.1-x64.exe',
    'Hoya-Agent-Setup-1.2.2-x64.exe',
    'Hoya-Agent-Setup-1.2.2-x64.exe.blockmap',
    'Hoya-Agent-Portable-1.2.2-x64.exe',
  ]
  for (const file of files) fs.writeFileSync(path.join(directory, file), file)
  fs.writeFileSync(path.join(directory, 'latest.yml'), 'version: 1.2.1\n')
  const squirrelDirectory = path.join(directory, 'squirrel-windows', 'legacy')
  fs.mkdirSync(squirrelDirectory, { recursive: true })
  fs.writeFileSync(path.join(squirrelDirectory, 'old-package.nupkg'), 'legacy')

  const result = cleanOldArtifacts(directory, '1.2.2')

  assert.deepEqual(result.removed.sort(), [
    'Hoya-Agent-Portable-1.2.1-x64.exe',
    'Hoya-Agent-Setup-1.2.1-x64.exe',
    'Hoya-Agent-Setup-1.2.1-x64.exe.blockmap',
    'latest.yml',
    'squirrel-windows',
    path.join('squirrel-windows', 'legacy', 'old-package.nupkg'),
  ])
  assert.equal(fs.existsSync(path.join(directory, 'Hoya-Agent-Setup-1.2.2-x64.exe')), true)
  assert.equal(fs.existsSync(path.join(directory, 'squirrel-windows')), false)
})
