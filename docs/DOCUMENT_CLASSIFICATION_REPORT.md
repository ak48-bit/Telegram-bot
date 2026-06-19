# PH90 WFH Bot — 文档分类报告

> 基准版本: v1.1 (32d830b) | 2026-06-19

## 一、文件分类总览

### 桌面文档

| 文件名 | 判断 | 原因 | 建议处理 |
|--------|------|------|----------|
| `PH90_Bonus_Bot_Complete_Flow_v2.md` | 旧版 | v2 Node.js 初版，大量 pending/approved 审核流程 | → 01_旧版Bot文档 |
| `PH90_Bonus_Bot_Operation_Flow.md` | 旧版 | 同上，英文简化版 | → 01_旧版Bot文档 |
| `PH90_Bonus_Bot_完整操作流程_v3.md` | 旧版 | 含 submit_game_id 审核、PH90 正则、无短链接 | → 01_旧版Bot文档 |
| `PH90_Bonus_Bot_完整操作流程_v4.md` | 不完整 | 有 v1.1 部分内容但缺短链接+试运营+常见错误 | → 02_不完整版本 |
| `PH90_Bonus_Bot_完整操作流程_提交排查.md` | 旧版 | 提交 ChatGPT 排查用的旧版诊断文档 | → 01_旧版Bot文档 |
| `PH90_Bonus_Bot_操作手册_同事版.md` | 不完整 | 有角色说明但无短链接/按钮 vs 命令/常见错误 | → 02_不完整版本 |
| `PH90_WFH_Bot_完整项目文档.md` | 不完整 | 有 v1.1 但缺短链接规则+试运营+备份 | → 02_不完整版本 |

### 桌面压缩包

| 文件名 | 判断 | 建议处理 |
|--------|------|----------|
| `PH90WFH_Bonus_Bot_推广裂变机器人.zip` | 旧版 | → 01_旧版Bot文档 |
| `PH90WFH_Bonus_Bot_云端版_24h.zip` | 旧版 | → 01_旧版Bot文档 |
| `PH90WFH_Bonus_Bot_完整包.zip` | 旧版 | → 01_旧版Bot文档 |
| `PH90WFH_Bonus_Bot_中文版.zip` | 旧版 | → 01_旧版Bot文档 |
| `PH90WFH_Bonus_Bot_English.zip` | 旧版 | → 01_旧版Bot文档 |
| `PH90_WFH_Bot.zip` | 不完整 | → 02_不完整版本 |
| `PH90_WFH_Bot_操作流程文档.zip` | 不完整 | → 02_不完整版本 |
| `PH90_WFH_Bot_ChatGPT复查.zip` | 待归档 | → 04_待删除或归档 |
| `PH90_WFH_Bot_v1.1_完整项目.zip` | 完整最终版 | → 03_完整最终版 |
| `RELEASE_v1.1.md` | 完整最终版 | → 03_完整最终版 |

### 项目内文档

| 文件名 | 判断 | 建议处理 |
|--------|------|----------|
| `README.md` | 完整最终版 | 保留原位（已同步 v1.1） |
| `docs/RELEASE_v1.1.md` | 完整最终版 | 保留原位 |
| `docs/COLLEAGUE_GUIDE.md` | 完整最终版 | 保留原位 |
| `docs/PILOT_CHECKLIST_v1.1.md` | 完整最终版 | 保留原位 |
| `docs/BACKUP_BEFORE_LAUNCH.md` | 完整最终版 | 保留原位 |
| `architecture.html` | 完整最终版 | 保留原位（v1.1） |
| `CHANGELOG.txt` | 待归档 | → 04_待删除或归档 |

---

## 二、旧版关键词命中清单

以下词汇出现在旧版/不完整版文档中，v1.1 最终版不应出现：

| 关键词 | 说明 |
|--------|------|
| `PH90[A-Za-z0-9]{4,12}` | 旧 Game ID 正则 |
| `/submit <PH90xxxx>` | 旧提交格式 |
| `pending` / `approved` / `rejected` | 旧审核状态 |
| `/approve_game` / `/reject_game` | 旧审核命令 |
| `Pending Review` | 旧等待审核文案 |
| `Waiting for Admin Approval` | 旧审核文案 |
| `p_<random_token>` 作为主要链接 | 无短链接说明 |
| `Bonus` / `Free Spins` | 旧奖励文案 |
| `No expiry, unlimited use` | 旧链接文案 |
| `Promoter can set player link` | 旧权限说明 |

---

## 三、完整最终版必须保留文件

| 文件 | 说明 |
|------|------|
| `docs/RELEASE_v1.1.md` | v1.1 版本记录 |
| `docs/COLLEAGUE_GUIDE.md` | 同事操作简版（含常见错误） |
| `docs/PILOT_CHECKLIST_v1.1.md` | 试运营检查表 |
| `docs/BACKUP_BEFORE_LAUNCH.md` | 备份指南 |
| `README.md` | 项目说明（已同步 v1.1） |
| `architecture.html` | 架构可视化（v1.1） |
| 桌面 `PH90_WFH_Bot_v1.1_完整项目.zip` | 最终版源码包 |
| 桌面 `RELEASE_v1.1.md` | 版本记录副本 |
