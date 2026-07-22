<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowLeft, ArrowRight, Link, Refresh, TopRight } from '@element-plus/icons-vue'

defineProps<{ compact?: boolean }>()

const address = ref('http://127.0.0.1:3000')
const activeUrl = ref('about:blank')
const loading = ref(false)
const pageTitle = ref('项目预览')
const viewport = ref<'desktop' | 'tablet' | 'mobile'>('desktop')
const webview = ref<HTMLWebViewElement | null>(null)
const addressInput = ref<{ focus: () => void } | null>(null)
let cleanup: Array<() => void> = []
let boundView: HTMLWebViewElement | null = null

function normalizeUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return 'about:blank'
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return `file:///${trimmed.replace(/\\/g, '/')}`
  if (/^(?:https?|file):\/\//i.test(trimmed) || trimmed === 'about:blank') return trimmed
  return `http://${trimmed}`
}

async function bindWebview() {
  await nextTick()
  const view = webview.value
  if (!view || view === boundView) return
  cleanup.forEach((dispose) => dispose())
  boundView = view
  const onStart = () => { loading.value = true }
  const onStop = () => { loading.value = false }
  const onNavigate = (event: Event) => {
    const url = String((event as Event & { url?: string }).url || '')
    if (url) {
      address.value = url
      activeUrl.value = url
    }
  }
  const onTitle = (event: Event) => { pageTitle.value = String((event as Event & { title?: string }).title || '项目预览') }
  view.addEventListener('did-start-loading', onStart)
  view.addEventListener('did-stop-loading', onStop)
  view.addEventListener('did-navigate', onNavigate)
  view.addEventListener('did-navigate-in-page', onNavigate)
  view.addEventListener('page-title-updated', onTitle)
  cleanup = [
    () => view.removeEventListener('did-start-loading', onStart),
    () => view.removeEventListener('did-stop-loading', onStop),
    () => view.removeEventListener('did-navigate', onNavigate),
    () => view.removeEventListener('did-navigate-in-page', onNavigate),
    () => view.removeEventListener('page-title-updated', onTitle),
  ]
}

async function navigate() {
  activeUrl.value = normalizeUrl(address.value)
  await nextTick()
  await bindWebview()
}

