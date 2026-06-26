# Render Background Worker 部署指南

## 一、服务类型

使用 **Background Worker**，不使用 Web Service。

- Background Worker 不会因为没有 HTTP 端口而被 Render 杀掉
- 适合 `today_scheduler` 这种持续运行的脚本
- 不需要监听端口，不需要 Flask/Gunicorn

## 二、Build Command

```
pip install -r requirements.txt
```

（当前 requirements.txt 为空，代码仅使用 Python 标准库）

## 三、Start Command

```
python backend_client.py today_scheduler
```

## 四、Environment Variables

在 Render Dashboard → Environment 中手动添加以下变量（共 12 个，**不要写真实值到代码或 Git**）：

| Key | 说明 |
|---|---|
| `BACKEND_BASE_URL` | 后台域名 |
| `BACKEND_AUTHORIZATION` | 后台鉴权 Token |
| `BACKEND_COOKIE` | 后台 Cookie |
| `BACKEND_MERCHANT` | 商户代码 |
| `BACKEND_MERCHANT_CODE` | 商户代码 |
| `BACKEND_ENVIRONMENT` | 环境标识 |
| `BACKEND_PLATFORM` | 平台标识 |
| `BACKEND_LANGUAGE` | 语言 |
| `BACKEND_TIMEZONE` | 时区 |
| `TOP_AGENT` | 目标总代名称 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_ALERT_CHAT_ID` | 告警群 chat_id |

> 代码从 `os.environ` 读取，不依赖 `.env` 文件。Render 的环境变量会直接注入。

## 五、部署步骤

1. **Push 代码到 GitHub / GitLab**

   确保以下文件已提交：
   - `backend_client.py`
   - `requirements.txt`
   - `README_RUN.md`
   - `.gitignore`

   确保以下文件 **未提交**：
   - `.env`（敏感信息）
   - `risk_cases_*.json`（运行时数据）
   - `sent_risk_cases.json`
   - `direct_agents_cache.json`

2. **打开 Render Dashboard**

   https://dashboard.render.com

3. **New → Background Worker**

   ![](https://render.com/docs/background-workers)

4. **连接 Repo**

   选择 GitHub / GitLab 仓库

5. **填写 Build Command**

   ```
   pip install -r requirements.txt
   ```

6. **填写 Start Command**

   ```
   python backend_client.py today_scheduler
   ```

7. **添加 Environment Variables**

   把第四节的变量逐个添加到 Render Environment 面板。
   **不要**把真实值写在代码里。

8. **Deploy**

   点击 Deploy 按钮，等待构建完成。

9. **检查 Logs**

   打开 Render Logs，确认出现：

   ```
   ⏱️  Today Scheduler — 持续运行
   🔄 Today Scheduler Run #1
   ```

   如果出现 `INVALID_TOKEN`，检查 BACKEND_AUTHORIZATION 和 BACKEND_COOKIE。
   如果出现 `chat not found`，检查 TELEGRAM_BOT_TOKEN 和 TELEGRAM_ALERT_CHAT_ID。

## 六、上线前安全检查

- [ ] `.env` 未上传到 Git（检查 `git status`）
- [ ] `TELEGRAM_BOT_TOKEN` 使用新创建的 Bot Token（不要复用开发环境的）
- [ ] 新 Token 只填到 Render Environment，不写入任何文件
- [ ] `BACKEND_AUTHORIZATION` / `BACKEND_COOKIE` 只填到 Render Environment
- [ ] 代码中不打印 Token / authorization / cookie
- [ ] 冻结提款功能未开启（freeze: DISABLED）
- [ ] `today_scheduler` 核心逻辑未修改

## 七、运行后检查

- [ ] Telegram「审核IP」群收到告警消息
- [ ] Render Logs 每 60 秒有一轮扫描输出
- [ ] `sent_risk_cases.json` 正常生成（防重复）
- [ ] `direct_agents_cache.json` 正常生成（代理缓存）
- [ ] 无连续错误导致自动停止

## 八、常见问题

### Build 失败
检查 `requirements.txt` 是否存在，Python 版本是否为 3.8+。

### 启动后立刻退出
检查 Environment Variables 是否全部配置。缺少 `BACKEND_AUTHORIZATION` 或 `BACKEND_COOKIE` 会导致 API 调用失败。

### 运行一段时间后停止
- 连续 5 次错误会自动停止（`max_consecutive_errors=5`）
- 检查 Render Logs 确认错误原因
- 常见原因：Token 过期、Cookie 过期、网络波动

### 更新 Token
1. 在 Render Dashboard → Environment 中修改
2. 点击 Deploy 重新部署
3. 不需要修改代码
