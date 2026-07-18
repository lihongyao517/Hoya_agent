import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type Language = 'zh-CN' | 'en-US'
type LlmProvider = 'openai-compatible' | 'ollama'

const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1'
const OLLAMA_DEFAULT_MODEL = 'qwen2.5-coder:7b'

type ServerStatus = {
  ok: boolean
  workspace: string
  error?: string
  provider?: string
  model?: string
  wire_api?: string
  reasoning_effort?: string
  show_reasoning?: boolean
  allow_shell?: boolean
  allow_desktop?: boolean
  require_write_approval?: boolean
  require_shell_approval?: boolean
}

type AgentEvent = {
  type: string
  text?: string
  id?: string
  operation?: PendingOperation['operation']
  path?: string
  command?: string
  risk?: PendingRisk
  name?: string
  arguments?: string
  result?: string
}

type ChatMessage = {
  role: 'user' | 'assistant' | 'system' | 'error'
  content: string
}

type Activity = {
  kind: string
  title: string
  body?: string
}

type PendingRisk = {
  level: 'low' | 'medium' | 'high' | string
  allowed?: boolean
  reasons?: string[]
}

type PendingOperation = {
  id: string
  operation?: 'write_file' | 'run_powershell' | string
  path?: string
  diff?: string
  command?: string
  risk?: PendingRisk
}

type Conversation = {
  id: string
  title: string
  created_at: string
  updated_at: string
}

type ConversationMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

type MemoryEntry = {
  created_at: string
  text: string
}

type ModelPreset = {
  id: string
  name: string
  provider: LlmProvider
  base_url: string
  model: string
  wire_api: WireApi
  reasoning_effort?: string
  show_reasoning?: boolean
}

type WireApi = 'chat' | 'responses'

type ApiConfigForm = {
  provider: LlmProvider
  apiKey: string
  apiKeyMasked: string
  baseUrl: string
  model: string
  wireApi: WireApi
  reasoningEffort: string
  showReasoning: boolean
}

type ApiFieldErrors = Partial<Record<'provider' | 'api_key' | 'base_url' | 'model' | 'wire_api' | 'reasoning_effort', string>>

type InspectorTab = 'run' | 'approvals' | 'memory' | 'history' | 'search'

type IconName =
  | 'activity'
  | 'alert'
  | 'bot'
  | 'check'
  | 'chevron-right'
  | 'clock'
  | 'code'
  | 'database'
  | 'file-diff'
  | 'file-plus'
  | 'folder-open'
  | 'folder-plus'
  | 'globe'
  | 'history'
  | 'info'
  | 'keyboard'
  | 'language'
  | 'layout'
  | 'message'
  | 'monitor'
  | 'refresh'
  | 'search'
  | 'send'
  | 'settings'
  | 'shield'
  | 'sparkles'
  | 'terminal'
  | 'user'
  | 'zap'

const emptyApiConfigForm: ApiConfigForm = {
  provider: 'openai-compatible',
  apiKey: '',
  apiKeyMasked: '',
  baseUrl: '',
  model: '',
  wireApi: 'chat',
  reasoningEffort: 'medium',
  showReasoning: true,
}

