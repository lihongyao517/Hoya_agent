const assert = require('node:assert/strict')
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
