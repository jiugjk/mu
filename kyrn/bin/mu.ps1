# mu from PowerShell, without cmd.exe in between: cmd parses the arguments a second time, which mangles a
# prompt that has quotes, & or % in it. mu.mjs checks the Node version itself and says so plainly.
#
# `mu link` installs mu.cmd only, on purpose. PowerShell prefers a .ps1 to a .cmd of the same name in one folder,
# and the default execution policy on Windows (Restricted) then refuses to run it: `mu` would stop working in
# PowerShell instead of falling back to mu.cmd. Call this file by its path when you need exact arguments.
#
# Not run on Windows yet (mu.cmd is, in CI). See kyrn\docs\features\windows-and-wsl.md for what to check first.
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
	[Console]::Error.WriteLine("mu needs Node.js 22.19 or newer, and no node was found on PATH.")
	[Console]::Error.WriteLine("Install it from https://nodejs.org or with: winget install OpenJS.NodeJS.LTS")
	exit 1
}
& $node.Source (Join-Path $PSScriptRoot "mu.mjs") @args
exit $LASTEXITCODE
