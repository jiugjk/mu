# mu from PowerShell, without cmd.exe in between: cmd parses the arguments a second time, which mangles a
# prompt that has quotes, & or % in it. mu.mjs checks the Node version itself and says so plainly.
#
# `mu link` installs mu.cmd only, on purpose. PowerShell prefers a .ps1 to a .cmd of the same name in one folder,
# and the default execution policy on Windows (Restricted) then refuses to run it: `mu` would stop working in
# PowerShell instead of falling back to mu.cmd. Call this file by its path when you need exact arguments.
#
# Run in CI under Windows PowerShell 5.1 and PowerShell 7 by the launcher's tests (windows-tests.yml). What is still
# unchecked on a real machine is in kyrn\docs\features\windows-and-wsl.md.
#
# Only what every PowerShell has loaded is used here (no Join-Path, no Select-Object): finding a command in a module
# can take seconds while PowerShell's module cache is cold.
$node = @(Get-Command node -CommandType Application -ErrorAction SilentlyContinue)[0]
if (-not $node) {
	[Console]::Error.WriteLine("mu needs Node.js 22.19 or newer, and no node was found on PATH.")
	[Console]::Error.WriteLine("Install it from https://nodejs.org or with: winget install OpenJS.NodeJS.LTS")
	exit 1
}
# Windows PowerShell 5.1 (and PowerShell 7 before 7.3, or with $PSNativeCommandArgumentPassing set to Legacy) hands a
# program its arguments without escaping the quotes in them: node would read `say "hi"` as `say hi`. They are escaped
# here the way node reads them back: a quote as \", with the backslashes before it doubled. An empty argument would be
# dropped, and "" keeps it. Windows PowerShell also puts an argument with a space in quotes without doubling the
# backslashes it ends with, which would then escape the closing quote: those are doubled too.
$arguments = $args
if ($null -eq $PSNativeCommandArgumentPassing -or $PSNativeCommandArgumentPassing -eq 'Legacy') {
	$arguments = @(foreach ($argument in $args) {
		$text = "$argument"
		if ($text -eq '') { '""'; continue }
		$text = $text -replace '(\\*)"', '$1$1\"'
		if ($PSVersionTable.PSEdition -ne 'Core' -and $text -match '\s') { $text = $text -replace '(\\+)$', '$1$1' }
		$text
	})
}
& $node.Source "$PSScriptRoot\mu.mjs" @arguments
exit $LASTEXITCODE
