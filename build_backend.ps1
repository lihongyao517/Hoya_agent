$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

python -m pip install pyinstaller

$ArtifactsRoot = Join-Path $ProjectRoot "artifacts"
$BackendDist = Join-Path $ArtifactsRoot "backend"
$BackendWork = Join-Path $ArtifactsRoot "pyinstaller-work"

if (Test-Path $BackendDist) {
    Remove-Item -Recurse -Force $BackendDist
}
if (Test-Path $BackendWork) {
    Remove-Item -Recurse -Force $BackendWork
}
New-Item -ItemType Directory -Force $ArtifactsRoot | Out-Null

python -m PyInstaller `
    --name hoya-agent-backend `
    --onedir `
    --clean `
    --distpath $BackendDist `
    --workpath $BackendWork `
    --specpath $BackendWork `
    --collect-submodules hoya_agent `
    hoya_agent\server_main.py

Write-Host "Backend built under: $BackendDist\hoya-agent-backend"
