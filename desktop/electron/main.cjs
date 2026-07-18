const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron')
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

function buildApplicationMenu() {
  const zh = currentLanguage === 'zh-CN'
  const template = [
    {
      label: 'Hoya Agent',
      submenu: [
        { role: 'quit', label: zh ? '退出' : 'Quit' },
      ],
    },
    {
      label: zh ? '语言' : 'Language',
      submenu: [
        {
          label: '中文',
          type: 'radio',
          checked: currentLanguage === 'zh-CN',
          click: () => setLanguage('zh-CN'),
        },
        {
          label: 'English',
          type: 'radio',
          checked: currentLanguage === 'en-US',
          click: () => setLanguage('en-US'),
        },
      ],
    },
    {
      label: zh ? '视图' : 'View',
      submenu: [
        { role: 'reload', label: zh ? '重新加载' : 'Reload' },
        { role: 'toggleDevTools', label: zh ? '切换开发者工具' : 'Toggle Developer Tools' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function setLanguage(language) {
  if (!supportedLanguages.has(language)) return currentLanguage
  currentLanguage = language
  saveLanguage(language)
  buildApplicationMenu()
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send('hoya:language-changed', currentLanguage)
  }
  return currentLanguage
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'Hoya Agent',
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#090b10',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  windows.add(win)
  win.on('closed', () => windows.delete(win))

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
  buildApplicationMenu()
  startBackend()
  ipcMain.handle('hoya:server-url', () => `http://${serverHost}:${serverPort}`)
  ipcMain.handle('hoya:get-language', () => currentLanguage)
  ipcMain.handle('hoya:set-language', (_event, language) => setLanguage(language))
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (backend) {
    backend.kill()
    backend = null
  }
})
