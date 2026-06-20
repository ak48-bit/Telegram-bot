# PH90 WFH Bot v1.2 — 转发绑定简化版

> Release: 2026-06-20 | Final Commit: `ab7b7ca` | Base: v1.1 (`32d830b`)

---

## 新增功能

### 转发式绑定卡片
- `/add_agent` 返回两张卡片：Admin 确认卡 + Agent 绑定卡（可直接转发给 Agent）
- `/add_promoter` 返回两张卡片：Agent 确认卡 + Promoter 绑定卡（可直接转发给 Promoter）
- 绑定卡包含：Code/Name/Bind Link/Manual command/URL button

### 双向绑定通知
- Agent 绑定成功后 → Admin 收到通知
- Promoter 绑定成功后 → Agent 收到通知

### 跨绑定检查
- 已绑定 Agent 的 TG 不能绑定另一个 Agent
- 已绑定 Promoter 的 TG 不能绑定另一个 Promoter
- 提前返回明确提示，不再触发 system error

### 绑定指导文案
- 新用户：点击 Bind Agent/Bind Promoter URL button
- 旧用户（已和 Bot 说过话）：复制 Manual command 发送给 Bot

---

## 真实测试通过 (13 项)

1. Admin 创建 Agent，收到两张卡片 ✅
2. Agent Binding Card 可转发 ✅
3. Agent Manual command 绑定 TestA01 ✅
4. Admin 收到 Agent Binding Completed ✅
5. Agent 创建 Promoter，收到两张卡片 ✅
6. Promoter Binding Card 可转发 ✅
7. Promoter 成功绑定 ✅
8. Agent 收到 Promoter Binding Completed ✅
9. Promoter 看到 Player Affiliate Link ✅
10. Promoter 看到 p_B01 Bot Share Link ✅
11. Player 通过 p_B01 进入并提交 TESTPLAYER001 ✅
12. system error 已修复 ✅
13. 跨绑定检查已增加 ✅

---

## 保留 v1.1 能力
- p_A01/p_B01/p_C001 短链接
- Game ID submitted 记录模式 (^[A-Za-z0-9]{3,32}$)
- bind_agent/bind_promoter 72h 一次性 SHA-256 hash
- legacy p_random_token 兼容
- Admin/Agent/Promoter/Player 权限隔离
