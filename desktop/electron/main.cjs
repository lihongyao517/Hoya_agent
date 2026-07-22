const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, session, shell, Tray } = require('electron')
const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { autoUpdater } = require('electron-updater')
const { RELEASES_URL, checkForUpdates: checkTagsForUpdates, compareVersions } = require('./update-service.cjs')

const isDev = !app.isPackaged
if (process.platform === 'win32') app.setAppUserModelId('com.hoya.agent.desktop')
const serverHost = '127.0.0.1'
const backendReadyPrefix = 'HOYA_SERVER_READY '
const backendStartTimeoutMs = 30000
const previewPartition = 'hoya-preview'
const supportedLanguages = new Set(['zh-CN', 'en-US'])
const windows = new Set()
let currentLanguage = 'zh-CN'
let backend = null
let backendConnection = null
let backendStartPromise = null
let backendRestartTimer = null
let mainWindow = null
let tray = null
let isQuitting = false
let backgroundNoticeShown = false
let updateCheckPromise = null
let updateState = null
let backgroundUpdateTimer = null
let updateInstallInProgress = false
const terminalRuns = new Map()
const approvedWorkspacePaths = new Set()
const lockedSessions = new WeakSet()

function projectRoot() {
  return path.resolve(__dirname, '..', '..')
}

function bundledBackendPath() {
  const exe = process.platform === 'win32' ? 'hoya-agent-backend.exe' : 'hoya-agent-backend'
  return path.join(process.resourcesPath, 'backend', 'hoya-agent-backend', exe)
}

function pythonSettingsPath() {
  return path.join(app.getPath('home'), '.hoya', 'settings.json')
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return {}
  }
}

function writeJsonFileAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    try { fs.unlinkSync(temporaryPath) } catch { /* The rename already consumed the temporary file. */ }
  }
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value || ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function existingDirectory(value) {
  if (!value) return ''
  try {
    const resolved = path.resolve(String(value))
    return fs.statSync(resolved).isDirectory() ? resolved : ''
  } catch {
    return ''
  }
}

function scratchWorkspace() {
  const workspace = path.join(app.getPath('userData'), 'workspaces', 'scratch')
  fs.mkdirSync(workspace, { recursive: true })
  return workspace
}

function initialWorkspace() {
  const configuredWorkspace = existingDirectory(process.env.HOYA_WORKSPACE)
  if (configuredWorkspace) return configuredWorkspace
  const settings = readJsonFile(pythonSettingsPath())
  const previousWorkspace = existingDirectory(settings.last_workspace)
  if (previousWorkspace && normalizedPath(previousWorkspace) !== normalizedPath(app.getPath('home'))) {
    return previousWorkspace
  }
  return scratchWorkspace()
}

function rememberWorkspace(workspace) {
  const resolved = existingDirectory(workspace)
  if (resolved) approvedWorkspacePaths.add(normalizedPath(resolved))
}

function knownWorkspaceRoots() {
  const settings = readJsonFile(pythonSettingsPath())
  const paths = [initialWorkspace(), ...(Array.isArray(settings.projects) ? settings.projects.map((item) => item?.path) : [])]
  for (const workspace of paths) rememberWorkspace(workspace)
  return [...approvedWorkspacePaths]
}

function isApprovedWorkspace(workspace) {
  if (!workspace) return false
  const candidate = normalizedPath(workspace)
  return knownWorkspaceRoots().some((root) => candidate === root)
}

function credentialsPath() {
  return path.join(app.getPath('userData'), 'credentials.json')
}

function normalizeCredentialDescriptor(payload = {}) {
  const provider = String(payload.provider || '').trim().toLowerCase()
  const rawBaseUrl = String(payload.baseUrl || payload.base_url || '').trim()
  let baseUrl = rawBaseUrl.replace(/\/+$/, '')
  try {
    baseUrl = new URL(rawBaseUrl).toString().replace(/\/+$/, '')
  } catch { /* Configuration validation reports malformed provider URLs. */ }
  if (!provider || !baseUrl) return null
  return { provider, baseUrl }
}

function credentialId(descriptor) {
  return crypto.createHash('sha256')
    .update(`${descriptor.provider}\0${descriptor.baseUrl}`)
    .digest('hex')
}

function loadCredentials() {
  const document = readJsonFile(credentialsPath())
  return {
    version: 1,
    entries: document && typeof document.entries === 'object' && !Array.isArray(document.entries)
      ? document.entries
      : {},
  }
}

