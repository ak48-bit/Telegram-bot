# IP 风控审核 Bot — 运行手册

## 项目用途

自动扫描后台指定总代（30xsldx）下的今日注册玩家，对比玩家与直属上级代理的 IP 地址，发现同 IP 注册/登录风险后通过 Telegram 告警通知审核人员。

## 环境要求

- Python 3.8+
- 标准库即可，无需额外 pip install（使用 urllib）

## .env 配置

在项目根目录创建 `.env` 文件，格式如下：

```
BACKEND_BASE_URL=https://www.wj-safety.com
BACKEND_AUTHORIZATION=<你的 authorization>
BACKEND_COOKIE=<你的 cookie>
BACKEND_MERCHANT=ph90tlbf5
BACKEND_MERCHANT_CODE=ph90tlbf5
BACKEND_ENVIRONMENT=TCG5
BACKEND_PLATFORM=TCG
BACKEND_LANGUAGE=zh_CN
BACKEND_TIMEZONE=Etc/GMT-8
TOP_AGENT=30xsldx
TELEGRAM_BOT_TOKEN=<你的 Bot Token>
TELEGRAM_ALERT_CHAT_ID=<目标群 chat_id>
```

> ⚠️ 不要提交 `.env` 到 Git。Authorization / Cookie / Bot Token 均为敏感信息。

| 变量 | 说明 | 从哪里获取 |
|---|---|---|
| `BACKEND_BASE_URL` | 后台域名 | 固定 |
| `BACKEND_AUTHORIZATION` | 后台鉴权 Token | 浏览器 F12 → Network → Request Headers |
| `BACKEND_COOKIE` | 后台 Cookie | 同上 |
| `BACKEND_MERCHANT` | 商户代码 | 后台配置 |
| `TOP_AGENT` | 目标总代账号 | 本部门监控的总代名称 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token | @BotFather 创建 |
| `TELEGRAM_ALERT_CHAT_ID` | 告警群 chat_id | 运行 `debug_chat` 获取 |

## 启动命令

| 命令 | 用途 | 运行方式 |
|---|---|---|
| `python backend_client.py` | 默认 = once | 单次 |
| `python backend_client.py once` | 全量 10 页扫描 + 风控 | 手动 |
| `python backend_client.py today_once` | 今日注册扫描 | 手动 |
| `python backend_client.py yesterday_once` | 昨日注册扫描 | 手动 |
| `python backend_client.py today_scheduler` | **正式持续运行** | 后台长期 |
| `python backend_client.py today_scheduler_test` | 测试 5轮×60s | 测试 |
| `python backend_client.py scheduler_test` | 全量 3轮×300s | 测试 |
| `python backend_client.py debug_chat` | 查 Telegram chat_id | 调试 |

### 正式部署命令

```powershell
python backend_client.py today_scheduler
```

- 每 60 秒扫描今日注册数据
- 自动补查缺失的上级代理（缓存到 `direct_agents_cache.json`）
- 发现风险 → Telegram 告警（已发送的不重复）
- 跨凌晨自动切换日期
- 连续失败 5 次自动停止
- Ctrl+C 安全退出

## 各模式说明

| 模式 | 扫描范围 | 循环 | 适用场景 |
|---|---|---|---|
| `once` | 10页×100=1000条（全量最新） | 否 | 手动检查 |
| `today_once` | 今日注册（GMT+8） | 否 | 手动检查今天 |
| `yesterday_once` | 昨日注册 | 否 | 手动补查昨天 |
| `today_scheduler` | 今日注册，每60s | 是 | **正式运行** |
| `today_scheduler_test` | 今日注册，5轮×60s | 是 | 部署前测试 |

## 输出文件说明

| 文件 | 用途 | 是否提交 Git |
|---|---|---|
| `.env` | 敏感配置 | ❌ 不提交 |
| `risk_cases_latest.json` | 最新风险案件（每次覆盖） | ❌ |
| `risk_cases_YYYYMMDD_HHMMSS.json` | 带时间戳的历史案件副本 | ❌ |
| `sent_risk_cases.json` | 已发送案件的指纹（防重复） | ❌ |
| `direct_agents_cache.json` | 直属上级代理缓存（减少 API 请求） | ❌ |

## Telegram 告警说明

- Bot 名称：IP审核
- 告警群：「审核IP」
- 每个风险玩家发送一条消息
- 同 IP 的其他玩家也会列出（最多 10 个）
- 已发送过的案件不会重复发送（由 `sent_risk_cases.json` 控制）

### 更换群组

1. 把 Bot 拉入新群并设为 admin
2. 在群里发一条消息
3. 运行 `python backend_client.py debug_chat`
4. 把输出的 `TELEGRAM_ALERT_CHAT_ID` 更新到 `.env`

### 更换 Bot Token

1. @BotFather 创建新 Bot
2. 更新 `.env` 中的 `TELEGRAM_BOT_TOKEN`
3. 把新 Bot 拉入告警群
4. 运行 `python backend_client.py debug_chat` 确认

## IP 风控规则

| 规则 | 等级 | 说明 |
|---|---|---|
| RULE_A | HIGH | 玩家上次登录IP == 上级代理上次登录IP |
| RULE_B | HIGH | 玩家注册IP == 上级代理注册IP |
| RULE_C | MEDIUM | 玩家登录IP == 上级代理注册IP |
| RULE_D | MEDIUM | 玩家注册IP == 上级代理登录IP |

## 如何停止程序

- 正式运行：按 `Ctrl+C` 安全退出
- Windows 计划任务：在任务管理器中停止
- 测试模式：自动停止（run 满后）

## 常见问题

### Q: Telegram 发送失败 "chat not found"
A: Bot 没有加入目标群，或 chat_id 不正确。运行 `debug_chat` 获取正确的 chat_id。

### Q: "INVALID_TOKEN" 错误
A: Authorization 或 Cookie 过期。重新从浏览器 F12 获取最新值，更新 `.env`。

### Q: 代理补查失败
A: 网络问题或 API 限流。检查网络，等待后重试。缓存文件会保留已成功的代理。

### Q: 没有任何风险案件
A: 正常现象。只有玩家和代理 IP 匹配时才触发告警。不代表程序有问题。
