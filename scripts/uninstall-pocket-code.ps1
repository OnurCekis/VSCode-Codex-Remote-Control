Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$bin = Join-Path $env:LOCALAPPDATA 'CodexPocket\bin'
Remove-Item -LiteralPath (Join-Path $bin 'pocket-code.cmd') -Force -ErrorAction SilentlyContinue
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($userPath -split ';' | Where-Object { $_ -and [IO.Path]::GetFullPath($_).TrimEnd('\') -ine [IO.Path]::GetFullPath($bin).TrimEnd('\') })
[Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
Write-Host 'Removed the current-user pocket-code launcher.'