function requireCredentialEncryption() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system.')
  }
}

function saveApiKey(payload = {}) {
  const descriptor = normalizeCredentialDescriptor(payload)
  if (!descriptor) throw new Error('Provider and base URL are required to save an API key.')
  const apiKey = String(payload.apiKey || payload.api_key || '').trim()
  if (!apiKey) return deleteApiKey(descriptor)
  requireCredentialEncryption()
  const document = loadCredentials()
  document.entries[credentialId(descriptor)] = {
    ...descriptor,
    encrypted: safeStorage.encryptString(apiKey).toString('base64'),
    updatedAt: new Date().toISOString(),
  }
  writeJsonFileAtomic(credentialsPath(), document)
  return true
}

function deleteApiKey(payload = {}) {
  const descriptor = normalizeCredentialDescriptor(payload)
  if (!descriptor) throw new Error('Provider and base URL are required to delete an API key.')
  const document = loadCredentials()
  const id = credentialId(descriptor)
  if (!Object.hasOwn(document.entries, id)) return false
  delete document.entries[id]
  writeJsonFileAtomic(credentialsPath(), document)
  return true
}

function parseEnvValue(content, name) {
  const expression = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, 'm')
  const line = String(content || '').split(/\r?\n/).find((item) => expression.test(item))
  if (!line) return ''
  return line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
}

function legacyCredential(workspace, requestedDescriptor) {
  if (!isApprovedWorkspace(workspace)) return null
  const envPath = path.join(path.resolve(workspace), '.env')
  let content = ''
  try {
    content = fs.readFileSync(envPath, 'utf8')
  } catch {
    return null
  }
  const apiKey = parseEnvValue(content, 'HOYA_API_KEY')
  if (!apiKey) return null
  const descriptor = requestedDescriptor || normalizeCredentialDescriptor({
    provider: parseEnvValue(content, 'HOYA_LLM_PROVIDER'),
    baseUrl: parseEnvValue(content, 'HOYA_BASE_URL'),
  })
  if (!descriptor) return null
  return { apiKey, content, descriptor, envPath }
}

function workspaceCredentialDescriptor(workspace) {
  if (!isApprovedWorkspace(workspace)) return null
  try {
    const content = fs.readFileSync(path.join(path.resolve(workspace), '.env'), 'utf8')
    return normalizeCredentialDescriptor({
      provider: parseEnvValue(content, 'HOYA_LLM_PROVIDER'),
      baseUrl: parseEnvValue(content, 'HOYA_BASE_URL'),
    })
  } catch {
    return null
  }
}

function removeLegacyApiKey(legacy) {
  const newline = legacy.content.includes('\r\n') ? '\r\n' : '\n'
  const lines = legacy.content.split(/\r?\n/)
  const filtered = lines.filter((line) => !/^\s*(?:export\s+)?HOYA_API_KEY\s*=/.test(line))
  const temporaryPath = `${legacy.envPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporaryPath, filtered.join(newline), 'utf8')
    fs.renameSync(temporaryPath, legacy.envPath)
  } finally {
    try { fs.unlinkSync(temporaryPath) } catch { /* The rename already consumed the temporary file. */ }
  }
}

function getApiKey(payload = {}) {
  const requestedDescriptor = normalizeCredentialDescriptor(payload) || workspaceCredentialDescriptor(payload.workspace)
  if (requestedDescriptor) {
    const entry = loadCredentials().entries[credentialId(requestedDescriptor)]
    if (entry?.encrypted) {
      requireCredentialEncryption()
      try {
        return safeStorage.decryptString(Buffer.from(entry.encrypted, 'base64'))
      } catch {
        throw new Error('The saved API key could not be decrypted. Please save it again.')
      }
    }
  }

  const legacy = legacyCredential(payload.workspace, requestedDescriptor)
  if (!legacy) return ''
  saveApiKey({ ...legacy.descriptor, apiKey: legacy.apiKey })
  removeLegacyApiKey(legacy)
  return legacy.apiKey
}

function migrateLegacyModelCredentials() {
  const settingsFile = pythonSettingsPath()
  const settings = readJsonFile(settingsFile)
  if (!Array.isArray(settings.models)) return 0
  let migrated = 0
  for (const model of settings.models) {
    if (!model || typeof model !== 'object') continue
    const apiKey = String(model.api_key || '').trim()
    const descriptor = normalizeCredentialDescriptor(model)
    if (!apiKey || !descriptor) continue
    try {
      saveApiKey({ ...descriptor, apiKey })
      delete model.api_key
      model.api_key_set = true
      migrated += 1
    } catch (error) {
      console.warn(`[hoya-desktop] legacy model credential migration deferred: ${error}`)
    }
  }
  if (migrated) writeJsonFileAtomic(settingsFile, settings)
  return migrated
}

function terminalWorkingDirectory(value) {
  const resolved = path.resolve(String(value || ''))
  const normalized = normalizedPath(resolved)
  const allowed = knownWorkspaceRoots().some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`))
  if (!allowed || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Terminal directory is outside the approved workspaces.')
  }
  return resolved
}

