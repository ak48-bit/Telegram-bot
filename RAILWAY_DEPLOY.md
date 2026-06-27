# Railway Pro 部署指南

## 一、为什么用 Railway Pro

- **Static Outbound IP** — 固定出口 IP，可加入后台白名单，避免 Cloudflare/WAF 拦截
- 24 小时运行 Background Worker
- GitHub Push 自动部署
- Environment Variables 面板配置（不依赖 .env 文件）
- 内置 Logs 面板
- 崩溃自动重启

## 二、创建项目

1. 打开 [Railway Dashboard](https://railway.app/dashboard)
2. **New Project** → **Deploy from GitHub repo**
3. 选择仓库：`ak48-bit/Telegram-bot`
4. Railway 会自动检测 `railway.json`，Start Command 已预设为：
   ```
   python -u backend_client.py today_scheduler
   ```
   （如果没有 `railway.json`，在 Service → Settings 手动填写 Start Command）

## 三、Environment Variables

在 Railway Dashboard → Service → Variables 中添加以下 12 个变量：

| Key | 说明 |
|---|---|
| `BACKEND_BASE_URL` | 后台域名 |
| `BACKEND_AUTHORIZATION` | 后台鉴权 Token |
| `BACKEND_COOKIE` | 后台 Cookie |
| `BACKEND_MERCHANT` | 商户代码 |
| `BACKEND_MERCHANT_CODE` | 商户代码 |
| `BACKEND_ENVIRONMENT` | 环境标识 |
| `BACKEND_PLATFORM` | 平台标识 |
| `BACKEND_LANGUAGE` | 语言 |
| `BACKEND_TIMEZONE` | 时区 |
| `TOP_AGENT` | 目标总代名称 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_ALERT_CHAT_ID` | 告警群 chat_id |

可选：

| Key | 说明 |
|---|---|
| `UPTIMEROBOT_HEARTBEAT_URL` | 健康监控回调 URL |

> ⚠️ Authorization / Cookie / Bot Token 只填到 Railway Variables，不要写入任何文件。

## 四、Static Outbound IP 配置

1. Railway Dashboard → 选择 Service
2. **Settings** → **Networking**
3. **Static Outbound IP** → **Enable**
4. 复制显示的固定出口 IP 地址
5. 在 Railway 命令行运行：
   ```
   python backend_client.py outbound_ip
   ```
   确认输出的 IP 与 Static Outbound IP 一致。

## 五、发给站点负责人的加白说明

> 请加白 Railway Static Outbound IP：
>
> **xxx.xxx.xxx.xxx**
>
> 用途：IP 风控审核 Bot 请求后台 API
>
> 需要放行的路径：
> - `/tac/api/*`
> - `POST /tac/api/relay/post/crm-advanced-search-search`
>
> 请确认以下设置：
> - [ ] Allow
> - [ ] Skip WAF
> - [ ] Skip Bot Fight Mode
> - [ ] Skip Managed Challenge
> - [ ] Skip Browser Integrity Check

## 六、部署后验证

### 6.1 环境变量检查
在 Railway 命令行运行：
```
python backend_client.py env_check
```
确认所有变量显示 `OK` 或 `SET`，没有 `MISSING`。

### 6.2 出口 IP 检查
```
python backend_client.py outbound_ip
```
确认输出的 IP 与 Railway Static Outbound IP 一致。

### 6.3 正常运行日志
```
Running 'python -u backend_client.py today_scheduler'
⏱️  Today Scheduler — 持续运行
🔄 Today Scheduler Run #1
📖 今日注册扫描 (GMT+8 ...)
  Page   1/10: records=...
✅ 无 risk_cases，不发送 Telegram。
  ⏳ 下一轮等待: 60s
```

### 6.4 常见异常日志

| 异常 | 原因 | 解决 |
|---|---|---|
| `HTTP 403` / Cloudflare 页面 | IP 未加白 | 联系站点负责人加白 |
| `INVALID_TOKEN` / `Unauthorized` | Token 过期 | 更新 BACKEND_AUTHORIZATION 和 BACKEND_COOKIE |
| `Telegram HTTP 400: chat not found` | Bot 不在群或 chat_id 错误 | 运行 `debug_chat` 确认 |
| `HTTP 5xx` | 后台服务异常 | 等待恢复，Bot 会自动重试 |

## 七、从 Render 迁移注意事项

- Railway 部署成功后，先观察 1-2 小时确认稳定
- 确认 Telegram 群正常收到告警
- 暂时不要删除 Render 服务（保留作为备份）
- 两个服务不要同时运行（会导致重复告警）
- 迁移完成后可以 stop Render worker

## 八、相关文件

| 文件 | 用途 |
|---|---|
| `railway.json` | Railway 部署配置 |
| `RAILWAY_DEPLOY.md` | 本文档 |
| `RENDER_DEPLOY.md` | Render 部署说明（备用） |
| `backend_client.py` | 主程序 |
| `requirements.txt` | 空依赖（stdlib only） |
