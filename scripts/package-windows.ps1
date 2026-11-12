param(
    [Parameter(Mandatory = $true)][string]$BunExecutable
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bunPath = (Resolve-Path -LiteralPath $BunExecutable).Path
$previousPath = $env:PATH
Push-Location $repoRoot
try {
    $sourceCommit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve source commit' }
    if (& git status --porcelain --untracked-files=normal) {
        throw 'Commit source changes before creating a release'
    }
    $revision = $sourceCommit.Substring(0, 8)
    $config = Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
    $catalog = Get-Content -LiteralPath 'plugins/desktop-bundles.json' -Raw | ConvertFrom-Json
    if ($catalog.schemaVersion -ne 1) { throw 'Unsupported desktop bundle catalog' }
    $prefix = "NextChat_$($config.package.version)_${revision}"
    $releaseDir = Join-Path $repoRoot 'release'
    $installer = Join-Path $releaseDir "${prefix}_x64-setup.exe"
    $zipPath = Join-Path $releaseDir "${prefix}_x64_portable.zip"
    $hashPath = Join-Path $releaseDir "${prefix}_SHA256SUMS.txt"
    $buildInfoPath = Join-Path $releaseDir "${prefix}_build-info.json"
    foreach ($output in @($installer, $zipPath, $hashPath, $buildInfoPath)) {
        if (Test-Path -LiteralPath $output) { throw "Release already exists: $output" }
    }

    $stageName = "release-$revision-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $stageDir = Join-Path $repoRoot "build/$stageName"
    $pluginsDir = Join-Path $stageDir 'plugins'
    $portableDir = Join-Path $stageDir "${prefix}_x64_portable"
    New-Item -ItemType Directory -Path $pluginsDir, $portableDir, $releaseDir -Force | Out-Null
    # Notices live in the repository and are embedded in NextChat.exe for offline viewing.
    if ((Get-FileHash -LiteralPath 'licenses/Bun-1.4.4.md' -Algorithm SHA256).Hash -ne '362FE32C954EC829240BD7429C53D705EEF08C6BFA45FFC2D02005F857CBA4DD') {
        throw 'Unexpected Bun license content'
    }
    $bundledPlugins = @()
    $expectedEntries = @('NextChat.exe')
    foreach ($bundle in $catalog.bundles) {
        if ($bundle.id -cnotmatch '^[a-z0-9]+(?:[.-][a-z0-9]+)*$' -or
            $bundle.executable -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]*\.exe$' -or
            $bundledPlugins.id -contains $bundle.id) { throw 'Invalid or duplicate desktop bundle' }
        $plugin = Get-Content -LiteralPath $bundle.manifest -Raw | ConvertFrom-Json
        if ($plugin.id -ne $bundle.id) { throw 'Bundle ID does not match its request plugin' }
        $pluginDir = Join-Path $pluginsDir $bundle.id
        New-Item -ItemType Directory -Path $pluginDir | Out-Null
        & node $bundle.buildScript $bunPath (Join-Path $pluginDir $bundle.executable)
        if ($LASTEXITCODE -ne 0) { throw "Bundled helper build failed: $($bundle.id)" }
        $relativeExecutable = "plugins/$($bundle.id)/$($bundle.executable)"
        $expectedEntries += $relativeExecutable
        $bundledPlugins += @{
            id = $bundle.id; version = $plugin.version; executable = $relativeExecutable
        }
    }
    if ($bundledPlugins.Count -eq 0) { throw 'Desktop bundle catalog is empty' }

    # Tauri v1 resource mappings must use paths relative to src-tauri on Windows.
    $tauriOverride = Join-Path $stageDir 'tauri.release.json'
    @{ tauri = @{ bundle = @{ resources = @{ "../build/$stageName/plugins/" = 'plugins/' } } } } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tauriOverride -Encoding UTF8
    $shimDir = Join-Path $stageDir 'bin'
    New-Item -ItemType Directory -Path $shimDir | Out-Null
    $corepackPath = (Get-Command corepack.cmd).Source
    "@echo off`r`ncall `"$corepackPath`" yarn %*`r`n" |
        Set-Content -LiteralPath (Join-Path $shimDir 'yarn.cmd') -Encoding ASCII
    $env:PATH = "$shimDir;$previousPath"
    & corepack yarn app:build --bundles nsis --config $tauriOverride --ci
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
    $nsis = Get-Content -LiteralPath 'src-tauri/target/release/nsis/x64/installer.nsi' -Raw
    foreach ($plugin in $bundledPlugins) {
        $installedPath = '$INSTDIR\' + $plugin.executable.Replace('/', '\')
        if (-not $nsis.Contains($installedPath)) { throw "Installer is missing $($plugin.id)" }
    }
    if ($nsis.Contains('claude-code-tools')) { throw 'Installer contains the old resource layout' }

    Copy-Item -LiteralPath 'src-tauri/target/release/NextChat.exe' -Destination $portableDir
    Copy-Item -LiteralPath $pluginsDir -Destination $portableDir -Recurse
    # Explicit allowlist: sources, development docs and duplicate plugin packages stay in Git.
    $actualEntries = @(Get-ChildItem -LiteralPath $portableDir -File -Recurse | ForEach-Object {
        $_.FullName.Substring($portableDir.Length + 1).Replace('\', '/')
    })
    if (Compare-Object ($expectedEntries | Sort-Object) ($actualEntries | Sort-Object)) {
        throw 'Portable directory differs from the runtime file allowlist'
    }
    @{
        sourceCommit = $sourceCommit; version = $config.package.version
        bundledPlugins = $bundledPlugins; platform = 'windows-x64'
        modes = @('independent-http', 'claude-cli-print'); bundledClaudeCli = $false
        desktopManagedServices = $true; separateNodeRequired = $false
        buildDateUtc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $buildInfoPath -Encoding UTF8
    Copy-Item -LiteralPath "src-tauri/target/release/bundle/nsis/NextChat_$($config.package.version)_x64-setup.exe" -Destination $installer
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($portableDir, $zipPath)
    $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $zipEntries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') } | ForEach-Object { $_.FullName.Replace('\', '/') })
        if (Compare-Object ($expectedEntries | Sort-Object) ($zipEntries | Sort-Object)) {
            throw 'ZIP differs from the runtime file allowlist'
        }
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            $stream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
            finally { $sha.Dispose(); $stream.Dispose() }
            $expected = (Get-FileHash -LiteralPath (Join-Path $portableDir $entry.FullName) -Algorithm SHA256).Hash
            if ($actual -ne $expected) { throw "ZIP verification failed: $($entry.FullName)" }
        }
        Write-Output "Verified $($archive.Entries.Count) ZIP entries"
    } finally { $archive.Dispose() }
    @($installer, $zipPath, $buildInfoPath) | ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $([IO.Path]::GetFileName($_))"
    } | Set-Content -LiteralPath $hashPath -Encoding ASCII
    Get-Item -LiteralPath $installer, $zipPath, $hashPath, $buildInfoPath | Select-Object FullName, Length
} finally {
    $env:PATH = $previousPath
    Pop-Location
}
