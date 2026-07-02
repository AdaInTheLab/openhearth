# -------------------------------------------------------------
# openhearth.ps1 - Windows control script for running an
# openhearth agent natively (no WSL) via Task Scheduler.
#
# This is the Windows sibling of scripts/openhearth.service:
# same restart-on-crash posture (5 retries, then give up until
# the next logon or manual start), same LOG_FILE convention.
#
# Install (from an elevated or normal PowerShell prompt):
#   cd C:\path\to\openhearth
#   powershell -ExecutionPolicy Bypass -File scripts\openhearth.ps1 install
#
# Control:
#   scripts\openhearth.ps1 start
#   scripts\openhearth.ps1 stop
#   scripts\openhearth.ps1 restart
#   scripts\openhearth.ps1 status
#   scripts\openhearth.ps1 logs        # tail -f the runtime log
#   scripts\openhearth.ps1 uninstall
#
# The scheduled task runs at logon of the installing user, in
# that user's session. That's deliberate: the agent shells out
# to CLIs (claude, codex) whose auth lives in the user profile,
# so SYSTEM is the wrong identity for it.
#
# Defaults assume the repo layout: entry point index.js in the
# repo root (same assumption as the systemd unit), log under
# .openhearth\runtime.log next to it. Override at install time:
#
#   scripts\openhearth.ps1 install -EntryScript scripts\luna.js `
#     -LogFile D:\hearth\workspace\.openhearth\runtime.log
#
# Point -LogFile into the agent's workspace if you want logs to
# live with the soul files (the VPS/WSL deploys do this so logs
# survive re-provisioning). openhearth's own logger rotates the
# file in-process: 10 MB threshold, keeps last 5.
#
# Written for Windows PowerShell 5.1 (stock on Windows 10/11);
# also runs on PowerShell 7+. Keep this file ASCII-only: PS 5.1
# reads BOM-less files as ANSI and mangles anything fancier.
# -------------------------------------------------------------

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs', 'run')]
  [string]$Action,

  # Name of the scheduled task. Change it if you run more than one
  # agent on the same box (e.g. -TaskName openhearth-luna).
  [string]$TaskName = 'openhearth',

  # Repo root. Defaults to the parent of this script's directory.
  [string]$RepoDir = (Split-Path -Parent $PSScriptRoot),

  # Entry point, relative to -RepoDir (or absolute).
  [string]$EntryScript = 'index.js',

  # Where openhearth's rotating logger writes.
  [string]$LogFile = '',

  # node.exe to use. Defaults to whatever `node` resolves to.
  [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'

if (-not $LogFile) { $LogFile = Join-Path $RepoDir '.openhearth\runtime.log' }

function Resolve-Node {
  if ($NodeExe) { return $NodeExe }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw 'node not found on PATH. Install Node 18+ (https://nodejs.org) or pass -NodeExe C:\path\to\node.exe'
  }
  return $cmd.Source
}

function Get-Task {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

switch ($Action) {

  # --- run: what the scheduled task actually executes ----------
  # Sets the environment the systemd unit sets, then hands off to
  # node. Task Scheduler's restart settings handle crashes.
  'run' {
    $env:LOG_FILE = $LogFile
    $env:NODE_ENV = 'production'
    New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
    Set-Location $RepoDir
    & (Resolve-Node) $EntryScript
    exit $LASTEXITCODE
  }

  'install' {
    $node = Resolve-Node
    $entryPath = if ([System.IO.Path]::IsPathRooted($EntryScript)) { $EntryScript } else { Join-Path $RepoDir $EntryScript }
    if (-not (Test-Path $entryPath)) {
      throw "Entry script not found: $entryPath. Pass -EntryScript (e.g. scripts\luna.js) or create index.js in the repo root."
    }

    $scriptPath = Join-Path $PSScriptRoot 'openhearth.ps1'
    $taskArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden' +
      " -File `"$scriptPath`" run" +
      " -RepoDir `"$RepoDir`" -EntryScript `"$EntryScript`"" +
      " -LogFile `"$LogFile`" -NodeExe `"$node`""

    # NOT $action - PowerShell variables are case-insensitive and that
    # would collide with the validated $Action parameter.
    $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs -WorkingDirectory $RepoDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

    # Mirrors the systemd unit: restart on crash (5 tries, 1 min
    # apart), no execution time limit, keep running on battery.
    $settings = New-ScheduledTaskSettingsSet `
      -RestartCount 5 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -MultipleInstances IgnoreNew `
      -StartWhenAvailable

    if (Get-Task) {
      Write-Host "Task '$TaskName' already exists - updating it."
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger `
      -Settings $settings -Description 'openhearth - persistent AI agent runtime' | Out-Null

    Write-Host "Installed scheduled task '$TaskName'."
    Write-Host "  entry : $entryPath"
    Write-Host "  node  : $node"
    Write-Host "  log   : $LogFile"
    Write-Host "It will start at your next logon. Start it now with:"
    Write-Host "  scripts\openhearth.ps1 start -TaskName $TaskName"
  }

  'uninstall' {
    if (-not (Get-Task)) { Write-Host "Task '$TaskName' is not installed."; break }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Uninstalled scheduled task '$TaskName'."
  }

  'start' {
    if (-not (Get-Task)) { throw "Task '$TaskName' is not installed. Run: scripts\openhearth.ps1 install" }
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started '$TaskName'. Follow the log with: scripts\openhearth.ps1 logs"
  }

  'stop' {
    if (-not (Get-Task)) { throw "Task '$TaskName' is not installed." }
    Stop-ScheduledTask -TaskName $TaskName
    Write-Host "Stopped '$TaskName'."
  }

  'restart' {
    if (-not (Get-Task)) { throw "Task '$TaskName' is not installed." }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Restarted '$TaskName'."
  }

  'status' {
    $task = Get-Task
    if (-not $task) { Write-Host "Task '$TaskName' is not installed."; break }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Task    : $TaskName ($($task.State))"
    Write-Host "Last run: $($info.LastRunTime)  (result: 0x$('{0:X}' -f $info.LastTaskResult))"
    Write-Host "Next run: $($info.NextRunTime)"
    Write-Host "Log     : $LogFile"
    if (Test-Path $LogFile) {
      Write-Host "--- last 10 log lines ---"
      Get-Content $LogFile -Tail 10
    }
  }

  'logs' {
    if (-not (Test-Path $LogFile)) { throw "No log file at $LogFile yet. Is the agent running? (Pass -LogFile if you installed with a custom path.)" }
    Get-Content $LogFile -Tail 50 -Wait
  }
}
