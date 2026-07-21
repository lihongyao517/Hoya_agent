<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowLeft, ArrowRight, Link, Refresh, TopRight } from '@element-plus/icons-vue'

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
    if (url) address.value = url
  }
  const onTitle = (event: Event) => { pageTitle.value = String((event as Event & { title?: string }).title || '项目预览') }
  view.addEventListener('did-start-loading', onStart)
  view.addEventListener('did-stop-loading', onStop)
  view.addEventListener('did-navigate', onNavigate)
  view.addEventListener('page-title-updated', onTitle)
  cleanup = [
    () => view.removeEventListener('did-start-loading', onStart),
    () => view.removeEventListener('did-stop-loading', onStop),
    () => view.removeEventListener('did-navigate', onNavigate),
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
  <section class="browser-panel">
    <header class="browser-toolbar">
      <div class="browser-navigation">
        <el-button text :icon="ArrowLeft" aria-label="后退" title="后退" @click="goBack" />
        <el-button text :icon="ArrowRight" aria-label="前进" title="前进" @click="goForward" />
        <el-button text :icon="Refresh" :loading="loading" aria-label="刷新" title="刷新" @click="reload" />
      </div>
      <el-input ref="addressInput" v-model="address" class="address-input" :prefix-icon="Link" @keyup.enter="navigate" />
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
          partition="persist:hoya-preview"
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.browser-panel { display: grid; grid-template-rows: 48px 28px minmax(0, 1fr); height: 100%; min-height: 0; background: #edf1ef; }
.browser-toolbar, .browser-navigation, .browser-meta { display: flex; align-items: center; }
.browser-toolbar { gap: 6px; padding: 6px 10px; border-bottom: 1px solid #d5ddda; background: #f9fbfa; }
.browser-navigation { gap: 2px; }
.browser-toolbar :deep(.el-button) { min-width: 36px; }
.address-input { min-width: 180px; flex: 1; }
.address-input :deep(.el-input__wrapper) { border-radius: 6px; box-shadow: 0 0 0 1px #d5ddda inset; }
.browser-meta { gap: 10px; min-width: 0; padding: 0 14px; color: #71807b; background: #f4f7f5; font-size: 10px; }
.browser-meta strong { color: #3a4743; font-size: 11px; }
.browser-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-stage { min-height: 0; overflow: auto; padding: 12px; }
.preview-frame { height: 100%; min-height: 260px; margin: 0 auto; overflow: hidden; border: 1px solid #cbd6d2; border-radius: 7px; background: #fff; box-shadow: 0 8px 24px rgba(23, 44, 38, .08); transition: width 180ms ease; }
.preview-frame.desktop { width: 100%; }
.preview-frame.tablet { width: min(820px, 100%); }
.preview-frame.mobile { width: min(390px, 100%); }
webview { display: flex; width: 100%; height: 100%; }
.browser-empty { display: grid; place-items: center; align-content: center; gap: 8px; height: 100%; color: #7a8984; text-align: center; }
.browser-empty svg { width: 28px; color: #0f766e; }
.browser-empty strong { color: #27332f; font-size: 14px; }
.browser-empty span { font-size: 11px; }
</style>
