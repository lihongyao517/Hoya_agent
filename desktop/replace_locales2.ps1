$files = Get-ChildItem -Path ".\src\locales" -File -Include *.ts
foreach ($f in $files) {
    $content = Get-Content $f.FullName -Raw -Encoding UTF8
    $content = $content -creplace "\.reasonix", ".hoya_agent"
    $content = $content -creplace "reasonix\.toml", "hoya_agent.toml"
    $content = $content -creplace "\breasonix\b", "Hoya Agent"
    Set-Content -Path $f.FullName -Value $content -NoNewline -Encoding UTF8
}
