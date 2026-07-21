const fs = require('node:fs')
const path = require('node:path')

const ELECTRON_PUBLIC_UPDATE_SERVER = 'https://update.electronjs.org'
const ELECTRON_PUBLIC_UPDATE_REPOSITORY = 'lihongyao517/Hoya_agent'

function electronPublicUpdateFeed(version, platform = process.platform, arch = process.arch) {
  const cleanVersion = String(version || '').trim().replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(cleanVersion)) {
    throw new Error(`Invalid application version for update feed: ${version}`)
  }
  return `${ELECTRON_PUBLIC_UPDATE_SERVER}/${ELECTRON_PUBLIC_UPDATE_REPOSITORY}/${platform}-${arch}/${cleanVersion}`
}

function squirrelUpdateExecutable(execPath) {
  const value = String(execPath || '')
  const pathApi = /^[A-Za-z]:[\\/]/.test(value) ? path.win32 : path
  const appDirectory = pathApi.dirname(value)
  if (!/^app-\d/i.test(pathApi.basename(appDirectory))) return ''
  return pathApi.join(pathApi.dirname(appDirectory), 'Update.exe')
}

function isSquirrelInstall(execPath, existsSync = fs.existsSync) {
  const updateExecutable = squirrelUpdateExecutable(execPath)
  return Boolean(updateExecutable && existsSync(updateExecutable))
}

function releaseVersion(info, releaseName, fallback = '') {
  const candidates = [info?.version, releaseName, fallback]
  for (const candidate of candidates) {
    const match = String(candidate || '').match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i)
    if (match) return match[1]
  }
  return String(fallback || '')
}

function squirrelAppUserModelId(packageId = 'HoyaAgent', executableName = 'Hoya Agent.exe') {
  const executableBaseName = String(executableName).replace(/\.exe$/i, '')
  return `com.squirrel.${packageId}.${executableBaseName}`
}

module.exports = {
  ELECTRON_PUBLIC_UPDATE_REPOSITORY,
  ELECTRON_PUBLIC_UPDATE_SERVER,
  electronPublicUpdateFeed,
  isSquirrelInstall,
  releaseVersion,
  squirrelAppUserModelId,
  squirrelUpdateExecutable,
}
