const REPOSITORY_URL = 'https://github.com/lihongyao517/Hoya_agent'
const TAGS_URL = `${REPOSITORY_URL}/tags`
const RELEASES_URL = `${REPOSITORY_URL}/releases`
const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`

function versionParts(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/i)
  if (!match) return null
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)]
}

function compareVersions(left, right) {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  if (!leftParts || !rightParts) return 0
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1
    if (leftParts[index] < rightParts[index]) return -1
  }
  return 0
}

function releaseTagFromUrl(value) {
  try {
    const url = new URL(String(value || ''))
    const match = url.pathname.match(/\/releases\/tag\/([^/]+)\/?$/)
    const tag = match ? decodeURIComponent(match[1]) : ''
    return versionParts(tag) ? tag : ''
  } catch {
    return ''
  }
}

async function checkForUpdates(currentVersion, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Update request API is unavailable.')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetchImpl('https://api.github.com/repos/lihongyao517/Hoya_agent/tags', {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': `Hoya-Agent/${currentVersion}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`)
    const tags = await response.json()
    let latestTag = currentVersion
    for (const t of tags) {
      if (t.name && compareVersions(t.name, latestTag) > 0) {
        latestTag = t.name
      }
    }
    
    return {
      ok: true,
      currentVersion,
      latestVersion: latestTag,
      updateAvailable: compareVersions(latestTag, currentVersion) > 0,
      repositoryUrl: REPOSITORY_URL,
      tagsUrl: TAGS_URL,
      releasesUrl: RELEASES_URL,
    }
  } finally {
    clearTimeout(timeout)
  }
}

module.exports = {
  RELEASES_URL,
  REPOSITORY_URL,
  TAGS_URL,
  checkForUpdates,
  compareVersions,
  releaseTagFromUrl,
  versionParts,
}
