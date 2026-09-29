Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$source = Join-Path $repoRoot 'tools\vscode-proxy\main.ts'
$outputDirectory = Join-Path $repoRoot 'tools\vscode-proxy\dist'
$output = Join-Path $outputDirectory 'codex-pocket-proxy.exe'

if (-not (Get-Command deno -ErrorAction SilentlyContinue)) {
    throw 'Deno is required to compile the disposable VS Code proxy launcher.'
}

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
deno compile --quiet --no-config --node-modules-dir=manual --allow-env --allow-read --allow-write --allow-run --allow-net=127.0.0.1 --output $output $source
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
Write-Output $output
