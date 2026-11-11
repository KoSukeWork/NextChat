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
    $plugin = Get-Content -LiteralPath 'plugins/claude-code-managed/manifest.json' -Raw | ConvertFrom-Json
    $prefix = "NextChat_$($config.package.version)_${revision}"
    $releaseDir = Join-Path $repoRoot 'release'
    $installer = Join-Path $releaseDir "${prefix}_x64-setup.exe"
    $zipPath = Join-Path $releaseDir "${prefix}_x64_portable.zip"
    $hashPath = Join-Path $releaseDir "${prefix}_SHA256SUMS.txt"
    foreach ($output in @($installer, $zipPath, $hashPath)) {
        if (Test-Path -LiteralPath $output) { throw "Release already exists: $output" }
    }

    $stageName = "release-$revision-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $stageDir = Join-Path $repoRoot "build/$stageName"
    $toolsDir = Join-Path $stageDir 'claude-code-tools'
    $portableDir = Join-Path $stageDir "${prefix}_x64_portable"
    New-Item -ItemType Directory -Path $toolsDir, $portableDir, $releaseDir -Force | Out-Null
    & node scripts/build-wire-relay.mjs $bunPath (Join-Path $toolsDir 'nextchat-wire-relay.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Bundled helper build failed' }
    $sources = @(
        'scripts/wire-relay.mjs', 'scripts/wire-relay/server.mjs',
        'scripts/build-wire-relay.mjs', 'scripts/client-bridge.mjs',
        'scripts/client-bridge/server.mjs', 'scripts/client-bridge/process.mjs',
        'scripts/client-bridge/standalone.mjs', 'plugins/claude-code/driver.mjs',
        'docs/claude-code-modes.md', 'docs/wire-relay.md', 'docs/request-plugins-legacy.md'
    )
    foreach ($source in $sources) {
        $destination = Join-Path $toolsDir $source
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
    }
    New-Item -ItemType Directory -Path (Join-Path $toolsDir 'request-plugins') | Out-Null
    Copy-Item -LiteralPath "public/request-plugins/nextchat.claude-code-$($plugin.version).json" -Destination (Join-Path $toolsDir 'request-plugins')
    Copy-Item -LiteralPath 'LICENSE' -Destination (Join-Path $toolsDir 'LICENSE-NextChat')
    $bunLicense = Join-Path $toolsDir 'LICENSE-Bun.md'
    Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/oven-sh/bun/38afee6c84fcf48c0edb2466aa4b27d287a59c30/LICENSE.md' -OutFile $bunLicense
    if ((Get-FileHash -LiteralPath $bunLicense -Algorithm SHA256).Hash -ne '362FE32C954EC829240BD7429C53D705EEF08C6BFA45FFC2D02005F857CBA4DD') {
        throw 'Unexpected Bun license content'
    }

    # Tauri v1 resource mappings must use paths relative to src-tauri on Windows.
    $tauriOverride = Join-Path $stageDir 'tauri.release.json'
    @{ tauri = @{ bundle = @{ resources = @{ "../build/$stageName/claude-code-tools/" = 'claude-code-tools/' } } } } |
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
    if ($nsis -notmatch 'nextchat-wire-relay\.exe') { throw 'Installer is missing the service helper' }

    Copy-Item -LiteralPath 'src-tauri/target/release/NextChat.exe' -Destination $portableDir
    Copy-Item -LiteralPath $toolsDir -Destination $portableDir -Recurse
    Copy-Item -LiteralPath 'docs/desktop-portable.md' -Destination (Join-Path $portableDir 'README.md')
    Copy-Item -LiteralPath 'LICENSE' -Destination $portableDir
    @{
        sourceCommit = $sourceCommit; version = $config.package.version
        pluginVersion = $plugin.version; platform = 'windows-x64'
        modes = @('independent-http', 'claude-cli-print'); bundledClaudeCli = $false
        desktopManagedServices = $true; separateNodeRequired = $false
        buildDateUtc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $portableDir 'build-info.json') -Encoding UTF8
    Copy-Item -LiteralPath "src-tauri/target/release/bundle/nsis/NextChat_$($config.package.version)_x64-setup.exe" -Destination $installer
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($portableDir, $zipPath)
    $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
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
    @($installer, $zipPath) | ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $([IO.Path]::GetFileName($_))"
    } | Set-Content -LiteralPath $hashPath -Encoding ASCII
    Get-Item -LiteralPath $installer, $zipPath, $hashPath | Select-Object FullName, Length
} finally {
    $env:PATH = $previousPath
    Pop-Location
}
