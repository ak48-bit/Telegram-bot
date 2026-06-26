#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Backend Client — CRM Advanced Search API wrapper.

Reads credentials from .env, calls the player advanced search endpoint,
parses player fields, and filters by target master agent.

Phase 1: searchPlayers() — call API, print results, filter by TOP_AGENT.
"""

import os
import json
import sys
import io
import urllib.request
import urllib.error
import ssl
import time
from datetime import datetime, timezone, timedelta

# Fix encoding for Windows console
if sys.stdout and sys.stdout.buffer:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
if sys.stderr and sys.stderr.buffer:
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')


# ---------------------------------------------------------------------------
# .env loader (stdlib, no python-dotenv dependency)
# ---------------------------------------------------------------------------

def _load_dotenv(dotenv_path: str = None) -> dict:
    """Parse KEY=VALUE pairs from a .env file into a dict + os.environ."""
    if dotenv_path is None:
        dotenv_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")

    env_vars = {}
    if not os.path.isfile(dotenv_path):
        return env_vars

    with open(dotenv_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            env_vars[key] = value
            if key not in os.environ:
                os.environ[key] = value
    return env_vars


def _normalize_ip(ip):
    """Normalize IP to lowercase string; treat None / empty as None."""
    if ip is None:
        return None
    s = str(ip).strip().lower()
    return s if s and s != "none" else None


# ---------------------------------------------------------------------------
# BackendClient
# ---------------------------------------------------------------------------

class BackendClient:
    """HTTP client for the WJ-Safety CRM backend."""

    # Player fields to extract from the API response,
    # plus known aliases the API may use for the same field.
    PLAYER_FIELDS = [
        "customerId",
        "customerName",
        "customerType",
        "masterAgentName",
        "recommenderName",
        "registerIp",
        "registerTime",
        "firstDepositDate",
        "lastLoginIp",
        "lastLoginTime",
    ]

    # Map our canonical field name → possible API field names
    FIELD_ALIASES = {
        "registerTime": ["regDate", "registerTime", "createTime", "createdAt"],
    }

    def __init__(self, dotenv_path: str = None):
        """Load config from .env and initialise the client."""
        _load_dotenv(dotenv_path)

        self.base_url = os.environ.get("BACKEND_BASE_URL", "").rstrip("/")
        self.authorization = os.environ.get("BACKEND_AUTHORIZATION", "")
        self.cookie = os.environ.get("BACKEND_COOKIE", "")
        self.merchant = os.environ.get("BACKEND_MERCHANT", "")
        self.merchant_code = os.environ.get("BACKEND_MERCHANT_CODE", "")
        self.environment = os.environ.get("BACKEND_ENVIRONMENT", "")
        self.platform = os.environ.get("BACKEND_PLATFORM", "")
        self.language = os.environ.get("BACKEND_LANGUAGE", "")
        self.timezone = os.environ.get("BACKEND_TIMEZONE", "")
        self.top_agent = os.environ.get("TOP_AGENT", "30xsldx")

        # Telegram alerting
        self.tg_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        self.tg_chat_id = os.environ.get("TELEGRAM_ALERT_CHAT_ID", "")
        self.tg_api = f"https://api.telegram.org/bot{self.tg_token}" if self.tg_token else ""

        # API endpoint
        self.search_url = f"{self.base_url}/tac/api/relay/post/crm-advanced-search-search"

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    def _build_headers(self) -> dict:
        """Build the HTTP request headers from .env config."""
        return {
            "Content-Type": "application/json",
            "Authorization": self.authorization,
            "Cookie": self.cookie,
            "merchant": self.merchant,
            "merchantCode": self.merchant_code,
            "environment": self.environment,
            "platform": self.platform,
            "language": self.language,
            "timezone": self.timezone,
        }

    def _post(self, url: str, body: dict, timeout: int = 30) -> dict:
        """Send a POST request with JSON body. Returns parsed JSON."""
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = self._build_headers()

        req = urllib.request.Request(url, data=data, headers=headers)

        # Allow self-signed / internal certs if needed
        ctx = ssl.create_default_context()

        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw)
        except UnicodeEncodeError as e:
            raise RuntimeError(
                f"Header encoding error: {e}\n"
                "HTTP headers must be ASCII-safe. Check .env values for "
                "BACKEND_AUTHORIZATION / BACKEND_COOKIE — they may contain "
                "non-ASCII characters. Replace with real browser values."
            ) from e
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"HTTP {e.code} from {url}\nResponse: {err_body[:2000]}"
            ) from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"Connection error to {url}: {e.reason}") from e

    # ------------------------------------------------------------------
    # searchPlayers()
    # ------------------------------------------------------------------

    def searchPlayers(
        self,
        page_size: int = 10,
        page_number: int = 1,
        account_types: list = None,
        subordinate_type: str = "ALL",
        subordinate_name: str = None,
        personal_info_type: str = "BOUND",
        domain_match_type: str = "FUZZY",
        global_filters: list = None,
        extra_body: dict = None,
        verbose: bool = True,
    ) -> list:
        """
        Call the CRM advanced search API and return the player list.

        Parameters
        ----------
        page_size : int
            Number of records per page (default 10).
        page_number : int
            Page number (1-based).
        account_types : list[int]
            Account types filter, e.g. [2, 1, 0].
        subordinate_type : str
            Subordinate filter type (default "ALL").
        subordinate_name : str
            Target master agent name for API-level filtering.
            Defaults to self.top_agent (from .env TOP_AGENT).
        personal_info_type : str
            Personal info filter (default "BOUND").
        domain_match_type : str
            Domain match mode (default "FUZZY").
        global_filters : list
            Additional global filter objects.
        extra_body : dict
            Extra keys merged into the request body (overrides defaults).

        Returns
        -------
        list[dict]
            Parsed player records (only the 9 fields listed in PLAYER_FIELDS).
        """
        if account_types is None:
            account_types = [2, 1, 0]
        if global_filters is None:
            global_filters = []
        if subordinate_name is None:
            subordinate_name = self.top_agent

        body = {
            "merchantCode": self.merchant_code,
            "subordinateType": subordinate_type,
            "subordinateName": subordinate_name,
            "pageSize": page_size,
            "pageNumber": page_number,
            "accountTypes": account_types,
            "personalInfoType": personal_info_type,
            "domainMatchType": domain_match_type,
            "globalFilters": global_filters,
        }

        if extra_body:
            body.update(extra_body)

        if verbose:
            print(f"\n{'='*60}")
            print(f"🔍 请求玩家高级搜索")
            print(f"{'='*60}")
            print(f"URL: {self.search_url}")
            print(f"Body: {json.dumps(body, ensure_ascii=False, indent=2)}")

        resp = self._post(self.search_url, body)

        if verbose:
            # ── Debug: print raw response structure ──
            print(f"\n{'─'*60}")
            print(f"📦 Raw response keys: {list(resp.keys()) if isinstance(resp, dict) else type(resp).__name__}")
            raw_preview = json.dumps(resp, ensure_ascii=False, indent=2)
            print(f"📦 Raw response preview (first 1000 chars):\n{raw_preview[:1000]}")

        # ── Extract records ──
        records = self._extract_records(resp)
        if verbose:
            print(f"\n📊 Total records in response: {len(records)}")

        # Store raw records for later inspection
        self._last_raw_records = records

        if not records:
            if verbose:
                print("⚠️  No records found in response. Trying common key paths...")
                self._debug_response_structure(resp)
            return []

        # ── Parse each record ──
        players = [self._parse_player(rec) for rec in records]

        return players

    # ------------------------------------------------------------------
    # Record extraction
    # ------------------------------------------------------------------

    def _extract_records(self, resp: dict) -> list:
        """Walk common response structures to find the player record list."""
        if not isinstance(resp, dict):
            return []

        # Common paths
        candidates = [
            resp.get("value", {}).get("contents"),
            resp.get("value", {}).get("records"),
            resp.get("value", {}).get("list"),
            resp.get("value", {}).get("rows"),
            resp.get("value"),
            resp.get("data", {}).get("records"),
            resp.get("data", {}).get("list"),
            resp.get("data", {}).get("rows"),
            resp.get("data", {}).get("content"),
            resp.get("data", {}).get("items"),
            resp.get("data"),
            resp.get("records"),
            resp.get("list"),
            resp.get("rows"),
            resp.get("result"),
        ]

        for c in candidates:
            if isinstance(c, list):
                return c

        # Fallback: walk every value looking for a list of dicts
        for key, val in resp.items():
            if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
                print(f"   (using fallback: resp['{key}'] is a list of dicts)")
                return val

        return []

    def _debug_response_structure(self, resp: dict):
        """Print the keys/types of the response to help debug."""
        def walk(d, depth=0):
            if depth > 3:
                return
            if isinstance(d, dict):
                for k, v in d.items():
                    prefix = "  " * depth
                    if isinstance(v, list):
                        print(f"{prefix}{k}: list[{len(v)}]")
                        if v and depth < 2:
                            print(f"{prefix}  first item keys: {list(v[0].keys()) if isinstance(v[0], dict) else type(v[0]).__name__}")
                    elif isinstance(v, dict):
                        print(f"{prefix}{k}: dict (keys={list(v.keys())[:10]})")
                        walk(v, depth + 1)
                    else:
                        val_str = str(v)[:80]
                        print(f"{prefix}{k}: {type(v).__name__} = {val_str}")
            elif isinstance(d, list):
                print(f"{'  '*depth}list[{len(d)}]")
        walk(resp)

    # ------------------------------------------------------------------
    # Player record parser
    # ------------------------------------------------------------------

    def _parse_player(self, record: dict) -> dict:
        """Extract the 9 target fields from a raw API record."""
        player = {}
        for field in self.PLAYER_FIELDS:
            val = None
            # 1) Direct camelCase match
            if field in record:
                val = record[field]
            # 2) Known aliases
            if val is None:
                for alias in self.FIELD_ALIASES.get(field, []):
                    if alias in record:
                        val = record[alias]
                        break
            # 3) snake_case fallback
            if val is None:
                snake = self._to_snake(field)
                if snake in record:
                    val = record[snake]
            # 4) Case-insensitive fallback
            if val is None:
                for k, v in record.items():
                    if k.lower() == field.lower():
                        val = v
                        break
            player[field] = val
        return player

    @staticmethod
    def _to_snake(camel: str) -> str:
        """customerId -> customer_id"""
        return "".join(
            "_" + c.lower() if c.isupper() else c for c in camel
        ).lstrip("_")

    # ------------------------------------------------------------------
    # Filter helpers
    # ------------------------------------------------------------------

    def filter_target_players(self, players: list, agent_name: str = None) -> list:
        """
        From the full agent downline returned by the API, keep ONLY
        level-4 player accounts (customerType == 0).

        Hierarchy (confirmed from API data):
          customerType = 1  →  agent (L1 培训员 / L2 开发员 / L3 推广)
          customerType = 0  →  player (L4 玩家) ← target

        Rules:
          1. Only keep customerType == 0 (player).
          2. Exclude the agent self (customerName == agent_name) as safety net.

        recommenderName is preserved — it's the player's direct superior agent
        and will be used later to cross-check historical login IPs.

        Parameters
        ----------
        players : list[dict]
            Parsed player records from the API.
        agent_name : str
            The target agent name to exclude (defaults to self.top_agent).

        Returns
        -------
        list[dict]
            Level-4 player accounts only.
        """
        if agent_name is None:
            agent_name = self.top_agent

        PLAYER_TYPE = 0   # customerType == 0 → 4级玩家

        result = []
        for p in players:
            # Rule 1: only level-4 players
            if p.get("customerType") != PLAYER_TYPE:
                continue

            # Rule 2: exclude the agent account itself (safety net)
            if str(p.get("customerName")) == agent_name:
                continue

            result.append(p)

        return result

    # ------------------------------------------------------------------
    # IP Risk Detection (V1 — same-IP rules on existing search fields)
    # ------------------------------------------------------------------

    def build_agent_index(self, records: list) -> dict:
        """
        Build a lookup index from agent customerName → agent record.

        Only customerType == 1 records are indexed (L1/L2/L3 agents).
        """
        agent_map = {}
        for r in records:
            if r.get("customerType") == 1:
                name = r.get("customerName")
                if name:
                    agent_map[str(name)] = r
        return agent_map

    def build_ip_player_index(self, records: list) -> dict:
        """
        Build an IP → player-list index from customerType == 0 records.

        Each player is indexed under both registerIp and lastLoginIp.
        Players are deduped per IP (by customerId).

        Returns dict like:
          {"115.84.97.177": [player1, player2], "103.183.193.143": [player3]}
        """
        ip_index = {}
        players = self.filter_players(records)

        for p in players:
            seen_ids = set()  # per-player dedup
            for ip_key in ("registerIp", "lastLoginIp"):
                ip = _normalize_ip(p.get(ip_key))
                if not ip:
                    continue
                if ip not in ip_index:
                    ip_index[ip] = []
                pid = p.get("customerId")
                if pid not in seen_ids:
                    ip_index[ip].append(p)
                    seen_ids.add(pid)

        return ip_index

    def filter_players(self, records: list) -> list:
        """
        Return only level-4 player records (customerType == 0),
        excluding the agent self-account.
        """
        return self.filter_target_players(records)

    def detect_same_ip_risks(self, records: list, agent_map: dict = None) -> list:
        """
        Compare every level-4 player against their direct superior agent
        using the 4 same-IP rules.

        If agent_map is provided it is used directly (multi-page mode);
        otherwise it is built from records.

        Returns a list of risk_case dicts.
        """
        # ── Build agent index (unless provided) ──
        if agent_map is None:
            agent_map = self.build_agent_index(records)
            print(f"\n  [IP风控] agentMap 已构建: {len(agent_map)} 个代理账号 (customerType=1)")

        # ── Filter players ──
        players = self.filter_players(records)
        print(f"  [IP风控] 玩家账号: {len(players)} 个 (customerType=0)")

        risk_cases = []
        case_counter = 0
        missing_agents = []

        for player in players:
            agent_name = str(player.get("recommenderName") or "")

            if not agent_name:
                continue  # no recommender → can't compare

            agent = agent_map.get(agent_name)
            if agent is None:
                missing_agents.append({
                    "player": player.get("customerName"),
                    "missing_agent": agent_name,
                })
                continue

            # ── Extract IPs ──
            p_reg_ip   = _normalize_ip(player.get("registerIp"))
            p_last_ip  = _normalize_ip(player.get("lastLoginIp"))
            a_reg_ip   = _normalize_ip(agent.get("registerIp"))
            a_last_ip  = _normalize_ip(agent.get("lastLoginIp"))

            matched = False
            risk_type = ""
            risk_level = ""
            matched_ip = ""
            reason = ""

            # Rule A: player.lastLoginIp == agent.lastLoginIp → HIGH
            if p_last_ip and a_last_ip and p_last_ip == a_last_ip:
                case_counter += 1
                risk_cases.append(self._make_risk_case(
                    case_counter, "HIGH", "RULE_A",
                    player, agent, p_last_ip,
                    "玩家上次登录IP == 直属上级代理上次登录IP",
                ))
                matched = True

            # Rule B: player.registerIp == agent.registerIp → HIGH
            if p_reg_ip and a_reg_ip and p_reg_ip == a_reg_ip:
                case_counter += 1
                risk_cases.append(self._make_risk_case(
                    case_counter, "HIGH", "RULE_B",
                    player, agent, p_reg_ip,
                    "玩家注册IP == 直属上级代理注册IP",
                ))
                matched = True

            # Rule C: player.lastLoginIp == agent.registerIp → MEDIUM
            if p_last_ip and a_reg_ip and p_last_ip == a_reg_ip:
                # Avoid duplicate if already matched by Rule A (same IP pair)
                if not (matched and p_last_ip == a_reg_ip):
                    case_counter += 1
                    risk_cases.append(self._make_risk_case(
                        case_counter, "MEDIUM", "RULE_C",
                        player, agent, p_last_ip,
                        "玩家上次登录IP == 直属上级代理注册IP",
                    ))

            # Rule D: player.registerIp == agent.lastLoginIp → MEDIUM
            if p_reg_ip and a_last_ip and p_reg_ip == a_last_ip:
                # Avoid duplicate if already matched by Rule B
                if not (matched and p_reg_ip == a_last_ip):
                    case_counter += 1
                    risk_cases.append(self._make_risk_case(
                        case_counter, "MEDIUM", "RULE_D",
                        player, agent, p_reg_ip,
                        "玩家注册IP == 直属上级代理登录IP",
                    ))

        # ── Report missing agents ──
        if missing_agents:
            print(f"\n  ⚠️  [IP风控] {len(missing_agents)} 个玩家找不到直属上级代理:")
            for m in missing_agents:
                print(f"      玩家 {m['player']} → recommenderName={m['missing_agent']} (不在当前页)")

        return risk_cases

    # ------------------------------------------------------------------
    # Multi-page scanner
    # ------------------------------------------------------------------

    def search_all_pages(self, max_pages: int = 10, page_size: int = 100,
                         page_sleep: float = 0.5) -> dict:
        """
        Paginate through the search API, collect all records, then run
        a single global IP risk detection pass with the full agent index.

        Parameters
        ----------
        max_pages : int
            Maximum number of pages to fetch (default 10).
        page_size : int
            Records per page (default 100).
        page_sleep : float
            Seconds to sleep between pages (default 0.5).

        Returns
        -------
        dict with keys:
          total_records_checked, total_agents, total_players,
          total_missing_agents, total_risk_cases, pages_fetched,
          all_risk_cases (list), page_log (list of per-page stats)
        """
        all_records = []
        page_log = []

        print(f"\n{'='*70}")
        print(f"📖 分页扫描开始 (max_pages={max_pages}, page_size={page_size})")
        print(f"{'='*70}")

        for page in range(1, max_pages + 1):
            players = self.searchPlayers(
                page_size=page_size,
                page_number=page,
                verbose=False,
            )

            if not players:
                print(f"  Page {page}: 空数据，停止扫描。")
                break

            all_records.extend(players)

            # Per-page quick counts
            agents_n = sum(1 for p in players if p.get("customerType") == 1)
            players_n = sum(1 for p in players if p.get("customerType") == 0)

            page_log.append({
                "page": page,
                "records": len(players),
                "agents": agents_n,
                "players": players_n,
            })

            print(f"  Page {page:>3}/{max_pages}: "
                  f"records={len(players):>3}, "
                  f"players={players_n:>3}, "
                  f"agents={agents_n:>3}")

            time.sleep(page_sleep)

        print(f"\n  ── 扫描完成: {len(page_log)} 页, {len(all_records)} 条记录 ──")

        # ── Global pass: build index + detect risks from ALL collected records ──
        agent_map = self.build_agent_index(all_records)
        all_players = self.filter_players(all_records)

        print(f"  [全局] agentMap: {len(agent_map)} 个代理")
        print(f"  [全局] players:  {len(all_players)} 个玩家")

        # Count missing agents (player's recommender not in agent_map)
        missing_agents = 0
        for p in all_players:
            agent_name = str(p.get("recommenderName") or "")
            if agent_name and agent_name not in agent_map:
                missing_agents += 1

        if missing_agents:
            print(f"  [全局] missing_agents: {missing_agents} (上级代理不在 {len(page_log)} 页范围内)")

        # Single risk detection pass
        risk_cases = self.detect_same_ip_risks_global(all_records, agent_map)

        # Re-number cases
        for idx, rc in enumerate(risk_cases, 1):
            rc["case_no"] = idx

        print(f"  [全局] risk_cases: {len(risk_cases)}")

        return {
            "total_records_checked": len(all_records),
            "total_agents": len(agent_map),
            "total_players": len(all_players),
            "total_missing_agents": missing_agents,
            "total_risk_cases": len(risk_cases),
            "pages_fetched": len(page_log),
            "all_risk_cases": risk_cases,
            "page_log": page_log,
        }

    def detect_same_ip_risks_global(self, records: list, agent_map: dict) -> list:
        """
        Silent global risk detection (used by search_all_pages).

        1. Builds ip_player_index for same-IP lookup.
        2. Detects raw rule matches (RULE_A/B/C/D).
        3. Groups by player_customer_id → merged risk_case.
        4. Enriches each case with same_ip_players from the index.
        """
        ip_player_index = self.build_ip_player_index(records)
        players = self.filter_players(records)

        # ── Step 1: collect raw hits, keyed by player_customer_id ──
        hits_by_player = {}  # {player_id: {player, agent, hits: [{rule, ip, reason}]}}

        for player in players:
            agent_name = str(player.get("recommenderName") or "")
            if not agent_name:
                continue

            agent = agent_map.get(agent_name)
            if agent is None:
                continue

            pid = player.get("customerId")
            p_reg_ip  = _normalize_ip(player.get("registerIp"))
            p_last_ip = _normalize_ip(player.get("lastLoginIp"))
            a_reg_ip  = _normalize_ip(agent.get("registerIp"))
            a_last_ip = _normalize_ip(agent.get("lastLoginIp"))

            hits = []
            matched_prev = False

            # Rule A
            if p_last_ip and a_last_ip and p_last_ip == a_last_ip:
                hits.append({"rule": "RULE_A", "ip": p_last_ip,
                             "reason": "玩家上次登录IP == 直属上级代理上次登录IP"})
                matched_prev = True

            # Rule B
            if p_reg_ip and a_reg_ip and p_reg_ip == a_reg_ip:
                hits.append({"rule": "RULE_B", "ip": p_reg_ip,
                             "reason": "玩家注册IP == 直属上级代理注册IP"})
                matched_prev = True

            # Rule C
            if p_last_ip and a_reg_ip and p_last_ip == a_reg_ip:
                if not (matched_prev and p_last_ip == a_reg_ip):
                    hits.append({"rule": "RULE_C", "ip": p_last_ip,
                                 "reason": "玩家上次登录IP == 直属上级代理注册IP"})

            # Rule D
            if p_reg_ip and a_last_ip and p_reg_ip == a_last_ip:
                if not (matched_prev and p_reg_ip == a_last_ip):
                    hits.append({"rule": "RULE_D", "ip": p_reg_ip,
                                 "reason": "玩家注册IP == 直属上级代理登录IP"})

            if hits:
                hits_by_player[pid] = {"player": player, "agent": agent, "hits": hits}

        # ── Step 2: merge into risk_cases with same_ip_players ──
        risk_cases = []
        for pid, entry in hits_by_player.items():
            player = entry["player"]
            agent = entry["agent"]

            # Collect unique matched IPs and rules
            matched_ips = []
            risk_types = []
            reasons = []
            seen_ip = set()
            seen_rule = set()
            for h in entry["hits"]:
                if h["rule"] not in seen_rule:
                    risk_types.append(h["rule"])
                    seen_rule.add(h["rule"])
                if h["ip"] not in seen_ip:
                    matched_ips.append(h["ip"])
                    seen_ip.add(h["ip"])
                if h["reason"] not in reasons:
                    reasons.append(h["reason"])

            # Risk level: HIGH if any HIGH rule, else MEDIUM
            risk_level = "HIGH" if any(r in ("RULE_A", "RULE_B") for r in risk_types) else "MEDIUM"

            # ── Build same_ip_players from index ──
            same_ip_players = []
            seen_pids = set()
            for ip in matched_ips:
                for sp in ip_player_index.get(ip, []):
                    spid = sp.get("customerId")
                    if spid not in seen_pids:
                        same_ip_players.append(sp)
                        seen_pids.add(spid)

            risk_cases.append({
                "risk_level":              risk_level,
                "risk_types":              risk_types,
                "reasons":                 reasons,
                "matched_ips":             matched_ips,
                "player_name":             player.get("customerName"),
                "player_customer_id":      player.get("customerId"),
                "player_register_ip":      player.get("registerIp"),
                "player_last_login_ip":    player.get("lastLoginIp"),
                "player_register_time":    player.get("registerTime"),
                "player_last_login_time":  player.get("lastLoginTime"),
                "direct_agent_name":       agent.get("customerName"),
                "agent_register_ip":       agent.get("registerIp"),
                "agent_last_login_ip":     agent.get("lastLoginIp"),
                "agent_register_time":     agent.get("registerTime"),
                "agent_last_login_time":   agent.get("lastLoginTime"),
                "same_ip_players":         same_ip_players,
                "same_ip_player_count":    len(same_ip_players),
                "created_at":              datetime.now(timezone.utc).isoformat(),
            })

        return risk_cases

    def _make_risk_case(self, case_no: int, risk_level: str, risk_type: str,
                        player: dict, agent: dict, matched_ip: str,
                        reason: str) -> dict:
        """Assemble a single risk_case dict."""
        return {
            "case_no":               case_no,
            "risk_level":            risk_level,
            "risk_type":             risk_type,
            "player_name":           player.get("customerName"),
            "player_customer_id":    player.get("customerId"),
            "player_register_ip":    player.get("registerIp"),
            "player_last_login_ip":  player.get("lastLoginIp"),
            "player_register_time":  player.get("registerTime"),
            "player_last_login_time":player.get("lastLoginTime"),
            "direct_agent_name":     agent.get("customerName"),
            "agent_register_ip":     agent.get("registerIp"),
            "agent_last_login_ip":   agent.get("lastLoginIp"),
            "agent_register_time":   agent.get("registerTime"),
            "agent_last_login_time": agent.get("lastLoginTime"),
            "matched_ip":            matched_ip,
            "reason":                reason,
            "created_at":            datetime.now(timezone.utc).isoformat(),
        }

    # ------------------------------------------------------------------
    # Print helpers
    # ------------------------------------------------------------------

    def print_players(self, players: list, title: str = "Player List"):
        """Pretty-print a list of parsed player records."""
        if not players:
            print(f"\n⚠️  {title}: (empty)")
            return

        print(f"\n{'='*60}")
        print(f"📋 {title} ({len(players)} players)")
        print(f"{'='*60}")

        for i, p in enumerate(players, 1):
            print(f"\n── Player #{i} ──")
            print(f"  customerName:     {p.get('customerName')}")
            print(f"  customerType:     {p.get('customerType')}")
            print(f"  masterAgentName:  {p.get('masterAgentName')}")
            print(f"  recommenderName:  {p.get('recommenderName')}")
            print(f"  registerIp:       {p.get('registerIp')}")
            print(f"  lastLoginIp:      {p.get('lastLoginIp')}")
            print(f"  registerTime:     {p.get('registerTime')}")
            print(f"  firstDepositDate: {p.get('firstDepositDate')}")

    def print_raw_records(self, records: list = None, title: str = "Raw API Records"):
        """
        Print ALL fields from raw API records (before field subset parsing).
        Use this to discover field names, level/tier indicators, etc.
        """
        if records is None:
            records = getattr(self, "_last_raw_records", [])

        if not records:
            print(f"\n⚠️  {title}: (empty)")
            return

        print(f"\n{'='*70}")
        print(f"📋 {title} ({len(records)} records — ALL fields)")
        print(f"{'='*70}")

        # Collect all unique keys across records (sorted, important fields first)
        PRIORITY_PREFIXES = [
            "customer", "account", "agent", "level", "tier", "role",
            "master", "recommend", "referrer", "subordin", "user",
            "register", "login", "last", "first", "deposit",
        ]

        all_keys = []
        for rec in records:
            for k in rec:
                if k not in all_keys:
                    all_keys.append(k)

        # Sort: priority keys first, then alphabetical
        def sort_key(k):
            k_lower = k.lower()
            for idx, prefix in enumerate(PRIORITY_PREFIXES):
                if k_lower.startswith(prefix):
                    return (0, idx, k_lower)
            return (1, 0, k_lower)

        all_keys.sort(key=sort_key)

        # Print all keys once as a reference header
        print(f"\n  Fields present ({len(all_keys)}):")
        print(f"  {', '.join(all_keys)}")

        # Print each record
        for i, rec in enumerate(records, 1):
            print(f"\n── Record #{i} ──")
            for key in all_keys:
                val = rec.get(key)
                # Truncate long values for readability
                if isinstance(val, str) and len(val) > 80:
                    val = val[:77] + "..."
                if isinstance(val, dict) and len(val) > 0:
                    val = f"dict(keys={list(val.keys())[:6]})"
                if isinstance(val, list) and len(val) > 0:
                    val = f"list[{len(val)}]"
                print(f"  {key:30s} = {val}")


    def print_risk_cases(self, risk_cases: list, max_same_ip_display: int = 20):
        """Print risk cases (v2 merged format with same-IP players)."""
        if not risk_cases:
            print(f"\n{'='*70}")
            print(f"✅ 无 IP 风控告警")
            print(f"{'='*70}")
            return

        print(f"\n{'='*70}")
        print(f"🚨 IP 风控告警 ({len(risk_cases)} 个独立玩家)")
        print(f"{'='*70}")

        for rc in risk_cases:
            level_icon = "🔴" if rc["risk_level"] == "HIGH" else "🟡"
            rules_str = " + ".join(rc.get("risk_types", []))
            reasons_str = "; ".join(rc.get("reasons", []))
            ips_str = ", ".join(rc.get("matched_ips", []))

            print(f"\n{'─'*60}")
            print(f"  {level_icon} Case #{rc.get('case_no', '?')}  [{rc['risk_level']}] {rules_str}")
            print(f"  Reasons: {reasons_str}")
            print(f"  🎯 Matched IPs: {ips_str}")
            print(f"")

            print(f"  风险玩家:")
            print(f"    customerName:   {rc['player_name']}")
            print(f"    customerId:     {rc['player_customer_id']}")
            print(f"    registerIp:     {rc['player_register_ip']}")
            print(f"    lastLoginIp:    {rc['player_last_login_ip']}")
            print(f"    registerTime:   {rc['player_register_time']}")
            print(f"    lastLoginTime:  {rc['player_last_login_time']}")
            print(f"")

            print(f"  直属上级代理:")
            print(f"    customerName:   {rc['direct_agent_name']}")
            print(f"    registerIp:     {rc['agent_register_ip']}")
            print(f"    lastLoginIp:    {rc['agent_last_login_ip']}")
            print(f"    registerTime:   {rc['agent_register_time']}")
            print(f"    lastLoginTime:  {rc['agent_last_login_time']}")
            print(f"")

            # ── Same-IP players ──
            same_ip = rc.get("same_ip_players", [])
            total = rc.get("same_ip_player_count", len(same_ip))
            displayed = same_ip[:max_same_ip_display]

            print(f"  同 IP 玩家账号 (共 {total} 人):")
            if not displayed:
                print(f"    (无)")
            else:
                for idx, sp in enumerate(displayed, 1):
                    marker = "← 本案例玩家" if sp.get("customerId") == rc.get("player_customer_id") else ""
                    print(f"    {idx}. {sp.get('customerName')}  {marker}")
                    print(f"       上级代理: {sp.get('recommenderName')}")
                    print(f"       注册 IP:  {sp.get('registerIp')}")
                    print(f"       上次登录: {sp.get('lastLoginIp')}")
                    print(f"       注册时间: {sp.get('registerTime')}")
                    print(f"       上次登录: {sp.get('lastLoginTime')}")

                if total > max_same_ip_display:
                    remaining = total - max_same_ip_display
                    print(f"    ⚠️  还有 {remaining} 个同 IP 玩家未展示。")

            print(f"")
            print(f"  📅 Created: {rc['created_at']}")

    # ------------------------------------------------------------------
    # Fingerprint / dedup helpers
    # ------------------------------------------------------------------

    @staticmethod
    def build_case_fingerprint(rc: dict) -> str:
        """
        Build a stable, sort-independent fingerprint for a risk_case.

        Format:
          player_customer_id|direct_agent_name|sorted_ips|sorted_rules
        """
        pid = rc.get("player_customer_id", "")
        agent = rc.get("direct_agent_name", "")
        ips = "|".join(sorted(rc.get("matched_ips", [])))
        rules = ",".join(sorted(rc.get("risk_types", [])))
        return f"{pid}|{agent}|{ips}|{rules}"

    def _sent_path(self) -> str:
        return os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "sent_risk_cases.json")

    def load_sent_fingerprints(self, path: str = None) -> set:
        """
        Load previously-sent fingerprints from JSON.

        Returns empty set if file missing or corrupted (never crashes).
        """
        if path is None:
            path = self._sent_path()

        if not os.path.isfile(path):
            return set()

        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                return set(data)
            return set()
        except (json.JSONDecodeError, IOError) as e:
            print(f"  ⚠️  sent_risk_cases.json 损坏，重置为空: {e}")
            return set()

    def save_sent_fingerprints(self, fingerprints: set, path: str = None):
        """Save fingerprint set to JSON array."""
        if path is None:
            path = self._sent_path()

        data = sorted(fingerprints)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def filter_unsent_risk_cases(self, risk_cases: list) -> tuple:
        """
        Split risk_cases into (unsent, already_sent) based on fingerprints.

        Returns (to_send: list, skipped: int).
        """
        sent_set = self.load_sent_fingerprints()
        to_send = []
        skipped = 0

        for rc in risk_cases:
            fp = self.build_case_fingerprint(rc)
            if fp in sent_set:
                skipped += 1
            else:
                # Attach fingerprint for later save-on-success
                rc["_fingerprint"] = fp
                to_send.append(rc)

        return to_send, skipped

    # ------------------------------------------------------------------
    # Telegram alerting
    # ------------------------------------------------------------------

    def _tg_configured(self) -> bool:
        return bool(self.tg_token and self.tg_chat_id)

    def get_telegram_updates_chat_ids(self) -> list:
        """
        Debug helper — call getUpdates and print every chat the bot can see.

        Does NOT print the token or the full URL.
        Returns list of {chat_id, chat_title, chat_type, update_id, ...}.
        """
        if not self.tg_token:
            print("⚠️  TELEGRAM_BOT_TOKEN 未配置，跳过。")
            return []

        url = f"{self.tg_api}/getUpdates"
        req = urllib.request.Request(url)

        print(f"\n{'='*60}")
        print(f"🔍 Telegram getUpdates — Bot 可见的 Chat")
        print(f"{'='*60}")

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            print(f"❌ getUpdates 请求失败: {e}")
            return []

        if not data.get("ok"):
            print(f"❌ Telegram API error: {data.get('description', data)}")
            return []

        results = data.get("result", [])
        if not results:
            print(f"\n⚠️  getUpdates 返回空。")
            print(f"   请在「审核IP」群里发送一条消息（例如 \"test\"），")
            print(f"   然后重新运行此调试方法。")
            return []

        print(f"\n📊 共 {len(results)} 条 update\n")

        found = []
        seen_chats = {}

        for upd in results:
            update_id = upd.get("update_id")
            msg = upd.get("message") or upd.get("channel_post") or {}
            chat = msg.get("chat", {})
            cid = chat.get("id")
            title = chat.get("title", "")
            ctype = chat.get("type", "")
            text = (msg.get("text") or msg.get("caption") or "")[:80]
            from_user = (msg.get("from") or {}).get("username", "")

            print(f"  update_id={update_id}")
            print(f"    chat_id:    {cid}")
            print(f"    chat_title: {title}")
            print(f"    chat_type:  {ctype}")
            print(f"    from:       @{from_user}" if from_user else f"    from:       (no username)")
            print(f"    text:       {text}")
            print()

            if cid:
                entry = {
                    "update_id": update_id,
                    "chat_id": cid,
                    "chat_title": title,
                    "chat_type": ctype,
                    "from_username": from_user,
                    "message_text": text,
                }
                found.append(entry)
                seen_chats[cid] = entry

        # ── Summary ──
        print(f"{'─'*60}")
        print(f"📋 去重后的 Chat 列表 ({len(seen_chats)} 个):")
        for cid, entry in seen_chats.items():
            print(f"    chat_id={cid}  title=\"{entry['chat_title']}\"  type={entry['chat_type']}")

        # ── Suggest .env value ──
        for cid, entry in seen_chats.items():
            if "审核IP" in entry.get("chat_title", ""):
                print(f"\n✅ 找到群「审核IP」！")
                print(f"   请在 .env 中确认或修改：")
                print(f"   TELEGRAM_ALERT_CHAT_ID={cid}")
                break
        else:
            if seen_chats:
                print(f"\n⚠️  未找到群名包含「审核IP」的 chat。")
                print(f"   请在上方列表中确认正确的 chat_id，然后手动修改 .env：")
                for cid in seen_chats:
                    print(f"   TELEGRAM_ALERT_CHAT_ID={cid}")

        return found

    def send_telegram_message(self, text: str) -> bool:
        """
        Send a plain-text message to the configured Telegram chat.

        Returns True on success, False on failure.
        """
        if not self._tg_configured():
            print("  ⚠️  Telegram 未配置 (TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID)，跳过发送。")
            return False

        # Truncate to Telegram's 4096 char limit
        if len(text) > 4000:
            text = text[:4000] + "\n\n... (截断)"

        payload = json.dumps({
            "chat_id": self.tg_chat_id,
            "text": text,
            "parse_mode": "HTML",
        }).encode("utf-8")

        url = f"{self.tg_api}/sendMessage"
        req = urllib.request.Request(url, data=payload,
                                     headers={"Content-Type": "application/json"})

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                if body.get("ok"):
                    return True
                else:
                    print(f"  ⚠️  Telegram API error: {body.get('description', body)}")
                    return False
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            print(f"  ⚠️  Telegram HTTP {e.code}: {err_body[:500]}")
            return False
        except Exception as e:
            print(f"  ⚠️  Telegram 发送失败: {e}")
            return False

    @staticmethod
    def _format_risk_telegram(rc: dict, max_same_ip: int = 10) -> str:
        """Format a single risk_case into a Telegram message string."""
        level_icon = "🔴" if rc["risk_level"] == "HIGH" else "🟡"
        rules_str = " + ".join(rc.get("risk_types", []))
        ips_str = "\n".join(f"• <code>{ip}</code>" for ip in rc.get("matched_ips", []))

        lines = [
            f"{level_icon} <b>IP 风控告警 | {rc['risk_level']}</b>",
            f"",
            f"<b>玩家账号：</b>{rc['player_name']}",
            f"<b>直属上级：</b>{rc['direct_agent_name']}",
            f"<b>风险等级：</b>{rc['risk_level']}",
            f"<b>命中规则：</b>{rules_str}",
            f"",
            f"<b>命中 IP：</b>",
            ips_str,
            f"",
            f"<b>玩家 IP：</b>",
            f"注册 IP：<code>{rc['player_register_ip'] or 'N/A'}</code>",
            f"上次登录：<code>{rc['player_last_login_ip'] or 'N/A'}</code>",
            f"注册时间：{rc['player_register_time'] or 'N/A'}",
            f"上次登录：{rc['player_last_login_time'] or 'N/A'}",
            f"",
            f"<b>直属上级代理 IP：</b>",
            f"注册 IP：<code>{rc['agent_register_ip'] or 'N/A'}</code>",
            f"上次登录：<code>{rc['agent_last_login_ip'] or 'N/A'}</code>",
            f"注册时间：{rc['agent_register_time'] or 'N/A'}",
            f"上次登录：{rc['agent_last_login_time'] or 'N/A'}",
        ]

        # Same-IP players
        same_ip = rc.get("same_ip_players", [])
        total = rc.get("same_ip_player_count", len(same_ip))
        lines.append(f"")
        lines.append(f"<b>同 IP 玩家账号：</b>")
        lines.append(f"总数：{total}")

        displayed = same_ip[:max_same_ip]
        for idx, sp in enumerate(displayed, 1):
            marker = " ← 本案例" if sp.get("customerId") == rc.get("player_customer_id") else ""
            lines.append(f"")
            lines.append(f"{idx}. <b>{sp.get('customerName')}</b>{marker}")
            lines.append(f"   上级代理：{sp.get('recommenderName')}")
            lines.append(f"   注册 IP：<code>{sp.get('registerIp') or 'N/A'}</code>")
            lines.append(f"   上次登录：<code>{sp.get('lastLoginIp') or 'N/A'}</code>")

        if total > max_same_ip:
            lines.append(f"")
            lines.append(f"⚠️ 还有 {total - max_same_ip} 个同 IP 玩家未展示。")

        lines.append(f"")
        lines.append(f"<i>案件时间：{rc.get('created_at', 'N/A')}</i>")

        return "\n".join(lines)

    def send_risk_cases_to_telegram(self, risk_cases: list) -> dict:
        """
        Send UNSENT risk_cases to Telegram, with dedup via sent_risk_cases.json.

        - Filters out already-sent cases by fingerprint.
        - Only saves fingerprint AFTER successful send.
        - Failed sends are NOT saved (retried next run).

        Returns dict with counts: {total, skipped, to_send, sent, failed}.
        """
        total = len(risk_cases)

        if not self._tg_configured():
            print("\n⚠️  Telegram 未配置，跳过告警发送。")
            print("   请在 .env 中设置 TELEGRAM_BOT_TOKEN 和 TELEGRAM_ALERT_CHAT_ID")
            return {"total": total, "skipped": total, "to_send": 0, "sent": 0, "failed": 0}

        if not risk_cases:
            print("\n✅ 无 risk_cases，不发送 Telegram。")
            return {"total": 0, "skipped": 0, "to_send": 0, "sent": 0, "failed": 0}

        # ── Dedup ──
        to_send, skipped = self.filter_unsent_risk_cases(risk_cases)

        print(f"\n📤 Telegram 告警")
        print(f"   risk_cases total:   {total}")
        print(f"   already_sent skip:  {skipped}")
        print(f"   to_send:            {len(to_send)}")

        if not to_send:
            print(f"   ✅ 无新案件需要发送。")
            return {"total": total, "skipped": skipped, "to_send": 0, "sent": 0, "failed": 0}

        # ── Load current sent set ──
        sent_set = self.load_sent_fingerprints()
        sent, failed = 0, 0

        for rc in to_send:
            fp = rc.get("_fingerprint", "")
            text = self._format_risk_telegram(rc)
            ok = self.send_telegram_message(text)
            if ok:
                sent += 1
                sent_set.add(fp)
                self.save_sent_fingerprints(sent_set)  # persist immediately
                print(f"  ✅ Telegram sent (fingerprint saved)")
            else:
                failed += 1
                print(f"  ❌ Telegram failed (fingerprint NOT saved, will retry)")

            if len(to_send) > 1:
                time.sleep(0.5)

        print(f"  ── 发送完成: sent={sent}, failed={failed} ──")
        return {"total": total, "skipped": skipped, "to_send": len(to_send),
                "sent": sent, "failed": failed}

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    @staticmethod
    def _trim_player(p: dict) -> dict:
        """Extract only the fields needed for same_ip_players in JSON output."""
        return {
            "customerName":    p.get("customerName"),
            "customerId":      p.get("customerId"),
            "recommenderName": p.get("recommenderName"),
            "registerIp":      p.get("registerIp"),
            "lastLoginIp":     p.get("lastLoginIp"),
            "registerTime":    p.get("registerTime"),
            "lastLoginTime":   p.get("lastLoginTime"),
        }

    def save_risk_cases(self, risk_cases: list, output_dir: str = None):
        """
        Save risk_cases to JSON files.

        Writes two files:
          - risk_cases_latest.json       (always overwritten)
          - risk_cases_YYYYMMDD_HHMMSS.json  (timestamped copy)

        Parameters
        ----------
        risk_cases : list
            List of risk_case dicts (v2 merged format).
        output_dir : str
            Directory for output files (defaults to script directory).
        """
        if output_dir is None:
            output_dir = os.path.dirname(os.path.abspath(__file__))

        # ── Add case numbers and trim same_ip_players ──
        output = []
        for idx, rc in enumerate(risk_cases, 1):
            trimmed = dict(rc)  # shallow copy
            trimmed["case_no"] = idx
            trimmed["same_ip_players"] = [
                self._trim_player(sp) for sp in rc.get("same_ip_players", [])
            ]
            output.append(trimmed)

        # ── Write latest ──
        latest_path = os.path.join(output_dir, "risk_cases_latest.json")
        with open(latest_path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        print(f"\n📁 risk_cases 已保存: {latest_path} ({len(output)} cases)")

        # ── Write timestamped copy ──
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        ts_path = os.path.join(output_dir, f"risk_cases_{ts}.json")
        with open(ts_path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        print(f"📁 时间戳副本:       {ts_path}")


# ---------------------------------------------------------------------------
# ── Main: quick self-test ──
# ---------------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Single run
    # ------------------------------------------------------------------

    def run_once(self):
        """Single scan: 10 pages → risk → save JSON → Telegram (with dedup)."""
        print("\n\n🚀 once 模式：单次扫描 + 风控 + Telegram\n")

        result = self.search_all_pages(max_pages=10, page_size=100, page_sleep=0.5)

        # ── Summary ──
        print(f"\n{'='*70}")
        print(f"📊 扫描汇总")
        print(f"{'='*70}")
        print(f"   subordinateName:     {self.top_agent}")
        print(f"   已扫描页数:          {result['pages_fetched']}")
        print(f"   总记录数:            {result['total_records_checked']}")
        print(f"   代理账号 (ct=1):     {result['total_agents']}")
        print(f"   玩家账号 (ct=0):     {result['total_players']}")
        print(f"   缺失上级代理:        {result['total_missing_agents']}")
        print(f"   命中风险:            {result['total_risk_cases']}")
        print(f"{'='*70}")

        self.print_risk_cases(result["all_risk_cases"])
        self.save_risk_cases(result["all_risk_cases"])
        self.send_risk_cases_to_telegram(result["all_risk_cases"])

    # ------------------------------------------------------------------
    # Agent cache (avoid re-fetching agents not in daily batch)
    # ------------------------------------------------------------------

    def _agent_cache_path(self) -> str:
        return os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "direct_agents_cache.json")

    def load_agent_cache(self, path: str = None) -> dict:
        """Load cached agent records. Returns {} on missing/corrupted file."""
        if path is None:
            path = self._agent_cache_path()
        if not os.path.isfile(path):
            return {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
            return {}
        except (json.JSONDecodeError, IOError) as e:
            print(f"  ⚠️  direct_agents_cache.json 损坏，重置: {e}")
            return {}

    def save_agent_cache(self, cache: dict, path: str = None):
        """Persist agent cache to JSON."""
        if path is None:
            path = self._agent_cache_path()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)

    def fetch_agent_by_name(self, agent_name: str) -> dict:
        """
        Call searchPlayers with subordinateName=agent_name to find the
        agent's own record (customerType=1, customerName==agent_name).

        Returns the parsed agent record dict, or None if not found.
        """
        players = self.searchPlayers(
            page_size=10,
            page_number=1,
            subordinate_name=agent_name,
            verbose=False,
        )
        for p in players:
            if (p.get("customerType") == 1
                    and str(p.get("customerName")) == agent_name):
                return p
        return None

    def get_agent_with_cache(self, agent_name: str, cache: dict) -> tuple:
        """
        Look up an agent, using cache when possible.

        Returns (agent_record, status) where status is one of:
          "cache_hit", "fetched", "not_found".
        """
        if agent_name in cache:
            return cache[agent_name], "cache_hit"

        agent = self.fetch_agent_by_name(agent_name)
        if agent is not None:
            cache[agent_name] = agent
            return agent, "fetched"

        return None, "not_found"

    # ------------------------------------------------------------------
    # Date‑offset registration helpers
    # ------------------------------------------------------------------

    @staticmethod
    def get_registration_range_gmt8(days_offset: int = 0) -> dict:
        """
        Return a GMT+8 day window in UTC ISO strings.

        days_offset=0 → today     (GMT+8)
        days_offset=1 → yesterday
        days_offset=2 → day before yesterday

        Returns {"registrationStartTime", "registrationEndTime", "date_gmt8"}.
        """
        gmt8 = timezone(timedelta(hours=8))
        now = datetime.now(gmt8)
        target = now - timedelta(days=days_offset)
        start = target.replace(hour=0, minute=0, second=0, microsecond=0)
        end   = target.replace(hour=23, minute=59, second=59, microsecond=0)

        start_utc = start.astimezone(timezone.utc)
        end_utc   = end.astimezone(timezone.utc)

        return {
            "registrationStartTime": start_utc.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "registrationEndTime":   end_utc.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "date_gmt8":             target.strftime("%Y-%m-%d"),
        }

    @staticmethod
    def get_today_registration_range_gmt8() -> dict:
        """Convenience wrapper for days_offset=0."""
        return BackendClient.get_registration_range_gmt8(days_offset=0)

    @staticmethod
    def get_yesterday_registration_range_gmt8() -> dict:
        """Convenience wrapper for days_offset=1."""
        return BackendClient.get_registration_range_gmt8(days_offset=1)

    def search_registered_pages_by_offset(self, days_offset: int = 0,
                                          max_pages: int = 10,
                                          page_size: int = 100,
                                          page_sleep: float = 0.5) -> dict:
        """
        Paginate through accounts registered on a specific day (GMT+8).

        days_offset=0 → today, 1 → yesterday, etc.
        """
        date_range = self.get_registration_range_gmt8(days_offset)
        date_str = date_range["date_gmt8"]

        label = {0: "今日", 1: "昨日"}.get(days_offset, f"days_offset={days_offset}")

        all_records = []
        page_log = []

        print(f"\n{'='*70}")
        print(f"📖 {label}注册扫描 (GMT+8 {date_str})")
        print(f"   {date_range['registrationStartTime']}  →  {date_range['registrationEndTime']}")
        print(f"   max_pages={max_pages}, page_size={page_size}")
        print(f"{'='*70}")

        for page in range(1, max_pages + 1):
            players = self.searchPlayers(
                page_size=page_size,
                page_number=page,
                verbose=False,
                extra_body={
                    "registrationStartTime": date_range["registrationStartTime"],
                    "registrationEndTime":   date_range["registrationEndTime"],
                },
            )

            if not players:
                print(f"  Page {page}: 空数据，停止扫描。")
                break

            all_records.extend(players)

            agents_n = sum(1 for p in players if p.get("customerType") == 1)
            players_n = sum(1 for p in players if p.get("customerType") == 0)

            page_log.append({
                "page": page,
                "records": len(players),
                "agents": agents_n,
                "players": players_n,
            })

            print(f"  Page {page:>3}/{max_pages}: "
                  f"records={len(players):>3}, "
                  f"players={players_n:>3}, "
                  f"agents={agents_n:>3}")

            time.sleep(page_sleep)

        print(f"\n  ── {label}扫描完成: {len(page_log)} 页, {len(all_records)} 条记录 ──")

        # ── Global pass: build agent map from batch + backfill from cache/API ──
        agent_map = self.build_agent_index(all_records)
        all_players = self.filter_players(all_records)

        agents_in_batch = len(agent_map)

        # ── Find missing agent names ──
        missing_names = set()
        for p in all_players:
            an = str(p.get("recommenderName") or "")
            if an and an not in agent_map:
                missing_names.add(an)

        # ── Backfill from cache + API ──
        cache = self.load_agent_cache()
        cache_hits = 0
        fetched = 0
        fetch_failed = 0

        if missing_names:
            print(f"\n  🔍 直属上级代理补查 ({len(missing_names)} 个缺失):")
            for an in sorted(missing_names):
                agent, status = self.get_agent_with_cache(an, cache)
                if status == "cache_hit":
                    cache_hits += 1
                    agent_map[an] = agent
                elif status == "fetched":
                    fetched += 1
                    agent_map[an] = agent
                    time.sleep(0.2)   # rate-limit API calls
                    print(f"      补查: {an}")
                else:
                    fetch_failed += 1

            if cache_hits or fetched:
                self.save_agent_cache(cache)

        remaining_missing = 0
        for p in all_players:
            an = str(p.get("recommenderName") or "")
            if an and an not in agent_map:
                remaining_missing += 1

        # ── Risk detection ──
        risk_cases = self.detect_same_ip_risks_global(all_records, agent_map)
        for idx, rc in enumerate(risk_cases, 1):
            rc["case_no"] = idx

        # ── Stats ──
        print(f"\n  {'─'*50}")
        print(f"  📊 代理补查统计:")
        print(f"     今日/昨日注册玩家数:   {len(all_players)}")
        print(f"     当前返回代理数:        {agents_in_batch}")
        print(f"     缺失直属上级代理数:    {len(missing_names)}")
        print(f"     缓存命中代理数:        {cache_hits}")
        print(f"     新补查代理数:          {fetched}")
        print(f"     补查失败代理数:        {fetch_failed}")
        print(f"     最终 agentMap 数量:    {len(agent_map)}")
        print(f"     risk_cases 数量:       {len(risk_cases)}")
        print(f"  {'─'*50}")

        return {
            "total_records_checked": len(all_records),
            "total_agents": len(agent_map),
            "total_players": len(all_players),
            "total_missing_agents": remaining_missing,
            "total_risk_cases": len(risk_cases),
            "pages_fetched": len(page_log),
            "all_risk_cases": risk_cases,
            "page_log": page_log,
            "date_range": date_range,
            "date_gmt8": date_str,
            "days_offset": days_offset,
        }

    def _run_day_offset_once(self, days_offset: int):
        """Shared runner for today/yesterday once modes."""
        label = {0: "今日", 1: "昨日"}.get(days_offset, f"偏移{days_offset}天")
        mode_name = {0: "today_once", 1: "yesterday_once"}.get(days_offset, f"day_offset_{days_offset}_once")

        print(f"\n\n🚀 {mode_name} 模式：{label}注册扫描 + 风控 + Telegram\n")

        result = self.search_registered_pages_by_offset(
            days_offset=days_offset, max_pages=10, page_size=100)

        print(f"\n{'='*70}")
        print(f"📊 {label}扫描汇总 (GMT+8 {result.get('date_gmt8', '?')})")
        print(f"{'='*70}")
        print(f"   subordinateName:     {self.top_agent}")
        print(f"   已扫描页数:          {result['pages_fetched']}")
        print(f"   总记录数:            {result['total_records_checked']}")
        print(f"   代理账号 (ct=1):     {result['total_agents']}")
        print(f"   玩家账号 (ct=0):     {result['total_players']}")
        print(f"   缺失上级代理:        {result['total_missing_agents']}")
        print(f"   命中风险:            {result['total_risk_cases']}")
        print(f"{'='*70}")

        self.print_risk_cases(result["all_risk_cases"])
        self.save_risk_cases(result["all_risk_cases"])
        self.send_risk_cases_to_telegram(result["all_risk_cases"])

    def run_today_once(self):
        """Single scan of today's registrations."""
        self._run_day_offset_once(days_offset=0)

    def run_yesterday_once(self):
        """Single scan of yesterday's registrations."""
        self._run_day_offset_once(days_offset=1)

    # ------------------------------------------------------------------
    # Today scheduler test
    # ------------------------------------------------------------------

    def run_today_scheduler_test(self, interval_seconds: int = 60,
                                  max_runs: int = 5):
        """
        Test scheduler: scan today's registrations every N seconds.

        Each run: today scan → agent backfill (cache) → IP risk →
                  save JSON → Telegram (dedup).
        """
        import traceback

        date_range = self.get_registration_range_gmt8(days_offset=0)
        today_str = date_range["date_gmt8"]

        print(f"\n{'='*70}")
        print(f"⏱️  Today Scheduler 测试模式")
        print(f"   date:      GMT+8 {today_str}")
        print(f"   interval:  {interval_seconds}s")
        print(f"   max_runs:  {max_runs}")
        print(f"   dedup:     sent_risk_cases.json")
        print(f"   cache:     direct_agents_cache.json")
        print(f"   freeze:    DISABLED")
        print(f"{'='*70}")

        for run in range(1, max_runs + 1):
            start_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            print(f"\n{'='*70}")
            print(f"🔄 Today Scheduler Run {run}/{max_runs}")
            print(f"   开始时间: {start_ts}")
            print(f"{'='*70}")

            try:
                result = self.search_registered_pages_by_offset(
                    days_offset=0, max_pages=10, page_size=100)

                self.print_risk_cases(result["all_risk_cases"])
                self.save_risk_cases(result["all_risk_cases"])
                tg_result = self.send_risk_cases_to_telegram(result["all_risk_cases"])

                end_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                print(f"\n  📊 Run {run} 结果:")
                print(f"     今日注册日期:     {today_str}")
                print(f"     扫描页数:         {result['pages_fetched']}")
                print(f"     总记录数:         {result['total_records_checked']}")
                print(f"     玩家数:           {result['total_players']}")
                print(f"     代理数(当日):     {result['total_agents']}")
                print(f"     缺失上级代理:     {result['total_missing_agents']}")
                print(f"     risk_cases:       {result['total_risk_cases']}")
                print(f"     already_sent:     {tg_result.get('skipped', 0)}")
                print(f"     to_send:          {tg_result.get('to_send', 0)}")
                print(f"     sent:             {tg_result.get('sent', 0)}")
                print(f"     failed:           {tg_result.get('failed', 0)}")
                print(f"     结束时间:         {end_ts}")

            except Exception as e:
                print(f"\n  ❌ Run {run} 异常 (不中断循环): {e}")
                traceback.print_exc()

            if run < max_runs:
                print(f"\n  ⏳ 等待 {interval_seconds}s 后开始下一轮...")
                time.sleep(interval_seconds)

        print(f"\n{'='*70}")
        print(f"✅ Today Scheduler 测试完成 ({max_runs}/{max_runs} runs)")
        print(f"{'='*70}")

    def run_today_scheduler(self, interval_seconds: int = 60,
                            max_consecutive_errors: int = 5):
        """
        Production today scheduler — runs indefinitely until Ctrl+C.

        - Recalculates today's date each run (survives midnight crossing).
        - Stops after max_consecutive_errors consecutive failures.
        - Safe Ctrl+C shutdown via KeyboardInterrupt.
        """
        import traceback

        print(f"\n{'='*70}")
        print(f"⏱️  Today Scheduler — 持续运行")
        print(f"   interval:              {interval_seconds}s")
        print(f"   max_consecutive_errors:{max_consecutive_errors}")
        print(f"   dedup:                 sent_risk_cases.json")
        print(f"   cache:                 direct_agents_cache.json")
        print(f"   freeze:                DISABLED")
        print(f"   stop:                  Ctrl+C")
        print(f"{'='*70}")

        run = 0
        consecutive_errors = 0

        try:
            while True:
                run += 1
                date_range = self.get_registration_range_gmt8(days_offset=0)
                today_str = date_range["date_gmt8"]
                start_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                print(f"\n{'='*70}")
                print(f"🔄 Today Scheduler Run #{run}")
                print(f"   开始时间:    {start_ts}")
                print(f"   GMT+8 日期:  {today_str}")
                print(f"{'='*70}")

                try:
                    result = self.search_registered_pages_by_offset(
                        days_offset=0, max_pages=10, page_size=100)

                    self.print_risk_cases(result["all_risk_cases"])
                    self.save_risk_cases(result["all_risk_cases"])
                    tg_result = self.send_risk_cases_to_telegram(
                        result["all_risk_cases"])

                    consecutive_errors = 0  # reset on success

                    end_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    print(f"\n  📊 Run #{run} 结果:")
                    print(f"     GMT+8 日期:        {today_str}")
                    print(f"     扫描页数:          {result['pages_fetched']}")
                    print(f"     总记录数:          {result['total_records_checked']}")
                    print(f"     玩家数:            {result['total_players']}")
                    print(f"     代理数:            {result['total_agents']}")
                    print(f"     缺失上级代理:      {result['total_missing_agents']}")
                    print(f"     risk_cases:        {result['total_risk_cases']}")
                    print(f"     already_sent skip: {tg_result.get('skipped', 0)}")
                    print(f"     to_send:           {tg_result.get('to_send', 0)}")
                    print(f"     sent:              {tg_result.get('sent', 0)}")
                    print(f"     failed:            {tg_result.get('failed', 0)}")
                    print(f"     连续错误次数:      {consecutive_errors}")
                    print(f"     结束时间:          {end_ts}")

                except Exception as e:
                    consecutive_errors += 1
                    print(f"\n  ❌ Run #{run} 异常: {e}")
                    traceback.print_exc()
                    print(f"  ⚠️  连续错误次数: {consecutive_errors}/{max_consecutive_errors}")

                    if consecutive_errors >= max_consecutive_errors:
                        print(f"\n❌ 已连续失败 {max_consecutive_errors} 次，停止 today_scheduler")
                        break

                print(f"\n  ⏳ 下一轮等待: {interval_seconds}s")
                time.sleep(interval_seconds)

        except KeyboardInterrupt:
            print(f"\n\n⏹️  收到 Ctrl+C，today_scheduler 已安全停止 ({run} runs)")

    # ------------------------------------------------------------------
    # Scheduler
    # ------------------------------------------------------------------

    def run_scheduler_test(self, interval_seconds: int = 300, max_runs: int = 3):
        """
        Test scheduler: scan → risk → save → Telegram, repeated N times.

        Parameters
        ----------
        interval_seconds : int
            Seconds between runs (default 300 = 5 min).
        max_runs : int
            Total number of runs before auto-stop (default 3).
        """
        import traceback

        print(f"\n{'='*70}")
        print(f"⏱️  Scheduler 测试模式")
        print(f"   interval:  {interval_seconds}s ({interval_seconds/60:.0f} min)")
        print(f"   max_runs:  {max_runs}")
        print(f"   scan:      10 pages × 100 = max 1000 records/run")
        print(f"   dedup:     sent_risk_cases.json")
        print(f"   freeze:    DISABLED")
        print(f"{'='*70}")

        for run in range(1, max_runs + 1):
            start_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            print(f"\n{'='*70}")
            print(f"🔄 Scheduler Run {run}/{max_runs}")
            print(f"   开始时间: {start_ts}")
            print(f"{'='*70}")

            try:
                result = self.search_all_pages(max_pages=10, page_size=100, page_sleep=0.5)

                # ── Save + print ──
                self.print_risk_cases(result["all_risk_cases"])
                self.save_risk_cases(result["all_risk_cases"])

                # ── Telegram ──
                tg_result = self.send_risk_cases_to_telegram(result["all_risk_cases"])

                end_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                print(f"\n  📊 Run {run} 完成:")
                print(f"     扫描页数:       {result['pages_fetched']}")
                print(f"     记录数:         {result['total_records_checked']}")
                print(f"     玩家数:         {result['total_players']}")
                print(f"     代理数:         {result['total_agents']}")
                print(f"     risk_cases:     {result['total_risk_cases']}")
                print(f"     already_sent:   {tg_result.get('skipped', 0)}")
                print(f"     to_send:        {tg_result.get('to_send', 0)}")
                print(f"     sent:           {tg_result.get('sent', 0)}")
                print(f"     failed:         {tg_result.get('failed', 0)}")
                print(f"     结束时间:       {end_ts}")

            except Exception as e:
                print(f"\n  ❌ Run {run} 异常 (不中断循环): {e}")
                traceback.print_exc()

            # ── Sleep between runs (skip after last) ──
            if run < max_runs:
                print(f"\n  ⏳ 等待 {interval_seconds}s 后开始下一轮...")
                time.sleep(interval_seconds)

        print(f"\n{'='*70}")
        print(f"✅ Scheduler 测试完成 ({max_runs}/{max_runs} runs)")
        print(f"{'='*70}")


