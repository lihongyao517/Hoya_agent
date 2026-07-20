import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import appIconUrl from '../assets/icon.png'
import {
  Activity,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  Database,
  Ellipsis,
  FileDiff,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Globe2,
  History,
  Info,
  Keyboard,
  Languages,
  LayoutDashboard,
  Maximize2,
  MessageSquare,
  Minus,
  Monitor,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import './styles.css'

type Language = 'zh-CN' | 'en-US'
type LlmProvider = 'openai-compatible' | 'anthropic' | 'ollama'
type ConversationColor = '' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'pink'

const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'
const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1'
const OLLAMA_DEFAULT_MODEL = 'qwen2.5-coder:7b'
const CONVERSATION_COLORS: Exclude<ConversationColor, ''>[] = ['blue', 'green', 'amber', 'red', 'purple', 'pink']
const CONVERSATION_COLOR_VALUES: Record<Exclude<ConversationColor, ''>, string> = {
  blue: '#79c0ff',
  green: '#7ee787',
  amber: '#f0b07d',
  red: '#ff8b81',
  purple: '#d2a8ff',
  pink: '#f778ba',
}

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
  run_id?: string
  run?: TaskRun
  change?: TaskChange
  sources?: Array<Record<string, unknown>>
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
  run_id?: string
}

type TaskPlanItem = {
  id: 'context' | 'execute' | 'verify' | 'deliver' | string
  title: string
  status: 'pending' | 'in_progress' | 'waiting' | 'completed' | 'failed' | 'cancelled' | string
  note?: string
}

type TaskChange = {
  version_id: string
  path?: string
  verification?: { ok?: boolean; summary?: string }
  auto_rollback?: boolean
  rolled_back_at?: string
}

type TaskRun = {
  id: string
  conversation_id: string
  task: string
  status: string
  context_summary?: string
  plan?: TaskPlanItem[]
  changes?: TaskChange[]
  updated_at?: string
}

type Conversation = {
  id: string
  title: string
  color?: ConversationColor
  kind?: 'task'
  status?: 'open' | 'done'
  created_at: string
  updated_at: string
}

