$files = Get-ChildItem -Path ".\src" -Recurse -File -Include *.ts,*.tsx
foreach ($f in $files) {
    $content = Get-Content $f.FullName -Raw -Encoding UTF8
    if ($content -cmatch "Hoya AgentErrorCode") {
        $newContent = $content -creplace "Hoya AgentErrorCode", "HoyaAgentErrorCode"
        Set-Content -Path $f.FullName -Value $newContent -NoNewline -Encoding UTF8
    }
}
