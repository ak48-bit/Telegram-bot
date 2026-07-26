# Bot Watchdog — monitors heartbeat and auto-restarts bot if it dies
# Telegram alert on restart

if (-not $env:TELEGRAM_BOT_TOKEN) {
    throw "TELEGRAM_BOT_TOKEN is not configured"
}
if (-not $env:TELEGRAM_CHAT_ID) {
    throw "TELEGRAM_CHAT_ID is not configured"
}
$TOKEN = $env:TELEGRAM_BOT_TOKEN
$CHAT_ID = $env:TELEGRAM_CHAT_ID
$HEARTBEAT_FILE = [System.IO.Path]::GetTempPath() + "bot_heartbeat.txt"
$BOT_DIR = "C:\Users\ak481\OneDrive\Desktop\ak 线上办公部门skills建议和调用"

$STALE_MINUTES = 10
$CHECK_INTERVAL = 300  # 5 minutes

Write-Host "Bot Watchdog started. Checking heartbeat every $($CHECK_INTERVAL/60) min..."

function Send-TelegramAlert($message) {
    try {
        $body = @{chat_id = $CHAT_ID; text = $message} | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "https://api.telegram.org/bot$TOKEN/sendMessage" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10 | Out-Null
    } catch {
        Write-Host "Alert send failed: $_"
    }
}

function Start-Bot {
    try {
        # Kill any stale bot processes first
        Get-Process -Name "python*" -ErrorAction SilentlyContinue | ForEach-Object {
            $cmd = (Get-WmiObject Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine
            if ($cmd -match "bot_listener") {
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
                Write-Host "Killed stale bot process PID $($_.Id)"
            }
        }
        Start-Sleep -Seconds 2

        # Start new bot instance
        Start-Process -WindowStyle Hidden -FilePath "pythonw" -ArgumentList "bot_listener.py" -WorkingDirectory $BOT_DIR
        Write-Host "Bot started at $(Get-Date)"
        return $true
    } catch {
        Write-Host "Failed to start bot: $_"
        return $false
    }
}

while ($true) {
    try {
        $stale = $true
        if (Test-Path $HEARTBEAT_FILE) {
            $hb = Get-Content $HEARTBEAT_FILE -Raw
            if ($hb) {
                $hbTime = [datetime]::Parse($hb.Trim())
                $age = [datetime]::Now - $hbTime
                if ($age.TotalMinutes -lt $STALE_MINUTES) {
                    $stale = $false
                    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Heartbeat OK (${age}s ago)"
                }
            }
        }

        if ($stale) {
            $alert = "⚠️ Bot 掉线警告！`n心跳超过 ${STALE_MINUTES} 分钟未更新`n正在尝试自动重启..."
            Write-Host $alert
            Send-TelegramAlert $alert

            if (Start-Bot) {
                Send-TelegramAlert "✅ Bot 已自动重启"
            } else {
                Send-TelegramAlert "❌ Bot 自动重启失败，请手动检查"
            }
        }
    } catch {
        Write-Host "Watchdog error: $_"
    }

    Start-Sleep -Seconds $CHECK_INTERVAL
}
