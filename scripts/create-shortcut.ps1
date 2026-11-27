# Creates "Finance Tracker" shortcuts on the Desktop and in the Start menu.
# They launch the built app (out/) with this project's Electron, so run
# `npm run build` after changing code. Run with: npm run shortcut

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $root 'resources\icon.ico'

if (-not (Test-Path $electron)) { throw "Electron isn't installed yet. Run 'npm install' first." }
if (-not (Test-Path (Join-Path $root 'out\main\index.js'))) { throw "The app isn't built yet. Run 'npm run build' first." }

$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Finance Tracker.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Finance Tracker.lnk')
)

$shell = New-Object -ComObject WScript.Shell
foreach ($path in $targets) {
  $s = $shell.CreateShortcut($path)
  $s.TargetPath = $electron
  $s.Arguments = "`"$root`""
  $s.WorkingDirectory = $root
  $s.IconLocation = "$icon,0"
  $s.Description = 'Personal finance tracker'
  $s.Save()
  Write-Output "Created $path"
}
