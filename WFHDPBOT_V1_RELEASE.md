# WFHDPbot V1.0 Release

@WFHDPbot — 线上办公数据推送 Bot（V1.0 封版文档）

> 本文档仅整理项目现状，不新增功能说明。所有内容以实际代码与配置为准。

---

## 一、项目用途

Bot 负责将线上办公部门每日数据推送至 Telegram 群组，覆盖：

- 开发业务数据推送（5 个开发站点日报）
- PH33 劫持数据推送
- 昨日对比（今日 vs 昨日）
- 上月同日对比（今日 vs 上月同日）
- 原始 Excel 附件
- 历史快照（`data/comparison_archive/`）
- 自动归档（三项发送成功后复制快照）
- dry-run（只生成图片，不发送 Telegram）

## 二、正式数据文件

### 开发（地推）数据

| 文件 | 说明 |
|------|------|
| `26年6月 线上办公数据汇总.xlsx` | 2026-06 全月历史 |
| `26年7月 线上办公数据汇总 New.xlsx` | 2026-07 正式 |
| `26年8月 线上办公数据汇总 New.xlsx` | 2026-08 正式 |

### 劫持数据

| 文件 | 说明 |
|------|------|
| `26年6月 劫持（线上办公数据汇总）.xlsx` | 2026-06 全月历史 |
| `26年7月 劫持（线上办公数据汇总）.xlsx` | 2026-07 正式 |
| `26年8月 劫持（线上办公数据汇总）.xlsx` | 2026-08 正式 |

数据目录：`C:\Users\ak481\OneDrive\Desktop\新建文件夹`

`config.json` 中 `active_excel_file` 指向当前正式开发文件。

## 三、正式站点范围

### 开发平台（`development_platforms`）

```
PH09  PH25  PH18  PH30  PH35
```

### 劫持平台（`hijack_platforms`）

```
PH33
```

### 停用平台（`disabled_platforms`）

```
PH09-2  PH05  PH16  BD02  BD05  MM01
```

停用站点不参与任何日报、对比、排名、异常与统计。

## 四、推送模板与顺序

### 开发推送（`/push`、`/compare`、`/compare_date`）

1. 开发当日汇总
2. 今日 vs 昨日
3. 今日 vs 上月同日

### PH33 劫持推送（`run_hijack_push("hijack")`）

1. PH33 当天数据汇总图
2. PH33 昨日/上月组合对比图（纵向长图）
3. PH33 原始 Excel

发送顺序由 `bot_listener.py` 统一控制，原子式：三项全部生成并通过 preflight 后才开始发送。

## 五、日期逻辑

- **使用 Excel 内部 `data_date`**，从 `【当天数据汇总】` sheet 的日期单元格读取。
- 不使用系统日期、不使用文件 mtime。
- 调用者显式传入 `target_date` 时必须与源数据日期一致，否则返回 `data_date_mismatch` 失败。
- `target_date=None` 时自动使用 Excel 内部 `data_date`。
- 缺昨日或上月历史快照时，组合图对应区块显示警告文字，不使用最近日期替代。

## 六、快照逻辑

命名格式：

```
development_YYYY-MM-DD.xlsx
hijack_YYYY-MM-DD.xlsx
```

目录：`data/comparison_archive/`

规则：

- dry-run 不归档（`archive_status = skipped_dry_run`）。
- 三项发送全部成功后才归档。
- 目标已存在且 SHA256 相同 → 跳过（`already_exists_same`）。
- 目标已存在但 SHA256 不同 → 冲突，不覆盖（`conflict`）。
- 快照日期来源必须是 Excel 内部 `data_date`，禁止回退。
- 异常文件隔离到 `data/comparison_archive/quarantine/`。

## 七、安全配置

环境文件：`.wfhdp.env`（仅 WFHDPbot 使用，不读取其他 Bot 的 `.env`）

| 变量 | 用途 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | Bot Token（从 @BotFather 获取） |
| `TELEGRAM_CHAT_ID` | 推送目标群组 ID |
| `ADMIN_TELEGRAM_IDS` | 管理员 ID（`/compare`、`/reload_config` 等权限校验） |

要求：

- 不得将 Token 硬编码在源码中。
- 不得提交 `.env`、`.wfhdp.env` 或任何 Excel 文件到 Git。
- `admin_telegram_ids` 为空时，管理员功能默认拒绝。

## 八、运行方式

- 环境：Windows 本地。
- 入口：`bot_listener.py`（Python 3.13）。
- 启动：在项目目录运行 `python bot_listener.py`。
- 检查 PID：`powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python3.13.exe' -and $_.CommandLine -like '*bot_listener*' }"`。
- 确认只有 1 个实例：实例数应为 1，避免 Telegram 409 getUpdates 冲突。
- 查看 401/409：检查 `bot_log.txt` 中的 `Unauthorized` / `409 Conflict` 记录。

## 九、更新流程（固定顺序）

1. `git status --short` — 确认工作区
2. dry-run — `run_hijack_push("hijack", dry_run=True)`
3. `python -m py_compile <修改文件>` — 语法检查
4. `git add <文件>` + `git commit`
5. `git push origin master`
6. 受控重启 `bot_listener.py`
7. 检查实例数 = 1
8. 人工触发一次 Telegram 测试推送

## 十、常见故障

| 故障 | 处理 |
|------|------|
| 409 Conflict | 存在多个 polling 实例，停止多余进程，保留 1 个 |
| 401 Unauthorized | Token 无效/被撤销，在 BotFather 重新获取并更新 `.wfhdp.env` |
| Excel 日期不匹配 | 显式 target_date 与 Excel 内部 data_date 不一致，改用实际日期或 None |
| 昨日快照缺失 | 组合图显示警告区块，不影响生成 |
| 上月快照缺失 | 组合图显示警告区块，不影响生成 |
| 截图失败 | Excel COM 不可用或 Excel 未打开，检查 Excel.Application |
| COM 不可用 | 仅 Windows 支持；Linux 下返回 "This function is only available on Windows." |
| Bot 无回复 | 检查进程是否存活、`bot_log.txt` 是否有异常 |
| 重复进程 | 结束多余 python.exe bot_listener.py 进程 |
| 文件名变化 | `find_main_excel` / 快照读取按 Excel 内部日期识别，不依赖文件名 |

## 十一、回滚流程

1. 记录当前 Commit（`git log -1 --oneline`）。
2. 停止当前新进程。
3. 切回已确认可用 Commit（`git checkout <旧hash>`）。
4. 启动单一 `bot_listener.py` 实例。
5. 执行 dry-run 确认。
6. 检查 `bot_log.txt`。

## 十二、当前版本信息（2026-08 封版时刻）

| 项目 | 值 |
|------|-----|
| 当前 Commit | `db4837d fix: resolve PH33 dates and allow missing comparison snapshots` |
| 当前分支 | `master` |
| 当前 PID | 28896（bot_listener.py） |
| Python 版本 | Python 3.13 |
| 数据目录 | `C:\Users\ak481\OneDrive\Desktop\新建文件夹` |
| 当前开发 Excel | `26年7月 线上办公数据汇总 New.xlsx`（config `active_excel_file`） |
| 当前劫持 Excel | `26年7月 劫持（线上办公数据汇总）.xlsx` |
| 开发平台 | PH09, PH25, PH18, PH30, PH35 |
| 劫持平台 | PH33 |
| 停用平台 | PH09-2, PH05, PH16, BD02, BD05, MM01 |
| 定时推送 | 每日 21:07 |

> 注：当前正式 Excel 随部门每日更新，`active_excel_file` 与快照日期随数据滚动。
