Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$launcher = Join-Path $repoRoot 'tools\vscode-proxy\dist\codex-pocket-proxy.exe'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    & (Join-Path $PSScriptRoot 'build-launcher.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Failed to build the pinned VS Code proxy launcher.' }
}

$tsx = Join-Path $repoRoot 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) {
    throw 'Dependencies are missing. Install the pinned workspace dependencies first.'
}

Push-Location $repoRoot
try {
    & (Get-Command node.exe).Source $tsx 'apps/ipc-probe/src/phase-0-7-vscode-session.ts'
    if ($LASTEXITCODE -ne 0) { throw "Phase 0.7 session failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}
