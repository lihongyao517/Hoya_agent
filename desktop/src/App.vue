<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowDown,
  Box,
  CircleCheck,
  Close,
  CopyDocument,
  Delete,
  Document,
  EditPen,
  Expand,
  Folder,
  FolderAdd,
  FolderOpened,
  Fold,
  FullScreen,
  Loading,
  Lock,
  Menu,
  Monitor,
  Moon,
  MoreFilled,
  Operation,
  Plus,
  Position,
  Promotion,
  Refresh,
  Search,
  Setting,
  SwitchButton,
  Sunny,
  Timer,
  Unlock,
  VideoPlay,
  Warning,
} from '@element-plus/icons-vue'
import appIconUrl from '../assets/icon.png'
import BrowserPanel from './components/BrowserPanel.vue'
import TerminalPanel from './components/TerminalPanel.vue'

type Provider = 'openai-compatible' | 'anthropic' | 'ollama'
type Reasoning = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type TaskColor = '' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'pink'
type MessageMeta = { run_id?: string; reasoning?: string[]; tool_results?: Array<{ name: string; result: string }>; duration_ms?: number }
type Message = { created_at?: string; role: 'user' | 'assistant' | 'system' | 'error'; content: string; meta?: MessageMeta }
type Task = { id: string; title: string; color?: TaskColor; status?: string; updated_at?: string }
type Project = { id: string; name: string; path: string; archived?: boolean; exists?: boolean; tasks?: Task[]; updated_at?: string }
type Model = { id: string; name: string; provider?: Provider; base_url?: string; model?: string; wire_api?: string; api_key_set?: boolean; reasoning_effort?: Reasoning; show_reasoning?: boolean }
type Pending = { id: string; operation?: string; path?: string; command?: string; diff?: string; run_id?: string; risk?: { level?: string; reasons?: string[] } }
type Run = { id: string; task: string; status: string; context_summary?: string; plan?: Array<{ id: string; title: string; status: string; note?: string }>; changes?: Array<{ version_id: string; path?: string; rolled_back_at?: string; verification?: { ok?: boolean; summary?: string } }> }
type Status = { ok?: boolean; configured?: boolean; workspace?: string; provider?: string; model?: string; allow_shell?: boolean; allow_desktop?: boolean; require_shell_approval?: boolean; permission_mode?: 'strict' | 'risk' | 'yolo' }
type CodeBlock = { language: string; code: string }
type CodeRun = { loading: boolean; expanded: boolean; output: string; ok?: boolean }
type MessageSegment = { kind: 'text' | 'code'; content: string; language?: string }
type UpdateInfo = HoyaUpdateInfo
type ContextMenuState = { kind: 'project' | 'task'; x: number; y: number; project?: Project; task?: Task }

const bridge = window.hoya ?? {
  serverConnection: async () => ({ url: import.meta.env.DEV ? 'http://127.0.0.1:8787' : '', token: '' }),
  getAppVersion: async () => 'dev',
  checkForUpdates: async () => ({ ok: false, status: 'error' as const, currentVersion: 'dev', latestVersion: '', updateAvailable: false, autoUpdateSupported: false, progress: 0, releasesUrl: 'https://github.com/lihongyao517/Hoya_agent/releases', error: 'Electron bridge unavailable' }),
  installUpdate: async () => false,
  onUpdateStatus: () => () => undefined,
  getLanguage: async () => 'zh-CN' as const,
  setLanguage: async (value: HoyaLanguage) => value,
  getApiKey: async () => '',
  saveApiKey: async () => false,
  deleteApiKey: async () => false,
  onServerConnectionChanged: () => () => undefined,
  terminalRun: async () => ({ ok: false, id: '', cwd: '' }),
  terminalStop: async () => false,
  runCode: async () => ({ ok: false, stdout: '', stderr: 'Electron bridge unavailable', exitCode: -1, timedOut: false, durationMs: 0 }),
  copyText: async () => false,
  openPath: async () => false,
  onTerminalOutput: () => () => undefined,
  openExternal: async () => false,
  onLanguageChanged: () => () => undefined,
  windowMinimize: async () => undefined,
  windowToggleMaximize: async () => false,
  windowIsMaximized: async () => false,
  windowClose: async () => undefined,
  onWindowMaximizedChanged: () => () => undefined,
  selectDirectory: async () => null,
  selectFile: async () => null,
}

const serverUrl = ref('')
const serverToken = ref('')
const appVersion = ref('')
const status = ref<Status>({})
const projects = ref<Project[]>([])
const tasks = ref<Task[]>([])
const activeTaskId = ref('')
const messages = ref<Message[]>([])
const messageInput = ref('')
const busy = ref(false)
const stopping = ref(false)
const currentRun = ref<Run | null>(null)
const runId = ref('')
const activities = ref<Array<{ type: string; title: string; body?: string }>>([])
const pending = ref<Pending[]>([])
const memories = ref<Array<{ id?: string; created_at: string; text: string }>>([])
const newMemoryText = ref('')
const permissionMode = ref<'strict' | 'risk' | 'yolo'>(
  (localStorage.getItem('hoya-permission-mode') as 'strict' | 'risk' | 'yolo') || 'risk'
)

async function setPermissionMode(mode: 'strict' | 'risk' | 'yolo') {
  if (mode === permissionMode.value) return
  if (busy.value) return ElMessage.warning('任务运行中，暂时不能切换权限等级')
  try {
    if (mode === 'yolo') {
      await ElMessageBox.confirm(
        'YOLO 模式会在本项目中自动执行后续写入和命令，不再逐项询问。是否一次性授予全部权限？',
        '授予全部权限',
        { type: 'warning', confirmButtonText: '授予全部权限', cancelButtonText: '取消' },
      )
    }
    const data = await (await api('/api/permissions', { method: 'POST', body: JSON.stringify({ mode }) })).json()
    permissionMode.value = mode
    localStorage.setItem('hoya-permission-mode', mode)
    status.value = data.status ?? status.value
    ElMessage.success(mode === 'strict' ? '已启用严格审批' : mode === 'risk' ? '已启用风险审批' : '已授予 YOLO 权限')
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(`权限切换失败：${String(error)}`)
  }
}

function handleImportCommand(command: 'file' | 'directory') {
  importPath(command)
}
const inspectorTab = ref('run')
const inspectorOpen = ref(false)
const settingsOpen = ref(false)
const settingsTab = ref('model')
const configSaving = ref(false)
const configLoading = ref(false)
const discovering = ref(false)
const discoveryError = ref('')
const discoveredModels = ref<Array<{ id: string; name: string; owned_by?: string }>>([])
const modelPresets = ref<Model[]>([])
const activeModelId = ref('')
const language = ref<HoyaLanguage>('zh-CN')
const windowMaximized = ref(false)
const themeMode = ref<'dark' | 'light'>('dark')
const chatScroll = ref<HTMLElement | null>(null)
const composerInput = ref<{ focus: () => void } | null>(null)
const workbenchOpen = ref(false)
const workbenchTab = ref<'terminal' | 'browser'>('terminal')
const sidebarWidth = ref(288)
const sidebarCollapsed = ref(localStorage.getItem('hoya-sidebar-collapsed') === '1')
const inspectorWidth = ref(360)
const workbenchHeight = ref(360)
const resizeMode = ref<'sidebar' | 'inspector' | 'workbench' | null>(null)
const taskEditingId = ref('')
const taskTitleDraft = ref('')
const projectDialogOpen = ref(false)
const projectParent = ref('')
const projectName = ref('新项目')
const projectCreating = ref(false)
const importing = ref(false)
const indexing = ref(false)
const showArchivedProjects = ref(false)
const editingCoordinate = ref('')
const codeRuns = reactive<Record<string, CodeRun>>({})
const updateChecking = ref(false)
const updateInfo = ref<UpdateInfo | null>(null)
const contextMenu = ref<ContextMenuState | null>(null)
const contextMenuElement = ref<HTMLElement | null>(null)
const hoveredAnchorPosition = ref(-1)
const activeAnchorPosition = ref(0)
const feedbackSubject = ref('Hoya Agent 使用建议')
const feedbackContent = ref('')
let activeResponseStartedAt = 0
let taskLoadSequence = 0

const repositoryUrl = 'https://github.com/lihongyao517/Hoya_agent'
const tagsUrl = `${repositoryUrl}/tags`
const releasesUrl = `${repositoryUrl}/releases`
const authorEmail = 'lihongyao517@gmail.com'

const config = reactive({
  provider: 'openai-compatible' as Provider,
  apiKey: '',
  baseUrl: '',
  model: '',
  wireApi: 'chat',
  reasoningEffort: 'medium' as Reasoning,
  showReasoning: true,
})
const composerModel = ref('')
const composerReasoning = ref<Reasoning>('medium')
const lightTheme = computed({
  get: () => themeMode.value === 'light',
  set: (value: boolean) => setTheme(value ? 'light' : 'dark'),
})

function setTheme(value: 'dark' | 'light') {
  themeMode.value = value
  document.documentElement.dataset.theme = value
  localStorage.setItem('hoya-theme', value)
}

function restoreTheme() {
  setTheme(localStorage.getItem('hoya-theme') === 'light' ? 'light' : 'dark')
}

const providerOptions = [
  { label: 'OpenAI-compatible', value: 'openai-compatible' },
  { label: 'Anthropic Messages', value: 'anthropic' },
  { label: 'Ollama', value: 'ollama' },
]
const reasoningOptions: Array<{ label: string; value: Reasoning }> = [
  { label: '轻度', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
  { label: '极高', value: 'xhigh' },
  { label: '极高+', value: 'max' },
]
const taskColors: Array<{ label: string; value: TaskColor; color: string }> = [
  { label: '无高亮', value: '', color: '#96a19d' },
  { label: '蓝色', value: 'blue', color: '#4f7fd8' },
  { label: '绿色', value: 'green', color: '#18a37d' },
  { label: '琥珀', value: 'amber', color: '#d08a24' },
  { label: '红色', value: 'red', color: '#d75b55' },
  { label: '紫色', value: 'purple', color: '#8a67c7' },
  { label: '粉色', value: 'pink', color: '#cc6b91' },
]

const connected = computed(() => Boolean(status.value.ok))
const workspace = computed(() => status.value.workspace ?? '')
const projectTasks = computed(() => projects.value.flatMap((project) => (project.tasks ?? []).map((task) => ({ ...task, project }))))
const activeTask = computed(() => tasks.value.find((item) => item.id === activeTaskId.value) ?? projectTasks.value.find((item) => item.id === activeTaskId.value))
const visibleProjects = computed(() => projects.value.filter((project) => showArchivedProjects.value || !project.archived || project.path === workspace.value))
const lastUserMessage = computed(() => [...messages.value].reverse().find((message) => message.role === 'user'))
const messageCoordinates = computed(() => {
  let questionNumber = 0
  return messages.value.map((message) => {
    if (message.role === 'user') questionNumber += 1
    const prefix = message.role === 'user' ? 'Q' : message.role === 'assistant' || message.role === 'error' ? 'A' : 'S'
    return `${prefix}${String(Math.max(questionNumber, 1)).padStart(3, '0')}`
  })
})
const questionAnchors = computed(() => messages.value.flatMap((message, index) => {
  if (message.role !== 'user') return []
  let answer: Message | undefined
  for (let answerIndex = index + 1; answerIndex < messages.value.length; answerIndex += 1) {
    const candidate = messages.value[answerIndex]
    if (candidate.role === 'user') break
    if (candidate.role === 'assistant' || candidate.role === 'error') {
      answer = candidate
      break
    }
  }
  return [{
    index,
    coordinate: messageCoordinate(index),
    preview: coordinatePreview(message.content, 110),
    answerPreview: answer?.content ? coordinatePreview(answer.content, 220) : '',
  }]
}))
const contextMenuStyle = computed(() => contextMenu.value ? { left: `${contextMenu.value.x}px`, top: `${contextMenu.value.y}px` } : {})
const modelOptions = computed(() => {
  const values = [
    ...discoveredModels.value.map((item) => ({ id: item.id, name: item.name })),
    ...modelPresets.value.map((item) => ({ id: item.model || item.id, name: item.model || item.name })),
  ]
  if (composerModel.value && !values.some((item) => item.id === composerModel.value)) values.unshift({ id: composerModel.value, name: composerModel.value })
  return values.filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
})
const composerModelLabel = computed(() => modelOptions.value.find((item) => item.id === composerModel.value)?.name ?? (composerModel.value || '选择模型'))
const composerReasoningLabel = computed(() => reasoningOptions.find((item) => item.value === composerReasoning.value)?.label ?? '中')
const isLocalCommand = computed(() => messageInput.value.trim().startsWith('/'))
const canSend = computed(() => Boolean(serverUrl.value && messageInput.value.trim() && !busy.value && composerModel.value && (activeTaskId.value || isLocalCommand.value)))

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${serverUrl.value}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
      ...(serverToken.value ? { Authorization: `Bearer ${serverToken.value}` } : {}),
    },
  })
  if (!response.ok) {
    const raw = await response.text()
    try {
      const parsed = JSON.parse(raw)
      throw new Error(parsed.error || raw)
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(raw)
      throw error
    }
  }
  return response
}

async function loadStatus() {
  if (!serverUrl.value) return
  status.value = await (await api('/api/status')).json()
  if (status.value.permission_mode) {
    permissionMode.value = status.value.permission_mode
    localStorage.setItem('hoya-permission-mode', permissionMode.value)
  }
}

async function loadConfig() {
  if (!serverUrl.value) return
  configLoading.value = true
  try {
    const data = await (await api('/api/config')).json()
    const value = data.config ?? {}
    config.provider = value.provider ?? 'openai-compatible'
    config.baseUrl = value.base_url ?? ''
    config.apiKey = await bridge.getApiKey({
      workspace: data.workspace ?? workspace.value,
      provider: config.provider,
      baseUrl: config.baseUrl,
    })
    config.model = value.model ?? ''
    config.wireApi = value.wire_api ?? 'chat'
    config.reasoningEffort = value.reasoning_effort ?? 'medium'
    config.showReasoning = value.show_reasoning !== false
    composerModel.value = config.model
    composerReasoning.value = config.reasoningEffort
  } finally {
    configLoading.value = false
  }
}

async function loadProjects() {
  if (!serverUrl.value) return
  const data = await (await api('/api/projects')).json()
  projects.value = data.projects ?? []
}

function applyProviderDefaults(provider: Provider | string, forceBaseUrl = false) {
  if (provider !== 'ollama') return
  if (forceBaseUrl || !config.baseUrl.trim()) config.baseUrl = 'http://127.0.0.1:11434/v1'
  config.wireApi = 'chat'
  if (!config.model) config.model = 'qwen2.5-coder:7b'
}

async function loadModels() {
  if (!serverUrl.value) return
  const data = await (await api('/api/models')).json()
  modelPresets.value = data.models ?? []
  activeModelId.value = data.active_model_id ?? ''
}

async function discoverModels() {
  applyProviderDefaults(config.provider)
  if (!config.baseUrl.trim()) {
    discoveryError.value = '请先填写 API URL'
    return
  }
  discovering.value = true
  discoveryError.value = ''
  try {
    const data = await (await api('/api/models/discover', { method: 'POST', body: JSON.stringify({ provider: config.provider, base_url: config.baseUrl, api_key: config.apiKey }) })).json()
    if (!data.ok) throw new Error(data.error || '获取模型失败')
    discoveredModels.value = data.models ?? []
    if (!config.model && discoveredModels.value[0]) config.model = discoveredModels.value[0].id
    if (!composerModel.value && config.model) composerModel.value = config.model
    ElMessage.success(`已获取 ${discoveredModels.value.length} 个模型`)
  } catch (error) {
    discoveryError.value = String(error)
  } finally {
    discovering.value = false
  }
}

function apiConfigPayload(model: string, includeApiKey = false) {
  const payload: Record<string, string | boolean> = {
    provider: config.provider,
    base_url: config.baseUrl,
    model,
    wire_api: config.provider === 'ollama' ? 'chat' : config.provider === 'anthropic' ? 'messages' : config.wireApi,
    reasoning_effort: config.reasoningEffort,
    show_reasoning: config.showReasoning,
  }
  if (includeApiKey) {
    payload.api_key = config.apiKey
    payload.clear_api_key = !config.apiKey
  }
  return payload
}

async function hydrateBackendCredential() {
  if (!config.apiKey) return
  await api('/api/config', {
    method: 'POST',
    body: JSON.stringify(apiConfigPayload(config.model, true)),
  })
}

async function saveConfig() {
  configSaving.value = true
  try {
    applyProviderDefaults(config.provider)
    const credential = { workspace: workspace.value, provider: config.provider, baseUrl: config.baseUrl }
    if (config.apiKey) await bridge.saveApiKey({ ...credential, apiKey: config.apiKey })
    else await bridge.deleteApiKey(credential)
    const data = await (await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(apiConfigPayload(config.model || composerModel.value, true)),
    })).json()
    status.value = data.status ?? status.value
    composerModel.value = config.model || composerModel.value
    composerReasoning.value = config.reasoningEffort
    await Promise.all([loadModels(), loadStatus()])
    settingsOpen.value = false
    ElMessage.success('API 配置已保存')
  } catch (error) {
    ElMessage.error(String(error))
  } finally {
    configSaving.value = false
  }
}

async function savePreset() {
  const model = composerModel.value || config.model
  if (!model) return ElMessage.warning('请先选择模型')
  await api('/api/models', { method: 'POST', body: JSON.stringify({ name: model, provider: config.provider, base_url: config.baseUrl, model, wire_api: config.wireApi, api_key_set: Boolean(config.apiKey), reasoning_effort: composerReasoning.value, show_reasoning: config.showReasoning }) })
  await loadModels()
  ElMessage.success('模型预设已保存')
}

async function selectPreset(id: string) {
  await api('/api/models/select', { method: 'POST', body: JSON.stringify({ id }) })
  await loadConfig()
  await hydrateBackendCredential()
  await Promise.all([loadModels(), loadStatus()])
  ElMessage.success('模型预设已切换')
}

async function deletePreset(id: string) {
  await ElMessageBox.confirm('确认删除这个模型预设？', '删除模型', { type: 'warning' })
  await api('/api/models/delete', { method: 'POST', body: JSON.stringify({ id }) })
  await loadModels()
}

async function applyComposerSelection() {
  if (!composerModel.value || !serverUrl.value) return
  config.model = composerModel.value
  config.reasoningEffort = composerReasoning.value
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify(apiConfigPayload(composerModel.value)) })
    await loadStatus()
  } catch (error) {
    ElMessage.error(`保存选择失败: ${String(error)}`)
  }
}

async function handleModelMenuCommand(command: string) {
  if (command.startsWith('model:')) composerModel.value = command.slice(6)
  else if (command.startsWith('reasoning:')) composerReasoning.value = command.slice(10) as Reasoning
  await applyComposerSelection()
}

async function loadTasks(preferredId = activeTaskId.value) {
  if (!serverUrl.value) return
  const data = await (await api('/api/tasks')).json()
  tasks.value = data.tasks ?? []
  const selected = preferredId || (tasks.value[0]?.id ?? '')
  activeTaskId.value = selected
  if (selected) {
    try {
      await loadTask(selected)
    } catch (error) {
      if (tasks.value.some((item) => item.id === selected)) ElMessage.error(String(error))
      activeTaskId.value = tasks.value[0]?.id ?? ''
      if (activeTaskId.value && activeTaskId.value !== selected) await loadTask(activeTaskId.value)
    }
  }
  else {
    taskLoadSequence += 1
    messages.value = []
    currentRun.value = null
  }
}

