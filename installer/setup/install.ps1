# Claude Pet installer: copies the app to %LOCALAPPDATA%\Claude Pet, makes shortcuts and (if you say yes)
# adds the Claude Code hooks. Run it with "Install Claude Pet.bat". Nothing needs administrator rights.
param(
  [string]$Target = (Join-Path $env:LOCALAPPDATA 'Claude Pet'),
  [ValidateSet('ask', 'yes', 'no')][string]$Shortcuts = 'yes',
  [ValidateSet('ask', 'yes', 'no')][string]$Hooks = 'ask',
  [ValidateSet('ask', 'yes', 'no')][string]$Startup = 'ask',
  [ValidateSet('ask', 'yes', 'no')][string]$Launch = 'ask'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot # the unzipped folder: app\, electron\, setup\

function Ask([string]$mode, [string]$question, [bool]$default) {
  if ($mode -eq 'yes') { return $true }
  if ($mode -eq 'no') { return $false }
  $hint = if ($default) { 'Y/n' } else { 'y/N' }
  $a = ("$(Read-Host "$question [$hint]")").Trim().ToLower()
  if (-not $a) { return $default }
  return $a -in @('y', 'yes')
}

function Stop-Pet([string]$folder) {
  Get-Process -Name electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
}

# a shortcut in one of the user's special folders (Desktop, Programs, Startup); skipped with a note if Windows has none
function New-Shortcut([string]$folder, [string]$leaf, [string]$targetFile, [string]$arguments, [string]$workDir, [string]$icon) {
  $dir = [Environment]::GetFolderPath($folder)
  if (-not $dir -or -not (Test-Path $dir)) { Write-Host "  (no $folder folder here, skipped $leaf)" -ForegroundColor Yellow; return }
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $dir $leaf))
  $link.TargetPath = $targetFile
  $link.Arguments = $arguments
  $link.WorkingDirectory = $workDir
  if ($icon) { $link.IconLocation = "$icon,0" }
  $link.Description = 'Claude Pet'
  $link.Save()
}
function New-PetShortcut([string]$folder) {
  New-Shortcut $folder 'Claude Pet.lnk' (Join-Path $Target 'electron\electron.exe') ('"' + (Join-Path $Target 'app') + '"') $Target (Join-Path $Target 'claude-pet.ico')
}

foreach ($need in 'app\package.json', 'electron\electron.exe') {
  if (-not (Test-Path (Join-Path $root $need))) { throw "This folder is incomplete ($need is missing). Unzip the whole archive first." }
}

Write-Host ''
Write-Host 'Claude Pet will be installed to:' -ForegroundColor Cyan
Write-Host "  $Target"
Write-Host ''

Stop-Pet $root   # a copy running straight from the unzipped folder
Stop-Pet $Target # and any installed copy, so its files can be replaced

Write-Host 'Copying files (about 350 MB, this takes a moment)...'
New-Item -ItemType Directory -Force -Path $Target | Out-Null
foreach ($dir in 'app', 'electron', 'setup') {
  # app\characters is never emptied: it holds any characters you added (copied separately below)
  # (excluded by name: robocopy only protects the destination copy of a folder when it is excluded by name, not by path)
  $keep = if ($dir -eq 'app') { @('/XD', 'characters') } else { @() }
  robocopy (Join-Path $root $dir) (Join-Path $Target $dir) /MIR /NFL /NDL /NJH /NJS /NP @keep | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying $dir failed (robocopy exit code $LASTEXITCODE)." }
}
robocopy (Join-Path $root 'app\characters') (Join-Path $Target 'app\characters') /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the characters failed (robocopy exit code $LASTEXITCODE)." }
foreach ($file in 'Claude Pet.bat', 'Uninstall Claude Pet.bat', 'claude-pet.ico', 'README.txt') {
  if (Test-Path (Join-Path $root $file)) { Copy-Item (Join-Path $root $file) $Target -Force }
}
Write-Host 'Files copied.' -ForegroundColor Green

if (Ask $Shortcuts 'Add Desktop and Start menu shortcuts?' $true) {
  New-PetShortcut 'Desktop'
  New-PetShortcut 'Programs'
  New-Shortcut 'Programs' 'Uninstall Claude Pet.lnk' (Join-Path $Target 'Uninstall Claude Pet.bat') '' $env:TEMP ''
  Write-Host 'Shortcuts added.' -ForegroundColor Green
}

if (Ask $Startup 'Start Claude Pet automatically when you sign in to Windows?' $false) {
  New-PetShortcut 'Startup'
  Write-Host 'She will start with Windows.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Claude Code hooks let her react to what Claude is doing. They are added to'
Write-Host "  $(Join-Path $env:USERPROFILE '.claude\settings.json')"
Write-Host 'as plain HTTP hooks to 127.0.0.1 only, with a backup of that file first. Other settings are kept.'
if (Ask $Hooks 'Add the Claude Code hooks now?' $true) {
  $env:ELECTRON_RUN_AS_NODE = '1' # electron.exe doubles as node, so nothing else has to be installed
  $out = Join-Path $env:TEMP 'claude-pet-hooks.out'
  $err = Join-Path $env:TEMP 'claude-pet-hooks.err'
  try {
    # electron.exe is a GUI program: only Start-Process -Wait waits for it and reports its real exit code
    $run = Start-Process -FilePath (Join-Path $Target 'electron\electron.exe') -ArgumentList ('"' + (Join-Path $Target 'app\tools\hooks.js') + '" install') `
      -Wait -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    if ($run.ExitCode -eq 0) {
      $result = Get-Content $out -Raw | ConvertFrom-Json
      if ($result.backup) { Write-Host "  backup of your settings: $($result.backup)" }
      Write-Host 'Hooks added. Start a new Claude Code session so it picks them up.' -ForegroundColor Green
    } else {
      Write-Host 'The hooks could not be added, so nothing was changed:' -ForegroundColor Yellow
      Get-Content $err | ForEach-Object { Write-Host "  $_" }
    }
  } finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item $out, $err -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
if (Ask $Launch 'Start Claude Pet now?' $true) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Start-Process -FilePath (Join-Path $Target 'electron\electron.exe') -ArgumentList ('"' + (Join-Path $Target 'app') + '"') -WorkingDirectory $Target
  Write-Host 'She is on your desktop. Right-click her (or the tray icon) for the menu.'
}
