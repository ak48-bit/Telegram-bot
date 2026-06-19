# PH90 WFH Bot — 正式运营前备份指南

> Commit: `32d830b` | 稳定验证版本

---

## 需要备份的表

| 表 | 说明 |
|----|------|
| `users` | 用户身份 |
| `agents` | Agent 记录 |
| `promoters` | Promoter 记录 |
| `players` | Player + Game ID |
| `invite_tokens` | 绑定 token |
| `audit_logs` | 操作审计 |
| `rate_limits` | 限流记录 |

---

## 备份方式

### 方式一：Supabase Dashboard

Supabase → Table Editor → 每个表 → Export → CSV

### 方式二：SQL Dump

Supabase → SQL Editor：

```sql
COPY users TO '/tmp/users.csv' CSV HEADER;
COPY agents TO '/tmp/agents.csv' CSV HEADER;
COPY promoters TO '/tmp/promoters.csv' CSV HEADER;
COPY players TO '/tmp/players.csv' CSV HEADER;
COPY invite_tokens TO '/tmp/invite_tokens.csv' CSV HEADER;
COPY audit_logs TO '/tmp/audit_logs.csv' CSV HEADER;
```

### 方式三：Claude 脚本

```
node -e "const db=require('./src/db'); ... 导出 CSV"
```

---

## 恢复注意事项

- 恢复前先停止 Render 服务
- 恢复后重启 Render → Manual Deploy
- 验证 `/ping` 正常

---

## 当前已备份

桌面: `PH90_WFH_Bot_DB_Backup\`（2026-06-18 干净版本）
