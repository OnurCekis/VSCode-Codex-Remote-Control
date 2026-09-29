Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-CodexPocketBinary {
    $expectedHash = '17E4FED6D6676AE0B894A7C39821DD1C50C1A786EEFB05362A3F9FDA678AF466'
    if ($env:CODEX_POCKET_CODEX_EXE) {
        $candidate = (Resolve-Path -LiteralPath $env:CODEX_POCKET_CODEX_EXE).Path
    }
    else {
        $repoRoot = Split-Path $PSScriptRoot -Parent
        $fixture = Join-Path $repoRoot '.codex-pocket\phase-0-7\vscode-extensions\openai.chatgpt-26.814.41407\bin\windows-x86_64\codex.exe'
        $global = Join-Path $env:USERPROFILE '.vscode\extensions\openai.chatgpt-26.814.41407-win32-x64\bin\windows-x86_64\codex.exe'
        $candidate = if (Test-Path -LiteralPath $fixture -PathType Leaf) { $fixture } else { $global }
    }

    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Codex executable does not exist: $candidate"
    }
    $resolved = (Resolve-Path -LiteralPath $candidate).Path
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolved).Hash
    if ($actualHash -ne $expectedHash) {
        throw "Pinned Codex SHA-256 mismatch: $actualHash"
    }
    return $resolved
}