async function loadTask(id: string) {
  if (!id || busy.value) return
  const requestSequence = ++taskLoadSequence
  activeTaskId.value = id
  const [messagesData, runData] = await Promise.all([
    (await api(`/api/conversations/messages?id=${encodeURIComponent(id)}&limit=200`)).json(),
    (await api(`/api/runs?conversation_id=${encodeURIComponent(id)}&limit=1`)).json(),
  ])
  if (requestSequence !== taskLoadSequence || activeTaskId.value !== id) return
  for (const key of Object.keys(codeRuns)) delete codeRuns[key]
  messages.value = (messagesData.messages ?? []).filter((item: Message) => ['user', 'assistant', 'system', 'error'].includes(item.role))
  currentRun.value = runData.latest ?? null
  await scrollChat('auto')
  await nextTick()
  composerInput.value?.focus()
}

async function createTask() {
  const data = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: '新任务' }) })).json()
  if (data.task?.id) await Promise.all([loadTasks(data.task.id), loadProjects()])
  nextTick(() => composerInput.value?.focus())
}

function beginTaskRename(task: Task) {
  taskEditingId.value = task.id
  taskTitleDraft.value = task.title
}

async function renameTask(task: Task) {
  if (tasks.value.some((item) => item.id === task.id)) {
    beginTaskRename(task)
    return
  }
  const result = await ElMessageBox.prompt('修改项目任务显示名称。', '重命名任务', { inputValue: task.title, inputValidator: (value) => Boolean(value.trim()) || '名称不能为空' })
  await api('/api/conversations/update', { method: 'POST', body: JSON.stringify({ id: task.id, title: result.value.trim() }) })
  await loadProjects()
}

async function saveTaskTitle(task: Task) {
  const title = taskTitleDraft.value.trim()
  if (!title) return
  const data = await (await api('/api/conversations/update', { method: 'POST', body: JSON.stringify({ id: task.id, title }) })).json()
  tasks.value = tasks.value.map((item) => item.id === task.id ? data.conversation : item)
  taskEditingId.value = ''
  await loadProjects()
}

async function setTaskColor(task: Task, color: TaskColor) {
  const data = await (await api('/api/conversations/update', { method: 'POST', body: JSON.stringify({ id: task.id, color }) })).json()
  tasks.value = tasks.value.map((item) => item.id === task.id ? data.conversation : item)
  if (!tasks.value.some((item) => item.id === task.id)) await loadProjects()
}

async function deleteTask(task: Task) {
  await ElMessageBox.confirm(`确认删除“${task.title}”？`, '删除任务', { type: 'warning' })
  await api('/api/conversations/delete', { method: 'POST', body: JSON.stringify({ id: task.id }) })
  await Promise.all([loadTasks(task.id === activeTaskId.value ? '' : activeTaskId.value), loadProjects()])
}

async function handleTaskCommand(task: Task, command: string) {
  if (command === 'rename') await renameTask(task)
  else if (command === 'delete') deleteTask(task)
  else if (command.startsWith('color:')) setTaskColor(task, command.slice(6) as TaskColor)
}

async function chooseWorkspace() {
  const directory = await bridge.selectDirectory()
  if (!directory) return
  await api('/api/workspace', { method: 'POST', body: JSON.stringify({ workspace: directory }) })
  activeTaskId.value = ''
  await initializeWorkspace()
}

async function selectProject(project: Project, preferredTaskId = '') {
  if (busy.value || project.exists === false) return
  if (project.path !== workspace.value) {
    await api('/api/projects/select', { method: 'POST', body: JSON.stringify({ path: project.path }) })
    activeTaskId.value = preferredTaskId
    await initializeWorkspace()
  }
  if (preferredTaskId && activeTaskId.value !== preferredTaskId) await loadTask(preferredTaskId)
}

async function createTaskInProject(project: Project) {
  const data = await (await api('/api/projects/task', { method: 'POST', body: JSON.stringify({ project_id: project.id, title: '新任务' }) })).json()
  await loadProjects()
  await selectProject(project, data.task?.id ?? '')
  nextTick(() => composerInput.value?.focus())
}

async function renameProject(project: Project) {
  const result = await ElMessageBox.prompt('项目目录不会重命名，只修改客户端显示名称。', '重命名项目', { inputValue: project.name, inputValidator: (value) => Boolean(value.trim()) || '名称不能为空' })
  await api('/api/projects/update', { method: 'POST', body: JSON.stringify({ id: project.id, name: result.value.trim() }) })
  await loadProjects()
}

async function archiveProject(project: Project) {
  await api('/api/projects/update', { method: 'POST', body: JSON.stringify({ id: project.id, archived: !project.archived }) })
  await loadProjects()
  ElMessage.success(project.archived ? '项目已取消归档' : '项目已归档')
}

async function removeProject(project: Project) {
  await ElMessageBox.confirm(`确认删除“${project.name}”？这会同时删除磁盘目录：${project.path}`, '删除项目和文件', { type: 'warning', confirmButtonText: '删除项目和文件' })
  const data = await (await api('/api/projects/delete', { method: 'POST', body: JSON.stringify({ id: project.id }) })).json()
  status.value = data.status ?? status.value
  if (project.path === workspace.value) activeTaskId.value = ''
  await initializeWorkspace()
}

async function handleProjectCommand(project: Project, command: string) {
  if (command === 'open') await selectProject(project)
  else if (command === 'new-task') await createTaskInProject(project)
  else if (command === 'rename') await renameProject(project)
  else if (command === 'archive') await archiveProject(project)
  else if (command === 'delete') await removeProject(project)
  else if (command === 'copy-path') await copyText(project.path)
  else if (command === 'reveal') await bridge.openPath(project.path)
}

async function openContextMenu(event: MouseEvent, menu: Omit<ContextMenuState, 'x' | 'y'>) {
  event.preventDefault()
  event.stopPropagation()
  const pointer = { x: event.clientX, y: event.clientY }
  contextMenu.value = {
    ...menu,
    x: pointer.x,
    y: pointer.y,
  }
  await nextTick()
  if (!contextMenu.value || !contextMenuElement.value) return
  const bounds = contextMenuElement.value.getBoundingClientRect()
  const menuWidth = contextMenuElement.value.offsetWidth || bounds.width
  const menuHeight = contextMenuElement.value.offsetHeight || bounds.height
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  contextMenu.value = {
    ...contextMenu.value,
    x: Math.max(8, Math.min(pointer.x, viewportWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(pointer.y, viewportHeight - menuHeight - 8)),
  }
  await nextTick()
  contextMenuElement.value?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus()
}

function closeContextMenu() {
  contextMenu.value = null
}

function handleGlobalPointerDown(event: PointerEvent) {
  const target = event.target
  if (target instanceof Element && target.closest('.hoya-context-menu')) return
  closeContextMenu()
}

function handleContextMenuKeydown(event: KeyboardEvent) {
  if (!contextMenuElement.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeContextMenu()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = [...contextMenuElement.value.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
  if (!items.length) return
  const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next]?.focus()
}

async function handleContextMenuCommand(command: string) {
  const menu = contextMenu.value
  closeContextMenu()
  if (!menu) return
  if (menu.kind === 'project' && menu.project) {
    await handleProjectCommand(menu.project, command)
    return
  }
  if (menu.kind === 'task' && menu.task) {
    if (menu.project && menu.project.path !== workspace.value) await selectProject(menu.project, menu.task.id)
    await handleTaskCommand(menu.task, command)
  }
}

async function handleLocalCommand(raw: string) {
  const [name, ...rest] = raw.trim().split(/\s+/)
  const arg = rest.join(' ').trim()
  if (name === '/help') {
    messages.value.push({
      role: 'system',
      content: [
        '可用命令：',
        '/help 查看命令',
        '/compact 压缩当前任务上下文',
        '/reset 或 /new 新建独立任务',
        '/clear 清空当前界面消息',
        '/index 建立当前项目索引',
        '/pending 刷新待审批操作',
        '/skills 查看已安装 skills',
        '/mcp 查看 MCP 配置',
      ].join('\n'),
    })
    return
  }
  if (name === '/clear') {
    messages.value = []
    currentRun.value = null
    return
  }
  if (name === '/reset' || name === '/new') {
    await createTask()
    messages.value.push({ role: 'system', content: '已开始新任务。长期记忆仍会保留。' })
    return
  }
  if (name === '/compact') {
    if (!activeTaskId.value) return ElMessage.warning('请先选择任务')
    const keepLast = Number.parseInt(arg || '12', 10)
    const data = await (await api('/api/conversations/compact', { method: 'POST', body: JSON.stringify({ id: activeTaskId.value, keep_last: Number.isFinite(keepLast) ? keepLast : 12 }) })).json()
    await loadTask(activeTaskId.value)
    ElMessage.success(data.compacted ? `已压缩 ${data.removed ?? 0} 条上下文` : '当前上下文还不需要压缩')
    return
  }
  if (name === '/index') {
    await buildWorkspaceIndex()
    return
  }
  if (name === '/pending') {
    await refreshPending()
    messages.value.push({ role: 'system', content: pending.value.length ? `待审批操作：${pending.value.length} 个` : '没有待审批操作。' })
    return
  }
  if (name === '/skills' || name === '/mcp') {
    const data = await (await api('/api/capabilities')).json()
    const lines = name === '/skills'
      ? (data.skills ?? []).map((item: { name: string; description?: string }) => `- ${item.name}${item.description ? `：${item.description}` : ''}`)
      : (data.mcp_servers ?? []).map((item: { name: string; command?: string; source?: string }) => `- ${item.name}${item.command ? `：${item.command}` : item.source ? `：${item.source}` : ''}`)
    messages.value.push({ role: 'system', content: lines.length ? lines.join('\n') : (name === '/skills' ? '当前工作区没有发现 skill。' : '当前工作区没有发现 MCP 配置。') })
    return
  }
  ElMessage.warning(`未知命令：${name}。输入 /help 查看可用命令。`)
}

async function beginCreateProject() {
  const parent = await bridge.selectDirectory()
  if (!parent) return
  projectParent.value = parent
  projectName.value = '新项目'
  projectDialogOpen.value = true
}

async function createProject() {
  if (!projectParent.value || !projectName.value.trim()) return
  projectCreating.value = true
  try {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ parent: projectParent.value, name: projectName.value.trim() }) })
    projectDialogOpen.value = false
    activeTaskId.value = ''
    await initializeWorkspace()
  } catch (error) {
    ElMessage.error(String(error))
  } finally {
    projectCreating.value = false
  }
}

function messageCoordinate(index: number) {
  return messageCoordinates.value[index] ?? 'S001'
}

function coordinatePreview(content: string, maximumLength: number) {
  const normalized = content
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/[`#>*_~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length > maximumLength ? `${normalized.slice(0, maximumLength).trimEnd()}…` : normalized
}

async function copyText(text: string) {
  const copied = await bridge.copyText(text)
  if (copied) ElMessage.success('已复制')
  else ElMessage.error('复制失败')
}

function reusePrompt(message: Message, index?: number) {
  messageInput.value = message.content
  editingCoordinate.value = typeof index === 'number' ? messageCoordinate(index) : '上一条命令'
  nextTick(() => composerInput.value?.focus())
}

function jumpToMessage(index: number) {
  const position = questionAnchors.value.findIndex((anchor) => anchor.index === index)
  if (position >= 0) activeAnchorPosition.value = position
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  document.getElementById(`message-${index}`)?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' })
}

function syncActiveAnchor() {
  if (!chatScroll.value || !questionAnchors.value.length) return
  const center = chatScroll.value.getBoundingClientRect().top + chatScroll.value.clientHeight / 2
  let nearestPosition = 0
  let nearestDistance = Number.POSITIVE_INFINITY
  questionAnchors.value.forEach((anchor, position) => {
    const element = document.getElementById(`message-${anchor.index}`)
    if (!element) return
    const distance = Math.abs(element.getBoundingClientRect().top - center)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestPosition = position
    }
  })
  activeAnchorPosition.value = nearestPosition
}

function coordinateMarkerStyle(position: number) {
  const focus = hoveredAnchorPosition.value >= 0 ? hoveredAnchorPosition.value : activeAnchorPosition.value
  const hovering = hoveredAnchorPosition.value >= 0
  const distance = Math.abs(position - focus)
  const influence = Math.max(0, 1 - distance / 4)
  const scale = hovering ? .72 + influence * 1.48 : distance === 0 ? 1.5 : .72
  const colorMix = hovering ? influence : distance === 0 ? .72 : 0
  const neutral = [58, 62, 68]
  const accent = [79, 140, 255]
  const color = `rgb(${neutral.map((channel, index) => Math.round(channel + (accent[index] - channel) * colorMix)).join(' ')})`
  const opacity = .3 + influence * .7
  return { '--coordinate-scale': String(scale), '--coordinate-color': color, '--coordinate-opacity': String(opacity) }
}

function runnableCodeBlocks(content: string): CodeBlock[] {
  return messageSegments(content)
    .filter((segment) => segment.kind === 'code' && ['python', 'py', 'javascript', 'js', 'node', 'powershell', 'ps1'].includes(segment.language || ''))
    .map((segment) => ({ language: segment.language || '', code: segment.content }))
}

function messageSegments(content: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  const pattern = /```([\w+-]*)\s*\r?\n([\s\S]*?)```/g
  let cursor = 0
  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ kind: 'text', content: content.slice(cursor, start) })
    segments.push({ kind: 'code', language: (match[1] || 'text').toLowerCase(), content: match[2].trimEnd() })
    cursor = start + match[0].length
  }
  if (cursor < content.length) segments.push({ kind: 'text', content: content.slice(cursor) })
  return segments.length ? segments : [{ kind: 'text', content }]
}

function codeRunKey(messageIndex: number, blockIndex: number) {
  return `${activeTaskId.value}:${messageIndex}:${blockIndex}`
}

async function runCodeBlock(block: CodeBlock, messageIndex: number, blockIndex: number) {
  const key = codeRunKey(messageIndex, blockIndex)
  await ElMessageBox.confirm(`将在当前项目中运行 ${block.language} 代码，最长 30 秒。确认继续？`, '运行代码', { type: 'warning', confirmButtonText: '运行' })
  codeRuns[key] = { loading: true, expanded: true, output: '' }
  try {
    const result = await bridge.runCode({ code: block.code, language: block.language, cwd: workspace.value })
    const sections = [result.stdout.trim(), result.stderr.trim()].filter(Boolean)
    codeRuns[key] = {
      loading: false,
      expanded: true,
      ok: result.ok,
      output: `${sections.join('\n') || '（没有输出）'}\n\n退出码 ${result.exitCode} · ${result.durationMs}ms${result.timedOut ? ' · 已超时' : ''}`,
    }
  } catch (error) {
    codeRuns[key] = { loading: false, expanded: true, ok: false, output: String(error) }
  }
}

function assistantMessage() {
  const last = messages.value[messages.value.length - 1]
  return last?.role === 'assistant' || last?.role === 'error' ? last : undefined
}

function ensureMessageMeta(message: Message) {
  if (!message.meta) message.meta = {}
  if (!message.meta.reasoning) message.meta.reasoning = []
  if (!message.meta.tool_results) message.meta.tool_results = []
  return message.meta
}

function messageDurationMs(message: Message, index: number) {
  if (Number.isFinite(message.meta?.duration_ms)) return Math.max(0, Number(message.meta?.duration_ms))
  const previous = messages.value[index - 1]
  if (!message.created_at || previous?.role !== 'user' || !previous.created_at) return undefined
  const elapsed = new Date(message.created_at).getTime() - new Date(previous.created_at).getTime()
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined
}

function formatResponseDuration(durationMs?: number) {
  if (!Number.isFinite(durationMs)) return ''
  const totalSeconds = Math.max(0, Number(durationMs)) / 1000
  if (totalSeconds < 10) return `${totalSeconds.toFixed(1)} 秒`
  if (totalSeconds < 60) return `${Math.round(totalSeconds)} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
}

function chatIsNearBottom() {
  const element = chatScroll.value
  return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 96
}

async function scrollChat(behavior: ScrollBehavior = 'auto') {
  await nextTick()
  chatScroll.value?.scrollTo({ top: chatScroll.value.scrollHeight, behavior })
}

function appendToken(text: string) {
  const shouldFollow = chatIsNearBottom()
  const last = messages.value[messages.value.length - 1]
  if (last?.role === 'assistant') last.content += text
  if (shouldFollow) void scrollChat('auto')
}

function handleEvent(event: any) {
  if (event.type === 'run_started') runId.value = event.run_id ?? runId.value
  if (event.type === 'run_state') currentRun.value = event.run
  if (event.type === 'context_summary') activities.value.push({ type: 'context', title: event.text })
  if (event.type === 'status') activities.value.push({ type: event.type, title: event.text })
  if (event.type === 'reasoning' && event.text) {
    const message = assistantMessage()
    if (message) ensureMessageMeta(message).reasoning?.push(event.text)
  }
  if (event.type === 'tool_start') activities.value.push({ type: 'tool', title: `${event.name} ${event.arguments ?? ''}` })
  if (event.type === 'tool_result') {
    activities.value.push({ type: 'tool', title: `${event.name} 完成`, body: event.result })
    const message = assistantMessage()
    if (message) ensureMessageMeta(message).tool_results?.push({ name: event.name ?? 'tool', result: event.result ?? '' })
  }
  if (event.type === 'verification') activities.value.push({ type: 'verification', title: `${event.change?.path ?? ''}: ${event.change?.verification?.summary ?? '校验完成'}` })
  if (event.type === 'approval_required') {
    activities.value.push({ type: 'approval', title: event.text, body: event.path || event.command })
    refreshPending()
  }
  if (event.type === 'token') appendToken(event.text ?? '')
  if (event.type === 'done') {
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      if (!last.content) last.content = event.text ?? ''
      ensureMessageMeta(last).duration_ms = Number.isFinite(event.duration_ms)
        ? Math.max(0, Number(event.duration_ms))
        : Math.max(0, Date.now() - activeResponseStartedAt)
    }
  }
  if (event.type === 'cancelled') activities.value.push({ type: 'cancelled', title: event.text })
  if (event.type === 'error') {
    const message = assistantMessage()
    if (message && !message.content) {
      message.role = 'error'
      message.content = event.text ?? '运行失败'
    }
    ElMessage.error(event.text ?? '运行失败')
  }
}

async function consumeStream(response: Response) {
  if (!response.body) throw new Error('响应流为空')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) handleEvent(JSON.parse(line))
  }
  if (buffer.trim()) handleEvent(JSON.parse(buffer))
}

