const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const mainSource = fs.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8')
const preloadSource = fs.readFileSync(path.resolve(__dirname, '../electron/preload.cjs'), 'utf8')
const bridgeTypes = fs.readFileSync(path.resolve(__dirname, '../src/vite-env.d.ts'), 'utf8')

test('backend uses an authenticated random-port readiness handshake', () => {
  assert.match(mainSource, /crypto\.randomBytes\(32\)\.toString\('base64url'\)/)
  assert.match(mainSource, /HOYA_SERVER_TOKEN:\s*token/)
  assert.match(mainSource, /backendReadyPrefix\s*=\s*'HOYA_SERVER_READY '/)
  assert.match(mainSource, /JSON\.parse\(line\.slice\(backendReadyPrefix\.length\)\)/)
  assert.match(mainSource, /'--port',\s*'0'/)
  assert.doesNotMatch(mainSource, /HOYA_SERVER_PORT/)
  assert.match(mainSource, /ipcMain\.handle\('hoya:server-connection'/)
  assert.match(preloadSource, /serverConnection:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('hoya:server-connection'\)/)
  assert.match(bridgeTypes, /serverConnection\(\): Promise<HoyaServerConnection>/)
})

test('API keys are encrypted and legacy plaintext is scrubbed only after save', () => {
  assert.match(mainSource, /safeStorage\.encryptString\(apiKey\)/)
  assert.match(mainSource, /safeStorage\.decryptString/)
  assert.match(mainSource, /return path\.join\(app\.getPath\('userData'\), 'credentials\.json'\)/)
  assert.match(mainSource, /writeJsonFileAtomic\(credentialsPath\(\), document\)/)
  assert.match(mainSource, /saveApiKey\(\{ \.\.\.legacy\.descriptor, apiKey: legacy\.apiKey \}\)\s*\r?\n\s*removeLegacyApiKey\(legacy\)/)
  assert.match(mainSource, /function migrateLegacyModelCredentials\(\)/)
  assert.match(mainSource, /saveApiKey\(\{ \.\.\.descriptor, apiKey \}\)\s*\r?\n\s*delete model\.api_key/)
  assert.ok(mainSource.indexOf('migrateLegacyModelCredentials()') < mainSource.indexOf('startBackend().catch'))
  assert.match(mainSource, /\^\\s\*\(\?:export\\s\+\)\?HOYA_API_KEY\\s\*=\/\.test\(line\)/)
  assert.match(preloadSource, /getApiKey:.*hoya:get-api-key/)
  assert.match(preloadSource, /saveApiKey:.*hoya:save-api-key/)
  assert.match(preloadSource, /deleteApiKey:.*hoya:delete-api-key/)
})

test('desktop preferences and the default scratch workspace stay outside user projects', () => {
  assert.match(mainSource, /'desktop-settings\.json'/)
  assert.match(mainSource, /app\.getPath\('userData'\), 'workspaces', 'scratch'/)
  const initialWorkspaceSource = mainSource.slice(
    mainSource.indexOf('function initialWorkspace()'),
    mainSource.indexOf('function rememberWorkspace'),
  )
  assert.doesNotMatch(initialWorkspaceSource, /projectRoot\(\)/)
  assert.match(initialWorkspaceSource, /normalizedPath\(previousWorkspace\) !== normalizedPath\(app\.getPath\('home'\)\)/)
})

test('portable builds never invoke the automatic installer', () => {
  assert.match(mainSource, /PORTABLE_EXECUTABLE_FILE\s*\|\|\s*process\.env\.PORTABLE_EXECUTABLE_DIR/)
  assert.match(mainSource, /if \(!app\.isPackaged \|\| isPortableBuild\(\)\) return/)
  assert.match(mainSource, /if \(isPortableBuild\(\) \|\| currentUpdateState\(\)\.status !== 'downloaded'/)
  assert.match(mainSource, /autoUpdater\.quitAndInstall\(true, true\)/)
  assert.match(mainSource, /compareVersions\(info\.version, app\.getVersion\(\)\) <= 0/)
})

test('embedded browsing is ephemeral and denied native permissions and downloads', () => {
  assert.match(mainSource, /roundedCorners:\s*true/)
  assert.match(mainSource, /previewPartition\s*=\s*'hoya-preview'/)
  assert.doesNotMatch(mainSource, /previewPartition\s*=\s*['"]persist:/)
  assert.match(mainSource, /setPermissionCheckHandler\(\(\) => false\)/)
  assert.match(mainSource, /setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/)
  assert.match(mainSource, /targetSession\.on\('will-download', \(event\) => event\.preventDefault\(\)\)/)
  assert.match(mainSource, /webPreferences\.partition = previewPartition/)
})

test('feedback email opens a browser compose page instead of a Windows mail handler', () => {
  assert.match(mainSource, /new URL\('https:\/\/mail\.google\.com\/mail\/'\)/)
  assert.match(mainSource, /compose\.searchParams\.set\('to', 'lihongyao517@gmail\.com'\)/)
  const openExternalHandler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('hoya:open-external'"),
    mainSource.indexOf("ipcMain.handle('hoya:window-minimize'"),
  )
  assert.match(openExternalHandler, /browserTargetForExternal\(url\)/)
  assert.doesNotMatch(openExternalHandler, /shell\.openExternal\(String\(url/)
})
