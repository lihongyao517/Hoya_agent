<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Delete, VideoPause, VideoPlay } from '@element-plus/icons-vue'

const props = defineProps<{ cwd: string }>()
const terminalBridge = window.hoya ?? {
  terminalRun: async () => ({ ok: false, id: '', cwd: props.cwd }),
  terminalStop: async () => false,
  onTerminalOutput: () => () => undefined,
}

type TerminalLine = { id: number; kind: 'command' | 'stdout' | 'stderr' | 'system'; text: string }

const command = ref('')
const runningId = ref('')
const lines = ref<TerminalLine[]>([{ id: 1, kind: 'system', text: 'Hoya PowerShell terminal ready.' }])
const history = ref<string[]>([])
const historyIndex = ref(-1)
const output = ref<HTMLElement | null>(null)
const commandInput = ref<{ focus: () => void } | null>(null)
let lineId = 1
let unsubscribe: () => void = () => undefined

function append(kind: TerminalLine['kind'], text: string) {
  if (!text) return
  lines.value.push({ id: ++lineId, kind, text })
  nextTick(() => output.value?.scrollTo({ top: output.value.scrollHeight, behavior: 'smooth' }))
}

async function runCommand() {
  const value = command.value.trim()
  if (!value || runningId.value || !props.cwd) return
  history.value.push(value)
  historyIndex.value = history.value.length
  append('command', `PS ${props.cwd}> ${value}`)
  command.value = ''
  try {
    const result = await terminalBridge.terminalRun({ command: value, cwd: props.cwd })
    runningId.value = result.id
  } catch (error) {
    append('stderr', String(error))
  }
}

async function stopCommand() {
  if (!runningId.value) return
  await terminalBridge.terminalStop(runningId.value)
}

function browseHistory(direction: number) {
  if (!history.value.length) return
  historyIndex.value = Math.max(0, Math.min(history.value.length, historyIndex.value + direction))
  command.value = historyIndex.value === history.value.length ? '' : history.value[historyIndex.value]
}

onMounted(() => {
  unsubscribe = terminalBridge.onTerminalOutput((event: { id: string; stream: 'stdout' | 'stderr' | 'error' | 'exit'; data: string; code?: number }) => {
    if (!runningId.value && event.stream !== 'exit') runningId.value = event.id
    if (event.id !== runningId.value) return
    if (event.stream === 'exit') {
      append('system', `Process exited with code ${event.code ?? -1}.`)
      runningId.value = ''
      return
    }
    append(event.stream === 'stdout' ? 'stdout' : 'stderr', event.data)
  })
  nextTick(() => commandInput.value?.focus())
})

onBeforeUnmount(() => {
  unsubscribe()
})
</script>

<template>
  <section class="terminal-panel">
    <header class="panel-toolbar">
      <div class="terminal-context"><span class="terminal-dot" /><strong>PowerShell</strong><small>{{ cwd }}</small></div>
      <div class="toolbar-actions">
        <el-button text :icon="Delete" aria-label="清空终端" title="清空终端" @click="lines = []" />
        <el-button v-if="runningId" text type="danger" :icon="VideoPause" @click="stopCommand">停止</el-button>
      </div>
    </header>
    <div ref="output" class="terminal-output" aria-live="polite">
      <pre v-for="line in lines" :key="line.id" :class="line.kind">{{ line.text }}</pre>
    </div>
    <div class="terminal-input-row">
      <span class="terminal-prompt">PS</span>
      <el-input
        ref="commandInput"
        v-model="command"
        :disabled="Boolean(runningId) || !cwd"
        placeholder="输入 PowerShell 命令"
        @keyup.enter="runCommand"
        @keydown.up.prevent="browseHistory(-1)"
        @keydown.down.prevent="browseHistory(1)"
      />
      <el-button type="primary" :icon="VideoPlay" :disabled="!command.trim() || Boolean(runningId) || !cwd" @click="runCommand">运行</el-button>
    </div>
  </section>
</template>

<style scoped>
.terminal-panel { display: grid; grid-template-rows: 44px minmax(0, 1fr) 48px; height: 100%; min-height: 0; background: #0e0f10; color: #e3e5e7; }
.panel-toolbar, .terminal-input-row, .terminal-context, .toolbar-actions { display: flex; align-items: center; }
.panel-toolbar { justify-content: space-between; gap: 12px; padding: 0 10px 0 14px; border-bottom: 1px solid #303236; background: #191a1b; }
.terminal-context { min-width: 0; gap: 8px; }
.terminal-context strong { font-size: 12px; font-weight: 650; }
.terminal-context small { overflow: hidden; color: #84928d; font-family: "Cascadia Code", Consolas, monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.terminal-dot { width: 7px; height: 7px; border-radius: 50%; background: #2dd4bf; }
.toolbar-actions { gap: 4px; }
.terminal-output { min-height: 0; overflow: auto; padding: 12px 14px; scrollbar-color: #46534f transparent; }
.terminal-output pre { margin: 0 0 6px; white-space: pre-wrap; word-break: break-word; font: 12px/1.55 "Cascadia Code", Consolas, monospace; }
.terminal-output .command { color: #7ee0cf; }
.terminal-output .stdout { color: #dfe8e4; }
.terminal-output .stderr { color: #ff9c94; }
.terminal-output .system { color: #8fa09a; }
.terminal-input-row { gap: 8px; padding: 7px 10px; border-top: 1px solid #303236; background: #191a1b; }
.terminal-prompt { color: #2dd4bf; font: 700 12px "Cascadia Code", Consolas, monospace; }
.terminal-input-row :deep(.el-input__wrapper) { border: 1px solid #3a3c40; border-radius: 8px; background: #111213; box-shadow: none; }
.terminal-input-row :deep(.el-input__inner) { color: #eef5f2; font-family: "Cascadia Code", Consolas, monospace; }
.terminal-input-row :deep(.el-input__wrapper.is-focus) { border-color: #2aa896; box-shadow: 0 0 0 2px rgba(45, 212, 191, .12); }
.panel-toolbar :deep(.el-button) { min-width: 40px; color: #aab7b2; }
</style>
