const { app, BrowserWindow, dialog, ipcMain, Menu, Tray } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const isDev = !app.isPackaged
const serverHost = '127.0.0.1'
const serverPort = process.env.HOYA_SERVER_PORT || '8787'
const supportedLanguages = new Set(['zh-CN', 'en-US'])
const windows = new Set()
let currentLanguage = 'zh-CN'
let backend = null
let mainWindow = null
let tray = null
let isQuitting = false
let backgroundNoticeShown = false

function applyDwmCornerPreference(win) {
  if (process.platform !== 'win32' || win.isDestroyed()) return

  const handle = win.getNativeWindowHandle()
  const handleValue = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : handle.readUInt32LE(0).toString()
  const command = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class HoyaDwm {',
    '  [DllImport("dwmapi.dll")]',
    '  public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);',
    '}',
    '\'@',
    `$hwnd = [IntPtr]([UInt64]${handleValue})`,
    '$cornerPreference = 2',
    '[HoyaDwm]::DwmSetWindowAttribute($hwnd, 33, [ref]$cornerPreference, 4) | Out-Null',
  ].join('\n')

  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {
    windowsHide: true,
    stdio: 'ignore',
  })
  child.on('error', (error) => console.warn(`[hoya-desktop] failed to set DWM corner preference: ${error}`))
  child.on('exit', (code) => {
    if (code !== 0) console.warn(`[hoya-desktop] DWM corner preference exited with code ${code}`)
  })
}

function projectRoot() {
  return path.resolve(__dirname, '..', '..')
}

function bundledBackendPath() {
  const exe = process.platform === 'win32' ? 'hoya-agent-backend.exe' : 'hoya-agent-backend'
  return path.join(process.resourcesPath, 'backend', 'hoya-agent-backend', exe)
}

function pythonSettingsPath() {
  const appdata = process.env.APPDATA
  if (appdata) return path.join(appdata, 'Hoya Agent', 'settings.json')
  return path.join(app.getPath('home'), '.hoya_agent', 'settings.json')
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return {}
  }
}

function initialWorkspace() {
  if (process.env.HOYA_WORKSPACE) return process.env.HOYA_WORKSPACE
  const settings = readJsonFile(pythonSettingsPath())
  if (settings.last_workspace) return settings.last_workspace
  return isDev ? projectRoot() : app.getPath('home')
}

function resolveBackendCommand() {
  const workspace = initialWorkspace()
  const bundled = bundledBackendPath()
  if (!isDev && fs.existsSync(bundled)) {
    return {
      command: bundled,
      args: ['--host', serverHost, '--port', serverPort, '--workspace', workspace],
      cwd: path.dirname(bundled),
    }
  }

  const root = projectRoot()
  return {
    command: process.env.HOYA_PYTHON || 'python',
    args: ['-m', 'hoya_agent', '--server', '--host', serverHost, '--port', serverPort, '--workspace', workspace],
    cwd: root,
  }
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadLanguage() {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    if (supportedLanguages.has(settings.language)) currentLanguage = settings.language
  } catch {
    currentLanguage = 'zh-CN'
  }
}

function saveLanguage(language) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
    const settings = readJsonFile(settingsPath())
    settings.language = language
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
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
  tray.setToolTip('Hoya Agent')
  tray.on('double-click', showMainWindow)
  rebuildTrayMenu()
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    thickFrame: false,
    show: false,
    title: 'Hoya Agent',
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#f7f9f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow = win
  windows.add(win)
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
  const applyRoundedCorners = () => {
    applyDwmCornerPreference(win)
    sendMaximizedState()
  }
  win.on('maximize', applyRoundedCorners)
  win.on('unmaximize', applyRoundedCorners)
  win.on('restore', applyRoundedCorners)
  win.on('resize', sendMaximizedState)
  win.once('ready-to-show', () => {
    win.show()
    applyRoundedCorners()
  })

  if (isDev) {
    win.loadURL('http://127.0.0.1:5173')
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

function startBackend() {
  if (backend) return
  const backendCommand = resolveBackendCommand()
  backend = spawn(backendCommand.command, backendCommand.args, {
    cwd: backendCommand.cwd,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  backend.stdout.on('data', (chunk) => console.log(`[hoya-server] ${chunk}`.trim()))
  backend.stderr.on('data', (chunk) => console.error(`[hoya-server] ${chunk}`.trim()))
  backend.on('exit', (code) => {
    console.log(`[hoya-server] exited with code ${code}`)
    backend = null
  })
}

app.whenReady().then(() => {
  loadLanguage()
  Menu.setApplicationMenu(null)
  startBackend()
  createTray()
  ipcMain.handle('hoya:server-url', () => `http://${serverHost}:${serverPort}`)
  ipcMain.handle('hoya:get-language', () => currentLanguage)
  ipcMain.handle('hoya:set-language', (_event, language) => setLanguage(language))
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
    return result.filePaths[0]
  })
  ipcMain.handle('hoya:select-file', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
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
  if (backend) {
    backend.kill()
    backend = null
  }
})

app.on('will-quit', () => {
  tray?.destroy()
  tray = null
})
