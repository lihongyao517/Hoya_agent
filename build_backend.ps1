$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

python -m pip install pyinstaller

$ArtifactsRoot = Join-Path $ProjectRoot "artifacts"
$BackendDist = Join-Path $ArtifactsRoot "backend"
$BackendWork = Join-Path $ArtifactsRoot "pyinstaller-work"
$DesktopPackage = Get-Content (Join-Path $ProjectRoot "desktop\package.json") -Raw | ConvertFrom-Json
$Version = [string]$DesktopPackage.version
$VersionParts = @($Version.Split('.') | ForEach-Object { [int]$_ })
while ($VersionParts.Count -lt 4) {
    $VersionParts += 0
}

if (Test-Path $BackendDist) {
    Remove-Item -Recurse -Force $BackendDist
}
if (Test-Path $BackendWork) {
    Remove-Item -Recurse -Force $BackendWork
}
New-Item -ItemType Directory -Force $ArtifactsRoot | Out-Null
New-Item -ItemType Directory -Force $BackendWork | Out-Null

$VersionFile = Join-Path $BackendWork "hoya-agent-backend-version.txt"
$VersionTuple = "($($VersionParts[0]), $($VersionParts[1]), $($VersionParts[2]), $($VersionParts[3]))"
@"
VSVersionInfo(
  ffi=FixedFileInfo(filevers=$VersionTuple, prodvers=$VersionTuple),
  kids=[
    StringFileInfo([
      StringTable('040904B0', [
        StringStruct('CompanyName', 'lihongyao517'),
        StringStruct('FileDescription', 'Hoya Agent Backend'),
        StringStruct('FileVersion', '$Version'),
        StringStruct('InternalName', 'hoya-agent-backend'),
        StringStruct('LegalCopyright', 'Copyright (c) 2026 lihongyao517'),
        StringStruct('OriginalFilename', 'hoya-agent-backend.exe'),
        StringStruct('ProductName', 'Hoya Agent'),
        StringStruct('ProductVersion', '$Version')
      ])
    ]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"@ | Set-Content -LiteralPath $VersionFile -Encoding UTF8

python -m PyInstaller `
    --name hoya-agent-backend `
    --onedir `
    --clean `
    --distpath $BackendDist `
    --workpath $BackendWork `
    --specpath $BackendWork `
    --collect-submodules hoya_agent `
    --version-file $VersionFile `
    hoya_agent\server_main.py

Write-Host "Backend built under: $BackendDist\hoya-agent-backend"