const translations = {
  'zh-CN': {
    localCodingAgent: '本地编程 Agent',
    workspace: '工作区',
    openWorkspace: '打开工作区',
    reloadConfig: '重新加载配置',
    apiConfig: 'API 配置',
    editApiConfig: '编辑 API 配置',
    saveAndReload: '保存并重载',
    cancel: '取消',
    provider: '模型来源',
    openaiCompatible: 'OpenAI 兼容接口',
    ollamaLocal: 'Ollama 本地模型',
    ollamaHint: '请先启动 Ollama，并执行 ollama pull qwen2.5-coder:7b，或填写你已安装的模型名。',
    apiKey: 'API Key',
    currentApiKey: '当前密钥',
    noApiKey: '未设置',
    newApiKeyPlaceholder: '留空则保留当前密钥',
    apiKeyOptionalForOllama: 'Ollama 本地模型不需要 API Key，保存时会清空旧密钥。',
    baseUrl: 'Base URL',
    wireApi: '接口协议',
    apiConfigSaved: 'API 配置已保存并重新加载。',
    apiConfigLoadFailed: '加载 API 配置失败',
    apiConfigSaveFailed: '保存 API 配置失败',
    indexWorkspace: '索引工作区',
    files: '文件',
    importFile: '导入文件',
    importFolder: '导入文件夹',
    search: '搜索',
    searchIndexedFiles: '搜索已索引文件',
    ready: '就绪',
    configError: '配置错误',
    disconnected: '未连接',
    model: '模型',
    api: '接口',
    providerShort: '来源',
    shell: 'Shell',
    desktopWrite: '桌面写入',
    writeApproval: '写入审批',
    on: '开',
    off: '关',
    currentTask: '当前任务',
    agentWorking: 'Agent 正在工作…',
    askHoya: '让 Hoya 处理当前仓库',
    showToolOutput: '显示工具输出',
    language: '语言',
    chinese: '中文',
    english: 'English',
    startLocalTask: '开始本地 Agent 任务',
    emptyStateDescription: '可以请求代码修改、文档搜索、文件索引或工作区分析。工具调用和差异会显示在右侧。',
    describeTask: '描述你想要的修改或调查…',
    running: '运行中',
    send: '发送',
    run: '运行',
    toolTrace: '工具轨迹',
    pendingWrites: '待审批写入',
    history: '历史',
    searchResults: '搜索结果',
    apply: '应用',
    noPendingWrites: '暂无待审批写入。',
    noHistory: '暂无历史。',
    searchFailed: '搜索失败',
    noSearchResults: '没有匹配结果。',
    indexing: '正在建立索引...',
    unknownError: '未知错误',
    tool: '工具',
    completed: '已完成',
    outputHidden: '输出已隐藏',
    emptyResponseBody: '响应内容为空',
    roleUser: '用户',
    roleAssistant: '助手',
    roleSystem: '系统',
    roleError: '错误',
    connected: '已连接',
    notReady: '不可用',
    permissions: '权限',
    inspector: '检查器',
    runTab: '运行',
    writesTab: '写入',
    historyTab: '历史',
    searchTab: '搜索',
    activityStream: '活动流',
    noActivity: '暂无工具活动。运行任务后会在这里显示调用轨迹。',
    noSearchYet: '还没有搜索结果。请先在左侧搜索已索引文件。',
    pendingDiffs: '审批差异',
    recentConversation: '最近会话',
    searchPreview: '索引搜索预览',
    enterToSend: 'Enter 发送',
    shiftEnterNewline: 'Shift + Enter 换行',
    quickStart: '快捷开始',
    quickAnalyze: '分析当前工作区',
    quickAnalyzePrompt: '分析当前工作区的结构、关键模块和可以优化的地方。',
    quickSearch: '搜索索引文件',
    quickSearchPrompt: '帮我搜索当前项目中和主要功能相关的文件，并解释它们的作用。',
    quickRefactor: '优化一个功能',
    quickRefactorPrompt: '找出当前前端界面中可以简化和美化的地方，并给出修改建议。',
    quickReview: '审查待写入',
    quickReviewPrompt: '检查待审批写入和最近工具轨迹，指出需要注意的风险。',
    workspaceChanged: (directory: string) => `已切换工作区：${directory}`,
    configReloaded: '配置已重新加载。',
    imported: (relative: string) => `已导入：${relative}`,
    indexCompleted: (files: number) => `索引完成：${files} 个文件`,
    writeApplied: (path: string) => `已应用写入：${path}`,
  },
  'en-US': {
    localCodingAgent: 'local coding agent',
    workspace: 'Workspace',
    openWorkspace: 'Open Workspace',
    reloadConfig: 'Reload Config',
    apiConfig: 'API Config',
    editApiConfig: 'Edit API Config',
    saveAndReload: 'Save & Reload',
    cancel: 'Cancel',
    provider: 'Provider',
    openaiCompatible: 'OpenAI-compatible',
    ollamaLocal: 'Ollama local model',
    ollamaHint: 'Start Ollama first, then run ollama pull qwen2.5-coder:7b or enter a model you already have.',
    apiKey: 'API Key',
    currentApiKey: 'Current key',
    noApiKey: 'Not set',
    newApiKeyPlaceholder: 'Leave blank to keep current key',
    apiKeyOptionalForOllama: 'Ollama local models do not require an API key. Saving clears the old key.',
    baseUrl: 'Base URL',
    wireApi: 'Wire API',
    apiConfigSaved: 'API config saved and reloaded.',
    apiConfigLoadFailed: 'Failed to load API config',
    apiConfigSaveFailed: 'Failed to save API config',
    indexWorkspace: 'Index Workspace',
    files: 'Files',
    importFile: 'Import File',
    importFolder: 'Import Folder',
    search: 'Search',
    searchIndexedFiles: 'Search indexed files',
    ready: 'Ready',
    configError: 'Config error',
    disconnected: 'Disconnected',
    model: 'model',
    api: 'api',
    providerShort: 'provider',
    shell: 'shell',
    desktopWrite: 'desktop write',
    writeApproval: 'write approval',
    on: 'on',
    off: 'off',
    currentTask: 'Current task',
    agentWorking: 'Agent is working…',
    askHoya: 'Ask Hoya to work in this repo',
    showToolOutput: 'show tool output',
    language: 'Language',
    chinese: '中文',
    english: 'English',
    startLocalTask: 'Start a local agent task',
    emptyStateDescription: 'Ask for code edits, document search, file indexing, or workspace analysis. Tool calls and diffs stay visible on the right.',
    describeTask: 'Describe the change or investigation you want…',
    running: 'Running',
    send: 'Send',
    run: 'Run',
    toolTrace: 'Tool trace',
    pendingWrites: 'Pending writes',
    history: 'History',
    searchResults: 'Search results',
    apply: 'Apply',
    noPendingWrites: 'No pending writes.',
    noHistory: 'No history.',
    searchFailed: 'Search failed',
    noSearchResults: 'No matching results.',
    indexing: 'Indexing workspace...',
    unknownError: 'Unknown error',
    tool: 'tool',
    completed: 'completed',
    outputHidden: 'output hidden',
    emptyResponseBody: 'Empty response body',
    roleUser: 'user',
    roleAssistant: 'assistant',
    roleSystem: 'system',
    roleError: 'error',
    connected: 'Connected',
    notReady: 'Not ready',
    permissions: 'Permissions',
    inspector: 'Inspector',
    runTab: 'Run',
    writesTab: 'Writes',
    historyTab: 'History',
    searchTab: 'Search',
    activityStream: 'Activity stream',
    noActivity: 'No tool activity yet. Run a task to see the trace here.',
    noSearchYet: 'No search output yet. Search indexed files from the left sidebar.',
    pendingDiffs: 'Approval diffs',
    recentConversation: 'Recent conversation',
    searchPreview: 'Indexed search preview',
    enterToSend: 'Enter to send',
    shiftEnterNewline: 'Shift + Enter for newline',
    quickStart: 'Quick start',
    quickAnalyze: 'Analyze workspace',
    quickAnalyzePrompt: 'Analyze the current workspace structure, key modules, and optimization opportunities.',
    quickSearch: 'Search indexed files',
    quickSearchPrompt: 'Search this project for files related to the main features and explain what they do.',
    quickRefactor: 'Polish a feature',
    quickRefactorPrompt: 'Find frontend UI areas that can be simplified and beautified, then suggest edits.',
    quickReview: 'Review pending writes',
    quickReviewPrompt: 'Review pending writes and recent tool activity, then call out risks to watch.',
    workspaceChanged: (directory: string) => `Workspace changed: ${directory}`,
    configReloaded: 'Config reloaded.',
    imported: (relative: string) => `Imported: ${relative}`,
    indexCompleted: (files: number) => `Index complete: ${files} files`,
    writeApplied: (path: string) => `Applied write: ${path}`,
  },
} satisfies Record<Language, Record<string, string | ((value: any) => string)>>

function isLanguage(value: string): value is Language {
  return value === 'zh-CN' || value === 'en-US'
}

function normalizeMarkdown(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\n{4,}$/g, '\n\n')
}

