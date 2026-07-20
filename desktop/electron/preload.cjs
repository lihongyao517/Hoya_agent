const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hoya', {
  serverUrl: () => ipcRenderer.invoke('hoya:server-url'),
  getLanguage: () => ipcRenderer.invoke('hoya:get-language'),
  setLanguage: (language) => ipcRenderer.invoke('hoya:set-language', language),
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