function startTerminalCommand(event, payload) {
  const command = String(payload?.command || '').trim()
  if (!command) throw new Error('Command is required.')
  if (command.length > 16000) throw new Error('Command is too long.')

  const cwd = terminalWorkingDirectory(payload?.cwd)
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const encodedCommand = `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); ${command}`
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', encodedCommand], {
    cwd,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const sender = event.sender
  terminalRuns.set(id, { child, senderId: sender.id })
  const emit = (stream, data) => {
    if (!sender.isDestroyed()) sender.send('hoya:terminal-output', { id, stream, data: String(data) })
  }
  child.stdout.on('data', (data) => emit('stdout', data))
  child.stderr.on('data', (data) => emit('stderr', data))
  child.on('error', (error) => emit('error', error.message))
  child.on('close', (code) => {
    terminalRuns.delete(id)
    if (!sender.isDestroyed()) sender.send('hoya:terminal-output', { id, stream: 'exit', data: '', code: code ?? -1 })
  })
  return { ok: true, id, cwd }
}

function stopTerminalCommand(event, id) {
  const run = terminalRuns.get(String(id || ''))
  if (!run || run.senderId !== event.sender.id) return false
  if (process.platform === 'win32' && run.child.pid) {
    spawn('taskkill.exe', ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    run.child.kill()
  }
  return true
}

function runCodeSnippet(_event, payload) {
  const code = String(payload?.code || '')
  const language = String(payload?.language || '').trim().toLowerCase()
  if (!code.trim()) throw new Error('Code is required.')
  if (code.length > 20000) throw new Error('Code block is too long to run.')
  const cwd = terminalWorkingDirectory(payload?.cwd)
  let command = ''
  let args = []
  if (['python', 'py'].includes(language)) {
    command = process.env.HOYA_PYTHON || 'python'
    args = ['-c', code]
  } else if (['javascript', 'js', 'node'].includes(language)) {
    command = 'node'
    args = ['-e', code]
  } else if (['powershell', 'ps1'].includes(language)) {
    command = 'powershell.exe'
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')]
  } else {
    throw new Error(`Unsupported runnable language: ${language || 'unknown'}`)
  }

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(-200000)
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    child.on('error', (error) => { stderr = append(stderr, error.message) })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 30000)
    child.on('close', (codeValue) => {
      clearTimeout(timer)
      resolve({
        ok: !timedOut && codeValue === 0,
        stdout,
        stderr,
        exitCode: codeValue ?? -1,
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    })
  })
}

function resolveBackendCommand() {
  const workspace = initialWorkspace()
  const bundled = bundledBackendPath()
  if (!isDev && fs.existsSync(bundled)) {
    return {
      command: bundled,
      args: ['--host', serverHost, '--port', '0', '--workspace', workspace],
      cwd: path.dirname(bundled),
    }
  }

  const root = projectRoot()
  return {
    command: process.env.HOYA_PYTHON || 'python',
    args: ['-m', 'hoya_agent', '--server', '--host', serverHost, '--port', '0', '--workspace', workspace],
    cwd: root,
  }
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json')
}

function legacyDesktopSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadLanguage() {
  try {
    const settings = {
      ...readJsonFile(legacyDesktopSettingsPath()),
      ...readJsonFile(settingsPath()),
    }
    if (supportedLanguages.has(settings.language)) currentLanguage = settings.language
  } catch { currentLanguage = 'zh-CN' }
}

function saveLanguage(language) {
  try {
    const settings = readJsonFile(settingsPath())
    settings.language = language
    writeJsonFileAtomic(settingsPath(), settings)
  } catch (error) {
    console.error(`[hoya-desktop] failed to save language: ${error}`)
  }
}

