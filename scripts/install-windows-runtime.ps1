param(
    [string]$NodePath = (Get-Command node -ErrorAction Stop).Source,
    [string]$PythonPath = $env:NULLIUS_PYTHON,
    [string]$BinDir = (Join-Path $env:USERPROFILE '.local\bin'),
    [switch]$Persist
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer requires native Windows.' }
if (-not $PythonPath) { $PythonPath = (Get-Command python -ErrorAction Stop).Source }
foreach ($executable in @($NodePath, $PythonPath)) {
    if (-not [IO.Path]::IsPathRooted($executable) -or -not $executable.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw 'NodePath and PythonPath must be absolute native .exe paths.'
    }
}
$workspace = Split-Path -Parent $PSScriptRoot
$renderer = Join-Path $workspace 'packages\orchestrator\dist\project-local-nullius-windows.js'
$cli = Join-Path $workspace 'packages\orchestrator\dist\cli.js'
if (-not (Test-Path -LiteralPath $renderer) -or -not (Test-Path -LiteralPath $cli)) { throw 'Build the workspace with pnpm -r build first.' }
$git = (Get-Command git -ErrorAction Stop).Source
$gitBin = Join-Path (Split-Path -Parent (Split-Path -Parent $git)) 'bin'
if (-not (Test-Path -LiteralPath (Join-Path $gitBin 'bash.exe'))) { throw 'Git for Windows Bash was not found beside git.exe.' }
$BinDir = [IO.Path]::GetFullPath($BinDir)
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$wrapper = Join-Path $BinDir 'nullius.cmd'
foreach ($entry in @($wrapper, (Join-Path $BinDir 'nullius.ps1'))) {
    if (Test-Path -LiteralPath $entry) {
        Copy-Item -LiteralPath $entry -Destination ($entry + '.backup-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ'))
    }
}
$moduleUri = ([Uri]$renderer).AbsoluteUri
$env:NULLIUS_PYTHON = $PythonPath
$installer = Join-Path ([IO.Path]::GetTempPath()) ('nullius-install-' + [Guid]::NewGuid().ToString('N') + '.mjs')
$powerShellWrapper = Join-Path $BinDir 'nullius.ps1'
$installCode = "import fs from 'node:fs'; import {renderManagedWindowsCommand,renderManagedWindowsPowerShell} from $(ConvertTo-Json -Compress $moduleUri); const argv=$(ConvertTo-Json -Compress @($NodePath,$cli)); fs.writeFileSync($(ConvertTo-Json -Compress $wrapper),renderManagedWindowsCommand(argv)); fs.writeFileSync($(ConvertTo-Json -Compress $powerShellWrapper),renderManagedWindowsPowerShell(argv));"
try {
    [IO.File]::WriteAllText($installer, $installCode, $utf8)
    & $NodePath $installer
    if ($LASTEXITCODE -ne 0) { throw 'Managed CLI wrapper installation failed.' }
} finally {
    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
# Bash does not resolve Windows python3.cmd aliases. Keep its bridge separate
# from native executable approval: approved computations always bind the .exe.
$pythonBridge = @'
#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${NULLIUS_PYTHON:-}" ]]; then
  echo 'Set NULLIUS_PYTHON to an absolute native Python executable.' >&2
  exit 127
fi
exec "$(cygpath -u "$NULLIUS_PYTHON")" "$@"
'@
[IO.File]::WriteAllText((Join-Path $BinDir 'python3'), $pythonBridge.Replace("`r`n", "`n") + "`n", $utf8)
$env:NULLIUS_PYTHON = $PythonPath
$additions = @($BinDir, $gitBin, (Split-Path -Parent $PythonPath))
$env:PATH = (@((Split-Path -Parent $NodePath)) + $additions + @($env:PATH)) -join ';'
if ($Persist) {
    [Environment]::SetEnvironmentVariable('NULLIUS_PYTHON', $PythonPath, 'User')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($userPath -split ';' | Where-Object { $_ })
    foreach ($entry in $additions) { if ($entries -notcontains $entry) { $entries += $entry } }
    [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
}
& $wrapper --help
if ($LASTEXITCODE -ne 0) { throw 'Installed CLI failed its help check.' }
& $powerShellWrapper --help
if ($LASTEXITCODE -ne 0) { throw 'Installed PowerShell CLI failed its help check.' }
Write-Output "Installed $wrapper"
if ($Persist) { Write-Output 'Restart GUI agent clients to pick up the user environment.' }
