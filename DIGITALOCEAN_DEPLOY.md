# DigitalOcean Droplet 部署指南

## 一、服务器要求

- Ubuntu 22.04 / 24.04 LTS
- Python 3.11+ (系统自带)
- 1 vCPU / 1 GB RAM 足够
- 公网 IPv4

## 二、服务器初始化

```bash
# 1. 更新系统
apt update && apt upgrade -y

# 2. 安装依赖
apt install -y python3 python3-pip python3-venv git curl

# 3. 创建项目目录
mkdir -p /opt/ip-risk-bot
cd /opt/ip-risk-bot

# 4. Clone 仓库
git clone https://github.com/ak48-bit/Telegram-bot.git .

# 5. 创建虚拟环境
python3 -m venv .venv
source .venv/bin/activate

# 6. 安装依赖 (stdlib only, 无额外包)
pip install -r requirements.txt

# 7. 退出 venv
deactivate
```

## 三、配置 .env

```bash
# 创建 .env (权限 600)
touch /opt/ip-risk-bot/.env
chmod 600 /opt/ip-risk-bot/.env
```

编辑 `/opt/ip-risk-bot/.env`，填入以下变量：

```
BACKEND_BASE_URL=https://www.wj-safety.com
BACKEND_AUTHORIZATION=<真实值>
BACKEND_COOKIE=<真实值>
BACKEND_MERCHANT=ph90tlbf5
BACKEND_MERCHANT_CODE=ph90tlbf5
BACKEND_ENVIRONMENT=TCG5
BACKEND_PLATFORM=TCG
BACKEND_LANGUAGE=zh_CN
BACKEND_TIMEZONE=Etc/GMT-8
TOP_AGENT=30xsldx
TELEGRAM_BOT_TOKEN=<真实值>
TELEGRAM_ALERT_CHAT_ID=-5344737017
```

> ⚠️ 不要提交 .env 到 Git。文件权限必须 600。

## 四、诊断测试

```bash
cd /opt/ip-risk-bot
source .venv/bin/activate

# 检查环境变量
python backend_client.py env_check

# 获取出口 IP (用于加白)
python backend_client.py outbound_ip

# 完整诊断
python backend_client.py railway_diagnose
```

确认：
- `env_check` 所有变量显示 OK/SET，无 MISSING
- `outbound_ip` 输出 Droplet 公网 IP
- `railway_diagnose` HTTP Headers 显示 User-Agent 存在

## 五、加白 DigitalOcean IP

将 `outbound_ip` 输出的 IP 发给站点负责人：

> 请加白 DigitalOcean Droplet 出口 IP：
>
> **xxx.xxx.xxx.xxx**
>
> 用途：IP 风控审核 Bot 请求后台 API
>
> 请求接口：
> `https://www.wj-safety.com/tac/api/relay/post/crm-advanced-search-search`
>
> 请设置：
> - [ ] Allow (IP Access Rules)
> - [ ] Skip WAF Managed Rules
> - [ ] Skip Bot Fight Mode / Super Bot Fight Mode
> - [ ] Skip Managed Challenge / JS Challenge
> - [ ] Skip Browser Integrity Check
> - [ ] Skip Rate Limiting Rules
>
> 覆盖路径：
> - `/tac/api/*`
> - `/tac/api/relay/post/crm-advanced-search-search`
>
> 如果后台还有 Nginx / WAF / 安全网关，也需要同步放行这个 IP。

## 六、测试后台连接

加白后运行：

```bash
cd /opt/ip-risk-bot
source .venv/bin/activate
python -u backend_client.py today_once
```

- 无 HTTP 403 → 加白成功 ✅
- 仍 HTTP 403 → Cloudflare 未完全放行
- Telegram 收到告警 → 端到端正常

## 七、安装 systemd 服务

```bash
# 复制 service 文件
cp /opt/ip-risk-bot/systemd/ip-risk-bot.service /etc/systemd/system/

# 重新加载 systemd
systemctl daemon-reload

# 启用开机自启
systemctl enable ip-risk-bot

# 启动服务
systemctl start ip-risk-bot

# 检查状态
systemctl status ip-risk-bot --no-pager

# 查看日志
journalctl -u ip-risk-bot -f
```

## 八、日常运维

| 命令 | 用途 |
|---|---|
| `systemctl status ip-risk-bot` | 查看服务状态 |
| `journalctl -u ip-risk-bot -f` | 实时日志 |
| `journalctl -u ip-risk-bot --since "1 hour ago"` | 最近 1 小时日志 |
| `systemctl restart ip-risk-bot` | 重启服务 |
| `systemctl stop ip-risk-bot` | 停止服务 |

### 更新代码

```bash
cd /opt/ip-risk-bot
git pull origin master
systemctl restart ip-risk-bot
```

### 更新 .env (Token 过期)

```bash
vi /opt/ip-risk-bot/.env
systemctl restart ip-risk-bot
```

## 九、安全注意事项

- `.env` 权限 `600`，仅 root 可读
- 日志不包含完整 Token/Cookie (代码已保证)
- systemd 服务使用 `PrivateTmp=yes` 和 `NoNewPrivileges=yes`
- 不暴露任何 HTTP 端口
- 仅对外请求后台 API 和 Telegram API

## 十、故障排查

| 症状 | 检查 |
|---|---|
| 服务无法启动 | `journalctl -u ip-risk-bot -n 50` |
| HTTP 403 | 确认 IP 已加白 |
| INVALID_TOKEN | 更新 .env 中的 Token/Cookie |
| Telegram 不发送 | `python backend_client.py debug_chat` |
| 连续重启 | 检查 .env 是否存在且权限 600 |
