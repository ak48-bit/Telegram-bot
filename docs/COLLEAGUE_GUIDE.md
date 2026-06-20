# PH90 WFH Bot — 同事操作简版

> 写给组长、开发员、操作员 | v1.2 | 2026-06-19

---

## v1.2 最终操作流程

### Admin
1. `/add_agent AgentCode Name`
2. 收到两张卡片 — 把 **Agent Binding Card** 转发给 Agent

### Agent
1. 收到 Agent Binding Card
2. **新用户**：点 `Bind Agent` 按钮 | **旧用户**：复制 Manual command 发送给 Bot
3. 绑定成功后，点 `[Add Promoter]` 按钮创建 Promoter
4. 把 **Promoter Binding Card** 转发给 Promoter

### Promoter
1. 收到 Promoter Binding Card
2. **新用户**：点 `Bind Promoter` 按钮 | **旧用户**：复制 Manual command 发送给 Bot
3. 绑定成功后，Bot 直接显示 `p_B01_xxx` 短链接
4. 点 `[Share]` 把 Bot Share Link 发给玩家

### Player
1. 点击 `p_B01_xxx` 链接进入 Bot
2. 点 `[Submit Game ID]` 提交
3. 点 `[Share Bot Link]` 分享活动

> 常用操作优先按钮，高风险和带参数操作仍保留 `/命令`

---

## 一、Admin 管理员怎么用

1. 打开 Bot，发送 `/admin`
2. 看到面板按钮，日常操作点按钮即可

**日常按钮：**
- `[Agent List]` — 查看所有代理
- `[Player List]` — 查看所有玩家
- `[Submitted Game IDs]` — 查看已提交的 Game ID
- `[Export Players]` — 导出 CSV（需二次确认）
- `[System Status]` — 系统状态

**需要手动输入的命令：**
- `/add_agent 编码 姓名` — 创建 Agent
- `/block_agent 编码` — 封禁 Agent
- `/block_promoter 编码` — 封禁 Promoter
- `/change_player_owner TGID 编码` — 改玩家归属
- `/find_player TGID或GameID` — 查玩家

---

## 二、Agent 组长怎么用

1. 先绑定身份（点击 Admin 发来的 bind_agent 链接，或手动发送 `/start bind_agent_xxx`）
2. 发送 `/agent`，看到面板

**日常按钮：**
- `[Add Promoter]` — 创建开发员
- `[My Promoters]` — 查看我的开发员
- `[My Players]` — 查看我的玩家
- `[Set Agent Link]` — 设置我的代理链接
- `[My Link]` — 查看我的链接

**创建开发员步骤：**
```
点击 [Add Promoter] → 输入 Promoter Code → 输入 Name → 输入 Affiliate Link
→ 确认 → 生成绑定链接 → 发给 Promoter
```

---

## 三、Promoter 开发员怎么用

1. 先绑定身份（点击 Agent 发来的 bind_promoter 链接，或手动发送 `/start bind_promoter_xxx`）
2. 发送 `/promoter`，看到面板

**日常按钮：**
- `[Share]` — 获取推广文案（含 p_B01 短链接）
- `[My Players]` — 查看我的玩家
- `[Today]` — 今日数据
- `[My Links]` — 查看我的链接

**发给玩家的链接格式：**
```
https://t.me/PH90WFH_Bonus_bot?start=p_B01_你的PromoterCode
```

---

## 四、Player 玩家怎么用

1. 点击 Promoter 发来的链接进入 Bot
2. 发送 `/my`，看到面板

**日常按钮：**
- `[Submit Game ID]` — 提交游戏 ID
- `[My Info]` — 查看我的信息
- `[Share Bot Link]` — 分享活动链接给朋友

**Game ID 规则：**
- 3-32 位字母或数字（如 `player001`、`ABC123`）
- 不能有空格、符号、中文、emoji

---

## 五、常见错误

**"no permission"**
→ 你的账号角色不对。例如 Promoter 不能 `/submit`，只有 Player 可以提交 Game ID。

**"Please enter through a valid Bot Share Link first"**
→ 你没有通过推广链接进入 Bot。需要先点击 Promoter 发来的 `p_B01_xxx` 链接。

**"This Game ID has already been submitted"**
→ 这个 Game ID 别人已经提交过了，换一个。

**"Invalid Game ID"**
→ Game ID 只能是 3-32 位字母数字，不能有空格、符号、中文。

**"You do not have a referral source yet"**
→ Player 还没有归属来源，需要先通过 `p_B01_xxx` 或 `p_C001_xxx` 链接进入。

---

## 六、链接速查

| 谁用 | 链接格式 | 用途 |
|------|----------|------|
| Promoter 发玩家 | `p_B01_PromoterCode` | 玩家进入后归属该 Promoter |
| Player 分享朋友 | `p_C001_ShareCode` | 新玩家仍归属原 Promoter |
| Agent 展示 | `p_A01_AgentCode` | 仅展示，不绑定玩家 |
| 身份绑定 | `bind_agent_xxx` `bind_promoter_xxx` | 72h 一次性，不要发群里 |
