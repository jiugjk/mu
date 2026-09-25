@echo off
rem mu command line on Windows. Everything the launcher does is in mu.mjs, next to this file.
rem Only one job is left here: making sure the node on PATH is 22.19 or newer before it is asked to run it.
rem (kyrn\bin\mu does the same for macOS, Linux and WSL.)
rem
rem Keep this file ASCII: cmd reads a batch file in the console's code page.
rem No parentheses around the messages below: a ")" inside a block would end it.
rem Run through cmd.exe on a Windows runner by the tests in CI (windows-tests.yml). What is still unchecked
rem on a real machine is in kyrn\docs\features\windows-and-wsl.md.
setlocal
set "_MU_MAJOR="
set "_MU_MINOR="
for /f "tokens=1,2 delims=v." %%a in ('node --version 2^>nul') do (
  set "_MU_MAJOR=%%a"
  set "_MU_MINOR=%%b"
)
if not defined _MU_MAJOR goto :missing
if %_MU_MAJOR% LSS 22 goto :old
if %_MU_MAJOR% EQU 22 if %_MU_MINOR% LSS 19 goto :old
endlocal
node "%~dp0mu.mjs" %*
exit /b %errorlevel%

:missing
echo mu needs Node.js 22.19 or newer, and no node was found on PATH. 1>&2
echo Install it from https://nodejs.org or with: winget install OpenJS.NodeJS.LTS 1>&2
exit /b 1

:old
echo mu needs Node.js 22.19 or newer, found %_MU_MAJOR%.%_MU_MINOR%. 1>&2
echo Install a newer one from https://nodejs.org or with: winget install OpenJS.NodeJS.LTS 1>&2
exit /b 1
