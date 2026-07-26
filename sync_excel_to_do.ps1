# sync_excel_to_do.ps1
# Safe atomic Excel sync: Windows OneDrive -> DigitalOcean
# Unique temp filename + remote flock prevents concurrent corruption.

param(
    [string]$LocalFile = "C:\Users\ak481\OneDrive\Desktop\新建文件夹\26年7月 线上办公数据汇总 New.xlsx",
    [string]$RemoteHost = "root@168.144.135.25",
    [string]$RemoteDir = "/opt/wfhdp-bot/data",
    [string]$RemoteFinal = "26年7月 线上办公数据汇总 New.xlsx",
    [int]$LockTimeout = 60
)

$ErrorActionPreference = "Stop"
$StartTime = Get-Date
$Timestamp = $StartTime.ToString("yyyyMMdd_HHmmss")
$TempName = ".incoming_wfhdp_${Timestamp}_${PID}.xlsx"
$LockFile = "$RemoteDir/.sync.lock"

function Fail($msg) {
    Write-Host "SYNC FAILED: $msg"
    exit 1
}

function SshOK($cmd) {
    ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new $RemoteHost $cmd 2>&1
    return $LASTEXITCODE -eq 0
}

Write-Host "[$StartTime] Excel sync started"
Write-Host "  Temp: $TempName"

# A. Local file check
if (-not (Test-Path $LocalFile)) { Fail "Local file not found" }
$LocalSize = (Get-Item $LocalFile).Length
if ($LocalSize -eq 0) { Fail "Local file empty" }
Write-Host "  A. Local: $LocalSize bytes"

# B. Acquire remote flock
Write-Host "  B. Acquiring lock..."
$lockResult = ssh -o ConnectTimeout=10 $RemoteHost "flock -w $LockTimeout $LockFile -c 'echo LOCK_ACQUIRED'" 2>&1
if ($LASTEXITCODE -ne 0) { Fail "Lock timeout or in use" }
Write-Host "     $lockResult"

# C. SCP upload
Write-Host "  C. Uploading..."
scp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 $LocalFile "${RemoteHost}:${RemoteDir}/${TempName}"
if ($LASTEXITCODE -ne 0) {
    ssh -o ConnectTimeout=10 $RemoteHost "flock -u $LockFile" 2>$null
    Fail "SCP failed"
}
Write-Host "     Done."

# D. Remote: validate temp file size > 0
Write-Host "  D. Checking temp size..."
$sizeResult = ssh -o ConnectTimeout=10 $RemoteHost "stat -c%s $RemoteDir/$TempName 2>/dev/null || echo 0" 2>&1
if ([int]$sizeResult -eq 0) {
    ssh -o ConnectTimeout=10 $RemoteHost "rm -f $RemoteDir/$TempName; flock -u $LockFile" 2>$null
    Fail "Temp file empty"
}
Write-Host "     Temp size: $sizeResult"

# E. Remote: openpyxl validate
Write-Host "  E. Validating with openpyxl..."
$pyCode = "import openpyxl,sys; wb=openpyxl.load_workbook('data/$TempName',data_only=True); n=len(wb.sheetnames); wb.close(); print('OK sheets='+str(n))"
$validateResult = ssh -o ConnectTimeout=10 $RemoteHost "cd /opt/wfhdp-bot; .venv/bin/python -c '$pyCode'" 2>&1
if ($LASTEXITCODE -ne 0) {
    ssh -o ConnectTimeout=10 $RemoteHost "rm -f $RemoteDir/$TempName; flock -u $LockFile" 2>$null
    Fail "Validation failed: $validateResult"
}
Write-Host "     $validateResult"

# F. Atomic mv + verify
Write-Host "  F. Atomic replace..."
$replaceResult = ssh -o ConnectTimeout=10 $RemoteHost "cd $RemoteDir; mv -f $TempName '$RemoteFinal'; stat -c%s '$RemoteFinal'" 2>&1
if ($LASTEXITCODE -ne 0) {
    ssh -o ConnectTimeout=10 $RemoteHost "flock -u $LockFile" 2>$null
    Fail "Replace failed"
}
Write-Host "     Replaced. Final size: $replaceResult"

# G. Release lock
Write-Host "  G. Releasing lock..."
ssh -o ConnectTimeout=10 $RemoteHost "flock -u $LockFile" 2>$null
Write-Host "     Released."

# H. Done
$EndTime = Get-Date
$Duration = ($EndTime - $StartTime).TotalSeconds
Write-Host "  H. Sync complete (${Duration}s)"
Write-Host "     Final: $RemoteDir/$RemoteFinal"
exit 0
