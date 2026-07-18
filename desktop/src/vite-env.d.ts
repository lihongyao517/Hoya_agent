/// <reference types="vite/client" />

type HoyaLanguage = 'zh-CN' | 'en-US'

interface HoyaBridge {
  serverUrl(): Promise<string>
  getLanguage(): Promise<HoyaLanguage>
  setLanguage(language: HoyaLanguage): Promise<HoyaLanguage>
  onLanguageChanged(callback: (language: HoyaLanguage) => void): () => void
  selectDirectory(): Promise<string | null>
  selectFile(): Promise<string | null>
}

declare global {
  interface Window {
    hoya: HoyaBridge
  }
}

export {}
