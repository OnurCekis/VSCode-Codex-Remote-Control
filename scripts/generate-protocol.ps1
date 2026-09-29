Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-codex.ps1')

$codex = Resolve-CodexPocketBinary
$outputRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'protocol\generated'
$typescriptOutput = Join-Path $outputRoot 'typescript'
$jsonSchemaOutput = Join-Path $outputRoot 'json-schema'

New-Item -ItemType Directory -Force -Path $typescriptOutput, $jsonSchemaOutput | Out-Null
& $codex app-server generate-ts --experimental --out $typescriptOutput
if ($LASTEXITCODE -ne 0) { throw 'TypeScript protocol generation failed.' }
& $codex app-server generate-json-schema --experimental --out $jsonSchemaOutput
if ($LASTEXITCODE -ne 0) { throw 'JSON Schema protocol generation failed.' }
& $codex --version
