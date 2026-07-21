const assert = require('node:assert/strict')
const test = require('node:test')
const { checkForUpdates, compareVersions, newestTag, versionParts } = require('../electron/update-service.cjs')

test('normalizes two and three segment versions', () => {
  assert.deepEqual(versionParts('v1.1'), [1, 1, 0])
  assert.deepEqual(versionParts('0.1.3'), [0, 1, 3])
})

test('compares GitHub tags against the desktop version', () => {
  assert.equal(compareVersions('v1.1', '0.1.3'), 1)
  assert.equal(compareVersions('v1.1', '1.1.0'), 0)
  assert.equal(compareVersions('v0.1.3', '0.1.3'), 0)
  assert.equal(newestTag([{ name: 'v1.0' }, { name: 'v1.1' }]), 'v1.1')
})

test('returns update metadata from GitHub tags', async () => {
  const result = await checkForUpdates('0.1.3', async () => ({
    ok: true,
    json: async () => [{ name: 'v1.0' }, { name: 'v1.1' }],
  }))

  assert.equal(result.currentVersion, '0.1.3')
  assert.equal(result.latestVersion, 'v1.1')
  assert.equal(result.updateAvailable, true)
  assert.match(result.releasesUrl, /lihongyao517\/Hoya_agent\/releases$/)
})

test('does not report an update when tag and app versions are equivalent', async () => {
  const result = await checkForUpdates('1.1.0', async () => ({
    ok: true,
    json: async () => [{ name: 'v1.1' }],
  }))

  assert.equal(result.latestVersion, 'v1.1')
  assert.equal(result.updateAvailable, false)
})