async function sendTask() {
  if (!canSend.value) return
  const text = messageInput.value.trim()
  messageInput.value = ''
  editingCoordinate.value = ''
  if (text.startsWith('/')) {
    await handleLocalCommand(text)
    nextTick(() => composerInput.value?.focus())
    return
  }
  messages.value.push({ role: 'user', content: text, meta: {} }, { role: 'assistant', content: '', meta: { reasoning: [], tool_results: [] } })
  busy.value = true
  stopping.value = false
  activities.value = []
  const currentRunId = crypto.randomUUID()
  activeResponseStartedAt = Date.now()
  runId.value = currentRunId
  inspectorOpen.value = true
  inspectorTab.value = 'run'
  await scrollChat(window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')
  try {
    await applyComposerSelection()
    await consumeStream(await api('/api/chat', { method: 'POST', body: JSON.stringify({ task: text, conversation_id: activeTaskId.value, run_id: currentRunId }) }))
  } catch (error) {
    const message = assistantMessage()
    if (message && !message.content) {
      message.role = 'error'
      message.content = String(error)
    }
    ElMessage.error(String(error))
  } finally {
    busy.value = false
    runId.value = ''
    await Promise.all([refreshPending(), loadTasks(activeTaskId.value)])
  }
}

async function resumeRun(id: string) {
  busy.value = true
  activeResponseStartedAt = Date.now()
  runId.value = id
  if (messages.value[messages.value.length - 1]?.role !== 'assistant') messages.value.push({ role: 'assistant', content: '', meta: { reasoning: [], tool_results: [] } })
  try {
    await consumeStream(await api('/api/runs/resume', { method: 'POST', body: JSON.stringify({ run_id: id }) }))
  } catch (error) {
    ElMessage.error(String(error))
  } finally {
    busy.value = false
    runId.value = ''
    await Promise.all([refreshPending(), loadTask(activeTaskId.value)])
  }
}

async function stopTask() {
  if (!runId.value || !busy.value) return
  stopping.value = true
  await api('/api/chat/cancel', { method: 'POST', body: JSON.stringify({ run_id: runId.value }) }).catch(() => undefined)
}

async function refreshPending() {
  if (!serverUrl.value) return
  const data = await (await api('/api/pending')).json()
  pending.value = data.entries ?? []
}

async function decidePending(item: Pending, decision: 'approved' | 'denied') {
  const target = decision === 'approved' ? '/api/pending/apply' : '/api/pending/deny'
  const data = await (await api(target, { method: 'POST', body: JSON.stringify({ id: item.id }) })).json()
  if (data.resumable && data.run_id) await resumeRun(data.run_id)
  else if (!data.ok) ElMessage.error(data.error || '审批操作失败')
  await refreshPending()
}

async function rollback(change: NonNullable<Run['changes']>[number]) {
  await ElMessageBox.confirm(`确认回滚 ${change.path ?? '此版本'}？`, '版本回滚', { type: 'warning' })
  const data = await (await api('/api/versions/rollback', { method: 'POST', body: JSON.stringify({ version_id: change.version_id }) })).json()
  if (!data.ok) return ElMessage.error(data.error)
  ElMessage.success(`已回滚 ${data.path}`)
  await loadTask(activeTaskId.value)
}

async function refreshMemory() {
  if (!serverUrl.value) return
  const data = await (await api('/api/memory')).json()
  memories.value = data.memory ?? []
}

async function addMemory() {
  if (!newMemoryText.value.trim()) return
  await api('/api/memory', { method: 'POST', body: JSON.stringify({ text: newMemoryText.value.trim() }) })
  newMemoryText.value = ''
  await refreshMemory()
}

async function deleteMemory(identifier: string) {
  await api('/api/memory/delete', { method: 'POST', body: JSON.stringify({ id: identifier }) })
  await refreshMemory()
}



async function importPath(kind: 'file' | 'directory') {
  const source = kind === 'file' ? await bridge.selectFile() : await bridge.selectDirectory()
  if (!source) return
  importing.value = true
  try {
    const data = await (await api('/api/import', { method: 'POST', body: JSON.stringify({ source }) })).json()
    if (!data.ok) throw new Error(data.error || '导入失败')
    messages.value.push({ role: 'system', content: `已导入：${data.relative}` })
    ElMessage.success('导入完成')
  } catch (error) {
    ElMessage.error(String(error))
  } finally {
    importing.value = false
  }
}

async function buildWorkspaceIndex() {
  indexing.value = true
  try {
    const data = await (await api('/api/index', { method: 'POST', body: '{}' })).json()
    messages.value.push({ role: 'system', content: `索引完成：${data.files ?? 0} 个文件${data.truncated ? '（已截断）' : ''}` })
    ElMessage.success('工作区索引已更新')
  } catch (error) {
    ElMessage.error(String(error))
  } finally {
    indexing.value = false
  }
}

const layoutStyle = computed(() => ({
  '--sidebar-width': `${sidebarWidth.value}px`,
  '--inspector-width': `${inspectorWidth.value}px`,
  '--workbench-height': `${workbenchHeight.value}px`,
}))

function toggleWorkbench(tab: 'terminal' | 'browser') {
  if (tab === 'browser') {
    if (inspectorOpen.value && inspectorTab.value === 'browser') {
      inspectorOpen.value = false
      return
    }
    workbenchOpen.value = false
    inspectorTab.value = 'browser'
    inspectorOpen.value = true
    return
  }
  if (workbenchOpen.value && workbenchTab.value === tab) {
    workbenchOpen.value = false
    return
  }
  if (inspectorOpen.value && inspectorTab.value === 'browser') inspectorOpen.value = false
  workbenchTab.value = tab
  workbenchOpen.value = true
}

function toggleInspector() {
  if (inspectorOpen.value && inspectorTab.value === 'run') {
    inspectorOpen.value = false
    return
  }
  inspectorTab.value = 'run'
  inspectorOpen.value = true
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  localStorage.setItem('hoya-sidebar-collapsed', sidebarCollapsed.value ? '1' : '0')
}

let resizeStartX = 0
let resizeStartY = 0
let resizeStartSize = 0
let resizePointerId = -1
let resizeHandle: HTMLElement | null = null

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}

function handleResize(event: PointerEvent) {
  if (resizeMode.value === 'sidebar') {
    sidebarWidth.value = clamp(resizeStartSize + event.clientX - resizeStartX, 220, 380)
  } else if (resizeMode.value === 'inspector') {
    inspectorWidth.value = clamp(resizeStartSize - event.clientX + resizeStartX, 300, 560)
  } else if (resizeMode.value === 'workbench') {
    workbenchHeight.value = clamp(resizeStartSize - event.clientY + resizeStartY, 220, Math.max(220, window.innerHeight - 300))
  }
}

function stopResize() {
  if (!resizeMode.value) return
  window.removeEventListener('pointermove', handleResize)
  window.removeEventListener('pointerup', stopResize)
  window.removeEventListener('pointercancel', stopResize)
  if (resizeHandle?.hasPointerCapture(resizePointerId)) resizeHandle.releasePointerCapture(resizePointerId)
  resizeHandle = null
  resizePointerId = -1
  document.body.classList.remove('resizing-column', 'resizing-row')
  localStorage.setItem('hoya-layout', JSON.stringify({
    sidebarWidth: sidebarWidth.value,
    inspectorWidth: inspectorWidth.value,
    workbenchHeight: workbenchHeight.value,
  }))
  resizeMode.value = null
}

function startResize(mode: 'sidebar' | 'inspector' | 'workbench', event: PointerEvent) {
  if (mode === 'sidebar' && sidebarCollapsed.value) return
  event.preventDefault()
  resizeMode.value = mode
  resizeStartX = event.clientX
  resizeStartY = event.clientY
  resizeStartSize = mode === 'sidebar' ? sidebarWidth.value : mode === 'inspector' ? inspectorWidth.value : workbenchHeight.value
  resizePointerId = event.pointerId
  resizeHandle = event.currentTarget as HTMLElement
  resizeHandle.setPointerCapture(event.pointerId)
  document.body.classList.add(mode === 'workbench' ? 'resizing-row' : 'resizing-column')
  window.addEventListener('pointermove', handleResize)
  window.addEventListener('pointerup', stopResize)
  window.addEventListener('pointercancel', stopResize)
}

function restoreLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem('hoya-layout') || '{}')
    if (Number.isFinite(saved.sidebarWidth)) sidebarWidth.value = clamp(saved.sidebarWidth, 220, 380)
    if (Number.isFinite(saved.inspectorWidth)) inspectorWidth.value = clamp(saved.inspectorWidth, 300, 560)
    if (Number.isFinite(saved.workbenchHeight)) workbenchHeight.value = clamp(saved.workbenchHeight, 220, Math.max(220, window.innerHeight - 300))
  } catch {
    localStorage.removeItem('hoya-layout')
  }
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && contextMenu.value) {
    event.preventDefault()
    closeContextMenu()
    return
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'b') {
    event.preventDefault()
    toggleSidebar()
  }
  if ((event.ctrlKey || event.metaKey) && event.key === '`') {
    event.preventDefault()
    toggleWorkbench('terminal')
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
    event.preventDefault()
    toggleWorkbench('browser')
  }
}

async function changeLanguage(value: HoyaLanguage) {
  language.value = await bridge.setLanguage(value)
}

async function openUpdatePage() {
  await bridge.openExternal(updateInfo.value?.releasesUrl || releasesUrl)
}

const updateTitle = computed(() => {
  if (!updateInfo.value?.updateAvailable) return ''
  if (updateInfo.value.status === 'downloaded') return `新版本 ${updateInfo.value.latestVersion} 已就绪`
  if (updateInfo.value.status === 'downloading') return `正在下载 ${updateInfo.value.latestVersion}`
  return `发现新版本 ${updateInfo.value.latestVersion}`
})

const updateDetail = computed(() => {
  if (updateInfo.value?.status === 'downloaded') return '重启后自动安装'
  if (updateInfo.value?.status === 'downloading') return `后台下载 ${updateInfo.value.progress}%`
  if (updateInfo.value?.status === 'manual') return '前往 Releases 下载'
  return '将在后台自动下载'
})

async function installDownloadedUpdate() {
  try {
    await ElMessageBox.confirm('更新已下载完成。立即重启 Hoya Agent 并安装吗？', '安装更新', { confirmButtonText: '重启安装', cancelButtonText: '稍后', type: 'success' })
  } catch {
    return
  }
  if (!await bridge.installUpdate()) ElMessage.error('更新尚未下载完成')
}

async function handleUpdateAction() {
  if (updateInfo.value?.status === 'downloaded') {
    await installDownloadedUpdate()
    return
  }
  if (updateInfo.value?.status === 'manual') {
    await openUpdatePage()
    return
  }
  settingsOpen.value = true
  settingsTab.value = 'about'
}

async function checkUpdates(manual = false) {
  updateChecking.value = true
  try {
    const result = await bridge.checkForUpdates()
    updateInfo.value = result
    if (!result.ok) {
      if (manual) ElMessage.error(`检查更新失败：${result.error || '无法连接 GitHub'}`)
      return
    }
    if (result.updateAvailable) {
      if (manual) {
        if (result.status === 'downloaded') ElMessage.success(`新版本 ${result.latestVersion} 已下载，重启后自动安装`)
        else if (result.autoUpdateSupported) ElMessage.success(`发现新版本 ${result.latestVersion}，正在后台下载`)
        else ElMessage.warning(`发现新版本 ${result.latestVersion}，请从 Releases 下载`)
      }
      return
    }
    if (manual) ElMessage.success(`当前已是最新版本 ${result.currentVersion}`)
  } catch (error) {
    if (manual) ElMessage.error(`检查更新失败：${String(error)}`)
  } finally {
    updateChecking.value = false
  }
}

async function submitFeedback() {
  if (!feedbackContent.value.trim()) {
    ElMessage.warning('请先填写建议内容')
    return
  }
  const composeUrl = new URL('https://mail.google.com/mail/')
  composeUrl.searchParams.set('view', 'cm')
  composeUrl.searchParams.set('fs', '1')
  composeUrl.searchParams.set('to', authorEmail)
  composeUrl.searchParams.set('su', feedbackSubject.value.trim() || 'Hoya Agent 使用建议')
  composeUrl.searchParams.set('body', feedbackContent.value.trim())
  const opened = await bridge.openExternal(composeUrl.toString())
  if (!opened) ElMessage.error('无法在浏览器中打开写信页面')
}

async function initializeWorkspace() {
  await loadConfig()
  await hydrateBackendCredential()
  await Promise.all([loadStatus(), loadProjects()])
  await loadTasks()
  await Promise.allSettled([loadModels(), refreshPending(), refreshMemory()])
  if (status.value.configured === false) {
    settingsTab.value = 'model'
    settingsOpen.value = true
  }
}

async function initialize() {
  try {
    await initializeWorkspace()
  } catch (error) {
    status.value = { ok: false }
    ElMessage.error(`客户端初始化失败：${String(error)}`)
  }
}

let unsubscribeLanguage: () => void = () => undefined
let unsubscribeMaximized: () => void = () => undefined
let unsubscribeUpdate: () => void = () => undefined
let unsubscribeServerConnection: () => void = () => undefined

onMounted(async () => {
  restoreTheme()
  restoreLayout()
  const [version, savedLanguage, maximized] = await Promise.all([
    bridge.getAppVersion(),
    bridge.getLanguage(),
    bridge.windowIsMaximized(),
  ])
  appVersion.value = version
  language.value = savedLanguage
  windowMaximized.value = maximized
  unsubscribeServerConnection = bridge.onServerConnectionChanged((nextConnection) => {
    if (!nextConnection) {
      status.value = { ...status.value, ok: false }
      return
    }
    const changed = nextConnection.url !== serverUrl.value || nextConnection.token !== serverToken.value
    serverUrl.value = nextConnection.url
    serverToken.value = nextConnection.token
    if (changed) void initialize()
  })
  try {
    const connection = await bridge.serverConnection()
    serverUrl.value = connection.url
    serverToken.value = connection.token
  } catch (error) {
    status.value = { ok: false }
    ElMessage.error(`本地服务启动失败：${String(error)}`)
  }
  unsubscribeLanguage = bridge.onLanguageChanged((value) => { language.value = value })
  unsubscribeMaximized = bridge.onWindowMaximizedChanged((value) => { windowMaximized.value = value })
  unsubscribeUpdate = bridge.onUpdateStatus((value) => { updateInfo.value = value })
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('pointerdown', handleGlobalPointerDown, true)
  window.addEventListener('resize', closeContextMenu)
  window.addEventListener('blur', closeContextMenu)
  if (serverUrl.value) await initialize()
  void checkUpdates(false)
})

onBeforeUnmount(() => {
  stopResize()
  unsubscribeLanguage()
  unsubscribeMaximized()
  unsubscribeUpdate()
  unsubscribeServerConnection()
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('pointerdown', handleGlobalPointerDown, true)
  window.removeEventListener('resize', closeContextMenu)
  window.removeEventListener('blur', closeContextMenu)
})
</script>

