/// <reference types="vite/client" />

declare global {
  type HoyaLanguage = 'zh-CN' | 'en-US'

  interface HoyaBridge {
    serverUrl(): Promise<string>
    getLanguage(): Promise<HoyaLanguage>
    setLanguage(language: HoyaLanguage): Promise<HoyaLanguage>
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
}

export {}
