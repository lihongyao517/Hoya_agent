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
  selectDirectory: () => ipcRenderer.invoke('hoya:select-directory'),
  selectFile: () => ipcRenderer.invoke('hoya:select-file'),
})
