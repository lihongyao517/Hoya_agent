const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const mainProcessSource = fs.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8')

test('window lifecycle does not launch hidden PowerShell processes', () => {
  const createWindowSource = mainProcessSource.slice(
    mainProcessSource.indexOf('function createWindow()'),
    mainProcessSource.indexOf('function currentUpdateState()'),
  )

  assert.doesNotMatch(mainProcessSource, /DwmSetWindowAttribute|applyDwmCornerPreference/)
  assert.doesNotMatch(createWindowSource, /powershell(?:\.exe)?/i)
})

test('PowerShell is only launched by explicit terminal and code-runner actions', () => {
  const terminalStart = mainProcessSource.indexOf('function startTerminalCommand')
  const codeRunnerStart = mainProcessSource.indexOf('function runCodeSnippet')
  const terminalStop = mainProcessSource.indexOf('function stopTerminalCommand')
  const codeRunnerStop = mainProcessSource.indexOf('function resolveBackendCommand')
  const terminalSource = mainProcessSource.slice(terminalStart, terminalStop)
  const codeRunnerSource = mainProcessSource.slice(codeRunnerStart, codeRunnerStop)
  const remainingSource = mainProcessSource
    .replace(terminalSource, '')
    .replace(codeRunnerSource, '')

  assert.match(terminalSource, /spawn\('powershell\.exe'/)
  assert.match(codeRunnerSource, /command = 'powershell\.exe'/)
  assert.doesNotMatch(remainingSource, /powershell(?:\.exe)?/i)
})
