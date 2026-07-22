const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.vue'), 'utf8')

test('composer keeps a stable textarea instance while typing', () => {
  assert.match(appSource, /v-model="messageInput"/)
  assert.doesNotMatch(appSource, /@input=/)
})

test('project label keeps the icon and text in separate grid tracks', () => {
  assert.match(
    appSource,
    /\.project-main\s*\{[^}]*grid-template-columns:\s*17px\s+minmax\(0,\s*1fr\)/s,
  )
})

test('teleported settings dialog uses unscoped viewport constraints', () => {
  const globalStyle = appSource.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
  const scopedStyle = appSource.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? ''

  assert.match(globalStyle, /\.settings-dialog\.el-dialog\s*\{[^}]*max-height:\s*calc\(100vh - 48px\)/s)
  assert.match(globalStyle, /\.settings-dialog \.el-dialog__body\s*\{[^}]*overflow-y:\s*auto/s)
  assert.doesNotMatch(scopedStyle, /\.settings-dialog\.el-dialog/)
})
