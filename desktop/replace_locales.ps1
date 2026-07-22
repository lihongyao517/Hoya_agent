$files = Get-ChildItem -Path ".\src\locales" -File -Include *.ts
foreach ($f in $files) {
    $content = Get-Content $f.FullName -Raw -Encoding UTF8
    if ($content -cmatch "Reasonix") {
        $newContent = $content -creplace "Reasonix", "Hoya Agent"
        Set-Content -Path $f.FullName -Value $newContent -NoNewline -Encoding UTF8
    }
}
