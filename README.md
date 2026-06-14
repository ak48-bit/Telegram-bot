# Multi-Level Referral Telegram Bot

## 架构

```
Admin (总代)
  └── Agent (公司人员)
        └── Promoter (业务开发员)
              └── Player (玩家)
```

## 快速部署

### 1. 准备

- Node.js >= 18
- Supabase PostgreSQL 数据库
- Telegram Bot Token（@BotFather）

### 2. 配置 `.env`

```env
BOT_TOKEN=你的BotToken
DATABASE_URL=postgresql://...@...pooler.supabase.com:6543/postgres
SECRET_TOKEN=随机字符串
RENDER_APP_URL=https://你的服务.onrender.com
ADMIN_IDS=5228288204,7393739670
ALLOWED_DOMAINS=你的域名.com
```

### 3. 部署

```bash
npm install
npm start
```

## 安全特性

- ✅ Agent/Promoter 使用一次性随机 Token 绑定（不能猜号抢绑）
- ✅ 玩家归属第一次锁定，后续不可自动更改
- ✅ 所有身份判断用 telegram_id（不用 username）
- ✅ 所有关键操作写入 audit_logs
- ✅ SQL 参数化查询防注入
- ✅ 权限隔离在后端 SQL 层面实现
- ✅ Bot Token 不写死在代码中

## 命令

### Admin
| 命令 | 功能 |
|------|------|
| `/admin` | 仪表盘 |
| `/add_agent A001 Name` | 创建 Agent + 生成绑定链接 |
| `/list_agents` | 查看所有 Agent |
| `/list_promoters` | 查看所有 Promoter |
| `/list_players` | 查看所有 Player |
| `/export_players` | 导出 CSV |
| `/block_agent A001` | 封禁 Agent |
| `/block_promoter B001` | 封禁 Promoter |
| `/change_player_owner TGID B001` | 修改玩家归属 |

### Agent
| 命令 | 功能 |
|------|------|
| `/agent` | 个人面板 |
| `/add_promoter B001 Name` | 创建 Promoter + 生成绑定链接 |
| `/list_my_promoters` | 查看下级 Promoter |
| `/list_my_players` | 查看线下玩家 |
| `/export_my_players` | 导出线下玩家 |

### Promoter
| 命令 | 功能 |
|------|------|
| `/promoter` | 个人面板 |
| `/my_link` | 获取推广链接 |
| `/my_players` | 查看我的玩家 |
| `/my_today` | 今日数据 |

### Player
| 命令 | 功能 |
|------|------|
| `/submit PH90xxxx` | 提交游戏 ID |
| `/my` | 查看我的资料 |
