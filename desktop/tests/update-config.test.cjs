const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const packageJson = require('../package.json')

test('packages the updater and publishes GitHub update metadata', () => {
  assert.ok(packageJson.dependencies['electron-updater'])
  assert.ok(packageJson.devDependencies.vue)
  assert.ok(packageJson.devDependencies['element-plus'])
  assert.equal(packageJson.dependencies.vue, undefined)
  assert.deepEqual(packageJson.build.publish, [{
    provider: 'github',
    owner: 'lihongyao517',
    repo: 'Hoya_agent',
    releaseType: 'release',
  }])
  assert.deepEqual(packageJson.build.win.target, ['nsis', 'portable'])
  assert.equal(packageJson.build.win.signAndEditExecutable, undefined)
  assert.deepEqual(packageJson.build.electronLanguages, ['en-US', 'zh-CN'])
  assert.doesNotMatch(packageJson.build.files.join('\n'), /assets\/\*\*/)
  assert.equal(packageJson.repository.url, 'https://github.com/lihongyao517/Hoya_agent.git')
  assert.equal(packageJson.scripts['release:github'], undefined)
  assert.doesNotMatch(packageJson.scripts['release:prepare'], /--publish/)
})

test('tests and publishes immutable GitHub update assets', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8')
  assert.match(workflow, /working-directory: desktop/)
  assert.match(workflow, /npx electron-builder --win nsis portable --x64/)
  assert.match(workflow, /python -m unittest discover -s tests -v/)
  assert.match(workflow, /npm run verify:update-artifacts/)
  assert.match(workflow, /gh release create .*--draft/)
  assert.doesNotMatch(workflow, /--clobber/)
  assert.doesNotMatch(workflow, /config\.win\.signAndEditExecutable/)
  assert.doesNotMatch(workflow, /npx --prefix desktop electron-builder/)
  assert.doesNotMatch(workflow, /signpath\/github-action|SIGNPATH_API_TOKEN/)
  assert.doesNotMatch(workflow, /update\.electronjs\.org|\bsquirrel\b/i)
})

test('Python and Electron expose one product version', () => {
  const pythonPackage = fs.readFileSync(path.resolve(__dirname, '../../hoya_agent/__init__.py'), 'utf8')
  const pythonVersion = pythonPackage.match(/__version__\s*=\s*["']([^"']+)["']/)?.[1]
  assert.equal(pythonVersion, packageJson.version)
})
