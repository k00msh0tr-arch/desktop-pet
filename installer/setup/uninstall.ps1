# Claude Pet uninstaller: removes the hooks she added, the shortcuts and the installed files.
param(
  [string]$Target = (Join-Path $env:LOCALAPPDATA 'Claude Pet'),
  [ValidateSet('ask', 'yes', 'no')][string]$Settings = 'ask',
  [ValidateSet('ask', 'yes', 'no')][string]$KeepCharacters = 'ask',
  [switch]$NoPause
)
$ErrorActionPreference = 'Stop'

function Ask([string]$mode, [string]$question, [bool]$default) {
  if ($mode -eq 'yes') { return $true }
  if ($mode -eq 'no') { return $false }
  $hint = if ($default) { 'Y/n' } else { 'y/N' }
  $a = ("$(Read-Host "$question [$hint]")").Trim().ToLower()
  if (-not $a) { return $default }
  return $a -in @('y', 'yes')
}

Write-Host ''
Write-Host "Removing Claude Pet from $Target" -ForegroundColor Cyan

Get-Process -Name electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($Target, [StringComparison]::OrdinalIgnoreCase) } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

$electron = Join-Path $Target 'electron\electron.exe'
$hooks = Join-Path $Target 'app\tools\hooks.js'
if ((Test-Path $electron) -and (Test-Path $hooks)) {
  $env:ELECTRON_RUN_AS_NODE = '1' # electron.exe doubles as node
  $out = Join-Path $env:TEMP 'claude-pet-hooks.out'
  try {
    $run = Start-Process -FilePath $electron -ArgumentList ('"' + $hooks + '" uninstall') -Wait -NoNewWindow -PassThru -RedirectStandardOutput $out
    if ($run.ExitCode -eq 0) { Write-Host 'Claude Code hooks removed (a backup of settings.json was kept).' -ForegroundColor Green }
    else { Write-Host 'Could not edit ~/.claude/settings.json; nothing was changed there.' -ForegroundColor Yellow }
  } finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item $out -ErrorAction SilentlyContinue
  }
}

foreach ($pair in @(@('Desktop', 'Claude Pet.lnk'), @('Programs', 'Claude Pet.lnk'), @('Programs', 'Uninstall Claude Pet.lnk'), @('Startup', 'Claude Pet.lnk'))) {
  $dir = [Environment]::GetFolderPath($pair[0])
  if (-not $dir) { continue }
  $f = Join-Path $dir $pair[1]
  if (Test-Path $f) { Remove-Item $f -Force }
}
Write-Host 'Shortcuts removed.' -ForegroundColor Green

# characters you added live in app\characters; the ones she built are marked "auto" in their manifest
$added = @()
$chars = Join-Path $Target 'app\characters'
if (Test-Path $chars) {
  $added = @(Get-ChildItem $chars -Directory | Where-Object {
      $m = Join-Path $_.FullName 'manifest.json'
      (Test-Path $m) -and ((Get-Content $m -Raw) -match '"auto"\s*:\s*true')
    })
}
if ($added.Count -gt 0 -and (Ask $KeepCharacters "You added characters ($($added.Name -join ', ')). Keep a copy in your Documents folder?" $true)) {
  $backup = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Claude Pet characters'
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  foreach ($c in $added) { Copy-Item $c.FullName (Join-Path $backup $c.Name) -Recurse -Force }
  Write-Host "Your characters were copied to $backup" -ForegroundColor Green
}

if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
Write-Host 'Program files removed.' -ForegroundColor Green

$data = Join-Path $env:APPDATA 'claude-pet'
if ((Test-Path $data) -and (Ask $Settings 'Also delete her saved settings and image cache?' $false)) {
  Remove-Item $data -Recurse -Force
  Write-Host 'Settings and cache removed.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
if (-not $NoPause) { Read-Host 'Press Enter to close' | Out-Null }
# the .bat runs this from a temporary copy; tidy that up
if ($PSCommandPath -and (Split-Path -Leaf $PSCommandPath) -eq 'claude-pet-uninstall.ps1') { Remove-Item $PSCommandPath -Force -ErrorAction SilentlyContinue }