<template>
  <div class="hoya-shell" :class="[{ 'sidebar-collapsed': sidebarCollapsed, 'inspector-open': inspectorOpen, 'workbench-open': workbenchOpen, maximized: windowMaximized }]" :style="layoutStyle">
    <aside class="sidebar" :aria-hidden="sidebarCollapsed" :inert="sidebarCollapsed">
      <div class="brand">
        <img :src="appIconUrl" alt="" class="brand-icon" />
        <div class="brand-copy"><div class="brand-line"><strong>Hoya Agent</strong><span class="connection-dot" :class="{ ready: connected }" /></div><small>v{{ appVersion }} · Local workspace</small></div>
      </div>

      <div class="sidebar-scroll">
        <button v-if="updateInfo?.updateAvailable" class="sidebar-update" @click="handleUpdateAction"><Refresh :class="{ spinning: updateInfo.status === 'downloading' }" /><span><strong>{{ updateTitle }}</strong><small>{{ updateDetail }}</small></span><Promotion /></button>
        <section class="nav-section">
          <div class="section-heading"><span><FolderOpened />项目</span><el-button text :icon="Box" :class="{ active: showArchivedProjects }" :aria-label="showArchivedProjects ? '隐藏归档项目' : '显示归档项目'" :title="showArchivedProjects ? '隐藏归档项目' : '显示归档项目'" @click="showArchivedProjects = !showArchivedProjects" /></div>
          <div class="project-actions">
            <el-button :icon="FolderAdd" @click="beginCreateProject">新建项目</el-button>
            <el-button :icon="FolderOpened" @click="chooseWorkspace">打开项目</el-button>
          </div>
          <div v-for="project in visibleProjects" :key="project.id" class="project-group" :class="{ archived: project.archived }">
            <div class="project-row" :class="{ active: project.path === workspace, missing: project.exists === false }" :title="project.path" @contextmenu="openContextMenu($event, { kind: 'project', project })">
              <button class="project-main" @click.stop="selectProject(project)"><FolderOpened /><span><strong>{{ project.name }}</strong><small>{{ project.path }}</small></span></button>
              <el-button text :icon="MoreFilled" aria-label="项目菜单" title="项目菜单；也可以右键项目" @click.stop="openContextMenu($event, { kind: 'project', project })" />
            </div>
            <div v-if="project.tasks?.length" class="project-task-list">
              <div v-for="task in project.tasks" :key="task.id" class="project-task-row" :class="{ active: task.id === activeTaskId }" :style="{ '--task-color': taskColors.find((item) => item.value === (task.color || ''))?.color }" @contextmenu="openContextMenu($event, { kind: 'task', project, task })">
                <span class="task-marker" />
                <button class="task-title" @click="selectProject(project, task.id)">{{ task.title }}</button>
                <el-button text :icon="MoreFilled" aria-label="项目任务菜单" @click.stop="openContextMenu($event, { kind: 'task', project, task })" />
              </div>
            </div>
          </div>
        </section>

        <section class="nav-section task-section">
          <div class="section-heading"><span><Document />任务</span><el-button text :icon="Plus" aria-label="新建任务" title="新建任务" @click="createTask" /></div>
          <button class="new-task-button" @click="createTask"><Plus />新建任务</button>
          <div class="task-list">
            <div v-for="task in tasks" :key="task.id" class="task-row" :class="{ active: task.id === activeTaskId }" :style="{ '--task-color': taskColors.find((item) => item.value === (task.color || ''))?.color }" @contextmenu="openContextMenu($event, { kind: 'task', task })">
              <span class="task-marker" />
              <template v-if="taskEditingId === task.id">
                <el-input v-model="taskTitleDraft" size="small" @keyup.enter="saveTaskTitle(task)" />
                <el-button text :icon="CircleCheck" aria-label="保存名称" @click="saveTaskTitle(task)" />
              </template>
              <template v-else>
                <button class="task-title" @click="loadTask(task.id)">{{ task.title }}</button>
                <el-dropdown trigger="click" @command="handleTaskCommand(task, $event)">
                  <el-button text :icon="MoreFilled" aria-label="任务菜单" />
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="rename" :icon="EditPen">重命名</el-dropdown-item>
                      <el-dropdown-item v-for="color in taskColors" :key="color.value" :command="`color:${color.value}`"><span class="color-swatch" :style="{ background: color.color }" />{{ color.label }}</el-dropdown-item>
                      <el-dropdown-item divided command="delete" :icon="Delete">删除任务</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </template>
            </div>
          </div>
        </section>

        <section class="nav-section tools-section">
          <div class="section-heading"><span><Operation />工作区工具</span></div>
          <button class="tool-row" :disabled="indexing" @click="buildWorkspaceIndex"><Refresh :class="{ spinning: indexing }" /><span>索引工作区</span></button>
        </section>
      </div>

      <div class="sidebar-status">
        <div><span class="status-pill" :class="connected ? 'ready' : 'error'"><span />{{ connected ? '就绪' : '未连接' }}</span><small>{{ status.provider || 'provider' }} · {{ status.model || 'model' }}</small></div>
        <span class="workspace-path" :title="workspace">{{ workspace || '等待工作区' }}</span>
      </div>
    </aside>

    <div class="resize-handle vertical sidebar-resizer" aria-hidden="true" @pointerdown="startResize('sidebar', $event)" />

    <main class="main-column">
      <header class="topbar">
        <div class="topbar-leading">
          <el-button text class="sidebar-toggle" :icon="sidebarCollapsed ? Expand : Fold" :aria-label="sidebarCollapsed ? '展开左侧工作区' : '收起左侧工作区'" :title="sidebarCollapsed ? '展开左侧工作区 (Ctrl+B)' : '收起左侧工作区 (Ctrl+B)'" @click="toggleSidebar" />
          <div class="topbar-title"><FolderOpened /><span><small>当前任务</small><strong>{{ activeTask?.title || '新任务' }}</strong></span></div>
        </div>
        <div class="top-actions">
          <span class="run-state" :class="busy ? 'busy' : connected ? 'ready' : 'error'">{{ busy ? '运行中' : connected ? '就绪' : '离线' }}</span>
          <el-select v-model="language" class="language-select" size="small" aria-label="语言" @change="changeLanguage"><el-option label="中文" value="zh-CN" /><el-option label="EN" value="en-US" /></el-select>
          <button class="theme-toggle-btn" :class="{ 'is-light': lightTheme }" :aria-label="lightTheme ? '切换为夜间模式' : '切换为日间模式'" :title="lightTheme ? '切换为夜间模式' : '切换为日间模式'" @click="lightTheme = !lightTheme">
            <component :is="lightTheme ? Moon : Sunny" />
          </button>
          <el-button class="open-location" :icon="FolderOpened" :disabled="!workspace" @click="bridge.openPath(workspace)">打开位置</el-button>
          <el-button text :class="{ active: workbenchOpen && workbenchTab === 'terminal' }" aria-label="打开或关闭终端" title="终端" @click="toggleWorkbench('terminal')"><span class="terminal-glyph" aria-hidden="true">&gt;_</span></el-button>
          <el-button text :icon="Monitor" :class="{ active: inspectorOpen && inspectorTab === 'browser' }" aria-label="打开或关闭浏览器预览" title="浏览器预览" @click="toggleWorkbench('browser')" />
          <el-button text :icon="Setting" aria-label="设置" title="设置" @click="settingsOpen = true" />
          <el-button text :icon="Menu" :class="{ active: inspectorOpen && inspectorTab === 'run' }" aria-label="打开或关闭运行检查器" title="运行检查器" @click="toggleInspector" />
          <div class="window-controls">
            <el-button text class="window-control" aria-label="最小化" title="最小化" @click="bridge.windowMinimize()"><span class="minimize-symbol" /></el-button>
            <el-button text class="window-control" :icon="FullScreen" aria-label="最大化或还原" title="最大化或还原" @click="bridge.windowToggleMaximize()" />
            <el-button text class="window-control close" :icon="Close" aria-label="关闭" title="关闭" @click="bridge.windowClose()" />
          </div>
        </div>
      </header>

      <div class="workspace-stage">
        <section class="chat-pane">
          <div ref="chatScroll" class="message-list" @scroll.passive="syncActiveAnchor">
            <nav v-if="questionAnchors.length" class="conversation-coordinates" aria-label="对话坐标" @mouseleave="hoveredAnchorPosition = -1">
              <button v-for="(anchor, position) in questionAnchors" :key="anchor.index" :style="coordinateMarkerStyle(position)" :aria-label="`${anchor.coordinate}，问题：${anchor.preview}${anchor.answerPreview ? `，回答：${anchor.answerPreview}` : ''}`" @mouseenter="hoveredAnchorPosition = position" @focus="hoveredAnchorPosition = position" @blur="hoveredAnchorPosition = -1" @click="jumpToMessage(anchor.index)">
                <span class="coordinate-tooltip">
                  <span class="coordinate-tooltip-heading"><strong>{{ anchor.coordinate }}</strong><span>问题</span></span>
                  <span class="coordinate-question-preview">{{ anchor.preview }}</span>
                  <span v-if="anchor.answerPreview" class="coordinate-answer-preview"><em>回答</em><span>{{ anchor.answerPreview }}</span></span>
                </span>
                <span class="coordinate-tick" />
              </button>
            </nav>
            <div v-if="messages.length === 0" class="empty-state">
              <h1>开始构建</h1>
              <button class="workspace-selector" :title="workspace" @click="chooseWorkspace"><FolderOpened /><span>{{ workspace || '选择项目目录' }}</span><ArrowDown /></button>
              <p>描述要修改、分析或验证的内容，Hoya 会在当前项目中执行。</p>
            </div>
            <article v-for="(message, index) in messages" :id="`message-${index}`" :key="`${message.created_at ?? 'local'}-${index}`" class="message" :class="message.role">
              <div v-if="message.role === 'assistant' && messageDurationMs(message, index) !== undefined" class="response-duration"><Timer /><span>回答用时 {{ formatResponseDuration(messageDurationMs(message, index)) }}</span></div>
              <div class="message-head"><img v-if="message.role !== 'user'" :src="appIconUrl" alt="" /><span class="message-coordinate">{{ messageCoordinate(index) }}</span><span>{{ message.role === 'user' ? '你' : message.role === 'assistant' ? 'Hoya' : message.role === 'error' ? '错误' : '系统' }}</span><span class="message-actions"><el-button v-if="message.role === 'user'" text :icon="EditPen" aria-label="编辑并复用这条提问" title="编辑并复用" @click="reusePrompt(message, index)" /><el-button v-if="message.role === 'user' || message.role === 'assistant'" text :icon="CopyDocument" aria-label="复制消息" title="复制" @click="copyText(message.content)" /></span></div>
              <details v-if="message.meta?.reasoning?.length" class="reasoning-panel"><summary>思考过程 · {{ message.meta.reasoning.length }} 条</summary><ol><li v-for="(item, reasoningIndex) in message.meta.reasoning" :key="reasoningIndex">{{ item }}</li></ol></details>
              <div class="message-body">
                <template v-for="(segment, segmentIndex) in messageSegments(message.content)" :key="segmentIndex">
                  <pre v-if="segment.kind === 'text'">{{ segment.content }}</pre>
                  <section v-else class="message-code-block">
                    <header><span>{{ segment.language }}</span><el-button text size="small" :icon="CopyDocument" aria-label="复制代码块" title="复制代码" @click="copyText(segment.content)" /></header>
                    <pre><code>{{ segment.content }}</code></pre>
                  </section>
                </template>
              </div>
              <div v-if="message.role === 'assistant' && runnableCodeBlocks(message.content).length" class="code-actions">
                <div v-for="(block, blockIndex) in runnableCodeBlocks(message.content)" :key="blockIndex" class="code-run-row">
                  <el-button size="small" :icon="VideoPlay" :loading="codeRuns[codeRunKey(index, blockIndex)]?.loading" @click="runCodeBlock(block, index, blockIndex)">运行 {{ block.language }} #{{ blockIndex + 1 }}</el-button>
                  <el-button v-if="codeRuns[codeRunKey(index, blockIndex)]" text size="small" @click="codeRuns[codeRunKey(index, blockIndex)].expanded = !codeRuns[codeRunKey(index, blockIndex)].expanded">{{ codeRuns[codeRunKey(index, blockIndex)].expanded ? '收起结果' : '查看运行结果' }}</el-button>
                  <Transition name="reveal-content"><pre v-if="codeRuns[codeRunKey(index, blockIndex)]?.expanded" class="code-output" :class="{ error: codeRuns[codeRunKey(index, blockIndex)]?.ok === false }">{{ codeRuns[codeRunKey(index, blockIndex)].output }}</pre></Transition>
                </div>
              </div>
            </article>
          </div>

          <div class="composer">
            <Transition name="reveal-content"><div v-if="pending.length" class="composer-approvals">
              <div class="approvals-header">
                <span><Warning /><strong>审阅 · {{ pending.length }}</strong></span>
                <small>请审阅并确认操作指令</small>
              </div>
              <div class="approvals-list">
                <div v-for="item in pending" :key="item.id" class="composer-approval-card">
                  <div class="approval-card-main">
                    <el-tag size="small" :type="item.risk?.level === 'high' ? 'danger' : 'warning'">{{ item.risk?.level || 'review' }}</el-tag>
                    <span class="approval-target" :title="item.path || item.command">{{ item.path || item.command }}</span>
                    <div class="approval-buttons">
                      <el-button type="primary" size="small" @click="decidePending(item, 'approved')">批准并继续</el-button>
                      <el-button size="small" @click="decidePending(item, 'denied')">拒绝</el-button>
                    </div>
                  </div>
                  <pre v-if="item.diff" class="approval-diff">{{ item.diff }}</pre>
                </div>
              </div>
            </div></Transition>

            <Transition name="reveal-content"><div v-if="editingCoordinate" class="composer-editing"><EditPen /><span>正在编辑复用 {{ editingCoordinate }}</span><el-button text :icon="Close" aria-label="取消复用" @click="editingCoordinate = ''; messageInput = ''" /></div></Transition>
            <el-input ref="composerInput" v-model="messageInput" type="textarea" :rows="3" resize="none" aria-label="任务输入" placeholder="描述你想要的修改或调查…" @keydown.enter.exact.prevent="sendTask" />
            <div class="composer-controls">
              <div class="composer-primary-tools">
                <el-dropdown trigger="click" @command="handleImportCommand">
                <el-button text size="small" :icon="FolderOpened" :disabled="importing" title="导入文件或文件夹">导入</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="file" :icon="Document">导入文件</el-dropdown-item>
                    <el-dropdown-item command="directory" :icon="Folder">导入文件夹</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>

              <el-dropdown trigger="click" class="permission-selector" @command="setPermissionMode">
                <button class="permission-btn" :class="permissionMode" title="切换权限审批等级">
                  <Lock v-if="permissionMode === 'strict'" />
                  <Warning v-else-if="permissionMode === 'risk'" />
                  <Unlock v-else />
                  <span>{{ permissionMode === 'strict' ? '严格审批' : permissionMode === 'risk' ? '风险审批' : 'YOLO 模式' }}</span>
                  <ArrowDown />
                </button>
                <template #dropdown>
                  <el-dropdown-menu class="permission-dropdown-menu">
                    <el-dropdown-item command="strict" :class="{ active: permissionMode === 'strict' }">
                      <div class="permission-item">
                        <strong><Lock />严格审批</strong>
                        <small>每个命令与文件写入均需请示用户审批</small>
                      </div>
                    </el-dropdown-item>
                    <el-dropdown-item command="risk" :class="{ active: permissionMode === 'risk' }">
                      <div class="permission-item">
                        <strong><Warning />风险审批</strong>
                        <small>仅在存在潜在风险或高危操作时提示审批</small>
                      </div>
                    </el-dropdown-item>
                    <el-dropdown-item command="yolo" :class="{ active: permissionMode === 'yolo' }">
                      <div class="permission-item">
                        <strong><Unlock />YOLO 模式</strong>
                        <small>用户审批一次后，自动授予全部运行权限</small>
                      </div>
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>

              <el-button v-if="lastUserMessage" text size="small" :icon="EditPen" @click="reusePrompt(lastUserMessage)">编辑上一条</el-button>
              </div>
              <div class="composer-run-controls">
                <el-dropdown trigger="click" class="model-menu-selector" @command="handleModelMenuCommand">
                  <button class="model-menu-btn" title="选择模型和推理强度">
                    <Operation />
                    <span><strong>{{ composerModelLabel }}</strong><small>推理 {{ composerReasoningLabel }}</small></span>
                    <ArrowDown />
                  </button>
                  <template #dropdown>
                    <el-dropdown-menu class="model-dropdown-menu">
                      <el-dropdown-item v-for="model in modelOptions" :key="model.id" :command="`model:${model.id}`" :class="{ active: model.id === composerModel }">
                        <span class="model-option-name">{{ model.name }}</span>
                      </el-dropdown-item>
                      <div class="model-dropdown-section">
                        <small>推理强度</small>
                        <div class="reasoning-menu-grid">
                          <button v-for="option in reasoningOptions" :key="option.value" type="button" :class="{ active: option.value === composerReasoning }" @click.stop="handleModelMenuCommand(`reasoning:${option.value}`)">{{ option.label }}</button>
                        </div>
                      </div>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              <el-button v-if="busy" type="danger" :icon="Loading" :loading="stopping" @click="stopTask">停止</el-button>
                <el-button v-else type="primary" :icon="VideoPlay" :disabled="!canSend" @click="sendTask">发送</el-button>
              </div>
            </div>
          </div>
        </section>

      </div>
    </main>

    <div class="resize-handle vertical inspector-resizer" aria-hidden="true" @pointerdown="startResize('inspector', $event)" />

    <aside class="inspector" :class="{ open: inspectorOpen }" :aria-hidden="!inspectorOpen">
      <div class="inspector-title"><div><span>环境与工具</span><strong>运行检查器</strong></div><el-button text :icon="Close" aria-label="关闭检查器" @click="inspectorOpen = false" /></div>
      <el-tabs v-model="inspectorTab" stretch>
        <el-tab-pane name="run" label="环境">
          <div class="inspector-scroll">
            <section class="environment-card">
              <div class="environment-heading"><strong>环境信息</strong><span class="connection-dot" :class="{ ready: connected }" /></div>
              <div class="environment-row"><span>变更</span><strong>{{ currentRun?.changes?.length ?? 0 }} 个文件</strong></div>
              <div class="environment-row"><span>本地</span><strong :title="workspace">{{ workspace || '未选择项目' }}</strong></div>
              <div class="environment-row"><span>后台进程</span><strong>{{ busy ? '任务运行中' : '空闲' }}</strong></div>
            </section>
            <section v-if="currentRun" class="run-card"><div class="run-title"><strong>{{ currentRun.task }}</strong><el-tag size="small" effect="plain">{{ currentRun.status }}</el-tag></div><p>{{ currentRun.context_summary }}</p><el-steps direction="vertical" :active="(currentRun.plan ?? []).filter((item) => item.status === 'completed').length" finish-status="success"><el-step v-for="item in currentRun.plan" :key="item.id" :title="item.title" :description="item.note" /></el-steps><div v-for="change in currentRun.changes" :key="change.version_id" class="change-row"><span><CircleCheck v-if="change.verification?.ok" /><span>{{ change.path }}</span></span><el-button text type="warning" :disabled="Boolean(change.rolled_back_at)" @click="rollback(change)">回滚</el-button></div></section>
            <div class="activity-list"><div v-for="(item, index) in activities" :key="index" class="activity-row"><span class="activity-dot" /><div><small>{{ item.type }}</small><strong>{{ item.title }}</strong><pre v-if="item.body">{{ item.body }}</pre></div></div></div>
          </div>
        </el-tab-pane>
        <el-tab-pane name="memory" label="记忆">
          <div class="inspector-scroll"><div class="memory-editor"><el-input v-model="newMemoryText" type="textarea" :rows="3" placeholder="记录项目约束或长期偏好" /><el-button type="primary" :disabled="!newMemoryText.trim()" @click="addMemory">添加记忆</el-button></div><section v-for="item in memories" :key="item.id ?? item.created_at" class="memory-item"><small>{{ item.created_at }}</small><p>{{ item.text }}</p><el-button text type="danger" :icon="Delete" aria-label="删除记忆" @click="deleteMemory(item.id ?? item.created_at)" /></section></div>
        </el-tab-pane>
        <el-tab-pane name="browser" label="浏览器" lazy><BrowserPanel compact /></el-tab-pane>
      </el-tabs>
    </aside>

    <div class="resize-handle horizontal workbench-resizer" aria-hidden="true" @pointerdown="startResize('workbench', $event)" />
    <section class="workbench" :aria-hidden="!workbenchOpen">
      <div class="workbench-tabs">
        <button :class="{ active: workbenchTab === 'terminal' }" @click="toggleWorkbench('terminal')"><span class="terminal-glyph" aria-hidden="true">&gt;_</span>终端</button>
        <el-button text :icon="Close" aria-label="关闭工作台" title="关闭工作台" @click="workbenchOpen = false" />
      </div>
      <div class="workbench-body"><TerminalPanel :cwd="workspace" /></div>
    </section>
  </div>

  <Teleport to="body">
    <Transition name="context-pop"><div v-if="contextMenu" ref="contextMenuElement" class="hoya-context-menu" :style="contextMenuStyle" role="menu" @keydown="handleContextMenuKeydown" @contextmenu.prevent>
      <template v-if="contextMenu.kind === 'project'">
        <button role="menuitem" @click="handleContextMenuCommand('open')"><FolderOpened />打开项目</button>
        <button role="menuitem" @click="handleContextMenuCommand('new-task')"><Plus />在此项目新建任务</button>
        <button role="menuitem" @click="handleContextMenuCommand('rename')"><EditPen />重命名显示名称</button>
        <button role="menuitem" @click="handleContextMenuCommand('reveal')"><Promotion />在资源管理器中打开</button>
        <button role="menuitem" @click="handleContextMenuCommand('copy-path')"><CopyDocument />复制项目路径</button>
        <span class="context-menu-separator" />
        <button role="menuitem" @click="handleContextMenuCommand('archive')"><Box />{{ contextMenu.project?.archived ? '取消归档' : '归档项目' }}</button>
        <button class="danger" role="menuitem" @click="handleContextMenuCommand('delete')"><Delete />删除项目和文件</button>
      </template>
      <template v-else>
        <button role="menuitem" @click="handleContextMenuCommand('rename')"><EditPen />重命名任务</button>
        <div class="context-color-section"><small>任务颜色</small><div class="context-color-grid"><button v-for="color in taskColors" :key="color.value" :aria-label="color.label" :title="color.label" @click="handleContextMenuCommand(`color:${color.value}`)"><span :style="{ background: color.color }" /></button></div></div>
        <span class="context-menu-separator" />
        <button class="danger" role="menuitem" @click="handleContextMenuCommand('delete')"><Delete />删除任务</button>
      </template>
    </div></Transition>
  </Teleport>

  <el-dialog v-model="settingsOpen" title="设置" width="720px" class="settings-dialog" destroy-on-close>
    <el-tabs v-model="settingsTab" class="settings-tabs">
      <el-tab-pane name="model" label="模型与 API">
        <el-form label-position="top" @submit.prevent>
          <div class="config-grid"><el-form-item label="模型来源"><el-select v-model="config.provider" @change="applyProviderDefaults($event, true)"><el-option v-for="item in providerOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item><el-form-item label="接口类型"><el-select v-model="config.wireApi" :disabled="config.provider !== 'openai-compatible'"><el-option label="Chat Completions" value="chat" /><el-option label="Responses" value="responses" /><el-option label="Messages" value="messages" /></el-select></el-form-item></div>
          <el-form-item label="API Key"><el-input v-model="config.apiKey" type="password" show-password autocomplete="off" placeholder="Ollama 可留空" /></el-form-item>
          <el-form-item label="API URL"><el-input v-model="config.baseUrl" :placeholder="config.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://relay.example.com/v1'" /></el-form-item>
          <el-form-item label="模型"><div class="model-discovery"><el-select v-model="config.model" filterable allow-create default-first-option><el-option v-for="item in discoveredModels" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button :icon="Search" :loading="discovering" @click="discoverModels">获取模型</el-button></div></el-form-item>
          <el-alert v-if="discoveryError" :title="discoveryError" type="error" show-icon />
          <el-form-item label="推理强度"><el-radio-group v-model="config.reasoningEffort"><el-radio-button v-for="item in reasoningOptions" :key="item.value" :value="item.value">{{ item.label }}</el-radio-button></el-radio-group></el-form-item>
          <el-checkbox v-model="config.showReasoning">显示公开推理摘要</el-checkbox>
          <div v-if="modelPresets.length" class="preset-list"><div class="preset-heading">已保存模型</div><div v-for="model in modelPresets" :key="model.id" class="preset-row" :class="{ active: model.id === activeModelId }"><span><strong>{{ model.name }}</strong><small>{{ model.provider }} · {{ model.model }}</small></span><el-button text type="primary" @click="selectPreset(model.id)">使用</el-button><el-button text type="danger" :icon="Delete" aria-label="删除模型预设" @click="deletePreset(model.id)" /></div></div>
        </el-form>
      </el-tab-pane>

      <el-tab-pane name="about" label="关于与更新">
        <div class="settings-section">
          <div class="settings-row version-row"><div><small>当前工具版本</small><strong>Hoya Agent v{{ appVersion }}</strong></div><el-button :icon="Refresh" :loading="updateChecking || updateInfo?.status === 'checking'" @click="checkUpdates(true)">检查更新</el-button></div>
          <div v-if="updateInfo?.ok" class="update-status" :class="{ available: updateInfo.updateAvailable }"><span><strong>{{ updateInfo.updateAvailable ? updateTitle : '当前已是最新版本' }}</strong><small>{{ updateInfo.updateAvailable ? updateDetail : `已检查 ${updateInfo.currentVersion}` }}</small><el-progress v-if="updateInfo.status === 'downloading'" :percentage="updateInfo.progress" :stroke-width="6" /></span><el-button v-if="updateInfo.status === 'downloaded'" type="primary" :icon="Refresh" @click="installDownloadedUpdate">重启安装</el-button><el-button v-else-if="updateInfo.status === 'manual'" type="primary" :icon="Promotion" @click="openUpdatePage">前往 Releases</el-button></div>
          <el-alert v-else-if="updateInfo?.error" :title="`检查更新失败：${updateInfo.error}`" type="warning" :closable="false" show-icon />
        </div>
        <div class="settings-section repository-section">
          <div><small>GitHub 仓库</small><strong>lihongyao517/Hoya_agent</strong><span>{{ repositoryUrl }}</span></div>
          <div class="settings-actions"><el-button :icon="Promotion" @click="bridge.openExternal(repositoryUrl)">打开 GitHub</el-button><el-button text @click="bridge.openExternal(tagsUrl)">查看 Tags</el-button></div>
        </div>
      </el-tab-pane>

      <el-tab-pane name="feedback" label="提交建议">
        <div class="feedback-intro"><small>联系作者</small><strong>{{ authorEmail }}</strong><p>填写后将在浏览器中打开 Gmail 写信页面，由你确认并发送。</p><el-button text :icon="CopyDocument" @click="copyText(authorEmail)">复制邮箱</el-button></div>
        <el-form label-position="top" @submit.prevent>
          <el-form-item label="邮件主题"><el-input v-model="feedbackSubject" maxlength="120" show-word-limit /></el-form-item>
          <el-form-item label="建议内容"><el-input v-model="feedbackContent" type="textarea" :rows="8" maxlength="4000" show-word-limit placeholder="请描述使用场景、遇到的问题或希望增加的功能" /></el-form-item>
          <el-button type="primary" :icon="Promotion" :disabled="!feedbackContent.trim()" @click="submitFeedback">提交建议给作者</el-button>
        </el-form>
      </el-tab-pane>
    </el-tabs>
    <template #footer><div class="settings-footer"><template v-if="settingsTab === 'model'"><el-button @click="settingsOpen = false">取消</el-button><el-button :icon="Document" @click="savePreset">保存模型预设</el-button><el-button type="primary" :loading="configSaving || configLoading" @click="saveConfig">保存并重载</el-button></template><el-button v-else @click="settingsOpen = false">关闭</el-button></div></template>
  </el-dialog>

  <el-dialog v-model="projectDialogOpen" title="新建项目" width="480px">
    <el-form label-position="top" @submit.prevent><el-form-item label="父目录"><el-input v-model="projectParent" readonly><template #append><el-button :icon="FolderOpened" @click="beginCreateProject" /></template></el-input></el-form-item><el-form-item label="项目名称"><el-input v-model="projectName" autofocus @keyup.enter="createProject" /></el-form-item></el-form>
    <template #footer><el-button @click="projectDialogOpen = false">取消</el-button><el-button type="primary" :loading="projectCreating" @click="createProject">创建项目</el-button></template>
  </el-dialog>
