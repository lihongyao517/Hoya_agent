$files = Get-ChildItem -Path ".\src" -Recurse -File -Include *.ts,*.tsx,*.html,*.json
$files += Get-Item -Path ".\index.html"
foreach ($f in $files) {
    $content = Get-Content $f.FullName -Raw -Encoding UTF8
    if ($content -cmatch "Reasonix") {
        $newContent = $content -creplace "Reasonix", "Hoya Agent"
        Set-Content -Path $f.FullName -Value $newContent -NoNewline -Encoding UTF8
    }
}
