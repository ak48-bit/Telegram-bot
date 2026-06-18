# PH90 WFH Bot v1.1

> Release: 2026-06-18 | Commit: `32d830b` | Branch: `v2-nodejs`

## Core Features

### Short Bot Share Links
- `p_B01_<PromoterCode>` — Promoter referral link (e.g. `p_B01_Leostaff001`)
- `p_C001_<PlayerShareCode>` — Player share link, still belongs to original Promoter
- `p_A01_<AgentCode>` — Agent info page (not for player binding)
- Legacy `p_<random_token>` still supported for backward compatibility

### Game ID — Submitted Record Mode
- `/submit` sets `game_id_status = submitted` (record only, no review needed)
- Game ID format: 3-32 alphanumeric characters (A-Z, a-z, 0-9)
- `/approve_game` and `/reject_game` disabled
- Rewards claimed in-game, not via Bot

### Button Panels
- **Admin**: Agent List, Promoter List, Player List, Submitted Game IDs, System Status, Audit Log, Query Help, Export Players (with confirmation)
- **Agent**: Refresh, Add Promoter, Set Agent Link, My Link, My Promoters, My Players
- **Promoter**: Share, My Links, My Players, Today
- **Player**: Submit Game ID, My Info, Share Bot Link

### Bind Tokens (unchanged)
- `bind_agent_xxx` — 72h, one-time use, SHA-256 hash storage
- `bind_promoter_xxx` — 72h, one-time use, SHA-256 hash storage

## Security
- Callback button whitelist per role + re-auth from DB
- Webhook SECRET_TOKEN required
- Permission isolation at SQL level
- Player source lock (cannot overwrite via new link)
- Admin/Agent/Promoter blocked from becoming Player via referral links

## Test Coverage
- Short link + Game ID: 17/17 ✅
- Button command audit: 15/15 ✅
- Production flow: 39/39 ✅
- Compliance: 22/22 ✅
- Cumulative: 180+ tests
