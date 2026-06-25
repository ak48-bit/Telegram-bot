# PH90 WFH Bot v1.2.3 — 按钮化与角色互斥稳定版

> Final Commit: `eaf0931` | Base: v1.1 (`32d830b`)

---

## Key Commits

| Commit | Description |
|--------|-------------|
| `8b691c2` | v1.2 UX: Agent/Promoter bind success cards |
| `da9f06d` | v1.2 docs + colleague guide |
| `571c17d` | /start fix: unbound users no longer see Player Panel |
| `a78f663` | Telegram Username (@format) + Telegram ID recording |
| `31aa132` | Admin ➕ Add Agent button + Step Mode |
| `9bbb3c2` | Role mutex: one TG = one role only |
| `b076c1e` | Player entry card: TG info + buttons |
| `eaf0931` | Existing Player relink card: HTML fix + TG info + buttons |

---

## New Capabilities

### Button-First UX
- Admin: `/admin` → `➕ Add Agent` Step Mode button
- Agent: `/agent` → `➕ Add Promoter` Step Mode button
- Promoter: `/promoter` → `📣 Share` `🔗 My Links` `🎮 My Players` `📅 Today`
- Player: `/start` → `📝 Submit Game ID` `👤 My Info` `📣 Share Bot Link`
- All original `/commands` still work as fallback

### Telegram Profile Recording
- Promoter bind saves: `telegram_id`, `telegram_username` (@format)
- Player entry saves: `telegram_id`, `telegram_username` (@format)
- Player Panel shows: TG Username, TG ID, Game ID, Status

### Role Mutex
- One TG account = one role only (admin/agent/promoter/player)
- Admin cannot bind as Agent/Promoter
- Agent cannot bind as Promoter or become Player
- Promoter cannot bind as Agent or become Player

### Forwardable Binding Cards
- `/add_agent` returns Admin confirmation + Agent Binding Card (forwardable)
- `/add_promoter` returns Agent confirmation + Promoter Binding Card (forwardable)
- Both cards include: URL button + manual command + binding instructions

---

## Tested (13 items)

1. Admin Add Agent button + Step Mode ✅
2. Agent Add Promoter button + Step Mode ✅
3. Promoter bind shows TG Username + TG ID + p_B01 link ✅
4. Player p_B01 entry shows TG info + buttons ✅
5. Existing Player relink card: HTML fixed + TG info + buttons ✅
6. Player Panel /start shows TG info + Game ID + Status ✅
7. /list_players shows TG Username + TG ID ✅
8. /my_players shows TG Username + TG ID ✅
9. Role mutex: agent≠promoter, staff≠player, admin≠staff ✅
10. Conflict cleaned: TG 1259096820 = Promoter only ✅
11. Manual commands still work ✅
12. Game ID submitted mode ✅
13. Unbound /start shows entry help (not Player Panel) ✅

---

## Deploy
1. `git push origin v2-nodejs`
2. Render → Manual Deploy → Deploy latest commit
3. Verify: `/ping` on Telegram

## Rollback
`git checkout 32d830b` → Manual Deploy