# ---------------------------------------------------------------------------
# ── Main ──
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys as _sys

    mode = _sys.argv[1] if len(_sys.argv) > 1 else "once"

    USAGE = """
Usage: python backend_client.py [mode]

Modes:
  once                 Single scan (10 pages) + risk + save + Telegram (default)
  today_once           Today's registrations only (GMT+8) + risk + Telegram
  yesterday_once       Yesterday's registrations only (GMT+8) + risk + Telegram
  today_scheduler      持续运行, 每60s扫描今日注册 (Ctrl+C 停止)
  today_scheduler_test 5 runs × 60s interval (auto-stop)
  scheduler_test       3 runs × 300s interval (full 10-page scan)
  debug_chat           Print Telegram getUpdates to find correct chat_id
""".strip()

    client = BackendClient()

    if mode == "debug_chat":
        client.get_telegram_updates_chat_ids()

    elif mode == "once":
        print("=" * 60)
        print("🔧 BackendClient 配置检查")
        print("=" * 60)
        print(f"  Base URL:      {client.base_url}")
        print(f"  Merchant:      {client.merchant}")
        print(f"  Merchant Code: {client.merchant_code}")
        print(f"  Environment:   {client.environment}")
        print(f"  Platform:      {client.platform}")
        print(f"  Language:      {client.language}")
        print(f"  Timezone:      {client.timezone}")
        print(f"  TOP_AGENT:     {client.top_agent}")
        client.run_once()

    elif mode == "today_once":
        print("=" * 60)
        print("🔧 BackendClient 配置检查")
        print("=" * 60)
        print(f"  Base URL:      {client.base_url}")
        print(f"  TOP_AGENT:     {client.top_agent}")
        client.run_today_once()

    elif mode == "yesterday_once":
        print("=" * 60)
        print("🔧 BackendClient 配置检查")
        print("=" * 60)
        print(f"  Base URL:      {client.base_url}")
        print(f"  TOP_AGENT:     {client.top_agent}")
        client.run_yesterday_once()

    elif mode == "today_scheduler":
        print("=" * 60)
        print("🔧 BackendClient 配置检查")
        print("=" * 60)
        print(f"  Base URL:      {client.base_url}")
        print(f"  TOP_AGENT:     {client.top_agent}")
        client.run_today_scheduler(interval_seconds=60, max_consecutive_errors=5)

    elif mode == "today_scheduler_test":
        print("=" * 60)
        print("🔧 BackendClient 配置检查")
        print("=" * 60)
        print(f"  Base URL:      {client.base_url}")
        print(f"  TOP_AGENT:     {client.top_agent}")
        client.run_today_scheduler_test(interval_seconds=60, max_runs=5)

    elif mode == "scheduler_test":
        print("=" * 60)
        print("🔧 BackendClient 配置检查")
        print("=" * 60)
        print(f"  Base URL:      {client.base_url}")
        print(f"  TOP_AGENT:     {client.top_agent}")
        client.run_scheduler_test(interval_seconds=300, max_runs=3)

    else:
        print(f"Unknown mode: {mode}")
        print(USAGE)