</template>

<style>
:root {
  --bg: #111213;
  --surface: #1b1c1e;
  --surface-subtle: #202123;
  --text: #f2f3f4;
  --text-secondary: #c5c7ca;
  --text-muted: #8b8e94;
  --border: #313337;
  --border-strong: #42454a;
  --primary: #4f9f91;
  --primary-hover: #65b4a5;
  --primary-soft: #213a36;
  --sidebar: #191b20;
  --sidebar-hover: #252830;
  --sidebar-border: #30333a;
  --el-color-primary: #4f9f91;
  --el-color-primary-light-3: #72b5aa;
  --el-color-primary-light-5: #91c7be;
  --el-color-primary-light-7: #b7d9d3;
  --el-color-primary-light-8: #d1e6e2;
  --el-color-primary-light-9: #e8f2f0;
  --el-color-primary-dark-2: #3f8075;
  --el-bg-color: #1b1c1e;
  --el-bg-color-overlay: #242527;
  --el-fill-color-blank: #1b1c1e;
  --el-fill-color-light: #25272a;
  --el-fill-color-lighter: #2b2d30;
  --el-fill-color-extra-light: #303236;
  --el-text-color-primary: #f2f3f4;
  --el-text-color-regular: #c5c7ca;
  --el-text-color-secondary: #989ba1;
  --el-text-color-placeholder: #72767d;
  --el-border-color: #383a3f;
  --el-border-color-light: #313338;
  --el-border-color-lighter: #292b2f;
  --el-mask-color: rgba(0, 0, 0, .68);
  --el-border-radius-base: 8px;
  font-family: "Segoe UI Variable", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
  color: var(--text);
  background: var(--bg);
}

:root[data-theme='light'] {
  --bg: #f3f4f6;
  --surface: #ffffff;
  --surface-subtle: #f9fafb;
  --text: #111827;
  --text-secondary: #4b5563;
  --text-muted: #6b7280;
  --border: #e5e7eb;
  --border-strong: #d1d5db;
  --primary: #4b5563;
  --primary-hover: #1f2937;
  --primary-soft: #f3f4f6;
  --sidebar: #f8f9fa;
  --sidebar-hover: #e9ecef;
  --sidebar-border: #e5e7eb;
  --el-color-primary: #4b5563;
  --el-color-primary-light-3: #6b7280;
  --el-color-primary-light-5: #9ca3af;
  --el-color-primary-light-7: #d1d5db;
  --el-color-primary-light-8: #e5e7eb;
  --el-color-primary-light-9: #f3f4f6;
  --el-color-primary-dark-2: #1f2937;
  --el-color-success: #16875f;
  --el-color-success-light-9: #e8f7f1;
  --el-color-warning: #c77816;
  --el-color-warning-light-9: #fff6e8;
  --el-color-danger: #c7473f;
  --el-color-danger-light-9: #fdefed;
  --el-color-error: #c7473f;
  --el-color-error-light-9: #fdefed;
  --el-color-info: #3f6fc5;
  --el-color-info-light-9: #edf3ff;
  --el-bg-color: #ffffff;
  --el-bg-color-overlay: #ffffff;
  --el-fill-color-blank: #ffffff;
  --el-fill-color-light: #f3f4f6;
  --el-fill-color-lighter: #f9fafb;
  --el-fill-color-extra-light: #ffffff;
  --el-text-color-primary: #111827;
  --el-text-color-regular: #374151;
  --el-text-color-secondary: #6b7280;
  --el-text-color-placeholder: #9ca3af;
  --el-border-color: #e5e7eb;
  --el-border-color-light: #f3f4f6;
  --el-border-color-lighter: #f9fafb;
  --el-mask-color: rgba(17, 24, 39, 0.4);
  color: var(--text);
  background: var(--bg);
}

