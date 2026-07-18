$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

python -m pip install pyinstaller

if (Test-Path "dist-backend") {
    Remove-Item -Recurse -Force "dist-backend"
}
if (Test-Path "build\hoya-agent-backend") {
    Remove-Item -Recurse -Force "build\hoya-agent-backend"
}

python -m PyInstaller `
    --name hoya-agent-backend `
    --onedir `
    --clean `
    --distpath dist-backend `
    --workpath build `
    --specpath build `
    --collect-submodules hoya_agent `
    hoya_agent\server_main.py

Write-Host "Backend built under: $ProjectRoot\dist-backend\hoya-agent-backend"