function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: 2 } as const
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      {name === 'activity' && <><path d="M22 12h-4l-3 8L9 4l-3 8H2" /></>}
      {name === 'alert' && <><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>}
      {name === 'bot' && <><path d="M12 8V4H8" /><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M9 13h.01" /><path d="M15 13h.01" /><path d="M9 17h6" /></>}
      {name === 'check' && <><path d="M20 6 9 17l-5-5" /></>}
      {name === 'chevron-right' && <><path d="m9 18 6-6-6-6" /></>}
      {name === 'clock' && <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>}
      {name === 'code' && <><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></>}
      {name === 'database' && <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>}
      {name === 'file-diff' && <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M12 18h4" /><path d="M8 13h8" /><path d="M8 17h1" /></>}
      {name === 'file-plus' && <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M12 18v-6" /><path d="M9 15h6" /></>}
      {name === 'folder-open' && <><path d="m6 14 1.5-4.5A2 2 0 0 1 9.4 8H21l-2 8a2 2 0 0 1-2 1.5H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 2h5a2 2 0 0 1 2 2v1" /></>}
      {name === 'folder-plus' && <><path d="M12 10v6" /><path d="M9 13h6" /><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></>}
      {name === 'globe' && <><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 0 20" /><path d="M12 2a15.3 15.3 0 0 0 0 20" /></>}
      {name === 'history' && <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></>}
      {name === 'info' && <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>}
      {name === 'keyboard' && <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01" /><path d="M10 9h.01" /><path d="M14 9h.01" /><path d="M18 9h.01" /><path d="M8 13h8" /><path d="M6 17h12" /></>}
      {name === 'language' && <><path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" /></>}
      {name === 'layout' && <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /><path d="M15 3v18" /></>}
      {name === 'message' && <><path d="M21 15a4 4 0 0 1-4 4H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /></>}
      {name === 'monitor' && <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></>}
      {name === 'refresh' && <><path d="M21 12a9 9 0 0 0-15-6.7L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 15 6.7L21 16" /><path d="M16 16h5v5" /></>}
      {name === 'search' && <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>}
      {name === 'send' && <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>}
      {name === 'settings' && <><path d="M12.2 2h-.4a2 2 0 0 0-2 1.7l-.1.8a2 2 0 0 1-1.1 1.5l-.8.4a2 2 0 0 1-1.8 0l-.7-.3a2 2 0 0 0-2.5.8l-.2.4a2 2 0 0 0 .4 2.6l.6.5a2 2 0 0 1 0 3l-.6.5a2 2 0 0 0-.4 2.6l.2.4a2 2 0 0 0 2.5.8l.7-.3a2 2 0 0 1 1.8 0l.8.4a2 2 0 0 1 1.1 1.5l.1.8a2 2 0 0 0 2 1.7h.4a2 2 0 0 0 2-1.7l.1-.8a2 2 0 0 1 1.1-1.5l.8-.4a2 2 0 0 1 1.8 0l.7.3a2 2 0 0 0 2.5-.8l.2-.4a2 2 0 0 0-.4-2.6l-.6-.5a2 2 0 0 1 0-3l.6-.5a2 2 0 0 0 .4-2.6l-.2-.4a2 2 0 0 0-2.5-.8l-.7.3a2 2 0 0 1-1.8 0l-.8-.4a2 2 0 0 1-1.1-1.5l-.1-.8a2 2 0 0 0-2-1.7Z" /><circle cx="12" cy="12" r="3" /></>}
      {name === 'shield' && <><path d="M20 13c0 5-3.5 7.5-7.7 8.8a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V5l8-3 8 3Z" /><path d="m9 12 2 2 4-4" /></>}
      {name === 'sparkles' && <><path d="M9.9 4.2 12 2l2.1 2.2L17 5l-2.9.8L12 8l-2.1-2.2L7 5Z" /><path d="M17.5 14 19 12.5l1.5 1.5 2 .5-2 .5-1.5 1.5-1.5-1.5-2-.5Z" /><path d="M5 14l2 2 2 6 2-6 2-2-2-2-2-6-2 6Z" /></>}
      {name === 'terminal' && <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>}
      {name === 'user' && <><path d="M19 21a7 7 0 0 0-14 0" /><circle cx="12" cy="7" r="4" /></>}
      {name === 'zap' && <><path d="M13 2 3 14h8l-1 8 10-12h-8Z" /></>}
    </svg>
  )
}

function App() {
  const [language, setLanguage] = useState<Language>('zh-CN')
  const [serverUrl, setServerUrl] = useState('')
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activities, setActivities] = useState<Activity[]>([])
  const [pending, setPending] = useState<PendingOperation[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [models, setModels] = useState<ModelPreset[]>([])
  const [activeModelId, setActiveModelId] = useState('')
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([])
  const [newMemoryText, setNewMemoryText] = useState('')
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(true)
  const [history, setHistory] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState('')
  const [task, setTask] = useState('')
  const [apiConfigOpen, setApiConfigOpen] = useState(false)
  const [apiConfigLoading, setApiConfigLoading] = useState(false)
  const [apiConfigSaving, setApiConfigSaving] = useState(false)
  const [apiConfigError, setApiConfigError] = useState('')
  const [apiFieldErrors, setApiFieldErrors] = useState<ApiFieldErrors>({})
  const [apiConfigForm, setApiConfigForm] = useState<ApiConfigForm>(emptyApiConfigForm)
  const [busy, setBusy] = useState(false)
  const [showToolDetails, setShowToolDetails] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('run')
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const t = translations[language]

  useEffect(() => {
    window.hoya.serverUrl().then((url) => {
      setServerUrl(url)
      refreshStatus(url)
      refreshPending(url)
      refreshHistory(url)
      loadApiConfig(url)
      loadConversations(url)
      loadModels(url)
      refreshMemory(url)
    })
  }, [])

  useEffect(() => {
    window.hoya.getLanguage().then((nextLanguage) => {
      if (isLanguage(nextLanguage)) setLanguage(nextLanguage)
    })
    return window.hoya.onLanguageChanged((nextLanguage) => {
      if (isLanguage(nextLanguage)) setLanguage(nextLanguage)
    })
  }, [])

  useEffect(() => {
    refreshHistory()
  }, [language])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const safeStatus: ServerStatus = useMemo(() => status ?? { ok: false, workspace: t.disconnected as string }, [status, t.disconnected])
  const canSend = safeStatus.ok && !busy && task.trim().length > 0

  async function api(url: string, path: string, init?: RequestInit) {
    const response = await fetch(`${url}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    })
    if (!response.ok) throw new Error(await response.text())
    return response
  }

  async function refreshStatus(url = serverUrl) {
    if (!url) return
    const response = await api(url, '/api/status')
    setStatus(await response.json())
  }

  async function refreshPending(url = serverUrl) {
    if (!url) return
    const response = await api(url, '/api/pending')
    const data = await response.json()
    setPending(data.entries ?? [])
  }

  async function refreshHistory(url = serverUrl) {
    if (!url) return
    const response = await api(url, '/api/history?limit=24')
    const data = await response.json()
    setHistory((data.entries ?? []).map((entry: any) => `${entry.created_at} ${entry.role}: ${String(entry.content).slice(0, 240)}`).join('\n\n') || t.noHistory as string)
  }

  async function loadConversationMessages(id: string, url = serverUrl) {
    if (!url || !id) return
    const response = await api(url, `/api/conversations/messages?id=${encodeURIComponent(id)}&limit=200`)
    const data = await response.json()
    setMessages((data.messages ?? []).filter((item: ConversationMessage) => item.role === 'user' || item.role === 'assistant' || item.role === 'system').map((item: ConversationMessage) => ({ role: item.role, content: item.content })))
  }

  async function loadConversations(url = serverUrl) {
    if (!url) return
    const response = await api(url, '/api/conversations')
    const data = await response.json()
    const list = data.conversations ?? []
    setConversations(list)
    const selected = activeConversationId || list[0]?.id || ''
    if (selected) {
      setActiveConversationId(selected)
      await loadConversationMessages(selected, url)
    }
  }

  async function createConversation() {
    if (!serverUrl || busy) return
    const response = await api(serverUrl, '/api/conversations', { method: 'POST', body: JSON.stringify({ title: language === 'zh-CN' ? '新对话' : 'New conversation' }) })
    const data = await response.json()
    const id = data.conversation?.id ?? ''
    if (id) {
      setActiveConversationId(id)
      setMessages([])
      await loadConversations()
    }
  }

  async function selectConversation(id: string) {
    if (!serverUrl || busy || id === activeConversationId) return
    setActiveConversationId(id)
    await loadConversationMessages(id)
  }

  async function deleteConversation(id: string) {
    if (!serverUrl || busy) return
    await api(serverUrl, '/api/conversations/delete', { method: 'POST', body: JSON.stringify({ id }) })
    setActiveConversationId('')
    await loadConversations()
  }

  async function loadModels(url = serverUrl) {
    if (!url) return
    const response = await api(url, '/api/models')
    const data = await response.json()
    setModels(data.models ?? [])
    setActiveModelId(data.active_model_id ?? '')
  }

  async function saveCurrentModelPreset() {
    if (!serverUrl) return
    const name = apiConfigForm.model || (language === 'zh-CN' ? '模型预设' : 'Model preset')
    const response = await api(serverUrl, '/api/models', {
      method: 'POST',
      body: JSON.stringify({
        name,
        provider: apiConfigForm.provider,
        base_url: apiConfigForm.baseUrl,
        model: apiConfigForm.model,
        wire_api: apiConfigForm.provider === 'ollama' ? 'chat' : apiConfigForm.wireApi,
        reasoning_effort: apiConfigForm.reasoningEffort,
        show_reasoning: apiConfigForm.showReasoning,
      }),
    })
    const data = await response.json()
    setActiveModelId(data.model?.id ?? '')
    await loadModels()
  }

  async function selectModelPreset(id: string) {
    if (!serverUrl) return
    const response = await api(serverUrl, '/api/models/select', { method: 'POST', body: JSON.stringify({ id }) })
    const data = await response.json()
    setStatus(data.status)
    await loadApiConfig()
    await loadModels()
  }

  async function deleteModelPreset(id: string) {
    if (!serverUrl) return
    await api(serverUrl, '/api/models/delete', { method: 'POST', body: JSON.stringify({ id }) })
    await loadModels()
  }

  async function refreshMemory(url = serverUrl) {
    if (!url) return
    const response = await api(url, '/api/memory')
    const data = await response.json()
    setMemoryEntries(data.memory ?? [])
  }

  async function addMemory() {
    if (!serverUrl || !newMemoryText.trim()) return
    await api(serverUrl, '/api/memory', { method: 'POST', body: JSON.stringify({ text: newMemoryText.trim() }) })
    setNewMemoryText('')
    await refreshMemory()
  }

  async function deleteMemory(createdAt: string) {
    if (!serverUrl) return
    await api(serverUrl, '/api/memory/delete', { method: 'POST', body: JSON.stringify({ created_at: createdAt }) })
    await refreshMemory()
  }

  async function chooseWorkspace() {
    const directory = await window.hoya.selectDirectory()
    if (!directory || !serverUrl) return
    const response = await api(serverUrl, '/api/workspace', {
      method: 'POST',
      body: JSON.stringify({ workspace: directory }),
    })
    setStatus(await response.json())
    setMessages((prev) => [...prev, { role: 'system', content: t.workspaceChanged(directory) }])
    refreshPending()
    refreshHistory()
    loadApiConfig()
    loadConversations()
    loadModels()
    refreshMemory()
  }

  async function reloadConfig() {
    if (!serverUrl) return
    const response = await api(serverUrl, '/api/reload', { method: 'POST', body: '{}' })
    setStatus(await response.json())
    loadApiConfig()
    setMessages((prev) => [...prev, { role: 'system', content: t.configReloaded as string }])
  }

  async function loadApiConfig(url = serverUrl) {
    if (!url) return
    setApiConfigLoading(true)
    setApiConfigError('')
    try {
      const response = await api(url, '/api/config')
      const data = await response.json()
      const config = data.config ?? {}
      const provider: LlmProvider = config.provider === 'ollama' ? 'ollama' : 'openai-compatible'
      const wireApi = config.wire_api === 'responses' ? 'responses' : 'chat'
      setApiConfigForm({
        provider,
        apiKey: '',
        apiKeyMasked: config.api_key_masked ?? '',
        baseUrl: config.base_url ?? '',
        model: config.model ?? '',
        wireApi,
        reasoningEffort: config.reasoning_effort ?? 'medium',
        showReasoning: Boolean(config.show_reasoning),
      })
      setApiFieldErrors({})
    } catch (error) {
      setApiConfigError(`${t.apiConfigLoadFailed}: ${String(error)}`)
    } finally {
      setApiConfigLoading(false)
    }
  }

  async function openApiConfig() {
    setApiConfigOpen(true)
    await loadApiConfig()
  }

  function closeApiConfig() {
    setApiConfigOpen(false)
    setApiConfigError('')
    setApiFieldErrors({})
  }

  async function saveApiConfig() {
    if (!serverUrl || apiConfigSaving) return
    setApiConfigSaving(true)
    setApiConfigError('')
    setApiFieldErrors({})
    try {
      const payload: Record<string, string | boolean> = {
        provider: apiConfigForm.provider,
        base_url: apiConfigForm.baseUrl,
        model: apiConfigForm.model,
        wire_api: apiConfigForm.provider === 'ollama' ? 'chat' : apiConfigForm.wireApi,
        reasoning_effort: apiConfigForm.reasoningEffort,
        show_reasoning: apiConfigForm.showReasoning,
      }
      if (apiConfigForm.provider === 'ollama') {
        payload.clear_api_key = true
      } else if (apiConfigForm.apiKey.trim()) {
        payload.api_key = apiConfigForm.apiKey.trim()
      }
      const response = await fetch(`${serverUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (!response.ok) {
        setApiFieldErrors(data.field_errors ?? {})
        setApiConfigError(data.error || t.apiConfigSaveFailed as string)
        return
      }
      setStatus(data)
      setMessages((prev) => [...prev, { role: 'system', content: t.apiConfigSaved as string }])
      await loadApiConfig()
      await loadModels()
    } catch (error) {
      setApiConfigError(`${t.apiConfigSaveFailed}: ${String(error)}`)
    } finally {
      setApiConfigSaving(false)
    }
  }

  async function importPath(kind: 'file' | 'directory') {
    if (!serverUrl) return
    const source = kind === 'file' ? await window.hoya.selectFile() : await window.hoya.selectDirectory()
    if (!source) return
    const response = await api(serverUrl, '/api/import', {
      method: 'POST',
      body: JSON.stringify({ source }),
    })
    const data = await response.json()
    setMessages((prev) => [...prev, { role: data.ok ? 'system' : 'error', content: data.ok ? t.imported(data.relative) : data.error }])
  }

  async function buildWorkspaceIndex() {
    if (!serverUrl) return
    setInspectorTab('run')
    setActivities((prev) => [...prev, { kind: 'index', title: t.indexing as string }])
    const response = await api(serverUrl, '/api/index', { method: 'POST', body: '{}' })
    const data = await response.json()
    setMessages((prev) => [...prev, { role: data.ok ? 'system' : 'error', content: data.ok ? t.indexCompleted(data.files) : data.error }])
  }

  async function searchIndex() {
    if (!serverUrl || !searchQuery.trim()) return
    setInspectorTab('search')
    const response = await api(serverUrl, `/api/search?q=${encodeURIComponent(searchQuery)}&limit=12`)
    const data = await response.json()
    if (!data.ok) {
      setSearchResults(data.error || t.searchFailed as string)
      return
    }
    setSearchResults((data.results ?? []).map((item: any) => `${item.score}  ${item.path}\n${String(item.preview ?? '').slice(0, 240)}`).join('\n\n') || t.noSearchResults as string)
  }

  async function applyPending(id: string) {
    if (!serverUrl) return
    const response = await api(serverUrl, '/api/pending/apply', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
    const data = await response.json()
    const label = data.operation === 'run_powershell'
      ? `Shell ${data.returncode ?? ''}`.trim()
      : data.path
    setMessages((prev) => [...prev, { role: data.ok ? 'system' : 'error', content: data.ok ? t.writeApplied(label) : data.error }])
    refreshPending()
  }

  async function denyPending(id: string) {
    if (!serverUrl) return
    const response = await api(serverUrl, '/api/pending/deny', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
    const data = await response.json()
    setMessages((prev) => [...prev, { role: data.ok ? 'system' : 'error', content: data.ok ? `Denied pending operation: ${id}` : data.error }])
    refreshPending()
  }

  async function submitTask() {
    if (!serverUrl || !task.trim() || busy) return
    const currentTask = task.trim()
    setTask('')
    setBusy(true)
    setInspectorTab('run')
    setMessages((prev) => [...prev, { role: 'user', content: currentTask }, { role: 'assistant', content: '' }])

    try {
      const response = await api(serverUrl, '/api/chat', {
        method: 'POST',
        body: JSON.stringify({ task: currentTask, conversation_id: activeConversationId }),
      })
      if (!response.body) throw new Error(t.emptyResponseBody as string)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          handleAgentEvent(JSON.parse(line) as AgentEvent)
        }
      }
      if (buffer.trim()) handleAgentEvent(JSON.parse(buffer) as AgentEvent)
    } catch (error) {
      setMessages((prev) => [...prev, { role: 'error', content: String(error) }])
    } finally {
      setBusy(false)
      refreshPending()
      refreshHistory()
      loadConversations()
    }
  }

  function handleAgentEvent(event: AgentEvent) {
    if (event.type === 'status') {
      setActivities((prev) => [...prev, { kind: 'status', title: event.text ?? t.running as string }])
      return
    }
    if (event.type === 'reasoning') {
      setActivities((prev) => [...prev, { kind: 'reasoning', title: event.text ?? 'Public reasoning summary' }])
      return
    }
    if (event.type === 'approval_required') {
      setInspectorTab('approvals')
      setActivities((prev) => [...prev, { kind: 'approval', title: event.text ?? 'Operation is pending approval', body: event.command || event.path }])
      refreshPending()
      return
    }
    if (event.type === 'token') {
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.role === 'assistant') last.content += event.text ?? ''
        return next
      })
      return
    }
    if (event.type === 'tool_start') {
      setActivities((prev) => [...prev, { kind: 'tool', title: `${event.name ?? t.tool} ${event.arguments ?? ''}`.slice(0, 280) }])
      return
    }
    if (event.type === 'tool_result') {
      setActivities((prev) => [...prev, { kind: 'tool', title: `${event.name ?? t.tool} ${t.completed}`, body: showToolDetails ? event.result : t.outputHidden as string }])
      return
    }
    if (event.type === 'done') return
    if (event.type === 'error') {
      setMessages((prev) => [...prev, { role: 'error', content: event.text ?? t.unknownError as string }])
    }
  }

  function roleLabel(role: ChatMessage['role']) {
    if (role === 'user') return t.roleUser as string
    if (role === 'assistant') return t.roleAssistant as string
    if (role === 'system') return t.roleSystem as string
    return t.roleError as string
  }

  function roleIcon(role: ChatMessage['role']): IconName {
    if (role === 'user') return 'user'
    if (role === 'assistant') return 'bot'
    if (role === 'system') return 'info'
    return 'alert'
  }

  function changeLanguage(nextLanguage: Language) {
    setLanguage(nextLanguage)
    window.hoya.setLanguage(nextLanguage)
  }

  function changeProvider(provider: LlmProvider) {
    setApiConfigForm((prev) => {
      if (provider === 'ollama') {
        return {
          ...prev,
          provider,
          apiKey: '',
          baseUrl: OLLAMA_DEFAULT_BASE_URL,
          model: prev.model || OLLAMA_DEFAULT_MODEL,
          wireApi: 'chat',
        }
      }
      return { ...prev, provider }
    })
  }

  function toggleApiConfig() {
    setApiConfigOpen((open) => !open)
    if (!apiConfigOpen) loadApiConfig()
  }

  function fillQuickPrompt(prompt: string) {
    setTask(prompt)
  }

  function ActionButton({ icon, children, onClick, disabled, variant = 'secondary' }: { icon: IconName; children: React.ReactNode; onClick: () => void; disabled?: boolean; variant?: 'primary' | 'secondary' | 'ghost' }) {
    return (
      <button className={`action-button ${variant}`} disabled={disabled} onClick={onClick} type="button">
        <span className="action-icon"><Icon name={icon} /></span>
        <span className="action-label">{children}</span>
        <Icon name="chevron-right" size={15} className="action-chevron" />
      </button>
    )
  }

  function SectionHeader({ icon, title, onClick, open }: { icon: IconName; title: React.ReactNode; onClick?: () => void; open?: boolean }) {
    const content = (
      <>
        <span className="section-icon"><Icon name={icon} size={15} /></span>
        <span>{title}</span>
        {onClick && <Icon name="chevron-right" size={14} className="section-chevron" />}
      </>
    )
    if (onClick) {
      return <button className={`section-header section-toggle ${open ? 'open' : ''}`} aria-expanded={open} onClick={onClick} type="button">{content}</button>
    }
    return <div className="section-header">{content}</div>
  }

  function StatusChip({ icon, label, value, active = true }: { icon: IconName; label: React.ReactNode; value: React.ReactNode; active?: boolean }) {
    return (
      <span className={`status-chip ${active ? 'active' : 'muted'}`}>
        <Icon name={icon} size={13} />
        <span>{label}</span>
        <strong>{value}</strong>
      </span>
    )
  }

  function InspectorTabButton({ tab, icon, label, count }: { tab: InspectorTab; icon: IconName; label: React.ReactNode; count?: number }) {
    const active = inspectorTab === tab
    return (
      <button
        aria-selected={active}
        className={`inspector-tab ${active ? 'active' : ''}`}
        id={`tab-${tab}`}
        onClick={() => setInspectorTab(tab)}
        role="tab"
        type="button"
      >
        <Icon name={icon} size={16} />
        <span>{label}</span>
        {typeof count === 'number' && <b className="badge">{count}</b>}
      </button>
    )
  }

  function EmptyPanel({ icon, title, description }: { icon: IconName; title: React.ReactNode; description: React.ReactNode }) {
    return (
      <div className="empty-panel">
        <span className="empty-panel-icon"><Icon name={icon} /></span>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    )
  }

  function MarkdownMessage({ content }: { content: string }) {
    const lines = normalizeMarkdown(content).split('\n')
    const nodes: React.ReactNode[] = []
    let index = 0
    while (index < lines.length) {
      const line = lines[index]
      if (line.startsWith('```')) {
        const languageLabel = line.slice(3).trim()
        const code: string[] = []
        index += 1
        while (index < lines.length && !lines[index].startsWith('```')) {
          code.push(lines[index])
          index += 1
        }
        if (index < lines.length) index += 1
        nodes.push(<pre key={nodes.length} data-language={languageLabel}><code>{code.join('\n')}</code></pre>)
        continue
      }
      if (!line.trim()) {
        index += 1
        continue
      }
      const heading = /^(#{1,3})\s+(.+)$/.exec(line)
      if (heading) {
        const level = heading[1].length
        const text = heading[2]
        nodes.push(level === 1 ? <h1 key={nodes.length}>{text}</h1> : level === 2 ? <h2 key={nodes.length}>{text}</h2> : <h3 key={nodes.length}>{text}</h3>)
        index += 1
        continue
      }
      if (/^[-*]\s+/.test(line)) {
        const items: string[] = []
        while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
          items.push(lines[index].replace(/^[-*]\s+/, ''))
          index += 1
        }
        nodes.push(<ul key={nodes.length}>{items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>)
        continue
      }
      if (/^\d+\.\s+/.test(line)) {
        const items: string[] = []
        while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
          items.push(lines[index].replace(/^\d+\.\s+/, ''))
          index += 1
        }
        nodes.push(<ol key={nodes.length}>{items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ol>)
        continue
      }
      if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
        const headers = line.split('|').map((cell) => cell.trim()).filter(Boolean)
        index += 2
        const rows: string[][] = []
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
          rows.push(lines[index].split('|').map((cell) => cell.trim()).filter(Boolean))
          index += 1
        }
        nodes.push(
          <table key={nodes.length}>
            <thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{cell}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
          </table>
        )
        continue
      }
      const paragraph: string[] = [line]
      index += 1
      while (index < lines.length && lines[index].trim() && !lines[index].startsWith('```') && !/^(#{1,3})\s+/.test(lines[index]) && !/^[-*]\s+/.test(lines[index]) && !/^\d+\.\s+/.test(lines[index])) {
        paragraph.push(lines[index])
        index += 1
      }
      nodes.push(<p key={nodes.length}>{paragraph.join(' ')}</p>)
    }
    return <div className="markdown">{nodes}</div>
  }

  function MessageCard({ message }: { message: ChatMessage }) {
    return (
      <div className={`message ${message.role}`}>
        <div className="message-header">
          <span className="message-icon"><Icon name={roleIcon(message.role)} size={15} /></span>
          <b>{roleLabel(message.role)}</b>
        </div>
        <MarkdownMessage content={message.content} />
      </div>
    )
  }

  function activityIcon(kind: string): IconName {
    if (kind === 'tool') return 'terminal'
    if (kind === 'index') return 'database'
    if (kind === 'status') return 'activity'
    if (kind === 'reasoning') return 'sparkles'
    if (kind === 'approval') return 'shield'
    return 'info'
  }

  const quickPrompts = [
    { icon: 'layout' as IconName, title: t.quickAnalyze as string, prompt: t.quickAnalyzePrompt as string },
    { icon: 'search' as IconName, title: t.quickSearch as string, prompt: t.quickSearchPrompt as string },
    { icon: 'sparkles' as IconName, title: t.quickRefactor as string, prompt: t.quickRefactorPrompt as string },
    { icon: 'shield' as IconName, title: t.quickReview as string, prompt: t.quickReviewPrompt as string },
  ]

  return (
    <div className="app shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">HY</div>
          <div className="brand-copy">
            <div className="brand-row">
              <h1>Hoya Agent</h1>
              <span className={`connection-dot ${safeStatus.ok ? 'ok' : 'error'}`} title={safeStatus.ok ? t.connected as string : t.notReady as string} />
            </div>
            <p>{t.localCodingAgent}</p>
          </div>
        </div>

        <div className="nav-section">
          <SectionHeader icon="folder-open" title={t.workspace} onClick={() => setWorkspaceMenuOpen((open) => !open)} open={workspaceMenuOpen} />
          {workspaceMenuOpen && (
            <div className="collapsible-section">
              <ActionButton icon="folder-open" onClick={chooseWorkspace}>{t.openWorkspace}</ActionButton>
              <ActionButton icon="refresh" onClick={reloadConfig}>{t.reloadConfig}</ActionButton>
              <ActionButton icon="settings" onClick={toggleApiConfig}>{t.apiConfig}</ActionButton>
              <ActionButton icon="database" onClick={buildWorkspaceIndex}>{t.indexWorkspace}</ActionButton>
            </div>
          )}
          {apiConfigOpen && (
            <div className="config-editor">
              <SectionHeader icon="settings" title={t.editApiConfig} />
              <label className="config-field">
                <span>{t.provider}</span>
                <select value={apiConfigForm.provider} onChange={(e) => changeProvider(e.target.value as LlmProvider)}>
                  <option value="openai-compatible">{t.openaiCompatible}</option>
                  <option value="ollama">{t.ollamaLocal}</option>
                </select>
                {apiFieldErrors.provider && <span className="field-error">{apiFieldErrors.provider}</span>}
              </label>
              {apiConfigForm.provider === 'ollama' ? (
                <div className="secret-hint">{t.apiKeyOptionalForOllama}</div>
              ) : (
                <>
                  <div className="secret-hint">{t.currentApiKey}: {apiConfigForm.apiKeyMasked || t.noApiKey}</div>
                  <label className="config-field">
                    <span>{t.apiKey}</span>
                    <input type="password" value={apiConfigForm.apiKey} onChange={(e) => setApiConfigForm((prev) => ({ ...prev, apiKey: e.target.value }))} placeholder={t.newApiKeyPlaceholder as string} />
                    {apiFieldErrors.api_key && <span className="field-error">{apiFieldErrors.api_key}</span>}
                  </label>
                </>
              )}
              {apiConfigForm.provider === 'ollama' && <div className="config-hint">{t.ollamaHint}</div>}
              <label className="config-field">
                <span>{t.baseUrl}</span>
                <input value={apiConfigForm.baseUrl} onChange={(e) => setApiConfigForm((prev) => ({ ...prev, baseUrl: e.target.value }))} placeholder={apiConfigForm.provider === 'ollama' ? OLLAMA_DEFAULT_BASE_URL : 'https://example.com/v1'} />
                {apiFieldErrors.base_url && <span className="field-error">{apiFieldErrors.base_url}</span>}
              </label>
              <label className="config-field">
                <span>{t.model}</span>
                <input value={apiConfigForm.model} onChange={(e) => setApiConfigForm((prev) => ({ ...prev, model: e.target.value }))} placeholder={apiConfigForm.provider === 'ollama' ? OLLAMA_DEFAULT_MODEL : 'gpt-4o-mini'} />
                {apiFieldErrors.model && <span className="field-error">{apiFieldErrors.model}</span>}
              </label>
              <label className="config-field">
                <span>{t.wireApi}</span>
                <select disabled={apiConfigForm.provider === 'ollama'} value={apiConfigForm.provider === 'ollama' ? 'chat' : apiConfigForm.wireApi} onChange={(e) => setApiConfigForm((prev) => ({ ...prev, wireApi: e.target.value as WireApi }))}>
                  <option value="chat">chat</option>
                  <option value="responses">responses</option>
                </select>
                {apiFieldErrors.wire_api && <span className="field-error">{apiFieldErrors.wire_api}</span>}
              </label>
              <label className="config-field">
                <span>{language === 'zh-CN' ? '推理强度' : 'Reasoning effort'}</span>
                <select value={apiConfigForm.reasoningEffort} onChange={(e) => setApiConfigForm((prev) => ({ ...prev, reasoningEffort: e.target.value }))}>
                  <option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option>
                </select>
                {apiFieldErrors.reasoning_effort && <span className="field-error">{apiFieldErrors.reasoning_effort}</span>}
              </label>
              <label className="switch-row compact-switch">
                <input type="checkbox" checked={apiConfigForm.showReasoning} onChange={(e) => setApiConfigForm((prev) => ({ ...prev, showReasoning: e.target.checked }))} />
                <span className="switch-track"><span /></span>
                <span>{language === 'zh-CN' ? '显示公开推理摘要' : 'Show public reasoning summaries'}</span>
              </label>
              {apiConfigError && <div className="field-error">{apiConfigError}</div>}
              <div className="config-actions">
                <button className="button primary" disabled={apiConfigLoading || apiConfigSaving} onClick={saveApiConfig} type="button">{apiConfigSaving ? t.running : t.saveAndReload}</button>
                <button className="button ghost" disabled={apiConfigSaving} onClick={closeApiConfig} type="button">{t.cancel}</button>
              </div>
            </div>
          )}
        </div>

        <div className="nav-section">
          <SectionHeader icon="message" title={language === 'zh-CN' ? '对话' : 'Conversations'} />
          <button className="button secondary full" disabled={busy} onClick={createConversation} type="button"><Icon name="message" size={14} />{language === 'zh-CN' ? '新建对话' : 'New chat'}</button>
          <div className="list-stack">
            {conversations.slice(0, 8).map((item) => (
              <div className={`list-row ${item.id === activeConversationId ? 'active' : ''}`} key={item.id}>
                <button disabled={busy} onClick={() => selectConversation(item.id)} title={item.title} type="button">{item.title}</button>
                <button className="mini-danger" disabled={busy} onClick={() => deleteConversation(item.id)} title="delete" type="button">×</button>
              </div>
            ))}
          </div>
        </div>

        <div className="nav-section">
          <SectionHeader icon="bot" title={language === 'zh-CN' ? '模型' : 'Models'} />
          <button className="button secondary full" onClick={saveCurrentModelPreset} type="button"><Icon name="file-plus" size={14} />{language === 'zh-CN' ? '保存当前模型' : 'Save current model'}</button>
          <div className="list-stack">
            {models.slice(0, 6).map((item) => (
              <div className={`list-row ${item.id === activeModelId ? 'active' : ''}`} key={item.id}>
                <button onClick={() => selectModelPreset(item.id)} title={`${item.provider} · ${item.model}`} type="button">{item.name}</button>
                <button className="mini-danger" onClick={() => deleteModelPreset(item.id)} title="delete" type="button">×</button>
              </div>
            ))}
          </div>
        </div>

        <div className="nav-section">
          <SectionHeader icon="file-plus" title={t.files} />
          <ActionButton icon="file-plus" onClick={() => importPath('file')}>{t.importFile}</ActionButton>
          <ActionButton icon="folder-plus" onClick={() => importPath('directory')}>{t.importFolder}</ActionButton>
        </div>

        <div className="nav-section">
          <SectionHeader icon="search" title={t.search} />
          <div className="search-box">
            <div className="input-shell">
              <Icon name="search" size={16} />
              <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && searchIndex()} placeholder={t.searchIndexedFiles as string} />
            </div>
            <button className="button secondary" onClick={searchIndex} type="button"><Icon name="search" size={16} />{t.search}</button>
          </div>
        </div>

        <div className="status-card">
          <div className="status-card-top">
            <span className={`status-pill ${safeStatus.ok ? 'ready' : 'error'}`}>
              <Icon name={safeStatus.ok ? 'check' : 'alert'} size={14} />
              {safeStatus.ok ? t.ready : t.configError}
            </span>
            <span className="status-mini">{safeStatus.ok ? t.connected : t.notReady}</span>
          </div>
          <div className="workspace-path mono" title={safeStatus.workspace}>{safeStatus.workspace}</div>
          {safeStatus.error && <span className="error-text">{safeStatus.error}</span>}
          <div className="chip-grid">
            {safeStatus.provider && <StatusChip icon="globe" label={t.providerShort} value={safeStatus.provider} />}
            {safeStatus.model && <StatusChip icon="bot" label={t.model} value={safeStatus.model} />}
            {safeStatus.wire_api && <StatusChip icon="code" label={t.api} value={safeStatus.wire_api} />}
            {safeStatus.reasoning_effort && <StatusChip icon="sparkles" label={language === 'zh-CN' ? '推理' : 'effort'} value={safeStatus.reasoning_effort} />}
            <StatusChip icon="info" label={language === 'zh-CN' ? '摘要' : 'reasoning'} value={safeStatus.show_reasoning ? t.on : t.off} active={Boolean(safeStatus.show_reasoning)} />
            <StatusChip icon="terminal" label={t.shell} value={safeStatus.allow_shell ? t.on : t.off} active={Boolean(safeStatus.allow_shell)} />
            <StatusChip icon="monitor" label={t.desktopWrite} value={safeStatus.allow_desktop ? t.on : t.off} active={Boolean(safeStatus.allow_desktop)} />
            <StatusChip icon="shield" label={t.writeApproval} value={safeStatus.require_write_approval ? t.on : t.off} active={Boolean(safeStatus.require_write_approval)} />
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <span className="eyebrow">{t.currentTask}</span>
            <h2>{busy ? t.agentWorking : t.askHoya}</h2>
          </div>
          <div className="topbar-actions">
            <span className={`run-state ${busy ? 'busy' : safeStatus.ok ? 'ready' : 'error'}`}>
              <Icon name={busy ? 'activity' : safeStatus.ok ? 'check' : 'alert'} size={14} />
              {busy ? t.running : safeStatus.ok ? t.ready : t.notReady}
            </span>
            <label className="language-select">
              <Icon name="language" size={15} />
              <span>{t.language}</span>
              <select value={language} onChange={(e) => changeLanguage(e.target.value as Language)}>
                <option value="zh-CN">{t.chinese}</option>
                <option value="en-US">{t.english}</option>
              </select>
            </label>
            <label className="switch-row">
              <input type="checkbox" checked={showToolDetails} onChange={(e) => setShowToolDetails(e.target.checked)} />
              <span className="switch-track"><span /></span>
              <span>{t.showToolOutput}</span>
            </label>
          </div>
        </header>

        <section className="chat">
          {messages.length === 0 && (
            <div className="empty-state">
              <div className="empty-mark"><Icon name="sparkles" size={26} /></div>
              <span className="eyebrow">{t.quickStart}</span>
              <h3>{t.startLocalTask}</h3>
              <p>{t.emptyStateDescription}</p>
              <div className="quick-grid">
                {quickPrompts.map((item) => (
                  <button className="quick-card" key={item.title} onClick={() => fillQuickPrompt(item.prompt)} type="button">
                    <Icon name={item.icon} size={17} />
                    <span>{item.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message, index) => <MessageCard key={index} message={message} />)}
          <div ref={chatEndRef} />
        </section>
        <section className="composer">
          <div className="composer-shell">
            <textarea value={task} onChange={(e) => setTask(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitTask() } }} placeholder={t.describeTask as string} />
            <div className="composer-hints">
              <span><Icon name="keyboard" size={13} />{t.enterToSend}</span>
              <span>{t.shiftEnterNewline}</span>
            </div>
          </div>
          <button className="send-button" disabled={!canSend} onClick={submitTask} type="button">
            <Icon name="send" size={18} />
            <span>{busy ? t.running : t.send}</span>
          </button>
        </section>
      </main>

      <aside className="inspector">
        <div className="inspector-head">
          <span className="eyebrow">{t.inspector}</span>
          <h2>{inspectorTab === 'run' ? t.activityStream : inspectorTab === 'approvals' ? t.pendingDiffs : inspectorTab === 'memory' ? (language === 'zh-CN' ? '记忆' : 'Memory') : inspectorTab === 'history' ? t.recentConversation : t.searchPreview}</h2>
        </div>
        <div className="inspector-tabs" role="tablist" aria-label={t.inspector as string}>
          <InspectorTabButton tab="run" icon="activity" label={t.runTab} count={activities.length} />
          <InspectorTabButton tab="approvals" icon="file-diff" label={language === 'zh-CN' ? '审批' : 'Approvals'} count={pending.length} />
          <InspectorTabButton tab="memory" icon="database" label={language === 'zh-CN' ? '记忆' : 'Memory'} count={memoryEntries.length} />
          <InspectorTabButton tab="history" icon="history" label={t.historyTab} />
          <InspectorTabButton tab="search" icon="search" label={t.searchTab} />
        </div>

        <div className="inspector-body" role="tabpanel" aria-labelledby={`tab-${inspectorTab}`}>
          {inspectorTab === 'run' && (
            <div className="panel scroll trace-panel">
              {activities.length === 0 ? <EmptyPanel icon="activity" title={t.toolTrace} description={t.noActivity} /> : activities.map((item, index) => (
                <div key={index} className="activity">
                  <span className="timeline-icon"><Icon name={activityIcon(item.kind)} size={14} /></span>
                  <div>
                    <b title={item.title}>[{item.kind}] {item.title}</b>
                    {item.body && <pre>{item.body}</pre>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {inspectorTab === 'approvals' && (
            <div className="panel scroll writes-panel">
              {pending.length === 0 ? <EmptyPanel icon="file-diff" title={t.pendingWrites} description={t.noPendingWrites} /> : pending.map((item) => (
                <div key={item.id} className="pending">
                  <div className="pending-head">
                    <Icon name={item.operation === 'run_powershell' ? 'terminal' : 'file-diff'} size={15} />
                    <b title={item.path || item.command}>{item.operation === 'run_powershell' ? 'Shell' : item.path}</b>
                  </div>
                  {item.risk && <div className={`risk risk-${item.risk.level}`}><b>{item.risk.level}</b> {(item.risk.reasons ?? []).join('; ')}</div>}
                  {item.command && <pre>{item.command}</pre>}
                  {item.diff && <pre>{item.diff}</pre>}
                  <div className="pending-actions">
                    <button className="button primary compact" onClick={() => applyPending(item.id)} type="button"><Icon name="check" size={14} />{item.operation === 'run_powershell' ? (language === 'zh-CN' ? '执行' : 'Execute') : t.apply}</button>
                    <button className="button ghost compact" onClick={() => denyPending(item.id)} type="button">{language === 'zh-CN' ? '拒绝' : 'Deny'}</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {inspectorTab === 'memory' && (
            <div className="panel scroll memory-panel">
              <div className="memory-editor">
                <textarea value={newMemoryText} onChange={(e) => setNewMemoryText(e.target.value)} placeholder={language === 'zh-CN' ? '添加需要长期记住的偏好或项目事实；不要保存密钥。' : 'Add durable preferences or project facts; do not store secrets.'} />
                <button className="button primary compact" onClick={addMemory} type="button">{language === 'zh-CN' ? '记住' : 'Remember'}</button>
              </div>
              {memoryEntries.length === 0 ? <EmptyPanel icon="database" title={language === 'zh-CN' ? '暂无记忆' : 'No memory'} description={language === 'zh-CN' ? '手动添加，或让 Agent 在任务中保存偏好。' : 'Add entries manually or let the agent save durable preferences.'} /> : memoryEntries.map((item) => (
                <div className="memory-item" key={item.created_at}>
                  <small>{item.created_at}</small>
                  <p>{item.text}</p>
                  <button className="button ghost compact" onClick={() => deleteMemory(item.created_at)} type="button">{language === 'zh-CN' ? '删除' : 'Delete'}</button>
                </div>
              ))}
            </div>
          )}

          {inspectorTab === 'history' && (
            <pre className="panel scroll small history-panel">{history || t.noHistory as string}</pre>
          )}

          {inspectorTab === 'search' && (
            searchResults ? <pre className="panel scroll small search-panel">{searchResults}</pre> : <div className="panel"><EmptyPanel icon="search" title={t.searchResults} description={t.noSearchYet} /></div>
          )}
        </div>
      </aside>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
