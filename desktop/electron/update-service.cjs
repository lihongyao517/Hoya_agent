const REPOSITORY_URL = 'https://github.com/lihongyao517/Hoya_agent'
const TAGS_URL = `${REPOSITORY_URL}/tags`
const RELEASES_URL = `${REPOSITORY_URL}/releases`
const TAGS_API_URL = 'https://api.github.com/repos/lihongyao517/Hoya_agent/tags?per_page=20'

function versionParts(value) {
  const match = String(value || '').trim().match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
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

function newestTag(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag?.name || '').trim())
    .filter((name) => versionParts(name))
    .sort((left, right) => compareVersions(right, left))[0] || ''
}

async function checkForUpdates(currentVersion, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Update request API is unavailable.')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetchImpl(TAGS_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Hoya-Agent/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`GitHub Tags returned HTTP ${response.status}`)
    const latestTag = newestTag(await response.json())
    if (!latestTag) throw new Error('GitHub Tags did not return a valid version tag.')
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
  newestTag,
  versionParts,
}