html, body, #root { width: 100%; height: 100%; min-width: 980px; min-height: 640px; margin: 0; overflow: hidden; }
*, *::before, *::after { box-sizing: border-box; letter-spacing: 0; }
button, input, textarea, select { font: inherit; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid rgba(79, 159, 145, .68); outline-offset: 2px; }
.el-button { min-height: 40px; border-radius: 7px; }
.el-button.is-text { min-width: 40px; padding: 8px; border-radius: 7px; }
.el-dialog { border: 1px solid var(--border); border-radius: 12px; background: #1b1c1e; }
.settings-dialog.el-dialog { display: flex; flex-direction: column; max-width: calc(100vw - 32px); max-height: calc(100vh - 48px); margin: 24px auto !important; overflow: hidden; }
.settings-dialog .el-dialog__header,
.settings-dialog .el-dialog__footer { flex: 0 0 auto; }
.settings-dialog .el-dialog__body { flex: 1 1 auto; min-height: 0; padding-top: 8px; overflow-y: auto; }
.el-message-box, .el-popper.is-light { border-color: var(--border) !important; background: #242527 !important; }
:root[data-theme='light'] .el-dialog { background: #ffffff; }
:root[data-theme='light'] .el-message-box,
:root[data-theme='light'] .el-popper.is-light { border-color: #d7d8dc !important; background: #ffffff !important; }
:root[data-theme='light'] button:focus-visible,
:root[data-theme='light'] input:focus-visible,
:root[data-theme='light'] textarea:focus-visible,
:root[data-theme='light'] select:focus-visible { outline-color: rgba(70, 72, 77, .58); }
.model-dropdown-menu { width: min(330px, calc(100vw - 24px)); max-height: min(420px, 72vh); overflow-y: auto; padding: 6px !important; }
.model-dropdown-menu .el-dropdown-menu__item { min-height: 34px; padding: 7px 10px; border-radius: 6px; }
.model-dropdown-menu .el-dropdown-menu__item.active { color: #fff; background: #33423e; }
.model-option-name { display: block; overflow: hidden; max-width: 284px; text-overflow: ellipsis; white-space: nowrap; }
.model-dropdown-section { margin-top: 5px; padding: 9px 8px 8px; border-top: 1px solid #3b3d42; }
.model-dropdown-section small { display: block; margin-bottom: 7px; color: #aeb1b7; font-size: 10px; font-weight: 650; }
.reasoning-menu-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 5px; }
.reasoning-menu-grid button { min-height: 32px; padding: 0 6px; border: 1px solid #3b3d42; border-radius: 6px; color: #d6d8db; background: #1d1f22; cursor: pointer; font-size: 11px; }
.reasoning-menu-grid button:hover,
.reasoning-menu-grid button.active { border-color: #69736f; color: #fff; background: #33423e; }
:root[data-theme='light'] .model-dropdown-menu .el-dropdown-menu__item.active,
:root[data-theme='light'] .reasoning-menu-grid button.active,
:root[data-theme='light'] .reasoning-menu-grid button:hover { color: #202124; background: #e7e8eb; }
:root[data-theme='light'] .model-dropdown-section { border-color: #dedfe2; }
:root[data-theme='light'] .model-dropdown-section small { color: #55585e; }
:root[data-theme='light'] .reasoning-menu-grid button { border-color: #d5d6da; color: #3f4247; background: #f6f6f7; }
body.resizing-column, body.resizing-column * { cursor: col-resize !important; user-select: none !important; }
body.resizing-row, body.resizing-row * { cursor: row-resize !important; user-select: none !important; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; scroll-behavior: auto !important; } }
</style>

<style scoped>
.hoya-shell { display: grid; grid-template-columns: var(--sidebar-width) 1px minmax(300px, 1fr) 0 0; grid-template-rows: minmax(0, 1fr) 0 0; width: 100%; height: 100vh; overflow: hidden; border: 1px solid rgba(201, 213, 209, .72); border-radius: 16px; background: var(--bg); box-shadow: 0 14px 34px rgba(18, 39, 33, .12); transition: grid-template-columns 220ms cubic-bezier(.2, .8, .2, 1), grid-template-rows 220ms cubic-bezier(.2, .8, .2, 1); }
.hoya-shell.inspector-open { grid-template-columns: var(--sidebar-width) 1px minmax(300px, 1fr) 1px clamp(280px, 30vw, var(--inspector-width)); }
.hoya-shell.sidebar-collapsed { grid-template-columns: 0 0 minmax(300px, 1fr) 0 0; }
.hoya-shell.sidebar-collapsed.inspector-open { grid-template-columns: 0 0 minmax(300px, 1fr) 1px clamp(280px, 30vw, var(--inspector-width)); }
.hoya-shell.workbench-open { grid-template-rows: minmax(240px, 1fr) 1px var(--workbench-height); }
.hoya-shell.maximized { border: 0; border-radius: 0; box-shadow: none; }
.sidebar { grid-column: 1; grid-row: 1 / -1; display: grid; grid-template-rows: 68px minmax(0, 1fr) auto; min-width: 0; min-height: 0; overflow: hidden; background: var(--sidebar); opacity: 1; transform: translateX(0); transition: opacity 150ms ease, transform 220ms cubic-bezier(.2, .8, .2, 1); }
.sidebar-collapsed .sidebar { opacity: 0; pointer-events: none; transform: translateX(-12px); }
.sidebar-resizer { grid-column: 2; grid-row: 1 / -1; }
.sidebar-collapsed .sidebar-resizer { pointer-events: none; }
.resize-handle { position: relative; z-index: 20; min-width: 0; min-height: 0; background: transparent; touch-action: none; }
.resize-handle.vertical { cursor: col-resize; }
.resize-handle.horizontal { cursor: row-resize; }
.resize-handle::before { position: absolute; content: ''; inset: 0; }
.resize-handle.vertical::before { right: -3px; left: -3px; }
.resize-handle.horizontal::before { top: -3px; bottom: -3px; }
.resize-handle::after { position: absolute; content: ''; background: #0f766e; opacity: 0; transition: opacity 120ms ease; }
.resize-handle.vertical::after { top: 0; bottom: 0; left: 0; width: 1px; }
.resize-handle.horizontal::after { top: 0; right: 0; left: 0; height: 1px; }
.resize-handle:hover::after { opacity: .72; }
.brand { display: flex; align-items: center; gap: 11px; min-width: 0; padding: 14px 16px; border-bottom: 1px solid rgba(213, 221, 218, .72); -webkit-app-region: drag; }
.brand-icon { width: 36px; height: 36px; border-radius: 9px; }
.brand-copy { min-width: 0; }
.brand-line { display: flex; align-items: center; gap: 7px; }
.brand-line strong { color: #1d2825; font-size: 14.5px; font-weight: 680; }
.brand-copy small { display: block; margin-top: 2px; color: #74827d; font-size: 10px; }
.connection-dot { width: 6px; height: 6px; border-radius: 50%; background: #c4544e; }
.connection-dot.ready { background: #18a37d; }
.sidebar-scroll { min-height: 0; overflow-y: auto; padding: 9px 10px 20px; }
.sidebar-update { display: grid; grid-template-columns: 18px minmax(0, 1fr) 14px; align-items: center; gap: 8px; width: 100%; min-height: 52px; margin-bottom: 8px; padding: 8px 10px; border: 1px solid #b8d8d0; border-radius: 7px; color: #0d6656; background: #def1eb; cursor: pointer; text-align: left; }
.sidebar-update:hover { border-color: #79afa4; background: #d2ebe4; }
.sidebar-update > svg { width: 15px; }
.sidebar-update span { min-width: 0; }
.sidebar-update strong, .sidebar-update small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-update strong { font-size: 11px; }
.sidebar-update small { margin-top: 3px; color: #557d74; font-size: 9px; }
.nav-section { display: grid; gap: 5px; padding: 4px 0 12px; }
.nav-section + .nav-section { padding-top: 10px; border-top: 1px solid rgba(213, 221, 218, .72); }
.section-heading { display: flex; align-items: center; justify-content: space-between; min-height: 36px; padding: 4px 7px; color: #62716c; font-size: 11.5px; font-weight: 650; }
.section-heading > span { display: inline-flex; align-items: center; gap: 7px; }
.section-heading svg, .tool-row > svg, .new-task-button > svg { width: 15px; }
.section-heading :deep(.el-button.active) { color: var(--primary); background: #dce9e5; }
.project-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.project-actions :deep(.el-button) { min-width: 0; margin: 0; padding: 7px; border-color: var(--sidebar-border); color: #34423e; background: rgba(255, 255, 255, .68); font-size: 11px; }
.project-main, .tool-row, .new-task-button, .task-title, .workspace-selector, .workbench-tabs button { border: 0; cursor: pointer; }
.project-group { width: 100%; border-radius: 7px; }
.project-group.archived { opacity: .7; }
.project-row { display: grid; grid-template-columns: minmax(0, 1fr) 36px; align-items: center; width: 100%; min-height: 50px; border-radius: 7px; color: #3f4c48; background: transparent; }
.project-row:hover, .tool-row:hover { background: var(--sidebar-hover); }
.tool-row.active { color: #123d36; background: #dce9e5; box-shadow: inset 0 0 0 1px rgba(15, 118, 110, .1); }
.project-row.active { color: #123d36; background: #dce9e5; box-shadow: inset 0 0 0 1px rgba(15, 118, 110, .1); }
.project-row.missing { color: #a23d37; opacity: .68; }
.project-main { display: grid; grid-template-columns: 17px minmax(0, 1fr); align-items: center; gap: 6px; min-width: 0; min-height: 50px; padding: 6px 5px 6px 8px; color: inherit; background: transparent; text-align: left; }
.project-main > svg { width: 15px; }
.project-main span { min-width: 0; }
.project-row strong, .project-row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-row strong { font-size: 12px; }
.project-row small { color: #7a8984; font-family: "Cascadia Code", Consolas, monospace; font-size: 9px; }
.project-row :deep(.el-button) { width: 34px; min-width: 34px; color: #71807b; }
.project-task-list { display: grid; gap: 2px; margin: 1px 0 5px 19px; padding-left: 8px; border-left: 1px solid rgba(119, 128, 123, .28); }
.project-task-row { display: grid; grid-template-columns: 8px minmax(0, 1fr) 32px; align-items: center; min-height: 34px; border-radius: 6px; }
.project-task-row:hover { background: var(--sidebar-hover); }
.project-task-row.active { background: #dce9e5; }
.project-task-row .task-title { height: 34px; font-size: 10px; }
.project-task-row :deep(.el-button) { width: 32px; min-width: 32px; min-height: 32px; color: #71807b; }
.new-task-button { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 9px 12px; border-radius: 7px; color: #fff; background: #15201d; font-size: 12px; text-align: left; }
.new-task-button:hover { background: #26332f; }
.task-list { display: grid; gap: 3px; }
.task-row { display: grid; grid-template-columns: 8px minmax(0, 1fr) 36px; align-items: center; min-height: 42px; border-radius: 7px; }
.task-row:hover { background: var(--sidebar-hover); }
.task-row.active { background: #dce9e5; }
.task-marker { width: 3px; height: 20px; margin-left: 3px; border-radius: 3px; background: var(--task-color); }
.task-title { overflow: hidden; height: 42px; padding: 0 6px; color: #46534f; background: transparent; font-size: 11px; line-height: 1.35; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.task-row.active .task-title { color: #123d36; font-weight: 650; }
.task-row :deep(.el-dropdown .el-button) { width: 36px; min-width: 36px; color: #71807b; }
.color-swatch { display: inline-block; width: 12px; height: 12px; margin-right: 8px; border-radius: 50%; }
.tool-row { display: flex; align-items: center; gap: 9px; min-height: 42px; padding: 8px 10px; border-radius: 7px; color: #52605b; background: transparent; text-align: left; }
.terminal-glyph { display: inline-grid; place-items: center; flex: 0 0 16px; width: 16px; height: 16px; color: currentColor; font: 700 10px/1 "Cascadia Code", Consolas, monospace; white-space: nowrap; }
.tool-row:disabled { opacity: .5; cursor: wait; }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.sidebar-status { display: grid; gap: 7px; padding: 11px 15px 13px; border-top: 1px solid var(--sidebar-border); background: #e8eeeb; }
.sidebar-status > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sidebar-status small, .workspace-path { overflow: hidden; color: #71807b; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.status-pill { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 4px 8px; border-radius: 999px; color: #a23d37; background: #f7dfdd; font-size: 10px; font-weight: 700; }
.status-pill > span { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-pill.ready { color: #0f6d58; background: #d8eee5; }
.main-column { grid-column: 3; grid-row: 1; display: grid; grid-template-rows: 60px minmax(0, 1fr); min-width: 0; min-height: 0; background: var(--bg); }
.topbar { display: flex; align-items: center; justify-content: space-between; min-width: 0; padding-left: 12px; border-bottom: 1px solid #e1e7e4; background: rgba(250, 252, 251, .98); -webkit-app-region: drag; }
.topbar-leading { display: flex; align-items: center; min-width: 0; gap: 8px; }
.sidebar-toggle { width: 40px; min-width: 40px !important; height: 40px; margin: 0 !important; color: #596660; -webkit-app-region: no-drag; }
.sidebar-toggle:hover { color: #17201e; background: #e6ece9; }
.topbar-title { display: grid; min-width: 0; }
.topbar-title span { color: #7b8984; font-size: 9px; font-weight: 650; text-transform: uppercase; }
.topbar-title strong { overflow: hidden; color: #1d2925; font-size: 14px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.top-actions { display: flex; align-items: center; gap: 2px; height: 60px; margin-left: 16px; padding-right: 6px; -webkit-app-region: no-drag; }
.top-actions > :deep(.el-button) { width: 40px; min-width: 40px; height: 40px; margin: 0; border-radius: 7px; color: #596660; }
.top-actions > :deep(.el-button:hover) { color: #17201e; background: #e6ece9; }
.top-actions > :deep(.el-button.active) { color: #0f6d58; background: #dce9e5; }
.run-state { margin-right: 5px; padding: 4px 8px; border-radius: 999px; color: #a13f39; background: #f9e4e2; font-size: 10px; font-weight: 650; }
.run-state.ready { color: #0f6f59; background: #def1e9; }
.run-state.busy { color: #915611; background: #fff0d9; }
.language-select { width: 72px; margin-right: 4px; }
.language-select :deep(.el-select__wrapper) { min-height: 34px; border: 0; background: transparent; box-shadow: none; }
.theme-switch { flex: 0 0 auto; margin: 0 4px; --el-switch-on-color: #d9dadc; --el-switch-off-color: #303236; }
.theme-switch :deep(.el-switch__core) { min-width: 46px; height: 28px; border-color: #3c3e43; }
.theme-switch :deep(.el-switch__action) { width: 22px; height: 22px; color: #303236; }
.window-controls { display: flex; align-items: center; gap: 2px; height: 60px; margin-left: 2px; }
.window-control { width: 40px; min-width: 40px !important; height: 38px; border: 0 !important; border-radius: 7px !important; }
.window-control.close:hover { color: #fff !important; background: #c42b1c !important; }
.minimize-symbol { width: 10px; height: 1px; background: currentColor; }
.workspace-stage { display: grid; grid-template-rows: minmax(0, 1fr); min-height: 0; }
.chat-pane { display: grid; grid-template-rows: minmax(0, 1fr) auto; min-width: 0; min-height: 0; overflow: hidden; }
.message-list { position: relative; min-height: 0; overflow-y: auto; padding: 34px clamp(28px, 5vw, 72px) 20px; }
.conversation-coordinates { position: sticky; z-index: 8; top: 50%; float: left; display: flex; flex-direction: column; align-items: flex-start; width: 34px; margin-left: -32px; overflow: visible; transform: translateY(-50%); }
.conversation-coordinates::-webkit-scrollbar { display: none; }
.conversation-coordinates button { position: relative; display: flex; align-items: center; justify-content: flex-start; width: 32px; height: 14px; padding: 0 5px; border: 0; color: #dfe7e4; background: transparent; cursor: pointer; }
.coordinate-tick { display: block; width: 10px; height: 2px; border-radius: 2px; background: var(--coordinate-color); opacity: var(--coordinate-opacity); transform: scaleX(var(--coordinate-scale)); transform-origin: left center; transition: transform 220ms cubic-bezier(.2,.8,.2,1), background-color 220ms ease, opacity 220ms ease, box-shadow 220ms ease; }
.conversation-coordinates button:hover .coordinate-tick, .conversation-coordinates button:focus-visible .coordinate-tick { box-shadow: 0 0 10px rgba(79, 140, 255, .28); }
.coordinate-tooltip { position: absolute; top: 50%; left: 34px; display: grid; gap: 6px; overflow: hidden; width: min(320px, 34vw); padding: 9px 10px 10px; border: 1px solid #343c4c; border-radius: 7px; color: #e7ebf2; background: #141925; box-shadow: 0 12px 32px rgba(3, 7, 16, .34); opacity: 0; pointer-events: none; transform: translate(-8px, -50%) scale(.98); transform-origin: left center; transition: opacity 160ms ease, transform 200ms cubic-bezier(.2,.8,.2,1); text-align: left; white-space: normal; font-size: 10px; line-height: 1.45; }
.coordinate-tooltip-heading { display: flex; align-items: center; gap: 7px; color: #8f9aae; }
.coordinate-tooltip-heading strong { color: #72a4ff; font: 700 9px/1 "Cascadia Code", Consolas, monospace; }
.coordinate-question-preview { display: -webkit-box; overflow: hidden; color: #f0f3f8; font-weight: 500; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.coordinate-answer-preview { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px; padding-top: 6px; border-top: 1px solid #2d3545; color: #aeb8c9; }
.coordinate-answer-preview em { color: #7f8ca2; font-style: normal; font-weight: 500; }
.coordinate-answer-preview > span { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.conversation-coordinates button:hover .coordinate-tooltip, .conversation-coordinates button:focus-visible .coordinate-tooltip { opacity: 1; transform: translate(0, -50%) scale(1); }
.empty-state { display: grid; place-items: center; align-content: center; min-height: 100%; text-align: center; }
.empty-state h1 { margin: 0; color: #17231f; font-size: 29px; font-weight: 700; }
.empty-state p { max-width: 520px; margin: 10px 0 0; color: #7a8883; font-size: 12px; }
.workspace-selector { display: inline-flex; align-items: center; gap: 7px; max-width: min(520px, 100%); min-height: 40px; margin-top: 9px; padding: 6px 10px; border-radius: 6px; color: #62716c; background: transparent; }
.workspace-selector:hover { color: #1f4d45; background: #e9efed; }
.workspace-selector span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-selector svg { width: 14px; }
.message { width: min(760px, 100%); margin: 0 auto 22px; color: #20302b; }
.message.user { width: min(680px, 88%); margin-inline: auto; padding: 11px 14px; border-radius: 8px; background: #e8efec; }
.message-head { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; color: #62716c; font-size: 11px; font-weight: 650; }
.message-head img { width: 22px; height: 22px; border-radius: 6px; }
.message-coordinate { padding: 2px 4px; border-radius: 4px; color: #0f6d58; background: #e3f0ec; font: 700 8px/1 "Cascadia Code", Consolas, monospace; }
.message-actions { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; opacity: .28; transition: opacity 150ms ease; }
.message:hover .message-actions, .message:focus-within .message-actions { opacity: 1; }
.message-actions :deep(.el-button) { width: 30px; min-width: 30px; min-height: 30px; height: 30px; padding: 5px; }
.message pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 14px; font-weight: 500; line-height: 1.68; }
.message-body { display: grid; gap: 10px; }
.message-code-block { overflow: hidden; border: 1px solid #313a37; border-radius: 7px; background: #151a19; }
.message-code-block header { display: flex; align-items: center; justify-content: space-between; min-height: 34px; padding: 0 5px 0 11px; border-bottom: 1px solid #303836; color: #9eaaa6; font: 600 10px/1 "Cascadia Code", Consolas, monospace; }
.message-code-block header :deep(.el-button) { width: 30px; min-width: 30px; min-height: 28px; color: #aeb9b5; }
.message-code-block pre { max-height: 420px; overflow: auto; padding: 12px 14px; color: #e1e9e6; background: #111514; font: 12px/1.62 "Cascadia Code", Consolas, monospace; }
html[data-theme='light'] .message-code-block { border-color: #d4d8d6; background: #f3f5f4; }
html[data-theme='light'] .message-code-block header { border-color: #d9dddb; color: #5f6965; }
html[data-theme='light'] .message-code-block header :deep(.el-button) { color: #56615d; }
html[data-theme='light'] .message-code-block pre { color: #252d2a; background: #f8faf9; }
.response-duration { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: 11px; font-weight: 500; }
.response-duration svg { width: 13px; height: 13px; }
.message.system, .message.error { padding: 10px 12px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface-subtle); }
.message.error { color: #9c3e39; background: #fde9e7; }
.reasoning-panel { margin: 0 0 10px; border: 1px solid #d8e2df; border-radius: 6px; background: #f4f7f6; }
.reasoning-panel summary { min-height: 36px; padding: 9px 11px; color: #52625d; cursor: pointer; font-size: 11px; font-weight: 650; }
.reasoning-panel ol { margin: 0; padding: 0 12px 10px 30px; color: #65736e; font-size: 11px; line-height: 1.55; }
.reasoning-panel li + li { margin-top: 6px; }
.code-actions { display: grid; gap: 7px; margin-top: 10px; }
.code-run-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.code-output { flex: 1 0 100%; max-height: 260px; overflow: auto; padding: 10px !important; border-radius: 6px; color: #dfe8e4; background: #171d1b; font: 11px/1.55 "Cascadia Code", Consolas, monospace !important; }
.code-output.error { color: #ffaaa3; }
.composer { width: min(800px, calc(100% - 40px)); margin: 0 auto; padding: 10px 0 18px; }
.composer-editing { display: flex; align-items: center; gap: 7px; min-height: 34px; margin-bottom: 6px; padding: 4px 6px 4px 10px; border: 1px solid #bcd4cf; border-radius: 6px; color: #245d54; background: #e8f3f0; font-size: 11px; }
.composer-editing > svg { width: 14px; }
.composer-editing span { flex: 1; }
.composer-editing :deep(.el-button) { min-height: 28px; width: 28px; min-width: 28px; }
.composer :deep(.el-textarea__inner) { min-height: 96px !important; padding: 14px; border: 1px solid #ced9d5; border-radius: 8px; background: rgba(255,255,255,.97); box-shadow: 0 10px 30px rgba(22,55,45,.09); resize: none; }
.composer :deep(.el-textarea__inner:focus) { border-color: #77aaa0; box-shadow: 0 0 0 3px rgba(15,118,110,.12), 0 12px 32px rgba(22,55,45,.1); }
.composer-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
.model-select { width: 220px; }
.model-menu-selector { flex: 0 1 220px; min-width: 150px; }
.model-menu-btn { display: grid; grid-template-columns: 16px minmax(0, 1fr) 13px; align-items: center; gap: 7px; width: 100%; min-height: 36px; padding: 5px 9px; border: 1px solid #3a3c40; border-radius: 7px; color: #d5d7da; background: #222326; cursor: pointer; text-align: left; }
.model-menu-btn:hover { border-color: #505359; background: #282a2e; }
.model-menu-btn > svg { width: 14px; height: 14px; }
.model-menu-btn span { display: grid; min-width: 0; }
.model-menu-btn strong,
.model-menu-btn small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-menu-btn strong { font-size: 11px; font-weight: 650; }
.model-menu-btn small { color: #9da1a8; font-size: 9px; }
.composer-controls :deep(.el-radio-group) { margin-right: auto; }
.composer-controls :deep(.el-radio-button__inner) { padding-inline: 10px; }
.workbench { grid-column: 3 / -1; grid-row: 3; min-width: 0; min-height: 0; overflow: hidden; visibility: hidden; border: 0; background: #f5f8f7; opacity: 0; pointer-events: none; transform: translateY(10px); transition: opacity 180ms ease, transform 220ms cubic-bezier(.2, .8, .2, 1), visibility 0s linear 220ms; }
.workbench-open .workbench { visibility: visible; opacity: 1; pointer-events: auto; transform: translateY(0); transition-delay: 0s; }
.workbench-resizer { grid-column: 3 / -1; grid-row: 2; visibility: hidden; opacity: 0; pointer-events: none; transition: opacity 160ms ease, visibility 0s linear 220ms; }
.workbench-open .workbench-resizer { visibility: visible; opacity: 1; pointer-events: auto; transition-delay: 0s; }
.workbench-tabs { display: flex; align-items: center; height: 38px; padding-left: 8px; border-bottom: 1px solid #d5ddda; background: #eef2f0; }
.workbench-tabs button { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 6px 11px; border-radius: 7px; color: #687670; background: transparent; font-size: 11px; }
.workbench-tabs button.active { color: #123d36; background: #fff; box-shadow: inset 0 0 0 1px #d5ddda; }
.workbench-tabs button svg { width: 14px; }
.workbench-tabs :deep(.el-button) { margin-left: auto; }
.workbench-body { height: calc(100% - 38px); min-height: 0; }
.inspector { grid-column: 5; grid-row: 1; display: grid; grid-template-rows: 60px minmax(0, 1fr); min-width: 0; min-height: 0; visibility: hidden; overflow: hidden; border: 0; background: #f5f8f7; opacity: 0; pointer-events: none; transform: translateX(14px); transition: opacity 180ms ease, transform 220ms cubic-bezier(.2, .8, .2, 1), visibility 0s linear 220ms; }
.inspector.open { visibility: visible; opacity: 1; pointer-events: auto; transform: translateX(0); transition-delay: 0s; }
.inspector-resizer { grid-column: 4; grid-row: 1; visibility: hidden; opacity: 0; pointer-events: none; transition: opacity 160ms ease, visibility 0s linear 220ms; }
.inspector-open .inspector-resizer { visibility: visible; opacity: 1; pointer-events: auto; transition-delay: 0s; }
.inspector-title { display: flex; align-items: center; justify-content: space-between; padding: 0 10px 0 16px; border-bottom: 1px solid #dbe3e0; }
.inspector-title > div { display: grid; }
.inspector-title span { color: #7b8984; font-size: 9px; }
.inspector-title strong { color: #27332f; font-size: 14px; }
.inspector :deep(.el-tabs) { display: grid; grid-template-rows: 48px minmax(0, 1fr); min-height: 0; }
.inspector :deep(.el-tabs__header) { margin: 0; padding: 5px 8px 0; }
.inspector :deep(.el-tabs__content), .inspector :deep(.el-tab-pane) { min-height: 0; height: 100%; }
.inspector-scroll { height: 100%; overflow-y: auto; padding: 12px 14px 18px; }
.run-card, .approval-card, .memory-item { margin-bottom: 10px; padding: 12px; border: 1px solid #dbe3e0; border-radius: 7px; background: #fff; }
.run-title, .change-row, .approval-card > div:first-child, .approval-actions, .memory-item { display: flex; align-items: center; }
.run-title { justify-content: space-between; gap: 8px; }
.run-card > p, .memory-item p { color: #677570; font-size: 11px; line-height: 1.55; }
.change-row { justify-content: space-between; gap: 8px; min-height: 42px; border-top: 1px solid #edf1ef; }
.change-row > span { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; color: #0f766e; }
.activity-list { margin-top: 14px; }
.activity-row { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 7px; padding-bottom: 14px; }
.activity-dot { width: 7px; height: 7px; margin-top: 5px; border-radius: 50%; background: #0f766e; }
.activity-row small, .activity-row strong { display: block; }
.activity-row small { color: #81908a; font-size: 9px; text-transform: uppercase; }
.activity-row strong { color: #394641; font-size: 11px; line-height: 1.5; }
.activity-row pre, .approval-card pre { overflow: auto; margin: 7px 0 0; padding: 9px; border-radius: 5px; color: #e4ece9; background: #1d2422; white-space: pre-wrap; word-break: break-word; font: 10px/1.55 "Cascadia Code", Consolas, monospace; }
.approval-card > div:first-child { gap: 7px; }
.approval-card strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.approval-actions { gap: 7px; margin-top: 10px; }
.memory-editor { display: grid; gap: 8px; margin-bottom: 12px; }
.memory-item { align-items: flex-start; gap: 8px; }
.memory-item small { color: #84918c; font-size: 9px; }
.memory-item p { flex: 1; margin: 0; }
.config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.config-grid :deep(.el-select), .model-discovery :deep(.el-select) { width: 100%; }
.model-discovery { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; width: 100%; }
.preset-list { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
.preset-heading { margin-bottom: 6px; color: #687670; font-size: 11px; font-weight: 650; }
.preset-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 40px; align-items: center; min-height: 48px; padding: 4px 6px; border-radius: 6px; }
.preset-row.active { background: #edf7f4; }
.preset-row strong, .preset-row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preset-row small { color: #81908a; font-size: 10px; }
.hoya-context-menu { position: fixed; z-index: 5000; width: 232px; padding: 6px; border: 1px solid #d3ddda; border-radius: 7px; background: rgba(255, 255, 255, .98); box-shadow: 0 14px 36px rgba(19, 34, 29, .18); backdrop-filter: blur(12px); }
.hoya-context-menu > button { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 36px; padding: 7px 9px; border: 0; border-radius: 5px; color: #34423e; background: transparent; cursor: pointer; text-align: left; font-size: 11px; }
.hoya-context-menu > button:hover, .hoya-context-menu > button:focus-visible { color: #123d36; background: #e7f0ed; }
.hoya-context-menu > button.danger { color: #a8403a; }
.hoya-context-menu > button.danger:hover { background: #f9e5e3; }
.hoya-context-menu > button svg { flex: 0 0 auto; width: 15px; }
.context-menu-separator { display: block; height: 1px; margin: 5px 4px; background: #e3e9e7; }
.context-color-section { padding: 6px 9px 8px; }
.context-color-section small { display: block; margin-bottom: 6px; color: #7b8984; font-size: 9px; }
.context-color-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.context-color-grid button { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 5px; background: transparent; cursor: pointer; }
.context-color-grid button:hover, .context-color-grid button:focus-visible { background: #e8efec; }
.context-color-grid span { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(20, 35, 30, .12); }
.settings-tabs :deep(.el-tabs__content) { min-height: 0; }
.settings-section { padding: 18px 0; border-bottom: 1px solid var(--border); }
.settings-section:first-child { padding-top: 4px; }
.settings-section:last-child { border-bottom: 0; }
.settings-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.settings-row > div, .repository-section > div { min-width: 0; }
.settings-row small, .repository-section small, .feedback-intro small { display: block; margin-bottom: 5px; color: #7a8984; font-size: 10px; }
.settings-row strong, .repository-section strong, .feedback-intro strong { display: block; color: #24312d; font-size: 15px; }
.version-row strong { font-family: "Cascadia Code", Consolas, monospace; }
.update-status { display: flex; align-items: flex-start; gap: 9px; margin-top: 14px; padding: 11px 12px; border: 1px solid #d8e2df; border-radius: 7px; color: #53635e; background: #f3f6f5; font-size: 11px; line-height: 1.5; }
.update-status.available { border-color: #a9d1c8; color: #0d6656; background: #e5f3ef; }
.update-status > svg { flex: 0 0 auto; width: 15px; margin-top: 1px; }
.update-status > span { flex: 1; min-width: 0; }
.update-status strong, .update-status small { display: block; }
.update-status small { margin-top: 2px; color: #5f7f77; }
.update-status :deep(.el-progress) { margin-top: 9px; }
.update-status :deep(.el-button) { flex: 0 0 auto; margin-left: auto; }
.repository-section { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.repository-section span { display: block; overflow: hidden; margin-top: 5px; color: #71807b; font: 10px/1.4 "Cascadia Code", Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.settings-actions, .settings-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.settings-actions :deep(.el-button), .settings-footer :deep(.el-button) { margin: 0; }
.feedback-intro { position: relative; padding: 4px 128px 18px 0; border-bottom: 1px solid var(--border); }
.feedback-intro p { margin: 7px 0 0; color: #697772; font-size: 11px; line-height: 1.5; }
.feedback-intro > :deep(.el-button) { position: absolute; top: 4px; right: 0; }
.settings-tabs :deep(.el-form) { margin-top: 18px; }

/* Codex-inspired dark workbench */
.hoya-shell { border-color: #37393e; border-radius: 12px; background: #111213; box-shadow: 0 18px 56px rgba(0, 0, 0, .42); }
.sidebar { grid-template-rows: 72px minmax(0, 1fr) auto; border-right: 0; color: #e5e9f2; background: #141925; }
.brand { gap: 10px; padding: 14px 18px; border-color: #293246; background: #141925; }
.brand-icon { width: 34px; height: 34px; border-radius: 8px; }
.brand-line strong { color: #f2f3f4; font-size: 16px; }
.brand-copy small { color: #9aa5b8; font-weight: 500; }
.sidebar-scroll { padding: 12px 10px 24px; scrollbar-color: #48536a transparent; }
.nav-section { gap: 4px; padding-bottom: 14px; }
.nav-section + .nav-section { padding-top: 12px; border-color: #293246; }
.section-heading { min-height: 34px; padding-inline: 10px; color: #9da8bb; font-size: 12px; font-weight: 500; }
.section-heading :deep(.el-button.active) { color: #edf3ff; background: #2b3549; }
.project-actions { gap: 6px; padding-bottom: 4px; }
.project-actions :deep(.el-button) { min-height: 38px; border-color: #303a4f; color: #e1e6ef; background: #1b2230; font-weight: 500; }
.project-actions :deep(.el-button:hover) { border-color: #4b5a75; background: #222b3b; }
.project-row { min-height: 44px; border-radius: 8px; color: #dce2ec; font-weight: 500; }
.project-row:hover, .tool-row:hover { background: #202839; }
.project-row.active { color: #fff; background: #29344a; box-shadow: none; }
.project-row small { display: none; }
.project-main { min-height: 44px; color: inherit; }
.project-row :deep(.el-button), .project-task-row :deep(.el-button), .task-row :deep(.el-button) { color: #a6b0c1; }
.project-task-list { border-color: #333d51; }
.project-task-row:hover { background: #202839; }
.project-task-row.active { background: #29344a; }
.new-task-button { min-height: 42px; border: 1px solid #34405a; border-radius: 8px; color: #f5f7fb; background: #1d2534; font-weight: 500; }
.new-task-button:hover { border-color: #4b5a75; background: #263146; }
.task-row { border-radius: 8px; }
.task-row:hover { background: #202839; }
.task-row.active { background: #29344a; }
.task-title { color: #d1d8e4; font-weight: 500; }
.task-row.active .task-title { color: #fff; }
.tool-row { border-radius: 8px; color: #c4ccda; font-weight: 500; }
.tool-row.active { color: #fff; background: #29344a; box-shadow: none; }
.sidebar-update { border-color: #33534d; color: #8fd0c3; background: #20302e; }
.sidebar-status { border-color: #293246; background: #111622; }
.sidebar-status small, .workspace-path { color: #95a1b5; font-weight: 500; }
.status-pill { color: #ff9b8f; background: #3b2626; }
.status-pill.ready { color: #79ccb9; background: #203630; }
.resize-handle::after { background: #303239; }
.resize-handle:hover::after { background: #6faaa0; box-shadow: none; }

.main-column { background: #111213; }
.topbar { padding-left: 20px; border-color: #303236; background: #151617; }
.sidebar-toggle { color: #aeb1b7; }
.sidebar-toggle:hover { color: #fff; background: #292b2f; }
.topbar-title { display: flex; align-items: center; gap: 10px; }
.topbar-title > svg { width: 18px; color: #c7c9cc; }
.topbar-title > span { display: grid; }
.topbar-title small { color: #777b82; font-size: 9px; font-weight: 650; text-transform: uppercase; }
.topbar-title strong { color: #f3f4f5; font-size: 14px; }
.top-actions > :deep(.el-button) { color: #aeb1b7; }
.top-actions > :deep(.el-button:hover) { color: #fff; background: #292b2f; }
.top-actions > :deep(.el-button.active) { color: #dff5f0; background: #2b3b38; }
.top-actions > :deep(.el-button.open-location) { width: auto; min-width: 112px; padding-inline: 14px; border: 1px solid #383a3f; color: #e6e7e9; background: #202123; }
.top-actions > :deep(.el-button.open-location:hover) { border-color: #4a4d53; background: #292a2d; }
.run-state { color: #ff9b8f; background: #3b2626; }
.run-state.ready { color: #79ccb9; background: #203630; }
.run-state.busy { color: #f0b66e; background: #3b3020; }
.language-select :deep(.el-select__wrapper) { color: #c6c8cc; background: transparent; }
.window-control { color: #b7bac0 !important; }
.window-control:hover { background: #292b2f !important; }
.window-control.close:hover { background: #c42b1c !important; }

.chat-pane { background: #121313; }
.message-list { padding: 38px clamp(32px, 7vw, 116px) 24px; scrollbar-color: #3a3c40 transparent; }
.empty-state h1 { color: #f3f4f5; font-size: 28px; }
.empty-state p { color: #85888d; }
.workspace-selector { color: #c5c7ca; }
.workspace-selector:hover { color: #fff; background: #242628; }
.message { width: min(760px, 100%); margin-bottom: 30px; color: #e7e8ea; }
.message.user { width: min(680px, 88%); padding: 14px 16px; border: 1px solid #35373b; border-radius: 12px; background: #202123; }
.message-head { color: #8e9197; }
.message-head img { border-radius: 6px; }
.message pre { color: #e8e9eb; font-size: 14px; line-height: 1.72; }
.message.system, .message.error { border-color: #36383d; background: #1b1c1e; }
.message.error { color: #ffaaa1; background: #322020; }
.message-actions :deep(.el-button) { color: #8c9096; }
.message-actions :deep(.el-button:hover) { color: #f2f3f4; background: #292b2e; }
.reasoning-panel { border-color: #303236; color: #a3a6ac; background: #18191a; }
.reasoning-panel summary { color: #aeb1b7; }
.code-run-row { border-color: #323439; background: #18191a; }
.code-output { background: #0d0e0f !important; }
.conversation-coordinates { border-color: #34363a; }
.coordinate-tick { background: #5d6066; }

.composer { width: min(800px, calc(100% - 48px)); margin-bottom: 20px; padding: 12px 14px 10px; border: 1px solid #3a3c40; border-radius: 16px; background: #292a2c; box-shadow: 0 18px 46px rgba(0, 0, 0, .34); }
.composer :deep(.el-textarea__inner) { min-height: 84px !important; padding: 6px 4px 12px; border: 0; border-radius: 0; color: #f1f2f3; background: transparent; box-shadow: none; }
.composer :deep(.el-textarea__inner:focus) { border: 0; box-shadow: none; }
.composer :deep(.el-textarea__inner::placeholder) { color: #777a80; }
.composer-controls { gap: 8px; margin-top: 0; }
.composer-controls :deep(.el-button) { border-radius: 9px; }
.composer-controls :deep(.el-button.is-text) { color: #aeb1b7; }
.composer-controls :deep(.el-button--primary) { color: #17201e; background: #d9e8e5; border-color: #d9e8e5; }
.composer-controls :deep(.el-button--danger) { color: #fff; }
.composer-controls :deep(.el-radio-button__inner) { border-color: #3b3d42; color: #aaadb2; background: #222326; box-shadow: none; }
.composer-controls :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) { color: #eff8f6; background: #344a45; border-color: #4f796f; box-shadow: none; }
.composer-editing { border-color: #4c7169; color: #9bd0c5; background: #23332f; }
.access-mode { display: inline-flex; align-items: center; gap: 5px; min-height: 32px; color: #f28c45; font-size: 11px; font-weight: 650; white-space: nowrap; }
.access-mode svg { width: 14px; }
.model-select { width: 190px; margin-left: auto; }
.model-select :deep(.el-select__wrapper) { border: 0; color: #d5d7da; background: #222326; box-shadow: inset 0 0 0 1px #3a3c40; }
.model-menu-selector { width: 190px; margin-left: auto; }

.workbench { background: #131414; }
.workbench-tabs { border-color: #303236; background: #191a1b; }
.workbench-tabs button { color: #989ba1; }
.workbench-tabs button:hover { color: #e7e8e9; background: #252628; }
.workbench-tabs button.active { color: #fff; background: #2a2b2d; box-shadow: inset 0 0 0 1px #393b3f; }
.workbench-tabs :deep(.el-button) { color: #9fa2a7; }

.inspector { border-color: #303236; background: #171818; }
.inspector-title { border-color: #303236; }
.inspector-title span { color: #777b82; }
.inspector-title strong { color: #f1f2f3; }
.inspector :deep(.el-tabs__nav-wrap::after) { background: #303236; }
.inspector :deep(.el-tabs__item) { color: #93969c; }
.inspector :deep(.el-tabs__item.is-active) { color: #e9eaea; }
.inspector-scroll { scrollbar-color: #3b3d42 transparent; }
.environment-card, .run-card, .approval-card, .memory-item { margin-bottom: 12px; padding: 14px; border: 1px solid #36383c; border-radius: 12px; background: #222325; }
.environment-heading, .environment-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.environment-heading { padding-bottom: 10px; color: #e5e6e8; }
.environment-row { min-height: 38px; border-top: 1px solid #323438; color: #aeb1b6; font-size: 11px; }
.environment-row strong { overflow: hidden; max-width: 68%; color: #e1e2e4; text-overflow: ellipsis; white-space: nowrap; }
.run-card > p, .memory-item p { color: #a6a9ae; }
.change-row { border-color: #34363a; }
.change-row > span { color: #72c8a7; }
.activity-row strong { color: #d7d9dc; }
.activity-row small { color: #7f838a; }
.activity-row pre, .approval-card pre { background: #0e0f10; }
.preset-row.active { background: #26332f; }
.preset-heading, .preset-row small { color: #92969c; }
.hoya-context-menu { border-color: #3b3d42; background: rgba(37, 38, 41, .98); box-shadow: 0 18px 42px rgba(0, 0, 0, .42); }
.hoya-context-menu > button { color: #d6d8db; }
.hoya-context-menu > button:hover, .hoya-context-menu > button:focus-visible { color: #fff; background: #33353a; }
.hoya-context-menu > button.danger { color: #ff9e95; }
.hoya-context-menu > button.danger:hover { background: #442827; }
.context-menu-separator { background: #3b3d42; }
.context-color-section small { color: #94979d; }
.context-color-grid button:hover, .context-color-grid button:focus-visible { background: #34363a; }
.settings-section, .preset-list, .feedback-intro { border-color: #34363a; }
.settings-row small, .repository-section small, .feedback-intro small { color: #8e9298; }
.settings-row strong, .repository-section strong, .feedback-intro strong { color: #eceef0; }
.repository-section span, .feedback-intro p { color: #a0a3a8; }
.update-status { border-color: #383a3f; color: #b9bcc1; background: #222326; }
.update-status.available { border-color: #41665e; color: #8ed2c3; background: #20312d; }

/* Neutral daylight theme */
html[data-theme='light'] .hoya-shell { border-color: #cfd0d4; background: #f5f5f6; box-shadow: 0 16px 44px rgba(31, 33, 36, .14); }
html[data-theme='light'] .sidebar { background: #eeeef0; }
html[data-theme='light'] .brand { border-color: #d7d8dc; background: #eeeef0; }
html[data-theme='light'] .brand-icon { filter: grayscale(1); }
html[data-theme='light'] .brand-line strong { color: #202124; }
html[data-theme='light'] .brand-copy small,
html[data-theme='light'] .section-heading { color: #74777d; }
html[data-theme='light'] .sidebar-scroll { scrollbar-color: #c1c3c8 transparent; }
html[data-theme='light'] .nav-section + .nav-section { border-color: #d8d9dd; }
html[data-theme='light'] .project-actions :deep(.el-button) { border-color: #d2d3d7; color: #3f4247; background: #f8f8f9; }
html[data-theme='light'] .project-actions :deep(.el-button:hover) { border-color: #bfc1c6; background: #ffffff; }
html[data-theme='light'] .project-row { color: #44474c; }
html[data-theme='light'] .project-row:hover,
html[data-theme='light'] .project-task-row:hover,
html[data-theme='light'] .tool-row:hover,
html[data-theme='light'] .task-row:hover { background: #e2e3e6; }
html[data-theme='light'] .project-row.active,
html[data-theme='light'] .project-task-row.active,
html[data-theme='light'] .task-row.active,
html[data-theme='light'] .tool-row.active { color: #202124; background: #d9dade; }
html[data-theme='light'] .task-marker { background: #85888e !important; }
html[data-theme='light'] .project-row :deep(.el-button),
html[data-theme='light'] .project-task-row :deep(.el-button),
html[data-theme='light'] .task-row :deep(.el-button) { color: #74777d; }
html[data-theme='light'] .new-task-button { border-color: #d0d1d5; color: #292b2f; background: #fafafa; }
html[data-theme='light'] .new-task-button:hover { border-color: #bfc1c6; background: #ffffff; }
html[data-theme='light'] .task-title { color: #4d5055; }
html[data-theme='light'] .task-row.active .task-title,
html[data-theme='light'] .project-task-row.active .task-title { color: #202124; }
html[data-theme='light'] .tool-row { color: #56595f; }
html[data-theme='light'] .sidebar-update { border-color: #cfd0d4; color: #4d5055; background: #e4e4e6; }
html[data-theme='light'] .sidebar-status { border-color: #d5d6da; background: #e8e8ea; }
html[data-theme='light'] .sidebar-status small,
html[data-theme='light'] .workspace-path { color: #6c7076; }
html[data-theme='light'] .status-pill,
html[data-theme='light'] .status-pill.ready { color: #4f5258; background: #d8d9dc; }
html[data-theme='light'] .connection-dot,
html[data-theme='light'] .connection-dot.ready { background: #777a80; }
html[data-theme='light'] .resize-handle::after { background: #d0d1d4; }
html[data-theme='light'] .resize-handle:hover::after { background: #7a7d83; }

html[data-theme='light'] .main-column,
html[data-theme='light'] .chat-pane { background: #f7f7f8; }
html[data-theme='light'] .topbar { border-color: #d9dade; background: #f2f2f3; }
html[data-theme='light'] .topbar-title > svg { color: #505359; }
html[data-theme='light'] .topbar-title small { color: #7b7e84; }
html[data-theme='light'] .topbar-title strong { color: #202124; }
html[data-theme='light'] .top-actions > :deep(.el-button) { color: #5b5e64; }
html[data-theme='light'] .top-actions > :deep(.el-button:hover) { color: #202124; background: #e1e2e5; }
html[data-theme='light'] .top-actions > :deep(.el-button.active) { color: #303237; background: #d9dade; }
html[data-theme='light'] .top-actions > :deep(.el-button.open-location) { border-color: #d1d2d6; color: #303237; background: #fafafa; }
html[data-theme='light'] .top-actions > :deep(.el-button.open-location:hover) { border-color: #bfc1c6; background: #ffffff; }
html[data-theme='light'] .language-select :deep(.el-select__wrapper) { color: #4d5055; }
html[data-theme='light'] .window-control { color: #55585e !important; }
html[data-theme='light'] .window-control:hover { background: #e0e1e4 !important; }
html[data-theme='light'] .run-state,
html[data-theme='light'] .run-state.ready,
html[data-theme='light'] .run-state.busy { color: #4d5055; background: #dedfe2; }

html[data-theme='light'] .message-list { scrollbar-color: #c5c7cb transparent; }
html[data-theme='light'] .empty-state h1 { color: #202124; }
html[data-theme='light'] .empty-state p { color: #74777d; }
html[data-theme='light'] .workspace-selector { color: #55585e; }
html[data-theme='light'] .workspace-selector:hover { color: #202124; background: #e6e7e9; }
html[data-theme='light'] .message { color: #292b2f; }
html[data-theme='light'] .message.user { border-color: #d8d9dc; background: #ececef; }
html[data-theme='light'] .message-head { color: #71747a; }
html[data-theme='light'] .message pre { color: #292b2f; }
html[data-theme='light'] .message.system,
html[data-theme='light'] .message.error { border-color: #d9dade; background: #ffffff; }
html[data-theme='light'] .message.error { color: #34363b; background: #e5e5e7; }
html[data-theme='light'] .reasoning-panel,
html[data-theme='light'] .code-run-row { border-color: #d9dade; color: #5f6268; background: #f0f0f2; }
html[data-theme='light'] .reasoning-panel summary { color: #55585e; }
html[data-theme='light'] .code-output,
html[data-theme='light'] .history,
html[data-theme='light'] .activity-row pre,
html[data-theme='light'] .approval-card pre { color: #303237 !important; background: #e8e8ea !important; }
html[data-theme='light'] .composer { border-color: #d0d1d5; background: #ffffff; box-shadow: 0 16px 38px rgba(32, 34, 37, .12); }
html[data-theme='light'] .composer :deep(.el-textarea__inner) { color: #202124; }
html[data-theme='light'] .composer :deep(.el-textarea__inner::placeholder) { color: #94979d; }
html[data-theme='light'] .composer-controls :deep(.el-button.is-text) { color: #5c6066; }
html[data-theme='light'] .composer-controls :deep(.el-button--primary) { color: #ffffff; background: #42454a; border-color: #42454a; }
html[data-theme='light'] .composer-controls :deep(.el-radio-button__inner) { border-color: #d4d5d9; color: #62656b; background: #f4f4f5; }
html[data-theme='light'] .composer-controls :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) { color: #202124; background: #d9dade; border-color: #b8b9be; }
html[data-theme='light'] .el-tabs__active-bar { background-color: #4a4d52 !important; }
html[data-theme='light'] .el-tag { border-color: #d0d1d5 !important; color: #4d5055 !important; background: #ededee !important; }
html[data-theme='light'] .el-step__head.is-success,
html[data-theme='light'] .el-step__head.is-process { color: #55585e !important; border-color: #55585e !important; }
html[data-theme='light'] .el-step__title.is-success,
html[data-theme='light'] .el-step__title.is-process { color: #202124 !important; }
html[data-theme='light'] .el-switch.is-checked .el-switch__core { background-color: #606268 !important; border-color: #606268 !important; }
html[data-theme='light'] .model-select :deep(.el-select__wrapper) { color: #34363b; background: #f3f3f4; box-shadow: inset 0 0 0 1px #d7d8dc; }
html[data-theme='light'] .model-menu-btn { border-color: #d7d8dc; color: #34363b; background: #f3f3f4; }
html[data-theme='light'] .model-menu-btn:hover { border-color: #bfc1c6; background: #fff; }
html[data-theme='light'] .model-menu-btn small { color: #74777d; }
html[data-theme='light'] .composer-editing { border-color: #c8c9cd; color: #4d5055; background: #e8e8ea; }
html[data-theme='light'] .access-mode { color: #55585e; }

html[data-theme='light'] .workbench { background: #f4f4f5; }
html[data-theme='light'] .workbench-tabs { border-color: #d5d6da; background: #ececee; }
html[data-theme='light'] .workbench-tabs button { color: #686b71; }
html[data-theme='light'] .workbench-tabs button:hover { color: #202124; background: #dedfe2; }
html[data-theme='light'] .workbench-tabs button.active { color: #202124; background: #ffffff; box-shadow: inset 0 0 0 1px #d4d5d9; }
html[data-theme='light'] .inspector { border-color: #d5d6da; background: #f1f1f2; }
html[data-theme='light'] .inspector-title { border-color: #d5d6da; }
html[data-theme='light'] .inspector-title span { color: #777a80; }
html[data-theme='light'] .inspector-title strong { color: #202124; }
html[data-theme='light'] .inspector :deep(.el-tabs__nav-wrap::after) { background: #d5d6da; }
html[data-theme='light'] .inspector :deep(.el-tabs__item) { color: #686b71; }
html[data-theme='light'] .inspector :deep(.el-tabs__item.is-active) { color: #202124; }
html[data-theme='light'] .environment-card,
html[data-theme='light'] .run-card,
html[data-theme='light'] .approval-card,
html[data-theme='light'] .search-result,
html[data-theme='light'] .memory-item { border-color: #d9dade; background: #ffffff; }
html[data-theme='light'] .environment-heading,
html[data-theme='light'] .environment-row strong,
html[data-theme='light'] .search-result strong { color: #292b2f; }
html[data-theme='light'] .environment-row { border-color: #e2e3e6; color: #676a70; }
html[data-theme='light'] .run-card > p,
html[data-theme='light'] .search-result p,
html[data-theme='light'] .memory-item p { color: #5f6268; }
html[data-theme='light'] .activity-row strong { color: #3f4247; }
html[data-theme='light'] .activity-dot { background: #777a80; }
html[data-theme='light'] .change-row > span { color: #4d5055; }
html[data-theme='light'] .update-status,
html[data-theme='light'] .update-status.available { border-color: #d2d3d7; color: #55585e; background: #ededee; }
html[data-theme='light'] .update-status small { color: #74777d; }
html[data-theme='light'] .color-swatch,
html[data-theme='light'] .context-color-grid span { filter: grayscale(1); }
.theme-toggle-btn {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 6px !important;
  height: 30px !important;
  padding: 0 12px !important;
  border-radius: 16px !important;
  font-size: 11px !important;
  font-weight: 600 !important;
  border: 1px solid #474b56 !important;
  background: #23262e !important;
  color: #f3f4f6 !important;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.28) !important;
  cursor: pointer !important;
  transition: all 160ms ease !important;
}
.theme-toggle-btn svg {
  width: 14px !important;
  height: 14px !important;
  color: #fbbf24 !important;
}
.theme-toggle-btn:hover {
  border-color: #636875 !important;
  background: #2c303a !important;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4) !important;
}
.theme-toggle-btn.is-light {
  border: 1px solid #d1d5db !important;
  background: #ffffff !important;
  color: #111827 !important;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08) !important;
}
.theme-toggle-btn.is-light svg {
  color: #4b5563 !important;
}
.theme-toggle-btn.is-light:hover {
  border-color: #9ca3af !important;
  background: #f9fafb !important;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.12) !important;
}

.permission-selector { display: inline-flex; align-items: center; }
.permission-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid #36393e;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  background: #1d1e21;
  color: #c9cdd4;
  transition: all 140ms ease;
}
.permission-btn:hover { border-color: #4f535a; background: #26272b; color: #ffffff; }
.permission-btn svg { width: 13px; height: 13px; }
.permission-btn.strict { border-color: rgba(245, 108, 108, 0.4); color: #f89898; background: rgba(245, 108, 108, 0.1); }
.permission-btn.risk { border-color: rgba(230, 162, 60, 0.4); color: #e6a23c; background: rgba(230, 162, 60, 0.1); }
.permission-btn.yolo { border-color: rgba(103, 194, 58, 0.4); color: #67c23a; background: rgba(103, 194, 58, 0.1); }

html[data-theme='light'] .permission-btn { border-color: #dcdfe6; background: #f4f4f5; color: #4e5158; }
html[data-theme='light'] .permission-btn:hover { border-color: #c0c4cc; background: #ffffff; color: #1f2124; }
html[data-theme='light'] .permission-btn.strict { border-color: #fca5a5; color: #b91c1c; background: #fef2f2; }
html[data-theme='light'] .permission-btn.risk { border-color: #fde68a; color: #b45309; background: #fffbeb; }
html[data-theme='light'] .permission-btn.yolo { border-color: #bbf7d0; color: #15803d; background: #f0fdf4; }

.permission-dropdown-menu .el-dropdown-menu__item { padding: 8px 14px; min-width: 220px; }
.permission-item { display: flex; flex-direction: column; gap: 2px; }
.permission-item strong { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #e5e7eb; }
.permission-item strong svg { width: 13px; height: 13px; }
.permission-item small { font-size: 10px; color: #9ca3af; white-space: normal; line-height: 1.35; }
html[data-theme='light'] .permission-item strong { color: #1f2937; }
html[data-theme='light'] .permission-item small { color: #6b7280; }

.composer-approvals {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid #3d3420;
  border-radius: 8px;
  background: #1f1b13;
}
.approvals-header { display: flex; align-items: center; justify-content: space-between; color: #e6a23c; font-size: 12px; }
.approvals-header span { display: flex; align-items: center; gap: 6px; }
.approvals-header svg { width: 14px; height: 14px; }
.approvals-header small { color: #a49680; font-size: 11px; }
.approvals-list { display: flex; flex-direction: column; gap: 6px; }
.composer-approval-card { padding: 8px 10px; border: 1px solid #332d1e; border-radius: 6px; background: #161410; }
.approval-card-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.approval-target { font-family: "Cascadia Code", Consolas, monospace; font-size: 11px; color: #dcdfe6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.approval-buttons { display: flex; align-items: center; gap: 6px; }
.approval-diff { margin-top: 6px; padding: 6px 8px; font-size: 10px; font-family: "Cascadia Code", Consolas, monospace; background: #0c0b09; border-radius: 4px; color: #c0c4cc; max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }

html[data-theme='light'] .composer-approvals { border-color: #fde68a; background: #fffbeb; }
html[data-theme='light'] .approvals-header { color: #b45309; }
html[data-theme='light'] .approvals-header small { color: #92400e; }
html[data-theme='light'] .composer-approval-card { border-color: #fef08a; background: #ffffff; }
html[data-theme='light'] .approval-target { color: #1f2937; }
html[data-theme='light'] .approval-diff { background: #fefce8; color: #451a03; border: 1px solid #fef08a; }

html[data-theme='light'] .hoya-context-menu { border-color: #d4d5d9; background: rgba(255, 255, 255, .98); box-shadow: 0 18px 38px rgba(32, 34, 37, .16); }
html[data-theme='light'] .hoya-context-menu > button { color: #3f4247; }
html[data-theme='light'] .hoya-context-menu > button:hover,
html[data-theme='light'] .hoya-context-menu > button:focus-visible { color: #202124; background: #ececef; }
html[data-theme='light'] .context-menu-separator { background: #dedfe2; }

@media (max-width: 1180px) {
  .top-actions .run-state, .language-select { display: none; }
}
@media (max-width: 1040px) {
  .message-list { padding-inline: 28px; }
  .composer { width: calc(100% - 32px); }
}

/* Consolidated responsive workbench layout */
.hoya-shell { position: relative; }
.composer-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px 12px;
  width: 100%;
}
.composer-primary-tools,
.composer-run-controls { display: flex; align-items: center; min-width: 0; gap: 6px; }
.composer-primary-tools { flex-wrap: wrap; }
.composer-run-controls { justify-content: flex-end; }
.composer-run-controls .model-menu-selector,
.composer-run-controls .model-select { width: clamp(150px, 15vw, 190px); margin-left: 0; }
.composer-run-controls :deep(.el-radio-group) { flex: 0 0 auto; margin: 0; }
.composer-run-controls :deep(.el-radio-button__inner) { min-width: 38px; padding-inline: 8px; }
.composer-run-controls > :deep(.el-button) { flex: 0 0 auto; margin: 0; }
.theme-toggle-btn {
  width: 36px !important;
  min-width: 36px !important;
  height: 36px !important;
  padding: 0 !important;
  border-radius: 9px !important;
}
.theme-toggle-btn svg { width: 16px !important; height: 16px !important; }
.composer-approvals { max-height: min(190px, 28vh); overflow-y: auto; }
.approvals-list { gap: 4px; }
.composer-approval-card { padding-block: 6px; }
.approvals-header small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Day mode is deliberately neutral: white surfaces, gray hierarchy, no warm tint. */
html[data-theme='light'] .permission-btn.strict,
html[data-theme='light'] .permission-btn.risk,
html[data-theme='light'] .permission-btn.yolo {
  border-color: #c9cbd0;
  color: #3f4247;
  background: #f3f3f4;
}
html[data-theme='light'] .permission-btn.strict:hover,
html[data-theme='light'] .permission-btn.risk:hover,
html[data-theme='light'] .permission-btn.yolo:hover { border-color: #aeb0b6; color: #202124; background: #fff; }
html[data-theme='light'] .composer-approvals { border-color: #cfd0d4; background: #f1f1f2; }
html[data-theme='light'] .approvals-header,
html[data-theme='light'] .approvals-header small { color: #55585e; }
html[data-theme='light'] .composer-approval-card { border-color: #d9dade; background: #fff; }
html[data-theme='light'] .approval-diff { border-color: #d9dade; color: #34363b; background: #f2f2f3; }
html[data-theme='light'] .composer :deep(.el-button--danger) { border-color: #56595f; color: #fff; background: #56595f; }
html[data-theme='light'] .environment-card,
html[data-theme='light'] .run-card,
html[data-theme='light'] .memory-item { box-shadow: none; }

@media (max-width: 1360px) {
  .top-actions .run-state,
  .language-select { display: none; }
}
@media (max-width: 1120px) {
  .composer-controls { grid-template-columns: 1fr; }
  .composer-run-controls { justify-content: space-between; flex-wrap: wrap; }
  .composer-run-controls .model-menu-selector,
  .composer-run-controls .model-select { flex: 1 1 160px; width: auto; }
  .top-actions > :deep(.el-button.open-location) { width: 40px; min-width: 40px; padding-inline: 0; }
  .top-actions > :deep(.el-button.open-location span) { display: none; }
  .hoya-shell.inspector-open,
  .hoya-shell.sidebar-collapsed.inspector-open { grid-template-columns: var(--sidebar-width) 1px minmax(300px, 1fr) 0 0; }
  .hoya-shell.sidebar-collapsed.inspector-open { grid-template-columns: 0 0 minmax(300px, 1fr) 0 0; }
  .inspector-resizer { display: none; }
  .inspector { position: absolute; z-index: 90; top: 60px; right: 0; bottom: 0; width: min(var(--inspector-width), calc(100vw - 24px)); border-left: 1px solid #303236; box-shadow: -18px 0 42px rgba(0, 0, 0, .28); }
}
@media (max-width: 1020px) {
  .composer-run-controls .model-menu-selector { flex-basis: 100%; }
}


/* Shared enter/leave motion for expandable content. */
.expand-list-enter-active,
.expand-list-leave-active {
  overflow: hidden;
  transition: max-height 220ms cubic-bezier(.2, .8, .2, 1), opacity 160ms ease, transform 220ms cubic-bezier(.2, .8, .2, 1);
}
.expand-list-enter-from,
.expand-list-leave-to { max-height: 0; opacity: 0; transform: translateY(-6px); }
.expand-list-enter-to,
.expand-list-leave-from { max-height: 60vh; opacity: 1; transform: translateY(0); }
.reveal-content-enter-active,
.reveal-content-leave-active {
  overflow: hidden;
  transform-origin: top center;
  transition: max-height 220ms cubic-bezier(.2, .8, .2, 1), margin 220ms cubic-bezier(.2, .8, .2, 1), padding 220ms cubic-bezier(.2, .8, .2, 1), opacity 160ms ease, transform 220ms cubic-bezier(.2, .8, .2, 1);
}
.reveal-content-enter-from,
.reveal-content-leave-to { max-height: 0 !important; margin-top: 0 !important; margin-bottom: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; opacity: 0; transform: translateY(-6px) scale(.99); }
.reveal-content-enter-to,
.reveal-content-leave-from { max-height: 360px; opacity: 1; transform: translateY(0) scale(1); }
.context-pop-enter-active,
.context-pop-leave-active { transform-origin: top left; transition: opacity 140ms ease, transform 180ms cubic-bezier(.2, .8, .2, 1); }
.context-pop-enter-from,
.context-pop-leave-to { opacity: 0; transform: translateY(-5px) scale(.97); }
.inspector :deep(.el-tab-pane),
.settings-tabs :deep(.el-tab-pane) { animation: panel-content-in 190ms cubic-bezier(.2, .8, .2, 1); }
@keyframes panel-content-in {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}
.reasoning-panel::details-content {
  block-size: 0;
  overflow: hidden;
  opacity: 0;
  transition: block-size 220ms cubic-bezier(.2, .8, .2, 1), opacity 160ms ease, content-visibility 220ms allow-discrete;
}
.reasoning-panel[open]::details-content { block-size: auto; opacity: 1; }

html[data-theme='light'] .settings-section,
html[data-theme='light'] .preset-list,
html[data-theme='light'] .feedback-intro { border-color: #d9dade; }
html[data-theme='light'] .settings-row small,
html[data-theme='light'] .repository-section small,
html[data-theme='light'] .feedback-intro small,
html[data-theme='light'] .preset-heading,
html[data-theme='light'] .preset-row small { color: #74777d; }
html[data-theme='light'] .settings-row strong,
html[data-theme='light'] .repository-section strong,
html[data-theme='light'] .feedback-intro strong { color: #292b2f; }
html[data-theme='light'] .repository-section span,
html[data-theme='light'] .feedback-intro p { color: #5f6268; }
html[data-theme='light'] .preset-row.active { background: #e8e8ea; }
html[data-theme='light'] .update-status,
html[data-theme='light'] .update-status.available { border-color: #d2d3d7; color: #4d5055; background: #ededee; }

/* Semantic color is reserved for status and mode controls in daylight mode. */
html[data-theme='light'] .theme-toggle-btn.is-light {
  border-color: #b9c9ee !important;
  color: #244d9b !important;
  background: #edf3ff !important;
  box-shadow: 0 2px 8px rgba(63, 111, 197, .14) !important;
}
html[data-theme='light'] .theme-toggle-btn.is-light svg { color: #3f6fc5 !important; }
html[data-theme='light'] .theme-toggle-btn.is-light:hover {
  border-color: #91a9df !important;
  background: #dfe9ff !important;
  box-shadow: 0 3px 10px rgba(63, 111, 197, .2) !important;
}
html[data-theme='light'] .status-pill { color: #ad3832; background: #fbe8e6; }
html[data-theme='light'] .status-pill.ready { color: #0f7653; background: #def3ea; }
html[data-theme='light'] .connection-dot { background: #d15149; }
html[data-theme='light'] .connection-dot.ready { background: #19a474; }
html[data-theme='light'] .run-state { color: #ad3832; background: #fbe8e6; }
html[data-theme='light'] .run-state.ready { color: #0f7653; background: #def3ea; }
html[data-theme='light'] .run-state.busy { color: #9a5a0e; background: #fff0d8; }
html[data-theme='light'] .permission-btn.strict { border-color: #efb2ad; color: #a93630; background: #fdefed; }
html[data-theme='light'] .permission-btn.risk { border-color: #edc786; color: #995909; background: #fff6e8; }
html[data-theme='light'] .permission-btn.yolo { border-color: #9fd5c0; color: #0d704e; background: #e8f7f1; }
html[data-theme='light'] .permission-btn.strict:hover { border-color: #dc817a; color: #8f2d28; background: #fbe3e0; }
html[data-theme='light'] .permission-btn.risk:hover { border-color: #d9a951; color: #804904; background: #ffedce; }
html[data-theme='light'] .permission-btn.yolo:hover { border-color: #6ebc9d; color: #095b3f; background: #daf1e7; }
html[data-theme='light'] .composer-approvals { border-color: #edc786; background: #fff8ed; }
html[data-theme='light'] .approvals-header { color: #995909; }
html[data-theme='light'] .approvals-header small { color: #7d5c30; }
html[data-theme='light'] .activity-dot { background: #3f6fc5; }
html[data-theme='light'] .el-tag.el-tag--success { border-color: #9fd5c0 !important; color: #0d704e !important; background: #e8f7f1 !important; }
html[data-theme='light'] .el-tag.el-tag--warning { border-color: #edc786 !important; color: #995909 !important; background: #fff6e8 !important; }
html[data-theme='light'] .el-tag.el-tag--danger { border-color: #efb2ad !important; color: #a93630 !important; background: #fdefed !important; }
html[data-theme='light'] .el-step__head.is-success,
html[data-theme='light'] .el-step__head.is-process { color: #16875f !important; border-color: #16875f !important; }
html[data-theme='light'] .update-status.available { border-color: #9fd5c0; color: #0d704e; background: #e8f7f1; }

</style>
