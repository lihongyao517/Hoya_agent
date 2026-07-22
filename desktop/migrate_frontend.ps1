$ErrorActionPreference = "Stop"

$sourceDir = "..\..\DeepSeek-Reasonix-main-v2\desktop\frontend"
$targetDir = "."

Write-Host "Backing up Vue src directory..."
if (Test-Path "$targetDir\src") {
    Rename-Item -Path "$targetDir\src" -NewName "src_vue" -Force
}

Write-Host "Copying React frontend files..."
Copy-Item -Path "$sourceDir\src" -Destination "$targetDir\src" -Recurse -Force
Copy-Item -Path "$sourceDir\public" -Destination "$targetDir\public" -Recurse -Force
Copy-Item -Path "$sourceDir\index.html" -Destination "$targetDir\index.html" -Force
Copy-Item -Path "$sourceDir\vite.config.ts" -Destination "$targetDir\vite.config.ts" -Force
Copy-Item -Path "$sourceDir\tsconfig.json" -Destination "$targetDir\tsconfig.json" -Force

Write-Host "Migration script completed successfully."