function setLanguage(language) {
  if (!supportedLanguages.has(language)) return currentLanguage
  currentLanguage = language
  saveLanguage(language)
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send('hoya:language-changed', currentLanguage)
  }
  rebuildTrayMenu()
  return currentLanguage
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function rebuildTrayMenu() {
  if (!tray) return
  const zh = currentLanguage === 'zh-CN'
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: zh ? '打开 Hoya Agent' : 'Open Hoya Agent', click: showMainWindow },
    { type: 'separator' },
    {
      label: zh ? '退出' : 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ]))
}

function createTray() {
  if (tray) return
  tray = new Tray(path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'))
  tray.setToolTip(`Hoya Agent v${app.getVersion()}`)
  tray.on('double-click', showMainWindow)
  rebuildTrayMenu()
}

function lockDownSession(targetSession) {
  if (!targetSession || lockedSessions.has(targetSession)) return
  lockedSessions.add(targetSession)
  targetSession.setPermissionCheckHandler(() => false)
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  targetSession.on('will-download', (event) => event.preventDefault())
}

function createWindow() {
  lockDownSession(session.defaultSession)
  lockDownSession(session.fromPartition(previewPartition))
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    thickFrame: true,
    roundedCorners: true,
    show: false,
    title: 'Hoya Agent',
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#f7f9f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  })
  mainWindow = win
  windows.add(win)
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.partition = previewPartition
    params.partition = previewPartition
    delete params.allowpopups
    const source = String(params.src || 'about:blank')
    if (source === 'about:blank' || /^https?:\/\//i.test(source)) return
    if (source.startsWith('file://')) {
      try {
        const localPath = decodeURIComponent(new URL(source).pathname).replace(/^\/(?:([A-Za-z]:))/, '$1')
        terminalWorkingDirectory(path.dirname(localPath))
        return
      } catch {
        // Fall through and reject unapproved local files.
      }
    }
    event.preventDefault()
  })
  win.webContents.on('did-attach-webview', (_event, contents) => {
    lockDownSession(contents.session)
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
  })
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
    if (tray && !backgroundNoticeShown && process.platform === 'win32') {
      tray.displayBalloon({
        title: 'Hoya Agent',
        content: currentLanguage === 'zh-CN' ? 'Hoya Agent 正在后台运行。' : 'Hoya Agent is still running in the background.',
        iconType: 'info',
      })
      backgroundNoticeShown = true
    }
  })
  win.on('closed', () => {
    windows.delete(win)
    if (mainWindow === win) mainWindow = null
  })
  const sendMaximizedState = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('hoya:window-maximized-changed', win.isMaximized())
    }
  }
  win.on('maximize', sendMaximizedState)
  win.on('unmaximize', sendMaximizedState)
  win.on('restore', sendMaximizedState)
  win.on('resize', sendMaximizedState)
  win.once('ready-to-show', () => {
    win.show()
    sendMaximizedState()
  })

  if (isDev) {
    win.loadURL('http://127.0.0.1:5173')
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

function currentUpdateState() {
  return updateState || {
    ok: true,
    status: 'idle',
    currentVersion: app.getVersion(),
    latestVersion: '',
    updateAvailable: false,
    autoUpdateSupported: app.isPackaged && !isPortableBuild(),
    progress: 0,
    releasesUrl: RELEASES_URL,
  }
}

function isPortableBuild() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR)
}

function publishUpdateState(patch) {
  updateState = { ...currentUpdateState(), ...patch }
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send('hoya:update-status', updateState)
  }
  return updateState
}

