# PH90 Bonus Bot — Multi-Level Referral Telegram Bot

## Architecture

```
Admin（总代）
  └── Agent（公司代理）
        └── Promoter（业务推广员）
              └── Player（玩家）
```

## Quick Deploy

### Prerequisites
- Node.js >= 18
- Supabase PostgreSQL (pooler mode, port 6543)
- Telegram Bot Token (@BotFather)

### `.env`
```env
BOT_TOKEN=<your_token>
DATABASE_URL=postgresql://...@...pooler.supabase.com:6543/postgres
SECRET_TOKEN=<random_string>
RENDER_APP_URL=https://<your-app>.onrender.com
ADMIN_IDS=<tgid1>,<tgid2>
ALLOWED_DOMAINS=<domain1.com>,<www.domain1.com>
GAME_ID_REGEX=^PH90[A-Za-z0-9]{4,12}$
```

### Deploy
```bash
npm install && npm start
```
Render: push to `v2-nodejs` → Manual Deploy → Deploy latest commit.

⚠️ UptimeRobot should ping `GET /health`, NOT `/webhook`.

---

## Security Features

- ✅ One-time binding tokens with SHA-256 hash storage (plaintext never in DB)
- ✅ Player affiliation locked to first promoter (cannot be changed via link)
- ✅ Callback button commands verified against role whitelist + re-auth from DB
- ✅ Webhook SECRET_TOKEN verified on every request
- ✅ All identity checks use `telegram_id` (not username)
- ✅ All critical actions logged to `audit_logs`
- ✅ SQL parameterized queries (no injection)
- ✅ Permission isolation at SQL level (`WHERE agent_id = $1`)
- ✅ Bot Token never in code; all secrets in environment variables
- ✅ `/health` public (UptimeRobot); `/webhook` requires SECRET_TOKEN

---

## Commands

### Admin
| Command | Description |
|---------|-------------|
| `/admin` | Dashboard with button panel |
| `/system_status` | Bot + DB health, counts |
| `/audit_recent` | Last 20 audit log entries |
| `/add_agent <code> <name>` | Create Agent + bind link |
| `/list_agents` | All Agents |
| `/list_promoters` | All Promoters |
| `/list_players` | All Players |
| `/list_agent_applications` | Pending Agent applications |
| `/approve_agent <code>` | Approve Agent application |
| `/reject_agent <code>` | Reject Agent application |
| `/block_agent <code>` | Block Agent |
| `/unblock_agent <code>` | Unblock Agent |
| `/block_promoter <code>` | Block Promoter |
| `/unblock_promoter <code>` | Unblock Promoter |
| `/block_player <tgid>` | Block Player |
| `/unblock_player <tgid>` | Unblock Player |
| `/change_player_owner <tgid> <code>` | Change player's promoter |
| `/find_player <tgid_or_gameid>` | Search player |
| `/find_promoter <code>` | Search promoter |
| `/find_agent <code>` | Search agent |
| `/export_players` | Export all players to CSV |
| `/list_pending` | Pending Game IDs |
| `/approve_game <tgid>` | Approve Game ID |
| `/reject_game <tgid>` | Reject Game ID |
| `/relink_agent <code>` | Regenerate Agent bind link |
| `/reset_agent_link <code>` | Reset Agent link |
| `/reset_player_link <code>` | Reset Promoter link |

### Agent
| Command | Description |
|---------|-------------|
| `/agent` | Panel with button menu |
| `/add_promoter <code> <name> <link>` | Create Promoter with link |
| `/update_promoter_link <code> <link>` | Update Promoter link |
| `/list_my_promoters` | My Promoters |
| `/list_my_players` | My Players |
| `/export_my_players` | Export my Players |
| `/set_agent_link <link>` | Set Agent affiliate link |
| `/my_agent_link` | View my link |
| `/relink_pm <code>` | Regenerate Promoter bind link |

### Promoter
| Command | Description |
|---------|-------------|
| `/promoter` | Panel |
| `/my_link` | Get share link |
| `/share` | Generate sharing text |
| `/my_players` | My players |
| `/my_today` | Today's stats |

### Player
| Command | Description |
|---------|-------------|
| `/submit <PH90xxxx>` | Submit Game ID |
| `/my` | My profile |

### General
| Command | Description |
|---------|-------------|
| `/start` | Entry point |
| `/apply_agent` | Self-apply to become Agent |
| `/ping` | Liveness check |
| `/help` | Help menu |
| `/cancel` | Cancel current step flow |

---

## Agent Self-Application Flow

```
User → /apply_agent
  → Enter Agent Code (3-20 chars, A-Za-z0-9_-)
  → Enter Agent Name (2-30 chars)
  → Pending review
Admin receives: [✅ Approve] [❌ Reject] buttons
  → Click Approve → Agent activated, gets command buttons
User receives: [📊 Agent Panel] [➕ Add Promoter] [🔗 Set Agent Link] ...
```

---

## Promoter Link Management

- Agent creates Promoter WITH affiliate link (`/add_promoter code name link`)
- Promoter binds Telegram → link_status = BOUND immediately
- Promoter CANNOT self-submit links (`/set_player_link` denied)
- Agent can update links via `/update_promoter_link`
- All link updates logged with old/new values

---

## Security Test Checklist

- [ ] Webhook returns 403 without SECRET_TOKEN
- [ ] `/health` returns 200 without auth
- [ ] Bind token one-time use + expiry
- [ ] Player affiliation locked to first promoter
- [ ] Blocked promoter links suspended
- [ ] Blocked agent cascades to promoter links
- [ ] Agent cannot see other Agent's data
- [ ] Promoter cannot see other Promoter's players
- [ ] Callback buttons enforce role whitelist
- [ ] High-risk commands cannot be triggered via callback
- [ ] Export audit logged
- [ ] Token plaintext never stored in DB
