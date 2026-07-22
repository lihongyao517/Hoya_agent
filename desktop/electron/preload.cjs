const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hoya', {
  serverConnection: () => ipcRenderer.invoke('hoya:server-connection'),
  serverUrl: () => ipcRenderer.invoke('hoya:server-url'),
  onServerConnectionChanged: (callback) => {
    const listener = (_event, connection) => callback(connection)
    ipcRenderer.on('hoya:server-connection-changed', listener)
    return () => ipcRenderer.removeListener('hoya:server-connection-changed', listener)
  },
  getAppVersion: () => ipcRenderer.invoke('hoya:get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('hoya:check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('hoya:install-update'),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('hoya:update-status', listener)
    return () => ipcRenderer.removeListener('hoya:update-status', listener)
  },
  getLanguage: () => ipcRenderer.invoke('hoya:get-language'),
  setLanguage: (language) => ipcRenderer.invoke('hoya:set-language', language),
  getApiKey: (payload) => ipcRenderer.invoke('hoya:get-api-key', payload),
  saveApiKey: (payload) => ipcRenderer.invoke('hoya:save-api-key', payload),
  deleteApiKey: (payload) => ipcRenderer.invoke('hoya:delete-api-key', payload),
  getSavedApiKey: (workspace) => ipcRenderer.invoke('hoya:get-saved-api-key', workspace),
  terminalRun: (payload) => ipcRenderer.invoke('hoya:terminal-run', payload),
  terminalStop: (id) => ipcRenderer.invoke('hoya:terminal-stop', id),
  runCode: (payload) => ipcRenderer.invoke('hoya:run-code', payload),
  copyText: (text) => ipcRenderer.invoke('hoya:clipboard-write', text),
  openPath: (path) => ipcRenderer.invoke('hoya:open-path', path),
  onTerminalOutput: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('hoya:terminal-output', listener)
    return () => ipcRenderer.removeListener('hoya:terminal-output', listener)
  },
  openExternal: (url) => ipcRenderer.invoke('hoya:open-external', url),
  onLanguageChanged: (callback) => {
    const listener = (_event, language) => callback(language)
    ipcRenderer.on('hoya:language-changed', listener)
    return () => ipcRenderer.removeListener('hoya:language-changed', listener)
  },
  windowMinimize: () => ipcRenderer.invoke('hoya:window-minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('hoya:window-toggle-maximize'),
  windowIsMaximized: () => ipcRenderer.invoke('hoya:window-is-maximized'),
  windowClose: () => ipcRenderer.invoke('hoya:window-close'),
  onWindowMaximizedChanged: (callback) => {
    const listener = (_event, maximized) => callback(maximized)
    ipcRenderer.on('hoya:window-maximized-changed', listener)
    return () => ipcRenderer.removeListener('hoya:window-maximized-changed', listener)
  },
  selectDirectory: () => ipcRenderer.invoke('hoya:select-directory'),
  selectFile: () => ipcRenderer.invoke('hoya:select-file'),
})