function configureAutoUpdater() {
  if (!app.isPackaged || isPortableBuild()) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => publishUpdateState({ ok: true, status: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) => {
    if (!info.version || compareVersions(info.version, app.getVersion()) <= 0) {
      publishUpdateState({
        ok: true,
        status: 'not-available',
        latestVersion: info.version || app.getVersion(),
        updateAvailable: false,
        autoUpdateSupported: true,
        progress: 0,
        error: undefined,
      })
      return
    }
    publishUpdateState({
      ok: true,
      status: 'downloading',
      latestVersion: info.version,
      updateAvailable: true,
      autoUpdateSupported: true,
      progress: 0,
      error: undefined,
    })
  })
  autoUpdater.on('download-progress', (progress) => publishUpdateState({
    status: 'downloading',
    progress: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
  }))
  autoUpdater.on('update-downloaded', (info) => publishUpdateState({
    ok: true,
    status: 'downloaded',
    latestVersion: info.version || currentUpdateState().latestVersion,
    updateAvailable: true,
    autoUpdateSupported: true,
    progress: 100,
    error: undefined,
  }))
  autoUpdater.on('update-not-available', (info) => publishUpdateState({
    ok: true,
    status: 'not-available',
    latestVersion: info.version || app.getVersion(),
    updateAvailable: false,
    autoUpdateSupported: true,
    progress: 0,
    error: undefined,
  }))
  autoUpdater.on('error', (error) => {
    console.warn(`[hoya-desktop] automatic update failed: ${error}`)
    publishUpdateState({ ok: false, status: 'error', error: error instanceof Error ? error.message : String(error) })
  })
  autoUpdater.on('before-quit-for-update', () => {
    updateInstallInProgress = true
    isQuitting = true
    stopBackgroundProcesses()
  })

  setTimeout(() => checkDesktopUpdates().catch((error) => console.warn(`[hoya-desktop] initial update check failed: ${error}`)), 15000)
  backgroundUpdateTimer = setInterval(() => {
    checkDesktopUpdates().catch((error) => console.warn(`[hoya-desktop] scheduled update check failed: ${error}`))
  }, 10 * 60 * 1000)
  backgroundUpdateTimer.unref?.()
}