function goBack() { if (webview.value?.canGoBack()) webview.value.goBack() }
function goForward() { if (webview.value?.canGoForward()) webview.value.goForward() }
function reload() { webview.value?.reload() }
function openExternal() { if (/^https?:\/\//i.test(address.value)) window.hoya.openExternal(address.value) }

onBeforeUnmount(() => {
  cleanup.forEach((dispose) => dispose())
  boundView = null
})

onMounted(() => nextTick(() => addressInput.value?.focus()))
</script>

<template>
  <section class="browser-panel" :class="{ compact }">
    <header class="browser-toolbar">
      <div class="browser-navigation">
        <el-button text :icon="ArrowLeft" aria-label="后退" title="后退" @click="goBack" />
        <el-button text :icon="ArrowRight" aria-label="前进" title="前进" @click="goForward" />
        <el-button text :icon="Refresh" :loading="loading" aria-label="刷新" title="刷新" @click="reload" />
      </div>
      <el-input ref="addressInput" v-model="address" class="address-input" :prefix-icon="Link" aria-label="预览地址" @keyup.enter="navigate" />
      <el-radio-group v-model="viewport" size="small" aria-label="预览视口">
        <el-radio-button value="desktop">桌面</el-radio-button>
        <el-radio-button value="tablet">平板</el-radio-button>
        <el-radio-button value="mobile">手机</el-radio-button>
      </el-radio-group>
      <el-button text :icon="TopRight" aria-label="在系统浏览器打开" title="在系统浏览器打开" @click="openExternal" />
    </header>
    <div class="browser-meta"><strong>{{ pageTitle }}</strong><span>{{ activeUrl === 'about:blank' ? '输入地址开始预览' : activeUrl }}</span></div>
    <div class="preview-stage">
      <div class="preview-frame" :class="viewport">
        <div v-if="activeUrl === 'about:blank'" class="browser-empty"><Link /><strong>项目成果预览</strong><span>输入本地服务地址或项目内 HTML 文件路径</span></div>
        <webview
          v-else
          ref="webview"
          :src="activeUrl"
          partition="hoya-preview"
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.browser-panel { display: grid; grid-template-rows: 48px 28px minmax(0, 1fr); height: 100%; min-height: 0; color: #e6e7e9; background: #121313; }
.browser-toolbar, .browser-navigation, .browser-meta { display: flex; align-items: center; }
.browser-toolbar { gap: 6px; padding: 6px 10px; border-bottom: 1px solid #303236; background: #191a1b; }
.browser-navigation { gap: 2px; }
.browser-toolbar :deep(.el-button) { min-width: 36px; }
.address-input { min-width: 180px; flex: 1; }
.address-input :deep(.el-input__wrapper) { border-radius: 8px; color: #e8e9eb; background: #222326; box-shadow: 0 0 0 1px #3a3c40 inset; }
.browser-meta { gap: 10px; min-width: 0; padding: 0 14px; color: #858990; background: #171818; font-size: 10px; }
.browser-meta strong { flex: 0 1 38%; overflow: hidden; color: #d8dade; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.browser-meta span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-stage { min-height: 0; overflow: auto; padding: 12px; background: #121313; }
.preview-frame { height: 100%; min-height: 260px; margin: 0 auto; overflow: hidden; border: 1px solid #383a3f; border-radius: 10px; background: #fff; box-shadow: 0 12px 30px rgba(0, 0, 0, .28); transition: width 180ms ease; }
.preview-frame.desktop { width: 100%; }
.preview-frame.tablet { width: min(820px, 100%); }
.preview-frame.mobile { width: min(390px, 100%); }
webview { display: flex; width: 100%; height: 100%; }
.browser-empty { display: grid; place-items: center; align-content: center; gap: 8px; height: 100%; color: #858990; background: #1b1c1e; text-align: center; }
.browser-empty svg { width: 28px; color: #0f766e; }
.browser-empty strong { color: #e5e7e9; font-size: 14px; }
.browser-empty span { font-size: 11px; }
.browser-panel.compact { grid-template-rows: auto 28px minmax(0, 1fr); }
.compact .browser-toolbar { display: grid; grid-template-columns: auto minmax(90px, 1fr) 36px; grid-template-rows: 36px 34px; gap: 6px; padding: 7px 8px; }
.compact .browser-navigation { grid-row: 1; grid-column: 1; }
.compact .address-input { grid-row: 1; grid-column: 2; min-width: 0; }
.compact .browser-toolbar > :deep(.el-radio-group) { grid-row: 2; grid-column: 1 / -1; justify-self: start; }
.compact .browser-toolbar > :deep(.el-button:last-child) { grid-row: 1; grid-column: 3; }
.compact .browser-navigation :deep(.el-button) { width: 32px; min-width: 32px; padding-inline: 6px; }
.compact .browser-meta { padding-inline: 10px; }
.compact .preview-stage { padding: 8px; }
.compact .preview-frame { min-height: 220px; }
html[data-theme='light'] .browser-panel { color: #292b2f; background: #f4f4f5; }
html[data-theme='light'] .browser-toolbar { border-color: #d5d6da; background: #f1f1f2; }
html[data-theme='light'] .address-input :deep(.el-input__wrapper) { color: #292b2f; background: #ffffff; box-shadow: 0 0 0 1px #d5d6da inset; }
html[data-theme='light'] .browser-meta { color: #5f6268; background: #ececee; }
html[data-theme='light'] .browser-meta strong { color: #3f4247; }
html[data-theme='light'] .preview-stage { background: #f4f4f5; }
html[data-theme='light'] .preview-frame { border-color: #cfd0d4; box-shadow: 0 10px 26px rgba(32, 34, 37, .12); }
html[data-theme='light'] .browser-empty { color: #74777d; background: #ffffff; }
html[data-theme='light'] .browser-empty strong { color: #292b2f; }
html[data-theme='light'] .browser-empty svg { color: #666970; }
</style>
