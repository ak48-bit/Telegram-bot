# PH90 WFH Bot — 桌面文档整理复制清单

> 目标目录: `C:\Users\ak481\OneDrive\Desktop\PH90_WFH_Bot_文档整理\`

---

## 建议目录结构

```
PH90_WFH_Bot_文档整理/
├── 00_分类报告/
│   ├── DOCUMENT_CLASSIFICATION_REPORT.md
│   └── DESKTOP_DOC整理复制清单.md
├── 01_旧版Bot文档/
├── 02_不完整版本Bot文档/
├── 03_完整最终版Bot文档_v1.1/
└── 04_待删除或归档/
```

---

## 复制清单

### → 01_旧版Bot文档

从桌面复制：
- [ ] `PH90_Bonus_Bot_Complete_Flow_v2.md`
- [ ] `PH90_Bonus_Bot_Operation_Flow.md`
- [ ] `PH90_Bonus_Bot_完整操作流程_v3.md`
- [ ] `PH90_Bonus_Bot_完整操作流程_提交排查.md`
- [ ] `PH90WFH_Bonus_Bot_推广裂变机器人.zip`
- [ ] `PH90WFH_Bonus_Bot_云端版_24h.zip`
- [ ] `PH90WFH_Bonus_Bot_完整包.zip`
- [ ] `PH90WFH_Bonus_Bot_中文版.zip`
- [ ] `PH90WFH_Bonus_Bot_English.zip`

### → 02_不完整版本Bot文档

从桌面复制：
- [ ] `PH90_Bonus_Bot_完整操作流程_v4.md`
- [ ] `PH90_Bonus_Bot_操作手册_同事版.md`
- [ ] `PH90_WFH_Bot_完整项目文档.md`
- [ ] `PH90_WFH_Bot.zip`
- [ ] `PH90_WFH_Bot_操作流程文档.zip`

### → 03_完整最终版Bot文档_v1.1

从桌面复制：
- [ ] `PH90_WFH_Bot_v1.1_完整项目.zip`
- [ ] `RELEASE_v1.1.md`

从项目复制：
- [ ] `bonus-bot-v2\docs\RELEASE_v1.1.md`
- [ ] `bonus-bot-v2\docs\COLLEAGUE_GUIDE.md`
- [ ] `bonus-bot-v2\docs\PILOT_CHECKLIST_v1.1.md`
- [ ] `bonus-bot-v2\docs\BACKUP_BEFORE_LAUNCH.md`
- [ ] `bonus-bot-v2\README.md`
- [ ] `bonus-bot-v2\architecture.html`

### → 04_待删除或归档

从桌面复制：
- [ ] `PH90_WFH_Bot_ChatGPT复查.zip`

从项目复制：
- [ ] `bonus-bot-v2\CHANGELOG.txt`

---

## 不建议移动的文件

| 文件 | 原因 |
|------|------|
| `bonus-bot-v2\` 整个项目目录 | 是运行中的代码仓库 |
| `PH90_WFH_Bot_DB_Backup\` | 数据库备份，独立保留 |
| `.env` | 含敏感信息 |
| `Telegram bot\` `Telegram 群\` | 可能是其他项目目录 |
| `启动推送Bot.bat` | 可能是旧推送脚本 |

---

## 执行方式

**不要直接移动原文件。** 用以下 PowerShell 创建目录并复制：

```powershell
$base = "C:\Users\ak481\OneDrive\Desktop\PH90_WFH_Bot_文档整理"
New-Item -ItemType Directory -Force -Path "$base\00_分类报告"
New-Item -ItemType Directory -Force -Path "$base\01_旧版Bot文档"
New-Item -ItemType Directory -Force -Path "$base\02_不完整版本Bot文档"
New-Item -ItemType Directory -Force -Path "$base\03_完整最终版Bot文档_v1.1"
New-Item -ItemType Directory -Force -Path "$base\04_待删除或归档"

# 按清单复制各文件...
```
