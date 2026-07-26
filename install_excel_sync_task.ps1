# install_excel_sync_task.ps1
# Creates/updates Windows Task Scheduler task for Excel sync every 5 minutes.

$TaskName = "WFHDP Excel Sync"
$ScriptPath = Join-Path $PSScriptRoot "sync_excel_to_do.ps1"
$Interval = 5  # minutes

Write-Host "=== WFHDP Excel Sync Task Installer ==="

# Check script exists
if (-not (Test-Path $ScriptPath)) {
    Write-Host "ERROR: sync_excel_to_do.ps1 not found at $ScriptPath"
    exit 1
}
Write-Host "Sync script: $ScriptPath"

# Check if task already exists
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Task '$TaskName' already exists — updating."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
} else {
    Write-Host "Task '$TaskName' does not exist — creating new."
}

# Create trigger: every N minutes, indefinitely
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $Interval) -RepetitionDuration ([TimeSpan]::MaxValue)

# Action: run PowerShell with the sync script
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""

# Settings
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

# Register with current user
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Trigger $trigger -Action $action -Settings $settings -Principal $principal -Description "Sync WFHDP Excel from OneDrive to DigitalOcean every 5 minutes" -Force

Write-Host ""
Write-Host "=== Task '$TaskName' created/updated ==="
Write-Host "  Interval: every $Interval minutes"
Write-Host "  Script: $ScriptPath"
Write-Host ""
Write-Host "To run manually: powershell -File `"$ScriptPath`""
Write-Host "To disable: schtasks /Change /TN '$TaskName' /DISABLE"
Write-Host "To remove:  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
