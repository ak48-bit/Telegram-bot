# Push API 集成文档

## 概述

站点后台主动推送玩家/IP 数据到 IP 风控 Bot，Bot 被动接收并分析风险后通过 Telegram 告警。

**优点：** 后台发起请求，绕过 Cloudflare 对 Bot 出口 IP 的拦截。

## 推送地址

```
POST https://<railway-domain>/risk-data/push
```

（Railway 部署后会在 Dashboard 显示实际域名）

## Headers

| Header | 必填 | 说明 |
|---|---|---|
| `Content-Type` | ✅ | `application/json` |
| `X-Risk-Bot-Token` | ✅ | 鉴权密钥（由 Bot 管理员提供） |

## Request Body

```json
{
  "source": "wj-safety",
  "site": "PH90",
  "top_agent": "30xsldx",
  "date": "2026-06-27",
  "timezone": "GMT+8",
  "players": [
    {
      "player_account": "PLAYER001",
      "register_ip": "1.2.3.4",
      "login_ip": "1.2.3.4",
      "agent": "AGENT001",
      "top_agent": "30xsldx",
      "register_time": "2026-06-27 10:20:00",
      "last_login_time": "2026-06-27 10:30:00",
      "device": "Android",
      "mobile": "",
      "bank_card": "",
      "withdraw_account": "",
      "payment_account": ""
    }
  ]
}
```

### 字段说明

| 字段 | 必填 | 说明 | 别名 |
|---|---|---|---|
| `source` | ✅ | 数据来源标识 | — |
| `site` | ✅ | 站点代码 | — |
| `top_agent` | ✅ | 总代名称 | — |
| `date` | ✅ | 数据日期 | — |
| `players` | ✅ | 玩家数组（最多 5000 条） | — |
| `player_account` | ✅ | 玩家账号名 | `player`, `username` |
| `register_ip` | 建议 | 注册 IP | `registerIp`, `reg_ip` |
| `login_ip` | 建议 | 上次登录 IP | `loginIp`, `last_login_ip` |
| `agent` | 建议 | 直属代理名 | `parent_agent`, `direct_agent` |
| `register_time` | 建议 | 注册时间 | — |
| `last_login_time` | 建议 | 上次登录时间 | — |
| `device` | 选填 | 设备信息 | `lastDevice`, `device_id` |
| `mobile` | 选填 | 手机号 | — |
| `bank_card` | 选填 | 银行卡号 | — |
| `withdraw_account` | 选填 | 提款账户 | — |
| `payment_account` | 选填 | 支付账户 | — |

## Response

### 成功 (200)

```json
{
  "ok": true,
  "players_received": 100,
  "risk_cases_found": 3,
  "telegram_sent": 2,
  "telegram_skipped_duplicate": 1
}
```

### 错误

| 状态码 | 含义 |
|---|---|
| 400 | Body 格式错误 / players 非数组 / 超过 5000 条 |
| 401 | 缺少 `X-Risk-Bot-Token` Header |
| 403 | Token 错误 |
| 404 | 路径错误 |
| 500 | 服务器未配置 `PUSH_API_TOKEN` |

## 风险检测规则

| 规则 | 说明 | 阈值 |
|---|---|---|
| PUSH_SAME_REGISTER_IP | 同注册 IP | ≥2 LOW, ≥3 MEDIUM, ≥6 HIGH |
| PUSH_SAME_LOGIN_IP | 同登录 IP | 同上 |
| PUSH_SAME_DEVICE | 同设备 | 同上 |
| PUSH_SAME_MOBILE | 同手机号 | 同上 |
| PUSH_SAME_BANK_CARD | 同银行卡 | 同上 |
| PUSH_SAME_WITHDRAW | 同提款账户 | 同上 |
| PUSH_SAME_PAYMENT | 同支付账户 | 同上 |

重复案件不会重复发送 Telegram（由 `sent_risk_cases.json` 控制）。

## 推送频率建议

- 每 1–5 分钟推送一次今日新增注册玩家
- 或每次有新注册玩家时实时推送
- 同一批次内的玩家尽量打包（减少 HTTP 请求次数）

## 失败重试

- 如果返回非 200，1 分钟后重试
- 最多重试 3 次
- 单条推送失败不要阻塞后续推送

## 安全要求

- `X-Risk-Bot-Token` 由 Bot 管理员生成并私下提供给后台开发
- Token 不要写在公开代码或日志中
- 建议定期更换 Token
- 推送数据不包含明文密码
