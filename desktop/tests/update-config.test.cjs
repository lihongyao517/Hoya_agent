const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const packageJson = require('../package.json')

test('packages the updater and publishes GitHub update metadata', () => {
  assert.ok(packageJson.dependencies['electron-updater'])
  assert.deepEqual(packageJson.build.publish, [{
    provider: 'github',
    owner: 'lihongyao517',
    repo: 'Hoya_agent',
    releaseType: 'release',
  }])
  assert.deepEqual(packageJson.build.win.target, ['nsis', 'portable'])
  assert.equal(packageJson.repository.url, 'https://github.com/lihongyao517/Hoya_agent.git')
  assert.match(packageJson.scripts['release:github'], /--publish always/)
})

test('builds unsigned GitHub releases from the desktop working directory', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8')
  assert.match(workflow, /working-directory: desktop/)
  assert.match(workflow, /npx electron-builder --win nsis portable --x64/)
  assert.doesNotMatch(workflow, /npx --prefix desktop electron-builder/)
  assert.doesNotMatch(workflow, /signpath\/github-action|SIGNPATH_API_TOKEN/)
  assert.doesNotMatch(workflow, /update\.electronjs\.org|\bsquirrel\b/i)
})
