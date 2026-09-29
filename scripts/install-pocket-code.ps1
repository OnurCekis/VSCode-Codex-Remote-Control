Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$source = Join-Path $repoRoot 'pocket-code.cmd'
$bin = Join-Path $env:LOCALAPPDATA 'CodexPocket\bin'
$destination = Join-Path $bin 'pocket-code.cmd'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
$escapedSource = $source.Replace('%', '%%')
Set-Content -LiteralPath $destination -Encoding ASCII -Value "@echo off`r`ncall `"$escapedSource`" %*`r`nexit /b %ERRORLEVEL%`r`n"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($userPath -split ';' | Where-Object { $_ })
if (-not ($entries | Where-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') -ieq [IO.Path]::GetFullPath($bin).TrimEnd('\') })) {
  [Environment]::SetEnvironmentVariable('Path', (($entries + $bin) -join ';'), 'User')
}
Write-Host "Installed pocket-code for the current user at $destination"
Write-Host 'Open a new terminal, then run: pocket-code .'
