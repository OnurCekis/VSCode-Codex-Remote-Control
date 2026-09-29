@echo off
setlocal
set "POCKET_ROOT=%~dp0"
set "PYTHONUTF8=1"
python "%POCKET_ROOT%scripts\pocket-code-bootstrap.py" %*
exit /b %ERRORLEVEL%
