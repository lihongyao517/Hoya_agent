$files = Get-ChildItem -Path ".\src" -Recurse -File -Include *.ts,*.tsx
foreach ($f in $files) {
    $content = Get-Content $f.FullName -Raw -Encoding UTF8
    if ($content -cmatch "Hoya Agent") {
        $newContent = $content -creplace "Hoya Agent", "Reasonix"
        Set-Content -Path $f.FullName -Value $newContent -NoNewline -Encoding UTF8
    }
}
