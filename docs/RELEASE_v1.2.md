# PH90 WFH Bot v1.2 — 简化操作版

> Release: 2026-06-19 | UX Commit: `8b691c2` | Base: v1.1 (`32d830b`)

---

## 新增内容

- Agent 绑定成功后显示 **Next Step** 和操作按钮（Add Promoter / My Promoters / My Players / Agent Panel）
- Agent 已绑定时也显示下一步操作按钮
- Promoter 绑定成功后**直接显示 `p_B01_<PromoterCode>` Bot Share Link**
- Promoter 已绑定时也显示 `p_B01_<PromoterCode>` Bot Share Link
- Promoter 绑定成功后可一键 Share / My Links / My Players / Today
- 减少人员记忆 `/命令` 的成本
- 优化 Admin → Agent → Promoter → Player 交接流程

---

## 保留 v1.1 能力

- Promoter 短链接：`p_B01_<PromoterCode>`
- Player 分享短链接：`p_C001_<PlayerShareCode>`
- Agent 展示入口：`p_A01_<AgentCode>`
- Game ID submitted 记录模式
- Game ID 规则：`^[A-Za-z0-9]{3,32}$`
- bind_agent / bind_promoter 仍是长 token、72 小时、一次性
- legacy `p_<random_token>` 兼容
- Admin / Agent / Promoter / Player 权限隔离

---

## 测试结果

```
✅ UX FLOW SIMPLIFIED
✅ AGENT BIND SUCCESS CARD
✅ PROMOTER BIND SUCCESS CARD
✅ PROMOTER ALREADY BOUND CARD
✅ AGENT ALREADY BOUND CARD
✅ UX FLOW TEST PASSED 3/3
```

---

## 部署后人工测试

- [ ] Admin /add_agent 后确认 Agent 创建成功卡片
- [ ] Agent 点击 bind_agent 后确认 Add Promoter 按钮
- [ ] Agent 创建 Promoter 后确认 Promoter 绑定卡片
- [ ] Promoter 点击 bind_promoter 后确认 p_B01 短链接
- [ ] Promoter 点 Share 确认 p_B01 正常
- [ ] 新 Player 通过 p_B01 进入并提交 Game ID
