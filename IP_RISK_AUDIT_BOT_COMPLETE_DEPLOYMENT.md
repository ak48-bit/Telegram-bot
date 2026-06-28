# IP Risk Audit Bot — 实时同 IP 风控机器人 完整部署文档

> **项目名称：** IP Risk Audit Bot  
> **版本：** Lite / 同 IP 风控版本  
> **最后更新：** 2026-06-28  
> **当前 Commit：** `7fef3a9`  
> **Repo：** `ak48-bit/Telegram-bot` (Private)

---

## 目录

1. [项目说明](#1-项目说明)
2. [当前生产架构](#2-当前生产架构)
3. [核心运行流程](#3-核心运行流程)
4. [当前风险规则](#4-当前风险规则)
5. [文件说明](#5-文件说明)
6. [环境变量说明](#6-环境变量说明)
7. [DigitalOcean 部署说明](#7-digitalocean-部署说明)
8. [日常运维命令](#8-日常运维命令)
9. [更新代码流程](#9-更新代码流程)
10. [回滚流程](#10-回滚流程)
11. [Railway 说明](#11-railway-说明)
12. [Render 说明](#12-render-说明)
13. [安全注意事项](#13-安全注意事项)
14. [当前已验证结果](#14-当前已验证结果)
15. [后续优化方向](#15-后续优化方向)

---

## 1. 项目说明

### 用途

实时监控指定总代（30xsldx）下当日注册的玩家，对比玩家与直属上级代理的 IP 地址，发现同 IP 注册/登录风险后通过 Telegram 告警通知审核人员。

### 与 Telegram 推广 Bot 的区别

| | IP Risk Audit Bot (本项目) | Telegram 推广 Bot (telegram-bot-v2) |
|---|---|---|
| 用途 | 风控审核 | 代理推广 / 玩家绑定 |
| 监控对象 | 玩家 & 代理 IP | 推广链接 / 邀请关系 |
| Telegram 群 | 审核IP | 推广群 |
| Bot 名称 | IP审核 | PH90WFH_Bonus_bot |
| 运行命令 | `backend_client.py today_scheduler` | 独立项目 |
| 冻结功能 | DISABLED | N/A |

### 版本说明

- **当前版本：** Lite / 同 IP 风控版
- 仅对比 IP 地址（注册 IP + 登录 IP）
- 设备/手机/银行卡/提款账户字段已预留，等待站点后台集成
- 不包含自动冻结功能

---

## 2. 当前生产架构

```
DigitalOcean Droplet (168.144.135.25)
│
├── /opt/ip-risk-bot/
│   ├── backend_client.py          ← 主程序
│   ├── .env                        ← 敏感配置 (chmod 600)
│   ├── risk_cases_latest.json      ← 最新风险案件
│   ├── sent_risk_cases.json        ← 去重指纹
│   └── direct_agents_cache.json    ← 代理缓存
│
├── systemd: ip-risk-bot.service
│   └── python -u backend_client.py today_scheduler  (主运行)
│
├── Railway (web)                   ← push_server 备用
│   └── python -u backend_client.py push_server
│
└── Render (ip-risk-audit-worker)   ← 已暂停 ❌
```

**重要规则：**
- ✅ DigitalOcean 为主运行（today_scheduler）
- ✅ Railway 仅作为 push_server 备用
- ❌ Render 已暂停，不要恢复
- ❌ 不允许多个 today_scheduler 同时运行（会导致重复告警和 API 冲突）

---

## 3. 核心运行流程

```
每 60 秒一次循环:

1. 查询今日注册账号 (GMT+8 00:00:00 → 23:59:59)
   ├── subordinateName = TOP_AGENT = 30xsldx
   └── registrationStartTime / registrationEndTime (UTC 格式)

2. 分离玩家 (customerType=0) 和代理 (customerType=1)

3. 补查缺失直属上级代理
   ├── 优先从 direct_agents_cache.json 读取 (缓存命中)
   └── 缓存未命中则 API 单条查询 → 写入缓存

4. IP 风控对比 (4 规则)
   ├── RULE_A: 玩家 login_ip  vs 代理 last_login_ip
   ├── RULE_B: 玩家 reg_ip    vs 代理 reg_ip
   ├── RULE_C: 玩家 login_ip  vs 代理 reg_ip
   └── RULE_D: 玩家 reg_ip    vs 代理 last_login_ip

5. 命中 → 保存 risk_cases_latest.json (+ 时间戳副本)

6. Telegram 告警
   ├── 检查 sent_risk_cases.json (去重)
   ├── 新案件 → 发送 Telegram
   └── 已发送 → skip

7. 等待 60s → 下一轮
```

---

## 4. 当前风险规则

| 规则 | 等级 | 说明 |
|---|---|---|
| RULE_A | 🔴 HIGH | 玩家上次登录 IP == 直属上级代理上次登录 IP |
| RULE_B | 🔴 HIGH | 玩家注册 IP == 直属上级代理注册 IP |
| RULE_C | 🟡 MEDIUM | 玩家上次登录 IP == 直属上级代理注册 IP |
| RULE_D | 🟡 MEDIUM | 玩家注册 IP == 直属上级代理上次登录 IP |

- HIGH: 至少命中 RULE_A 或 RULE_B
- MEDIUM: 仅命中 RULE_C 或 RULE_D（且未命中 HIGH）

**⚠️ 禁止事项：**
- ❌ 不要启用 freeze / 自动冻结
- ❌ 不要修改风险判定逻辑
- ❌ 不要修改去重逻辑（sent_risk_cases.json）
- ❌ 不要修改 Telegram 告警格式（除非明确要求）

---

## 5. 文件说明

| 文件 | 用途 | Git | 生产环境 |
|---|---|---|---|
| `backend_client.py` | 主程序 (2000+ 行) | ✅ | /opt/ip-risk-bot/ |
| `requirements.txt` | Python 依赖 (空 — stdlib only) | ✅ | /opt/ip-risk-bot/ |
| `railway.json` | Railway 部署配置 (push_server) | ✅ | — |
| `systemd/ip-risk-bot.service` | systemd 服务定义 | ✅ | /etc/systemd/system/ |
| `.env` | 敏感配置 (BACKEND_*, TELEGRAM_*, TOP_AGENT) | ❌ | /opt/ip-risk-bot/ (chmod 600) |
| `risk_cases_latest.json` | 最新风险案件 (每次覆盖) | ❌ | /opt/ip-risk-bot/ |
| `risk_cases_YYYYMMDD_HHMMSS.json` | 时间戳历史副本 | ❌ | /opt/ip-risk-bot/ |
| `sent_risk_cases.json` | 已发送案件去重指纹 | ❌ | /opt/ip-risk-bot/ |
| `direct_agents_cache.json` | 直属代理缓存 | ❌ | /opt/ip-risk-bot/ |
| `DIGITALOCEAN_DEPLOY.md` | DO 部署指南 | ✅ | — |
| `RAILWAY_DEPLOY.md` | Railway 部署指南 | ✅ | — |
| `RENDER_DEPLOY.md` | Render 部署指南 (存档) | ✅ | — |
| `PUSH_API_INTEGRATION.md` | Push API 集成文档 | ✅ | — |
| `README_RUN.md` | 运行手册 | ✅ | — |
| `config.json` | 旧推送配置 (不相关) | ✅ | — |

---

## 6. 环境变量说明

> ⚠️ 以下仅列出变量名和用途。**真实值不在此文档中**，存储在服务器的 `/opt/ip-risk-bot/.env` (chmod 600)。

### 后台 API 相关

| 变量 | 用途 |
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

### 风控相关

| 变量 | 用途 |
|---|---|
| `TOP_AGENT` | 目标总代名称 (30xsldx) |

### Telegram 告警

| 变量 | 用途 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_ALERT_CHAT_ID` | 告警群 chat_id |

### Push 模式

| 变量 | 用途 |
|---|---|
| `PUSH_API_TOKEN` | Push API 鉴权密钥 |

### 可选

| 变量 | 用途 |
|---|---|
| `UPTIMEROBOT_HEARTBEAT_URL` | 健康监控回调 |

---

## 7. DigitalOcean 部署说明

### 7.1 服务器初始化

```bash
# SSH 登录
ssh root@168.144.135.25

# 更新系统
apt update && apt upgrade -y

# 安装依赖
apt install -y python3 python3-pip python3-venv git curl

# 创建项目目录
mkdir -p /opt/ip-risk-bot
cd /opt/ip-risk-bot
```

### 7.2 Clone 代码

```bash
git clone https://github.com/ak48-bit/Telegram-bot.git /opt/ip-risk-bot
```

> 如果 repo 是 Private，参考 DigitalOcean 部署文档中的 Token 方案。

### 7.3 Python 虚拟环境

```bash
cd /opt/ip-risk-bot
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
deactivate
```

### 7.4 配置 .env

```bash
touch /opt/ip-risk-bot/.env
chmod 600 /opt/ip-risk-bot/.env
vi /opt/ip-risk-bot/.env
```

填入第 6 节列出的环境变量。

### 7.5 诊断测试

```bash
cd /opt/ip-risk-bot
source .venv/bin/activate

# 检查环境变量
python backend_client.py env_check

# 获取出口 IP (用于加白)
python backend_client.py outbound_ip

# 测试单次扫描
python backend_client.py today_once
```

### 7.6 systemd 服务

```bash
cp /opt/ip-risk-bot/systemd/ip-risk-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ip-risk-bot
systemctl start ip-risk-bot
systemctl status ip-risk-bot --no-pager
```

---

## 8. 日常运维命令

```bash
# SSH 登录
ssh root@168.144.135.25

# 查看服务状态
systemctl status ip-risk-bot --no-pager

# 查看最近日志
journalctl -u ip-risk-bot -n 80 --no-pager

# 实时日志
journalctl -u ip-risk-bot -f

# 查看最近 1 小时日志
journalctl -u ip-risk-bot --since "1 hour ago"

# 重启服务
systemctl restart ip-risk-bot

# 停止服务
systemctl stop ip-risk-bot

# 启动服务
systemctl start ip-risk-bot
```

---

## 9. 更新代码流程

```bash
ssh root@168.144.135.25
cd /opt/ip-risk-bot
git pull
systemctl restart ip-risk-bot
systemctl status ip-risk-bot --no-pager
journalctl -u ip-risk-bot -n 80 --no-pager
```

---

## 10. 回滚流程

```bash
ssh root@168.144.135.25
cd /opt/ip-risk-bot
git log --oneline -10
git checkout <commit-hash>
systemctl restart ip-risk-bot
systemctl status ip-risk-bot --no-pager
```

回滚后如需恢复最新版本：
```bash
git checkout master
systemctl restart ip-risk-bot
```

---

## 11. Railway 说明

- **Railway 服务名：** web
- **当前用途：** push_server 备用（被动接收后台推送）
- **Start Command：** `python -u backend_client.py push_server`
- **所需环境变量：** `PUSH_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`

**⚠️ 重要：**
- ❌ 不允许 Railway 跑 `today_scheduler`
- ❌ 如发现 Railway 在跑 today_scheduler，必须暂停或改为 push_server
- ✅ push_server 模式不主动请求后台 API（不会触发 Cloudflare 403）

---

## 12. Render 说明

- **Render 服务名：** ip-risk-audit-worker
- **状态：** ❌ 已暂停
- **原因：** Railway 出口 IP 被 Cloudflare 拦截，迁移到 DigitalOcean

**⚠️ 重要：**
- ❌ 不要恢复 Render worker
- ❌ Render 与 DigitalOcean 同时运行会导致重复告警
- ❌ telegram-bot-v2 (Render 上的另一个服务) 不属于本项目，不要操作

---

## 13. 安全注意事项

### 禁止事项

| ❌ 禁止 | 原因 |
|---|---|
| 提交 .env 到 Git | 包含 Token / Cookie / Bot Token |
| 截图 .env | 敏感信息泄露 |
| 输出 TELEGRAM_BOT_TOKEN | Telegram Bot 控制权 |
| 输出 BACKEND_AUTHORIZATION | 后台鉴权泄露 |
| 输出 BACKEND_COOKIE | 后台会话泄露 |
| 输出 PUSH_API_TOKEN | Push API 鉴权泄露 |

### 文件保护

| 文件 | 保护 |
|---|---|
| `.env` | chmod 600, .gitignore 排除 |
| `sent_risk_cases.json` | 去重文件, 不要随意删除 |
| `direct_agents_cache.json` | 代理缓存, 不要随意删除 |
| `risk_cases_latest.json` | 运行时数据, .gitignore 排除 |

### Token 安全

- 如果 Token 曾经在聊天/日志/截图/commit 中暴露，上线前需要重新生成
- 定期轮换 BACKEND_AUTHORIZATION 和 BACKEND_COOKIE
- Bot Token 可通过 @BotFather 重新生成

### 功能安全

- ❌ **freeze / 自动冻结功能为 DISABLED**，不要启用
- ❌ 不要修改 `sent_risk_cases.json` 去重逻辑
- ❌ 不要修改 IP 风控规则（RULE_A/B/C/D）
- ❌ 不要修改 Telegram 告警格式

---

## 14. 当前已验证结果

**服务器：** DigitalOcean `168.144.135.25`  
**运行状态：** ✅ 正常运行

| 指标 | Run #27 实际值 |
|---|---|
| 系统状态 | systemctl active running |
| 扫描页数 | 2 |
| 总记录数 | 188 |
| 玩家数 | 180 |
| 代理数 | 62 |
| 缺失上级代理 | 0 |
| risk_cases | 1 |
| already_sent skip | 1 |
| to_send | 0 |
| sent | 0 |
| failed | 0 |
| 连续错误次数 | 0 |
| 下一轮等待 | 60s |

### 已验证功能

- [x] PowerShell SSH 正常登录
- [x] systemctl 显示 active running
- [x] today_scheduler 持续运行
- [x] 代理补查正常 (缓存命中率高)
- [x] IP 风控正常
- [x] Telegram 告警正常
- [x] 去重正常 (重复案件不发送)
- [x] 不冻结提款 (freeze: DISABLED)

---

## 15. 后续优化方向

### 短期 (数据补充)

- [ ] 补充设备 ID / Device ID 接口 — 自动对比同设备玩家
- [ ] 补充手机号接口 — 自动对比同手机号玩家
- [ ] 补充银行卡/提款账户接口 — 自动对比同账户玩家
- [ ] 优化 enrichment 字段 — 从 null 变为实际对比结果

### 中期 (告警优化)

- [ ] 每日汇总报告 — 每天固定时间推送风险统计
- [ ] 风险等级细化 — 支持更多维度评分
- [ ] 代理线风险趋势 — 按代理线展示风险变化

### 长期 (运维增强)

- [ ] 健康检查通知 — 服务异常时主动告警
- [ ] 自动重试机制 — 后台 API 临时故障时自动恢复
- [ ] 部署回滚说明 — 完善回滚文档
- [ ] Docker 化 — 简化环境依赖

---

> **文档维护：** 每次架构/配置变更后请同步更新此文档。  
> **安全提醒：** 此文档不含任何真实 Token / Cookie / Password，可安全提交 Git。