async function checkDesktopUpdates() {
  if (['checking', 'downloading', 'downloaded'].includes(currentUpdateState().status)) return currentUpdateState()
  if (updateCheckPromise) return updateCheckPromise
  updateCheckPromise = (async () => {
    if (!app.isPackaged) {
      return publishUpdateState({ ok: true, status: 'not-available', latestVersion: app.getVersion(), updateAvailable: false, autoUpdateSupported: false })
    }
    if (isPortableBuild()) {
      try {
        const manual = await checkTagsForUpdates(app.getVersion())
        return publishUpdateState({
          ...manual,
          status: manual.updateAvailable ? 'manual' : 'not-available',
          autoUpdateSupported: false,
          progress: 0,
          error: undefined,
        })
      } catch (error) {
        return publishUpdateState({
          ok: false,
          status: 'error',
          updateAvailable: false,
          autoUpdateSupported: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    try {
      await autoUpdater.checkForUpdates()
      return currentUpdateState()
    } catch (automaticError) {
      try {
        const fallback = await checkTagsForUpdates(app.getVersion())
        if (fallback.updateAvailable && fallback.latestVersion) {
          try {
            autoUpdater.setFeedURL({
              provider: 'generic',
              url: `https://github.com/lihongyao517/Hoya_agent/releases/download/${fallback.latestVersion}`
            })
            await autoUpdater.checkForUpdates()
            return currentUpdateState()
          } catch (forceError) {
            // If downloading from the specific tag fails, fallback to manual
          }
        }
        return publishUpdateState({
          ...fallback,
          status: fallback.updateAvailable ? 'manual' : 'not-available',
          autoUpdateSupported: false,
          progress: 0,
          error: fallback.updateAvailable ? '此版本由于 GitHub 限制只能手动下载，请前往 Releases 获取。' : undefined,
        })
      } catch (fallbackError) {
        return publishUpdateState({
          ok: false,
          status: 'error',
          updateAvailable: false,
          autoUpdateSupported: false,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError || automaticError),
        })
      }
    }
  })()
  try {
    return await updateCheckPromise
  } finally {
    updateCheckPromise = null
  }
}

function installDownloadedUpdate() {
  if (isPortableBuild() || currentUpdateState().status !== 'downloaded' || updateInstallInProgress) return false
  updateInstallInProgress = true
  isQuitting = true
  stopBackgroundProcesses()
  autoUpdater.quitAndInstall(true, true)
  return true
}

function stopBackgroundProcesses() {
  for (const { child } of terminalRuns.values()) child.kill()
  terminalRuns.clear()
  backendConnection = null
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer)
    backendRestartTimer = null
  }
  if (backend) {
    backend.kill()
    backend = null
  }
}

function scheduleBackendRestart() {}

function startBackend() {
  return Promise.resolve({ url: 'http://127.0.0.1:0', token: 'mock' })
}

function serverConnection() {
  return Promise.resolve({ url: 'http://127.0.0.1:0', token: 'mock' })
}

function browserTargetForExternal(value) {
  const target = String(value || '')
  if (/^https?:\/\//i.test(target)) return target
  if (!/^mailto:lihongyao517@gmail\.com(?:\?|$)/i.test(target)) return ''
  const message = new URL(target)
  const compose = new URL('https://mail.google.com/mail/')
  compose.searchParams.set('view', 'cm')
  compose.searchParams.set('fs', '1')
  compose.searchParams.set('to', 'lihongyao517@gmail.com')
  if (message.searchParams.get('subject')) compose.searchParams.set('su', message.searchParams.get('subject'))
  if (message.searchParams.get('body')) compose.searchParams.set('body', message.searchParams.get('body'))
  return compose.toString()
}

app.whenReady().then(() => {
  rememberWorkspace(initialWorkspace())
  migrateLegacyModelCredentials()
  loadLanguage()
  Menu.setApplicationMenu(null)
  startBackend().catch((error) => console.error(`[hoya-desktop] ${error.message}`))
  createTray()
  configureAutoUpdater()
  ipcMain.handle('hoya:server-connection', () => serverConnection())
  ipcMain.handle('hoya:server-url', async () => (await serverConnection()).url)
  ipcMain.handle('hoya:get-app-version', () => app.getVersion())
  ipcMain.handle('hoya:check-for-updates', () => checkDesktopUpdates())
  ipcMain.handle('hoya:install-update', () => installDownloadedUpdate())
  ipcMain.handle('hoya:get-language', () => currentLanguage)
  ipcMain.handle('hoya:set-language', (_event, language) => setLanguage(language))
  ipcMain.handle('hoya:get-api-key', (_event, payload) => getApiKey(payload))
  ipcMain.handle('hoya:save-api-key', (_event, payload) => saveApiKey(payload))
  ipcMain.handle('hoya:delete-api-key', (_event, payload) => deleteApiKey(payload))
  ipcMain.handle('hoya:get-saved-api-key', (_event, workspace) => getApiKey({ workspace }))
  ipcMain.handle('hoya:terminal-run', (event, payload) => startTerminalCommand(event, payload))
  ipcMain.handle('hoya:terminal-stop', (event, id) => stopTerminalCommand(event, id))
  ipcMain.handle('hoya:run-code', (event, payload) => runCodeSnippet(event, payload))
  ipcMain.handle('hoya:clipboard-write', (_event, text) => {
    clipboard.writeText(String(text || '').slice(0, 1000000))
    return true
  })
  ipcMain.handle('hoya:open-path', async (_event, value) => {
    const resolved = terminalWorkingDirectory(value)
    return (await shell.openPath(resolved)) === ''
  })
  ipcMain.handle('hoya:open-external', async (_event, url) => {
    const target = browserTargetForExternal(url)
    if (!target) return false
    await shell.openExternal(target)
    return true
  })
  ipcMain.handle('hoya:window-minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.handle('hoya:window-toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('hoya:window-is-maximized', (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)
  ipcMain.handle('hoya:window-close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  ipcMain.handle('hoya:select-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    rememberWorkspace(result.filePaths[0])
    return result.filePaths[0]
  })
  ipcMain.handle('hoya:select-file', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Express server compatibility layer using pi-coding-agent
  ipcMain.handle('Capabilities', async () => {
    return { servers: [], skills: [], skillRoots: [], plugins: [] }
  })
  
  ipcMain.handle('Settings', async () => {
    return {
      defaultModel: "deepseek", plannerModel: "", subagentModel: "", subagentEffort: "", autoPlan: "off",
      providers: [], officialProviders: [], providerPresets: [],
      permissions: { mode: "ask", allow: ["ls", "read_file"], ask: [], deny: ["Bash(rm:*)"] },
      sandbox: { bash: "off", network: true, workspaceRoot: "", allowWrite: [], effectiveWorkspaceRoot: "", effectiveWriteRoots: [""], shell: "auto", effectiveShell: "auto" },
      network: { proxyMode: "auto", proxyUrl: "", noProxy: "", proxy: { type: "socks5", server: "127.0.0.1", port: 7890, username: "", password: "" } },
      agent: { temperature: 0.2, maxSteps: 0, plannerMaxSteps: 0, maxSubagentDepth: 2, maxSubagentConcurrency: 6, maxParallelWriters: 3, systemPrompt: "You are Reasonix, a coding agent.", coldResumePrune: true, reasoningLanguage: "auto" },
      bot: { enabled: false, model: "", toolApprovalMode: "ask", maxSteps: 25, debounceMs: 1500, queueMode: "steer", queueCap: 20, queueDrop: "summarize", ignoreSelfMessages: true, selfUserIds: { qq: [], feishu: [], weixin: [] }, control: { enabled: false, addr: "127.0.0.1:37913", tokenEnv: "REASONIX_BOT_CONTROL_TOKEN" }, pairing: { enabled: true, requestTtlMinutes: 60, maxPendingPerPlatform: 3 }, routes: [], allowlist: { enabled: true, allowAll: false, qqUsers: [], feishuUsers: [], weixinUsers: [], qqApprovers: [], feishuApprovers: [], weixinApprovers: [], qqAdmins: [], feishuAdmins: [], weixinAdmins: [], qqGroups: [], feishuGroups: [], weixinGroups: [] }, qq: { enabled: false, appId: "", appSecretEnv: "QQ_BOT_APP_SECRET", secretSet: false, sandbox: false, model: "", toolApprovalMode: "ask", workspaceRoot: "", access: { enabled: true, allowAll: false, pairingEnabled: true, users: [], groups: [], approvers: [], admins: [] } }, feishu: { enabled: false, domain: "feishu", appId: "", appSecretEnv: "FEISHU_BOT_APP_SECRET", secretSet: false, verificationToken: "", mode: "webhook", webhookPort: 8080, requireMention: true }, weixin: { enabled: false, accountId: "default", tokenEnv: "WEIXIN_BOT_TOKEN", tokenSet: false, apiBase: "https://ilinkai.weixin.qq.com" }, connections: [] },
      desktopLanguage: "", desktopLayoutStyle: "workbench", desktopTheme: "auto", desktopThemeStyle: "graphite",
      conversationWidth: "standard", closeBehavior: "background", displayMode: "compact", statusBarStyle: "text",
      statusBarItems: [], defaultToolApprovalMode: "auto", checkUpdates: true, telemetry: true, metrics: true,
      configPath: "~/.hoya/config.toml", providerKinds: ["openai", "anthropic"], autoApproveTools: false, bypass: false
    }
  })

  ipcMain.handle('ListTabs', async () => [])
  ipcMain.handle('Tabs', async () => [])

  let agentWorker = null
  function getAgentWorker() {
    if (!agentWorker) {
      agentWorker = require('node:child_process').fork(path.join(__dirname, 'agent-worker.mjs'))
      agentWorker.on('message', (msg) => {
        if (msg.type === 'agent:event' && mainWindow) {
          mainWindow.webContents.send('agent:event', msg.payload)
        }
      })
      agentWorker.on('exit', () => {
        agentWorker = null
      })
    }
    return agentWorker
  }

  ipcMain.handle('Submit', async (event, input) => {
    try {
      getAgentWorker().send({ type: 'Submit', input, cwd: projectRoot() })
    } catch (e) {
      console.error(e)
    }
  })

  ipcMain.handle('Cancel', async (event) => {
    try {
      getAgentWorker().send({ type: 'Cancel' })
    } catch (e) {
      console.error(e)
    }
  })

  ipcMain.handle('CancelTab', async (event, tabID) => {
    try {
      getAgentWorker().send({ type: 'Cancel' })
    } catch (e) {
      console.error(e)
    }
  })

  ipcMain.handle('ClearSession', async (event) => {
    try {
      getAgentWorker().send({ type: 'ClearSession' })
    } catch (e) {
      console.error(e)
    }
  })

  ipcMain.handle('ClearSessionForTab', async (event) => {
    try {
      getAgentWorker().send({ type: 'ClearSession' })
    } catch (e) {
      console.error(e)
    }
  })

  ipcMain.handle('Chat', async (event, input) => {
    try {
      getAgentWorker().send({ type: 'Chat', input, cwd: projectRoot() })
    } catch (e) {
      console.error(e)
    }
  })

  createWindow()
})

const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) app.quit()

app.on('second-instance', () => {
  showMainWindow()
})

app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) showMainWindow()
  else createWindow()
})

app.on('before-quit', () => {
  isQuitting = true
  if (backgroundUpdateTimer) clearInterval(backgroundUpdateTimer)
  backgroundUpdateTimer = null
  stopBackgroundProcesses()
})

app.on('before-quit-for-update', () => {
  isQuitting = true
  stopBackgroundProcesses()
})

app.on('will-quit', () => {
  tray?.destroy()
  tray = null
})
