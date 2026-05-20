# 线上办公部门 — Claude Code Skill & Bot 完整配置

## 一、推送流程（最高优先级）

### 触发词
"更新完毕" / "更新好了" / "更新了" / "已更新好" / "推送" / "推一下"

### 执行流程
```
用户说触发词
  → python3 push_update.py
  → 读取 LATEST_PUSH.md
  → 脚本自动发送 Telegram (2条消息到群组 sss)
  → Claude 展示结果摘要
```

### 脚本详情
| 项目 | 值 |
|------|-----|
| 入口脚本 | `push_update.py` |
| 数据源 | `C:\Users\ak481\OneDrive\Desktop\新建文件夹\26年05月 线上办公数据汇总.xlsx` |
| 输出 | `LATEST_PUSH.md` + `push_history_*.md` |
| 覆盖站点 | PH09/PH09-2/PH25/PH18/PH30/PH05/PH16 + BD02/BD05 + MM01 |
| 数据字段 | 注册/首存/充值/首存金额/总充值/总提款/充提差/新客单价/投产比/状态 |

---

## 二、Telegram Bot 配置

| 配置项 | 值 |
|--------|-----|
| Bot Token | `8731392429:AAFb6QywB4NG4TDTmeOtzDbS7IR_G95JzAI` |
| Bot 名称 | @WFHDPbot |
| 目标群组 | sss (chat_id: `-1003899337250`) |
| 发送格式 | HTML parse_mode |
| 分条策略 | Part1=box表格+区域汇总, Part2=环比+异常+风控 |

### Bot API 调用方式 (备用)

```powershell
$body = @{
    chat_id = "-1003899337250"
    text = "消息内容"
    parse_mode = "HTML"
} | ConvertTo-Json -Depth 3

$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Uri "https://api.telegram.org/bot8731392429:AAFb6QywB4NG4TDTmeOtzDbS7IR_G95JzAI/sendMessage" `
    -Method Post -Body $bytes -ContentType "application/json; charset=utf-8"
```

---

## 三、Claude Code 记忆系统

### 记忆文件位置
```
C:\Users\ak481\.claude\projects\C--Users-ak481\memory\
├── MEMORY.md                       # 索引
└── project_push_workflow.md        # 推送工作流记忆
```

### 记忆内容
- 触发词识别 → 自动执行推送
- 重启后依然有效
- 每次用户说触发词时检查此记忆

---

## 四、系统监控 Skill（新增）

### 位置
```
C:\Users\ak481\.claude\skills\system-monitor\
├── SKILL.md                        # Skill 定义
└── scripts\
    └── collect_ram.ps1             # RAM 数据采集
```

### 功能
- 采集 Windows 系统内存使用
- 格式化报告发送到 Telegram
- 可选推送到 GitLab 记录历史

### 调用方式
- "查内存" / "发系统报告" / "内存占用"

---

## 五、风控规则

| 规则 | 阈值 | 标签 |
|------|------|------|
| 提款率过高 | >90% | 🚨 风控告警 |
| 存提差占比过低 | <10% | 🚨 风控告警 |
| FTD 归零 | =0 | 🔴 严重 |
| FTD 个位数 | <10 | 🟡 警告 |
| ROI 负数 | <0 | 🟡 警告 |

---

## 六、定时任务

| 任务 | 频率 | 方式 |
|------|------|------|
| 自动推送 | 每天 9:07 | Cron 定时 |
| 手动推送 | 用户说触发词 | Claude 记忆触发 |
| 系统内存报告 | 按需 | Skill 调用 |

---

## 七、目录结构

```
ak 线上办公部门skills建议和调用/
├── push_update.py                  # 主推送脚本 (中文)
├── push_update_en.py               # 主推送脚本 (英文)
├── push_may2.py                    # 5月2日版推送
├── ftd_price_push.py               # FTD客单价推送
├── monthly_report.py               # 月度报告
├── extract_script.py               # 数据提取
├── LATEST_PUSH.md                  # 最新推送结果
├── LATEST_PUSH_EN.md               # 最新推送结果 (英文)
├── push_history_*.md               # 推送历史 (保留50份)
├── SKILL_WORKFLOW.md               # 本文件 — 完整配置
├── 推送指令_数据板块.md              # Skill调用指令
├── .gitlab-ci.yml                  # GitLab CI 配置
├── GITLAB_WIKI.md                  # GitLab Wiki
└── FTD_PRICE_PUSH.md               # FTD客单价说明
```