type Project = {
  id: string
  name: string
  path: string
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

type WireApi = 'chat' | 'responses' | 'messages'

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
  | 'copy'
  | 'database'
  | 'edit'
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
  | 'maximize'
  | 'message'
  | 'minimize'
  | 'monitor'
  | 'more'
  | 'palette'
  | 'plus'
  | 'refresh'
  | 'rollback'
  | 'search'
  | 'send'
  | 'settings'
  | 'shield'
  | 'sparkles'
  | 'square'
  | 'terminal'
  | 'trash'
  | 'user'
  | 'x'
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

const desktopBridge: HoyaBridge = window.hoya ?? {
  serverUrl: async () => '',
  getLanguage: async () => 'zh-CN',
  setLanguage: async (language) => language,
  onLanguageChanged: () => () => undefined,
  windowMinimize: async () => undefined,
  windowToggleMaximize: async () => false,
  windowIsMaximized: async () => false,
  windowClose: async () => undefined,
  onWindowMaximizedChanged: () => () => undefined,
  selectDirectory: async () => null,
  selectFile: async () => null,
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
    save: '保存',
    cancel: '取消',
    provider: '模型来源',
    openaiCompatible: 'OpenAI 兼容接口',
    anthropicApi: 'Anthropic 原生接口',
    ollamaLocal: 'Ollama 本地模型',
    ollamaHint: '请先启动 Ollama，并执行 ollama pull qwen2.5-coder:7b，或填写你已安装的模型名。',
    anthropicHint: '支持 Anthropic 官方地址或兼容 Anthropic Messages API 的中转站地址。',
    relayHint: '中转站可填写 /v1 基础地址，也可直接填写完整的 chat/completions 或 responses 地址。',
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
    startLocalTask: '开始构建',
    emptyStateDescription: '可以请求代码修改、文档搜索、文件索引或工作区分析。工具调用和差异会显示在右侧。',
    describeTask: '描述你想要的修改或调查…',
    running: '运行中',
    stop: '停止',
    stopping: '正在停止',
    stopped: '任务已由用户停止。',
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
    renameConversation: '重命名对话',
    colorConversation: '设置高亮颜色',
    deleteConversation: '删除对话',
    clearColor: '清除高亮颜色',
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
    save: 'Save',
    cancel: 'Cancel',
    provider: 'Provider',
    openaiCompatible: 'OpenAI-compatible',
    anthropicApi: 'Anthropic native API',
    ollamaLocal: 'Ollama local model',
    ollamaHint: 'Start Ollama first, then run ollama pull qwen2.5-coder:7b or enter a model you already have.',
    anthropicHint: 'Use Anthropic directly or a relay compatible with the Anthropic Messages API.',
    relayHint: 'For a relay, enter its /v1 base URL or the full chat/completions or responses endpoint.',
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
    startLocalTask: "Let's build",
    emptyStateDescription: 'Ask for code edits, document search, file indexing, or workspace analysis. Tool calls and diffs stay visible on the right.',
    describeTask: 'Describe the change or investigation you want…',
    running: 'Running',
    stop: 'Stop',
    stopping: 'Stopping',
    stopped: 'Task stopped by user.',
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
    renameConversation: 'Rename conversation',
    colorConversation: 'Set highlight color',
    deleteConversation: 'Delete conversation',
    clearColor: 'Clear highlight color',
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

const icons: Record<IconName, LucideIcon> = {
  activity: Activity,
  alert: TriangleAlert,
  bot: Bot,
  check: Check,
  'chevron-right': ChevronRight,
  clock: Clock3,
  code: Code2,
  copy: Copy,
  database: Database,
  edit: Pencil,
  'file-diff': FileDiff,
  'file-plus': FilePlus2,
  'folder-open': FolderOpen,
  'folder-plus': FolderPlus,
  globe: Globe2,
  history: History,
  info: Info,
  keyboard: Keyboard,
  language: Languages,
  layout: LayoutDashboard,
  maximize: Maximize2,
  message: MessageSquare,
  minimize: Minus,
  monitor: Monitor,
  more: Ellipsis,
  palette: Palette,
  plus: Plus,
  refresh: RefreshCw,
  rollback: RotateCcw,
  search: Search,
  send: SendHorizontal,
  settings: Settings,
  shield: ShieldCheck,
  sparkles: Sparkles,
  square: Square,
  terminal: Terminal,
  trash: Trash2,
  user: UserRound,
  x: X,
  zap: Zap,
}

function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  const IconComponent = icons[name]
  return <IconComponent aria-hidden="true" className={`icon ${className}`} size={size} strokeWidth={1.8} />
}

function App() {
  const [language, setLanguage] = useState<Language>('zh-CN')
  const [serverUrl, setServerUrl] = useState('')
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activities, setActivities] = useState<Activity[]>([])
  const [currentRun, setCurrentRun] = useState<TaskRun | null>(null)
  const [pending, setPending] = useState<PendingOperation[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [conversationEditingId, setConversationEditingId] = useState('')
  const [conversationTitleDraft, setConversationTitleDraft] = useState('')
  const [conversationMenuId, setConversationMenuId] = useState('')
  const [models, setModels] = useState<ModelPreset[]>([])
  const [activeModelId, setActiveModelId] = useState('')
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([])
  const [newMemoryText, setNewMemoryText] = useState('')
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [utilitiesOpen, setUtilitiesOpen] = useState(false)
  const [projectCreatorOpen, setProjectCreatorOpen] = useState(false)
  const [projectParent, setProjectParent] = useState('')
  const [projectName, setProjectName] = useState('')
  const [projectError, setProjectError] = useState('')
  const [projectCreating, setProjectCreating] = useState(false)
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
  const [runStarted, setRunStarted] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [approvalBusyId, setApprovalBusyId] = useState('')
  const [showToolDetails, setShowToolDetails] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('run')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [windowMaximized, setWindowMaximized] = useState(false)
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const activeRunIdRef = useRef('')
  const chatAbortControllerRef = useRef<AbortController | null>(null)
  const stopRequestedRef = useRef(false)
  const t = translations[language]

  useEffect(() => {
    desktopBridge.serverUrl().then((url) => {
      setServerUrl(url)
      refreshStatus(url)
      refreshPending(url)
      refreshHistory(url)
      loadApiConfig(url)
      loadConversations(url)
      loadProjects(url)
      loadModels(url)
      refreshMemory(url)
    })
  }, [])

  useEffect(() => {
    desktopBridge.getLanguage().then((nextLanguage) => {
      if (isLanguage(nextLanguage)) setLanguage(nextLanguage)
    })
    return desktopBridge.onLanguageChanged((nextLanguage) => {
      if (isLanguage(nextLanguage)) setLanguage(nextLanguage)
    })
  }, [])

  useEffect(() => {
    desktopBridge.windowIsMaximized().then(setWindowMaximized)
    return desktopBridge.onWindowMaximizedChanged(setWindowMaximized)
  }, [])

  useEffect(() => {
    refreshHistory()
  }, [language])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const safeStatus: ServerStatus = useMemo(() => status ?? { ok: false, workspace: t.disconnected as string }, [status, t.disconnected])
  const canSend = safeStatus.ok && !busy && task.trim().length > 0
  const activeConversationTitle = conversations.find((item) => item.id === activeConversationId)?.title

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

  async function loadLatestRun(conversationId = activeConversationId, url = serverUrl) {
    if (!url || !conversationId) {
      setCurrentRun(null)
      return
    }
    const response = await api(url, `/api/runs?conversation_id=${encodeURIComponent(conversationId)}&limit=1`)
    const data = await response.json()
    setCurrentRun(data.latest ?? null)
  }

  async function loadConversationMessages(id: string, url = serverUrl) {
    if (!url || !id) return
    const response = await api(url, `/api/conversations/messages?id=${encodeURIComponent(id)}&limit=200`)
    const data = await response.json()
    setMessages((data.messages ?? []).filter((item: ConversationMessage) => item.role === 'user' || item.role === 'assistant' || item.role === 'system').map((item: ConversationMessage) => ({ role: item.role, content: item.content })))
  }

  async function loadConversations(url = serverUrl, preferredId = '', reloadMessages = true) {
    if (!url) return
    const response = await api(url, '/api/tasks')
    const data = await response.json()
    const list: Conversation[] = data.tasks ?? []
    setConversations(list)
    const currentId = preferredId || activeConversationId
    const selected = list.some((item) => item.id === currentId) ? currentId : list[0]?.id || ''
    if (selected) {
      setActiveConversationId(selected)
      await Promise.all([
        reloadMessages ? loadConversationMessages(selected, url) : Promise.resolve(),
        loadLatestRun(selected, url),
      ])
    } else {
      setCurrentRun(null)
    }
  }

  async function createTask() {
    if (!serverUrl || busy) return
    const response = await api(serverUrl, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: language === 'zh-CN' ? '新任务' : 'New task' }) })
    const data = await response.json()
    const id = data.task?.id ?? ''
    if (id) {
      setActiveConversationId(id)
      setMessages([])
      setConversationMenuId('')
      await loadConversations(serverUrl, id)
    }
  }

  async function selectConversation(id: string) {
    if (!serverUrl || busy || id === activeConversationId) return
    setActiveConversationId(id)
    setConversationMenuId('')
    await Promise.all([loadConversationMessages(id), loadLatestRun(id)])
  }

  async function loadProjects(url = serverUrl) {
    if (!url) return
    const response = await api(url, '/api/projects')
    const data = await response.json()
    setProjects(data.projects ?? [])
  }

  async function refreshProjectWorkspace(url = serverUrl) {
    await Promise.all([
      refreshPending(url),
      refreshHistory(url),
      loadApiConfig(url),
      loadConversations(url, ''),
      loadProjects(url),
      loadModels(url),
      refreshMemory(url),
    ])
  }

  async function selectProject(project: Project) {
    if (!serverUrl || busy || project.path === safeStatus.workspace) return
    const response = await api(serverUrl, '/api/projects/select', {
      method: 'POST',
      body: JSON.stringify({ path: project.path }),
    })
    const data = await response.json()
    setStatus(data.status)
    setMessages([])
    setActiveConversationId('')
    await refreshProjectWorkspace()
  }

  async function beginCreateProject() {
    const parent = await desktopBridge.selectDirectory()
    if (!parent) return
    setProjectParent(parent)
    setProjectName(language === 'zh-CN' ? '新项目' : 'new-project')
    setProjectError('')
    setProjectCreatorOpen(true)
  }

  function closeProjectCreator() {
    if (projectCreating) return
    setProjectCreatorOpen(false)
    setProjectError('')
  }

  async function createProject() {
    if (!serverUrl || projectCreating || !projectParent || !projectName.trim()) return
    setProjectCreating(true)
    setProjectError('')
    try {
      const response = await api(serverUrl, '/api/projects', {
        method: 'POST',
        body: JSON.stringify({ parent: projectParent, name: projectName.trim() }),
      })
      const data = await response.json()
      setStatus(data.status)
      setMessages([])
      setActiveConversationId('')
      setProjectCreatorOpen(false)
      await refreshProjectWorkspace()
    } catch (error) {
      setProjectError(String(error))
    } finally {
      setProjectCreating(false)
    }
  }

  function beginRenameConversation(item: Conversation) {
    setConversationEditingId(item.id)
    setConversationTitleDraft(item.title)
    setConversationMenuId('')
  }

  function cancelRenameConversation() {
    setConversationEditingId('')
    setConversationTitleDraft('')
  }

  async function saveConversationTitle(id: string) {
    const title = conversationTitleDraft.trim()
    if (!serverUrl || !title) return
    const response = await api(serverUrl, '/api/conversations/update', {
      method: 'POST',
      body: JSON.stringify({ id, title }),
    })
    const data = await response.json()
    setConversations((prev) => prev.map((item) => item.id === id ? data.conversation : item))
    cancelRenameConversation()
  }

  async function setConversationColor(id: string, color: ConversationColor) {
    if (!serverUrl) return
    const response = await api(serverUrl, '/api/conversations/update', {
      method: 'POST',
      body: JSON.stringify({ id, color }),
    })
    const data = await response.json()
    setConversations((prev) => prev.map((item) => item.id === id ? data.conversation : item))
    setConversationMenuId('')
  }

  async function deleteConversation(id: string) {
    if (!serverUrl || busy) return
    await api(serverUrl, '/api/conversations/delete', { method: 'POST', body: JSON.stringify({ id }) })
    setConversationMenuId('')
    setConversationEditingId('')
    await loadConversations(serverUrl, id === activeConversationId ? '' : activeConversationId)
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
        wire_api: apiConfigForm.provider === 'ollama' ? 'chat' : apiConfigForm.provider === 'anthropic' ? 'messages' : apiConfigForm.wireApi,
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
    const directory = await desktopBridge.selectDirectory()
    if (!directory || !serverUrl) return
    const response = await api(serverUrl, '/api/workspace', {
      method: 'POST',
      body: JSON.stringify({ workspace: directory }),
    })
    setStatus(await response.json())
    setMessages([])
    setActiveConversationId('')
    await refreshProjectWorkspace()
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
      const provider: LlmProvider = config.provider === 'ollama' ? 'ollama' : config.provider === 'anthropic' ? 'anthropic' : 'openai-compatible'
      const wireApi: WireApi = config.wire_api === 'responses' ? 'responses' : config.wire_api === 'messages' ? 'messages' : 'chat'
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
        wire_api: apiConfigForm.provider === 'ollama' ? 'chat' : apiConfigForm.provider === 'anthropic' ? 'messages' : apiConfigForm.wireApi,
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
    const source = kind === 'file' ? await desktopBridge.selectFile() : await desktopBridge.selectDirectory()
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
    if (!serverUrl || approvalBusyId) return
    setApprovalBusyId(id)
    try {
      const response = await api(serverUrl, '/api/pending/apply', {
        method: 'POST',
        body: JSON.stringify({ id }),
      })
      const data = await response.json()
      const label = data.operation === 'run_powershell'
        ? `Shell ${data.returncode ?? ''}`.trim()
        : data.path
      setActivities((prev) => [...prev, { kind: data.ok ? 'approval' : 'error', title: data.ok ? t.writeApplied(label) : data.error }])
      await refreshPending()
      if (data.resumable && data.run_id) {
        await resumeRun(data.run_id)
      } else {
        setMessages((prev) => [...prev, { role: data.ok ? 'system' : 'error', content: data.ok ? t.writeApplied(label) : data.error }])
      }
    } catch (error) {
      setMessages((prev) => [...prev, { role: 'error', content: String(error) }])
    } finally {
      setApprovalBusyId('')
    }
  }

  async function denyPending(id: string) {
    if (!serverUrl || approvalBusyId) return
    setApprovalBusyId(id)
    try {
      const response = await api(serverUrl, '/api/pending/deny', {
        method: 'POST',
        body: JSON.stringify({ id }),
      })
      const data = await response.json()
      setActivities((prev) => [...prev, { kind: 'approval', title: language === 'zh-CN' ? `已拒绝操作 ${id}` : `Denied operation ${id}` }])
      await refreshPending()
      if (data.resumable && data.run_id) {
        await resumeRun(data.run_id)
      } else {
        setMessages((prev) => [...prev, { role: data.ok ? 'system' : 'error', content: data.ok ? `Denied pending operation: ${id}` : data.error }])
      }
    } catch (error) {
      setMessages((prev) => [...prev, { role: 'error', content: String(error) }])
    } finally {
      setApprovalBusyId('')
    }
  }

  async function rollbackVersion(versionId: string) {
    if (!serverUrl || busy) return
    const response = await api(serverUrl, '/api/versions/rollback', {
      method: 'POST',
      body: JSON.stringify({ version_id: versionId }),
    })
    const data = await response.json()
    setActivities((prev) => [...prev, {
      kind: data.ok ? 'rollback' : 'error',
      title: data.ok
        ? (language === 'zh-CN' ? `已回滚 ${data.path}` : `Rolled back ${data.path}`)
        : data.error,
    }])
    await loadLatestRun()
  }

  async function stopTask() {
    const runId = activeRunIdRef.current
    if (!serverUrl || !busy || !runStarted || !runId || stopping) return
    setStopping(true)
    stopRequestedRef.current = true
    try {
      await api(serverUrl, '/api/chat/cancel', {
        method: 'POST',
        body: JSON.stringify({ run_id: runId }),
      })
    } catch (error) {
      setActivities((prev) => [...prev, { kind: 'error', title: String(error) }])
    } finally {
      chatAbortControllerRef.current?.abort()
    }
  }

  async function submitTask() {
    if (!serverUrl || !task.trim() || busy) return
    const currentTask = task.trim()
    const runId = crypto.randomUUID()
    const abortController = new AbortController()
    activeRunIdRef.current = runId
    chatAbortControllerRef.current = abortController
    stopRequestedRef.current = false
    setTask('')
    setBusy(true)
    setRunStarted(false)
    setStopping(false)
    setInspectorTab('run')
    setCurrentRun(null)
    setMessages((prev) => [...prev, { role: 'user', content: currentTask }, { role: 'assistant', content: '' }])

    try {
      const response = await api(serverUrl, '/api/chat', {
        method: 'POST',
        body: JSON.stringify({ task: currentTask, conversation_id: activeConversationId, run_id: runId }),
        signal: abortController.signal,
      })
      await consumeAgentStream(response)
    } catch (error) {
      const aborted = stopRequestedRef.current || (error instanceof Error && error.name === 'AbortError')
      if (aborted) {
        setMessages((prev) => {
          const next = [...prev]
          if (next.at(-1)?.role === 'assistant' && !next.at(-1)?.content.trim()) next.pop()
          if (next.at(-1)?.role !== 'system' || next.at(-1)?.content !== t.stopped) {
            next.push({ role: 'system', content: t.stopped as string })
          }
          return next
        })
        setActivities((prev) => [...prev, { kind: 'cancelled', title: t.stopped as string }])
      } else {
        setMessages((prev) => [...prev, { role: 'error', content: String(error) }])
      }
    } finally {
      setBusy(false)
      setRunStarted(false)
      setStopping(false)
      activeRunIdRef.current = ''
      chatAbortControllerRef.current = null
      refreshPending()
      refreshHistory()
      loadConversations(serverUrl, activeConversationId, false)
    }
  }

  async function consumeAgentStream(response: Response) {
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
  }

  async function resumeRun(runId: string) {
    if (!serverUrl || busy) return
    const abortController = new AbortController()
    activeRunIdRef.current = runId
    chatAbortControllerRef.current = abortController
    stopRequestedRef.current = false
    setBusy(true)
    setRunStarted(false)
    setStopping(false)
    setInspectorTab('run')
    setMessages((prev) => prev.at(-1)?.role === 'assistant' ? prev : [...prev, { role: 'assistant', content: '' }])
    try {
      const response = await api(serverUrl, '/api/runs/resume', {
        method: 'POST',
        body: JSON.stringify({ run_id: runId }),
        signal: abortController.signal,
      })
      await consumeAgentStream(response)
    } catch (error) {
      const aborted = stopRequestedRef.current || (error instanceof Error && error.name === 'AbortError')
      if (!aborted) setMessages((prev) => [...prev, { role: 'error', content: String(error) }])
    } finally {
      setBusy(false)
      setRunStarted(false)
      setStopping(false)
      activeRunIdRef.current = ''
      chatAbortControllerRef.current = null
      await Promise.all([refreshPending(), refreshHistory(), loadLatestRun()])
      loadConversations(serverUrl, activeConversationId, false)
    }
  }

  function handleAgentEvent(event: AgentEvent) {
    if (event.type === 'run_started') {
      setRunStarted(true)
      return
    }
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
    if (event.type === 'cancelled') {
      setActivities((prev) => [...prev, { kind: 'cancelled', title: event.text ?? t.stopped as string }])
      setMessages((prev) => prev.at(-1)?.role === 'system' && prev.at(-1)?.content === t.stopped
        ? prev
        : [...prev, { role: 'system', content: t.stopped as string }])
      return
    }
    if (event.type === 'run_state' && event.run) {
      setCurrentRun(event.run)
      return
    }
    if (event.type === 'context_summary') {
      setActivities((prev) => [...prev, { kind: 'context', title: event.text ?? '' }])
      return
    }
    if (event.type === 'verification') {
      const verification = event.change?.verification
      setActivities((prev) => [...prev, {
        kind: verification?.ok ? 'verification' : 'error',
        title: `${event.change?.path ?? ''}: ${verification?.summary ?? (language === 'zh-CN' ? '校验完成' : 'Verification completed')}`,
      }])
      return
    }
    if (event.type === 'stale_repeat') {
      setActivities((prev) => [...prev, { kind: 'context', title: event.text ?? (language === 'zh-CN' ? '检测到可能复读，建议新建对话。' : 'Possible stale repeat detected. Start a new chat if this is off-topic.') }])
      return
    }
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
    desktopBridge.setLanguage(nextLanguage)
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
      if (provider === 'anthropic') {
        return {
          ...prev,
          provider,
          baseUrl: prev.provider === 'anthropic' ? prev.baseUrl : ANTHROPIC_DEFAULT_BASE_URL,
          model: prev.provider === 'anthropic' ? prev.model : '',
          wireApi: 'messages',
        }
      }
      return {
        ...prev,
        provider,
        baseUrl: prev.provider === 'openai-compatible' ? prev.baseUrl : '',
        model: prev.provider === 'openai-compatible' ? prev.model : '',
        wireApi: prev.wireApi === 'responses' ? 'responses' : 'chat',
      }
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
        {message.role !== 'user' && (
          <div className="message-header">
            <span className="message-icon"><Icon name={roleIcon(message.role)} size={15} /></span>
            <b>{roleLabel(message.role)}</b>
          </div>
        )}
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
    if (kind === 'verification') return 'check'
    if (kind === 'rollback') return 'rollback'
    if (kind === 'cancelled') return 'square'
    if (kind === 'error') return 'alert'
    return 'info'
  }

  const quickPrompts = [
    { icon: 'layout' as IconName, title: t.quickAnalyze as string, prompt: t.quickAnalyzePrompt as string },
    { icon: 'search' as IconName, title: t.quickSearch as string, prompt: t.quickSearchPrompt as string },
    { icon: 'sparkles' as IconName, title: t.quickRefactor as string, prompt: t.quickRefactorPrompt as string },
    { icon: 'shield' as IconName, title: t.quickReview as string, prompt: t.quickReviewPrompt as string },
  ]

  function TaskComposer({ embedded = false }: { embedded?: boolean }) {
    return (
      <section className={`composer ${embedded ? 'embedded' : ''}`}>
        <div className="composer-shell">
          <textarea
            aria-label={t.describeTask as string}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submitTask()
              }
            }}
            placeholder={t.describeTask as string}
          />
          <div className="composer-toolbar">
            <button aria-label={t.openWorkspace as string} className="composer-tool" onClick={chooseWorkspace} title={t.openWorkspace as string} type="button"><Icon name="plus" size={17} /></button>
            <span className={`composer-status ${safeStatus.ok ? 'ready' : 'error'}`}><span />{safeStatus.ok ? t.ready : t.notReady}</span>
          </div>
        </div>
        <button
          aria-label={stopping ? t.stopping as string : busy ? t.stop as string : t.send as string}
          className={`send-button ${busy ? 'stop-button' : ''}`}
          disabled={busy ? stopping || !runStarted : !canSend}
          onClick={busy ? stopTask : submitTask}
          title={busy ? t.stop as string : t.send as string}
          type="button"
        >
          <Icon name={busy ? 'square' : 'send'} size={18} />
        </button>
      </section>
    )
  }

  return (
    <div className={`app shell ${inspectorOpen ? 'inspector-open' : 'inspector-closed'} ${windowMaximized ? 'window-maximized' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="logo"><img alt="" src={appIconUrl} /></div>
          <div className="brand-copy">
            <div className="brand-row">
              <h1>Hoya Agent</h1>
              <span className={`connection-dot ${safeStatus.ok ? 'ok' : 'error'}`} title={safeStatus.ok ? t.connected as string : t.notReady as string} />
            </div>
            <p>{t.localCodingAgent}</p>
          </div>
        </div>

        <div className="sidebar-scroll">
        <div className="nav-section nav-workspace">
          <SectionHeader icon="folder-open" title={language === 'zh-CN' ? '项目' : 'Projects'} />
          <div className="project-actions">
            <button className="action-button project-action-button" disabled={busy} onClick={beginCreateProject} type="button"><span className="action-icon"><Icon name="folder-plus" /></span><span className="action-label">{language === 'zh-CN' ? '新建项目' : 'New project'}</span></button>
            <button className="action-button project-action-button" disabled={busy} onClick={chooseWorkspace} type="button"><span className="action-icon"><Icon name="folder-open" /></span><span className="action-label">{language === 'zh-CN' ? '打开项目' : 'Open project'}</span></button>
          </div>
          <div className="list-stack project-list">
            {projects.slice(0, 6).map((project) => (
              <div className={`list-row project-row ${project.path === safeStatus.workspace ? 'active' : ''}`} key={project.id}>
                <button disabled={busy} onClick={() => selectProject(project)} title={project.path} type="button">
                  <Icon name="folder-open" size={15} />
                  <span><strong>{project.name}</strong><small>{project.path}</small></span>
                </button>
              </div>
            ))}
          </div>
          <SectionHeader icon="settings" title={language === 'zh-CN' ? '项目工具' : 'Project tools'} onClick={() => setWorkspaceMenuOpen((open) => !open)} open={workspaceMenuOpen} />
          {workspaceMenuOpen && (
            <div className="collapsible-section">
              <ActionButton icon="refresh" onClick={reloadConfig}>{t.reloadConfig}</ActionButton>
              <ActionButton icon="settings" onClick={toggleApiConfig}>{t.apiConfig}</ActionButton>
              <ActionButton icon="database" onClick={buildWorkspaceIndex}>{t.indexWorkspace}</ActionButton>
            </div>
          )}
          {apiConfigOpen && (
            <>
            <button className="modal-backdrop" aria-label={t.cancel as string} onClick={closeApiConfig} type="button" />
            <div aria-modal="true" className="config-editor" role="dialog">
              <div className="config-modal-head">
                <div>
                  <span className="eyebrow">Hoya Agent</span>
                  <h2>{t.editApiConfig}</h2>
                </div>
                <button aria-label={t.cancel as string} className="icon-button" onClick={closeApiConfig} title={t.cancel as string} type="button"><Icon name="x" /></button>
              </div>
              <label className="config-field">
                <span>{t.provider}</span>
                <select value={apiConfigForm.provider} onChange={(e) => changeProvider(e.target.value as LlmProvider)}>
                  <option value="openai-compatible">{t.openaiCompatible}</option>
                  <option value="anthropic">{t.anthropicApi}</option>
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
              {apiConfigForm.provider === 'anthropic' && <div className="config-hint">{t.anthropicHint}</div>}
              {apiConfigForm.provider === 'openai-compatible' && <div className="config-hint">{t.relayHint}</div>}
              <label className="config-field">
                <span>{t.baseUrl}</span>
                <input value={apiConfigForm.baseUrl} onChange={(e) => setApiConfigForm((prev) => ({ ...prev, baseUrl: e.target.value }))} placeholder={apiConfigForm.provider === 'ollama' ? OLLAMA_DEFAULT_BASE_URL : apiConfigForm.provider === 'anthropic' ? ANTHROPIC_DEFAULT_BASE_URL : 'https://relay.example.com/v1'} />
                {apiFieldErrors.base_url && <span className="field-error">{apiFieldErrors.base_url}</span>}
              </label>
              <label className="config-field">
                <span>{t.model}</span>
                <input value={apiConfigForm.model} onChange={(e) => setApiConfigForm((prev) => ({ ...prev, model: e.target.value }))} placeholder={apiConfigForm.provider === 'ollama' ? OLLAMA_DEFAULT_MODEL : apiConfigForm.provider === 'anthropic' ? 'claude-opus-4-8' : 'gpt-4o-mini'} />
                {apiFieldErrors.model && <span className="field-error">{apiFieldErrors.model}</span>}
              </label>
              <label className="config-field">
                <span>{t.wireApi}</span>
                <select disabled={apiConfigForm.provider !== 'openai-compatible'} value={apiConfigForm.provider === 'ollama' ? 'chat' : apiConfigForm.provider === 'anthropic' ? 'messages' : apiConfigForm.wireApi} onChange={(e) => setApiConfigForm((prev) => ({ ...prev, wireApi: e.target.value as WireApi }))}>
                  <option value="chat">chat</option>
                  <option value="responses">responses</option>
                  <option value="messages">messages</option>
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
            </>
          )}
          {projectCreatorOpen && (
            <>
              <button className="modal-backdrop" aria-label={t.cancel as string} onClick={closeProjectCreator} type="button" />
              <div aria-modal="true" className="config-editor project-creator" role="dialog">
                <div className="config-modal-head">
                  <div>
                    <span className="eyebrow">Hoya Agent</span>
                    <h2>{language === 'zh-CN' ? '新建项目' : 'New project'}</h2>
                  </div>
                  <button aria-label={t.cancel as string} className="icon-button" onClick={closeProjectCreator} title={t.cancel as string} type="button"><Icon name="x" /></button>
                </div>
                <label className="config-field">
                  <span>{language === 'zh-CN' ? '保存位置' : 'Location'}</span>
                  <input readOnly value={projectParent} />
                </label>
                <label className="config-field">
                  <span>{language === 'zh-CN' ? '项目名称' : 'Project name'}</span>
                  <input autoFocus maxLength={80} value={projectName} onChange={(event) => setProjectName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && createProject()} />
                </label>
                {projectError && <div className="field-error">{projectError}</div>}
                <div className="config-actions">
                  <button className="button primary" disabled={projectCreating || !projectName.trim()} onClick={createProject} type="button">{projectCreating ? t.running : (language === 'zh-CN' ? '创建并打开' : 'Create and open')}</button>
                  <button className="button ghost" disabled={projectCreating} onClick={closeProjectCreator} type="button">{t.cancel}</button>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="nav-section nav-conversations">
          <SectionHeader icon="message" title={language === 'zh-CN' ? '任务' : 'Tasks'} />
          <button className="button full new-task-button" disabled={busy} onClick={createTask} type="button"><Icon name="file-plus" size={16} />{language === 'zh-CN' ? '新建任务' : 'New task'}</button>
          <div className="list-stack">
            {conversations.slice(0, 8).map((item) => (
              <div
                className={`list-row conversation-row ${item.id === activeConversationId ? 'active' : ''} ${item.color ? 'has-color' : ''}`}
                key={item.id}
                style={{ '--conversation-color': item.color ? CONVERSATION_COLOR_VALUES[item.color] : 'var(--c-brand)' } as React.CSSProperties}
              >
                <span className="conversation-marker" aria-hidden="true" />
                {conversationEditingId === item.id ? (
                  <div className="conversation-edit">
                    <input
                      autoFocus
                      maxLength={120}
                      value={conversationTitleDraft}
                      onChange={(e) => setConversationTitleDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveConversationTitle(item.id)
                        if (e.key === 'Escape') cancelRenameConversation()
                      }}
                    />
                    <button disabled={!conversationTitleDraft.trim()} onClick={() => saveConversationTitle(item.id)} title={t.save as string} type="button"><Icon name="check" size={13} /></button>
                    <button onClick={cancelRenameConversation} title={t.cancel as string} type="button"><Icon name="x" size={13} /></button>
                  </div>
                ) : (
                  <>
                    <button className="conversation-title" disabled={busy} onClick={() => selectConversation(item.id)} onDoubleClick={() => beginRenameConversation(item)} title={item.title} type="button">{item.title}</button>
                    <button className="conversation-menu-button" aria-expanded={conversationMenuId === item.id} disabled={busy} onClick={() => setConversationMenuId((current) => current === item.id ? '' : item.id)} title={language === 'zh-CN' ? '对话操作' : 'Conversation actions'} type="button"><Icon name="more" size={14} /></button>
                  </>
                )}
                {conversationMenuId === item.id && (
                  <div className="conversation-tools">
                    <button disabled={busy} onClick={() => beginRenameConversation(item)} title={t.renameConversation as string} type="button"><Icon name="edit" size={14} /></button>
                    <span className="conversation-palette" title={t.colorConversation as string}>
                      <Icon name="palette" size={14} />
                      {CONVERSATION_COLORS.map((color) => (
                        <button
                          aria-label={`${t.colorConversation}: ${color}`}
                          className={`color-swatch ${item.color === color ? 'selected' : ''}`}
                          disabled={busy}
                          key={color}
                          onClick={() => setConversationColor(item.id, color)}
                          style={{ backgroundColor: CONVERSATION_COLOR_VALUES[color] }}
                          type="button"
                        />
                      ))}
                      <button className="clear-color" disabled={busy} onClick={() => setConversationColor(item.id, '')} title={t.clearColor as string} type="button"><Icon name="x" size={12} /></button>
                    </span>
                    <button className="mini-danger" disabled={busy} onClick={() => deleteConversation(item.id)} title={t.deleteConversation as string} type="button"><Icon name="trash" size={14} /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="nav-section nav-utilities">
          <SectionHeader icon="layout" title={language === 'zh-CN' ? '资源与工具' : 'Resources & tools'} onClick={() => setUtilitiesOpen((open) => !open)} open={utilitiesOpen} />
          {utilitiesOpen && (
            <div className="utility-stack">
              <div className="utility-group">
                <div className="utility-label"><Icon name="bot" size={14} /><span>{language === 'zh-CN' ? '模型' : 'Models'}</span></div>
                <button className="button secondary full" onClick={saveCurrentModelPreset} type="button"><Icon name="file-plus" size={14} />{language === 'zh-CN' ? '保存当前模型' : 'Save current model'}</button>
                <div className="list-stack">
                  {models.slice(0, 6).map((item) => (
                    <div className={`list-row ${item.id === activeModelId ? 'active' : ''}`} key={item.id}>
                      <button onClick={() => selectModelPreset(item.id)} title={`${item.provider} · ${item.model}`} type="button">{item.name}</button>
                      <button aria-label={language === 'zh-CN' ? '删除模型' : 'Delete model'} className="mini-danger" onClick={() => deleteModelPreset(item.id)} title={language === 'zh-CN' ? '删除模型' : 'Delete model'} type="button"><Icon name="trash" size={14} /></button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="utility-group">
                <div className="utility-label"><Icon name="file-plus" size={14} /><span>{t.files}</span></div>
                <ActionButton icon="file-plus" onClick={() => importPath('file')}>{t.importFile}</ActionButton>
                <ActionButton icon="folder-plus" onClick={() => importPath('directory')}>{t.importFolder}</ActionButton>
              </div>
              <div className="utility-group">
                <div className="utility-label"><Icon name="search" size={14} /><span>{t.search}</span></div>
                <div className="search-box">
                  <div className="input-shell">
                    <Icon name="search" size={16} />
                    <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && searchIndex()} placeholder={t.searchIndexedFiles as string} />
                  </div>
                  <button className="button secondary" onClick={searchIndex} type="button"><Icon name="search" size={16} />{t.search}</button>
                </div>
              </div>
            </div>
          )}
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
            <h2>{activeConversationTitle || (language === 'zh-CN' ? '新任务' : 'New task')}</h2>
          </div>
          <div className="topbar-actions">
            <span className={`run-state ${busy ? 'busy' : safeStatus.ok ? 'ready' : 'error'}`}>
              <Icon name={busy ? 'activity' : safeStatus.ok ? 'check' : 'alert'} size={14} />
              {stopping ? t.stopping : busy ? t.running : safeStatus.ok ? t.ready : t.notReady}
            </span>
            <label className="language-select">
              <Icon name="language" size={15} />
              <span>{t.language}</span>
              <select value={language} onChange={(e) => changeLanguage(e.target.value as Language)}>
                <option value="zh-CN">{t.chinese}</option>
                <option value="en-US">{t.english}</option>
              </select>
            </label>
            <button aria-label={t.showToolOutput as string} aria-pressed={showToolDetails} className={`icon-button tool-output-toggle ${showToolDetails ? 'active' : ''}`} onClick={() => setShowToolDetails((shown) => !shown)} title={t.showToolOutput as string} type="button"><Icon name="terminal" /></button>
            <button
              aria-label={inspectorOpen ? (language === 'zh-CN' ? '关闭运行面板' : 'Close run panel') : (language === 'zh-CN' ? '打开运行面板' : 'Open run panel')}
              aria-pressed={inspectorOpen}
              className={`icon-button inspector-toggle ${inspectorOpen ? 'active' : ''}`}
              onClick={() => setInspectorOpen((open) => !open)}
              title={language === 'zh-CN' ? '运行面板' : 'Run panel'}
              type="button"
            >
              <Icon name="layout" />
            </button>
            <div className="window-controls">
              <button aria-label={language === 'zh-CN' ? '最小化窗口' : 'Minimize window'} className="window-control" onClick={() => desktopBridge.windowMinimize()} title={language === 'zh-CN' ? '最小化' : 'Minimize'} type="button"><Icon name="minimize" size={16} /></button>
              <button aria-label={windowMaximized ? (language === 'zh-CN' ? '还原窗口' : 'Restore window') : (language === 'zh-CN' ? '最大化窗口' : 'Maximize window')} className="window-control" onClick={async () => setWindowMaximized(await desktopBridge.windowToggleMaximize())} title={windowMaximized ? (language === 'zh-CN' ? '还原' : 'Restore') : (language === 'zh-CN' ? '最大化' : 'Maximize')} type="button"><Icon name={windowMaximized ? 'copy' : 'maximize'} size={15} /></button>
              <button aria-label={language === 'zh-CN' ? '关闭窗口' : 'Close window'} className="window-control close" onClick={() => desktopBridge.windowClose()} title={language === 'zh-CN' ? '关闭' : 'Close'} type="button"><Icon name="x" size={17} /></button>
            </div>
          </div>
        </header>

        <section className="chat">
          {messages.length === 0 && (
            <div className="empty-state">
              <h3>{t.startLocalTask}</h3>
              <button className="workspace-selector" onClick={chooseWorkspace} title={safeStatus.workspace} type="button">
                <Icon name="folder-open" size={16} />
                <span>{safeStatus.workspace}</span>
                <Icon name="chevron-right" size={14} />
              </button>
              <TaskComposer embedded />
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
        {messages.length > 0 && <TaskComposer />}
      </main>

      <aside aria-hidden={!inspectorOpen} className={`inspector ${inspectorOpen ? 'open' : 'closed'}`}>
        <div className="inspector-head">
          <div>
            <span className="eyebrow">{t.inspector}</span>
            <h2>{inspectorTab === 'run' ? t.activityStream : inspectorTab === 'approvals' ? t.pendingDiffs : inspectorTab === 'memory' ? (language === 'zh-CN' ? '记忆' : 'Memory') : inspectorTab === 'history' ? t.recentConversation : t.searchPreview}</h2>
          </div>
          <button aria-label={language === 'zh-CN' ? '关闭运行面板' : 'Close run panel'} className="icon-button inspector-close" onClick={() => setInspectorOpen(false)} title={language === 'zh-CN' ? '关闭' : 'Close'} type="button"><Icon name="x" /></button>
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
              {currentRun && (
                <section className="run-summary" aria-label={language === 'zh-CN' ? '任务运行计划' : 'Task run plan'}>
                  <div className="run-summary-head">
                    <div>
                      <small>RUN {currentRun.id.slice(0, 8)}</small>
                      <b>{currentRun.task}</b>
                    </div>
                    <span className={`run-status status-${currentRun.status}`}>{currentRun.status}</span>
                  </div>
                  {currentRun.context_summary && <p className="context-summary"><Icon name="search" size={14} />{currentRun.context_summary}</p>}
                  <ol className="run-plan">
                    {(currentRun.plan ?? []).map((item) => (
                      <li className={`plan-${item.status}`} key={item.id}>
                        <span className="plan-marker"><Icon name={item.status === 'completed' ? 'check' : item.status === 'failed' ? 'alert' : 'clock'} size={13} /></span>
                        <div><b>{item.title}</b>{item.note && <small>{item.note}</small>}</div>
                      </li>
                    ))}
                  </ol>
                  {(currentRun.changes ?? []).length > 0 && (
                    <div className="run-changes">
                      <small>{language === 'zh-CN' ? '局部版本' : 'Local versions'}</small>
                      {(currentRun.changes ?? []).map((change) => (
                        <div className="run-change" key={change.version_id}>
                          <span><Icon name={change.verification?.ok ? 'check' : 'alert'} size={14} /><b>{change.path}</b><small>{change.rolled_back_at ? (language === 'zh-CN' ? '已回滚' : 'Rolled back') : change.verification?.summary}</small></span>
                          <button aria-label={language === 'zh-CN' ? `回滚 ${change.path}` : `Roll back ${change.path}`} className="icon-button" disabled={busy || Boolean(change.rolled_back_at)} onClick={() => rollbackVersion(change.version_id)} title={language === 'zh-CN' ? '回滚此版本' : 'Roll back this version'} type="button"><Icon name="rollback" size={15} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
              {activities.length === 0 && !currentRun ? <EmptyPanel icon="activity" title={t.toolTrace} description={t.noActivity} /> : activities.map((item, index) => (
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
                    <button className="button primary compact" disabled={busy || Boolean(approvalBusyId)} onClick={() => applyPending(item.id)} type="button"><Icon name={approvalBusyId === item.id ? 'clock' : 'check'} size={14} />{approvalBusyId === item.id ? (language === 'zh-CN' ? '处理中' : 'Working') : item.operation === 'run_powershell' ? (language === 'zh-CN' ? '执行' : 'Execute') : t.apply}</button>
                    <button className="button ghost compact" disabled={busy || Boolean(approvalBusyId)} onClick={() => denyPending(item.id)} type="button"><Icon name="x" size={14} />{language === 'zh-CN' ? '拒绝' : 'Deny'}</button>
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
