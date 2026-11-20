$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$archive = [IO.Path]::GetFullPath((Join-Path $workspace '_local/history'))
if (-not $archive.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive is outside workspace' }
$essential = @('.gitignore','.gitattributes','.node-version','.nvmrc','package.json','package-lock.json','playwright.config.ts','README.md','tsconfig.json','vitest.config.ts','vitest.integration.config.ts')
$targets = @(Get-ChildItem -LiteralPath $workspace -Force | Where-Object {
    if ($_.PSIsContainer) { $_.Name -match '^(checkpoint\d|data-test-|test-results)' }
    else { $_.Name -notin $essential }
})
New-Item -ItemType Directory -Path $archive -Force | Out-Null
$manifest = @()
foreach ($target in $targets) {
    $source = (Resolve-Path -LiteralPath $target.FullName).Path
    $destination = [IO.Path]::GetFullPath((Join-Path $archive $target.Name))
    if ([IO.Path]::GetDirectoryName($source) -ne $workspace -or -not $destination.StartsWith($archive + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unverified move target' }
    if (Test-Path -LiteralPath $destination) { throw "Archive collision: $destination" }
    $files = if ($target.PSIsContainer) { @(Get-ChildItem -LiteralPath $source -Recurse -File) } else { @($target) }
    foreach ($file in $files) {
        $relative = [IO.Path]::GetRelativePath($workspace, $file.FullName).Replace('\','/')
        $manifest += [PSCustomObject]@{ original=$relative; archived=('_local/history/'+$relative); bytes=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    Move-Item -LiteralPath $source -Destination $destination
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $archive 'relocation-manifest.json') -Encoding utf8
[PSCustomObject]@{ movedEntries=$targets.Count; preservedFiles=$manifest.Count; archive=$archive } | ConvertTo-Json -Compress
