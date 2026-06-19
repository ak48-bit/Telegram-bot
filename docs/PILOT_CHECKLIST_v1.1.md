# PH90 WFH Bot v1.1 — 小范围试运营检查表

> Commit: `32d830b` | 2026-06-19

---

## 试运营规模

| 角色 | 数量 |
|------|------|
| Agent | 1 |
| Promoter | 2-3 |
| Player | 10-20 |
| 试运营天数 | 1 天 |

---

## 每日检查清单

### Admin 检查

- [ ] Player List 数量是否正常
- [ ] Submitted Game IDs 数量是否正常
- [ ] Agent / Promoter 数据是否一致
- [ ] Audit Log 是否有异常
- [ ] Export 导出功能正常
- [ ] System Status 正常

### Agent 检查

- [ ] My Promoters 是否正确显示
- [ ] My Players 是否只显示自己线下的玩家
- [ ] 是否有玩家未提交 Game ID
- [ ] Add Promoter 功能正常

### Promoter 检查

- [ ] Share 链接格式是否为 `p_B01_PromoterCode`
- [ ] My Players 是否只显示自己的玩家
- [ ] Today 数据是否正常
- [ ] 玩家点击 p_B01 链接能否正常进入

### Player 检查

- [ ] 能否通过 p_B01 进入并绑定
- [ ] 能否 /submit Game ID
- [ ] 能否 /share 生成 p_C001 链接
- [ ] 新玩家点击 p_C001 链接后是否归属原 Promoter

---

## 异常监控

| 指标 | 说明 | 正常值 |
|------|------|--------|
| `no permission` | 角色越权尝试 | 偶发 OK |
| `no referral source` | 未通过链接进入 | 应尽量少 |
| `duplicate Game ID` | 重复提交 | 偶发 OK |
| `invalid short referral` | 无效短链接 | 应为 0 |
| `player_relink_blocked` | 归属锁定触发 | 偶发 OK |

---

## 试运营后确认

- [ ] 无玩家归属错误
- [ ] 无数据泄漏（Agent 看其他 Agent 数据）
- [ ] 无 Game ID 审核流程恢复
- [ ] 短链接均正常工作
- [ ] 旧链接兼容正常
- [ ] Bot 24h 无宕机
