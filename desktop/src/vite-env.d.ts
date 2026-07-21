/// <reference types="vite/client" />

declare global {
  type HoyaLanguage = 'zh-CN' | 'en-US'
  type HoyaUpdateStatus = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'not-available' | 'manual' | 'error'
  type HoyaUpdateInfo = { ok: boolean; status: HoyaUpdateStatus; currentVersion: string; latestVersion: string; updateAvailable: boolean; autoUpdateSupported: boolean; progress: number; repositoryUrl?: string; tagsUrl?: string; releasesUrl: string; error?: string }

  interface HoyaBridge {
    serverUrl(): Promise<string>
    getAppVersion(): Promise<string>
    checkForUpdates(): Promise<HoyaUpdateInfo>
    installUpdate(): Promise<boolean>
    onUpdateStatus(callback: (status: HoyaUpdateInfo) => void): () => void
    getLanguage(): Promise<HoyaLanguage>
    setLanguage(language: HoyaLanguage): Promise<HoyaLanguage>
    getSavedApiKey(workspace: string): Promise<string>
    terminalRun(payload: { command: string; cwd: string }): Promise<{ ok: boolean; id: string; cwd: string }>
    terminalStop(id: string): Promise<boolean>
    runCode(payload: { code: string; language: string; cwd: string }): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number; timedOut: boolean; durationMs: number }>
    copyText(text: string): Promise<boolean>
    openPath(path: string): Promise<boolean>
    onTerminalOutput(callback: (payload: { id: string; stream: 'stdout' | 'stderr' | 'error' | 'exit'; data: string; code?: number }) => void): () => void
    openExternal(url: string): Promise<boolean>
    onLanguageChanged(callback: (language: HoyaLanguage) => void): () => void
    windowMinimize(): Promise<void>
    windowToggleMaximize(): Promise<boolean>
    windowIsMaximized(): Promise<boolean>
    windowClose(): Promise<void>
    onWindowMaximizedChanged(callback: (maximized: boolean) => void): () => void
    selectDirectory(): Promise<string | null>
    selectFile(): Promise<string | null>
  }

  interface Window {
    hoya: HoyaBridge
  }

  interface HTMLWebViewElement extends HTMLElement {
    src: string
    loadURL(url: string): Promise<void>
    reload(): void
    goBack(): void
    goForward(): void
    canGoBack(): boolean
    canGoForward(): boolean
  }
}

export {}
