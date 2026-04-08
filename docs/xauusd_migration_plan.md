# XAU/USD Migration Plan
**From: Meridian (Meteora DLMM LP agent) → To: Autonomous XAU/USD spot trading bot**

---

## 1. Repository Overview

Meridian is a Node.js autonomous agent for providing liquidity on Meteora DLMM pools on the Solana blockchain. It uses a ReAct loop (LLM → tool call → repeat) with two specialized scheduled agents (SCREENER, MANAGER) running on cron intervals. The architecture is modular: a central orchestrator (`index.js`) drives an LLM agent core (`agent.js`) which dispatches to a tool layer (`tools/`). Persistent state lives in JSON flat files. Notifications go through Telegram.

The goal of this migration is to **strip all Solana/DEX/LP specifics** and reuse the architectural skeleton—scheduler, ReAct loop, tool dispatcher, state store, lessons system, and Telegram notifications—to build an LLM-driven XAU/USD spot trading bot.

---

## 2. Current Architecture Summary

```
index.js              Orchestrator: REPL + cron scheduler + Telegram bot polling
agent.js              Core ReAct loop (LLM → tools → repeat, role-gated tool access)
config.js             Runtime config (user-config.json + .env); live mutation support
prompt.js             System prompt builder per agent role (SCREENER / MANAGER / GENERAL)
state.js              Position registry (state.json): open/closed trades, OOR timestamps, trailing TP
lessons.js            Learning engine: records perf, derives lessons, evolves thresholds
pool-memory.js        Per-pool deploy history and notes (pool-memory.json)
strategy-library.js   Saved LP strategies (strategy-library.json)
signal-tracker.js     In-memory signal staging for Darwinian weight analysis
signal-weights.js     Darwinian signal weight recalculation from performance data
hive-mind.js          Optional collective intelligence server sync
smart-wallets.js      KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js    Permanent token blacklist (token-blacklist.json)
dev-blocklist.js      Deployer blacklist (deployer-blacklist.json)
briefing.js           Daily Telegram briefing (HTML)
telegram.js           Telegram bot polling + notifications
logger.js             Daily-rotating log files + JSONL action audit trail
cli.js                Direct CLI — every tool as a subcommand
setup.js              Interactive setup wizard

tools/
  definitions.js      Tool schemas in OpenAI function-calling format
  executor.js         Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js             Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js        Pool discovery from Meteora API
  wallet.js           SOL/token balances (Helius) + Jupiter swap
  token.js            Token info/holders/narrative (Jupiter + OKX APIs)
  study.js            Top LPer study via LPAgent API
  okx.js              OKX OnchainOS API client (smart money signals)

discord-listener/
  index.js            Selfbot Discord listener for token signals
  pre-checks.js       Signal pre-check pipeline (dedup, blacklist, rug check)

.claude/
  agents/             Claude Code sub-agent definitions
  commands/           Claude Code slash command definitions
```

### Key Architectural Patterns Worth Keeping

| Pattern | File | Notes |
|---|---|---|
| ReAct agent loop | `agent.js` | LLM → tool → repeat; role-gated tools; retry logic; JSON repair |
| Dual-cycle cron | `index.js:481–551` | Two independent cron schedules (analysis + management) |
| Deterministic pre-check + LLM for edge cases | `index.js:144–270` | Rules run first; LLM only called when action needed |
| State with trailing TP / SL | `state.js:261–341` | Peak PnL tracking, OOR detection, exit logic |
| Lessons + threshold evolution | `lessons.js` | Record perf, derive lesson, evolve thresholds every N closes |
| Tool safety checks | `tools/executor.js:357–448` | Pre-execution guards before write operations |
| Config live mutation | `config.js` + `executor.js:update_config` | Runtime config changes persist and apply instantly |
| JSONL action audit trail | `logger.js:logAction` | Every tool call logged with args/result/duration |
| Signal staging + Darwin weights | `signal-tracker.js`, `signal-weights.js` | Tracks which signals correlated with wins |
| REPL with countdown | `index.js:592–998` | Interactive terminal with cycle countdowns |

---

## 3. File-by-File Migration Table

### Core Files

| File | Classification | Reason |
|---|---|---|
| `agent.js` | **REWRITE** | Keep ReAct loop structure, retry/fallback logic, JSON repair, role-gated tool routing. Remove all Solana-specific imports (`getWalletBalances`, `getMyPositions` from dlmm). Replace with XAU/USD equivalents. |
| `index.js` | **REWRITE** | Keep cron orchestration, REPL, Telegram handler, busy/lock guards, deterministic rule engine. Remove all DEX-specific logic: pool snapshots, screening cycle, `getMyPositions`, `getWalletBalances` from Solana. Replace with market data and position management calls. |
| `config.js` | **REWRITE** | Keep config loading pattern and live mutation. Replace all Solana/DEX screening fields with XAU/USD-relevant params (spread, session filters, lot size, risk %, ATR period, etc.). |
| `prompt.js` | **REWRITE** | Keep role-based prompt architecture (ANALYST / MANAGER / GENERAL). Replace all Meteora/DLMM/Solana language and rules with XAU/USD market context. |
| `state.js` | **REWRITE** | Keep JSON persistence pattern, trailing TP logic, OOR→drawdown detection, position lifecycle (open/close/note). Remove Solana-specific fields: `bin_range`, `pool`, `bin_step`, `amount_sol`. Replace with XAU/USD trade fields: `symbol`, `direction`, `entry_price`, `stop_loss`, `take_profit`, `lot_size`. |
| `lessons.js` | **REWRITE** | Keep all learning infrastructure: `recordPerformance`, `derivLesson`, `evolveThresholds`, pinned/role lessons, `getLessonsForPrompt`. Replace DEX-specific perf fields (`fee_tvl_ratio`, `bin_step`, `organic_score`, `range_efficiency`) with trade-relevant fields (`atr`, `session`, `setup_type`, `regime`). |
| `logger.js` | **KEEP** | Generic daily-rotating log + JSONL action audit. Fully reusable as-is. |
| `telegram.js` | **KEEP** | Generic Telegram bot polling + send. No DEX-specific logic. Fully reusable. |
| `briefing.js` | **REWRITE** | Keep daily briefing concept and Telegram HTML delivery. Replace pool/fee/TVL content with XAU/USD: daily range, session P&L, open trade summary, upcoming news events. |
| `signal-tracker.js` | **KEEP** | Generic in-memory signal staging with TTL. Reusable for any signal type. |
| `signal-weights.js` | **REWRITE** | Keep Darwinian weight recalculation structure. Replace DEX signal names with XAU/USD signals: `session`, `atr_breakout`, `rsi_divergence`, `news_proximity`, `regime`. |
| `pool-memory.js` | **REWRITE** | Keep per-instrument memory pattern and JSON store. Rename to `instrument-memory.js`. Replace pool-specific fields with XAU/USD context: past trade stats per session/setup/regime. |
| `strategy-library.js` | **KEEP** | Generic named-strategy store. Rename strategy fields to fit XAU/USD but structure is identical. |
| `hive-mind.js` | **REMOVE** | Solana-specific collective intelligence server. No equivalent needed initially. |
| `smart-wallets.js` | **REMOVE** | Solana wallet tracker. No equivalent for XAU/USD (though could become "signal source tracker"). |
| `token-blacklist.js` | **REMOVE** | Token-specific. For XAU/USD consider a "news event blackout" list or "blocked broker symbols" list if needed. |
| `dev-blocklist.js` | **REMOVE** | Deployer blacklist. Irrelevant. |
| `setup.js` | **REWRITE** | Keep wizard concept. Replace Solana wallet/RPC/Helius setup with broker API key, data feed URL, account ID, risk params. |
| `cli.js` | **REWRITE** | Keep CLI subcommand architecture and JSON output. Replace all DEX commands with XAU/USD equivalents: `balance`, `positions`, `quote`, `place-order`, `close-order`, `history`. |

### Tools Layer

| File | Classification | Reason |
|---|---|---|
| `tools/definitions.js` | **REWRITE** | Keep OpenAI function-calling schema structure. Replace every tool definition with XAU/USD tools: `get_market_data`, `get_position`, `place_order`, `close_order`, `get_news_events`, `get_account_balance`, `get_atr`, `get_session_info`. |
| `tools/executor.js` | **REWRITE** | Keep dispatch pattern, safety checks, pre/post hooks, WRITE_TOOLS guard, Telegram notifications on write. Replace tool implementations map and DEX-specific safety logic with XAU/USD equivalents (lot size checks, margin checks, duplicate position guard). |
| `tools/dlmm.js` | **REMOVE** | Entirely Meteora DLMM SDK. No reusable logic. |
| `tools/screening.js` | **REMOVE** | Entirely Meteora pool discovery API. Replace with market data / signal engine. |
| `tools/wallet.js` | **REMOVE** | Solana wallet + Helius balance + Jupiter swap. Replace with broker account adapter. |
| `tools/token.js` | **REMOVE** | Jupiter / OKX token info, holder analysis, narrative. No equivalent needed. |
| `tools/study.js` | **REMOVE** | LPAgent API for top LPer study. No equivalent. |
| `tools/okx.js` | **REMOVE** | OKX OnchainOS smart money API. No equivalent. |

### Discord Listener

| File | Classification | Reason |
|---|---|---|
| `discord-listener/index.js` | **REMOVE** | LP Army Discord selfbot. No equivalent. |
| `discord-listener/pre-checks.js` | **REMOVE** | Pool pre-check pipeline for Discord signals. No equivalent. |

### Claude Code Integration

| File | Classification | Reason |
|---|---|---|
| `.claude/agents/screener.md` | **REWRITE** | Rename to `analyst.md`. Replace pool screening instructions with XAU/USD setup identification. |
| `.claude/agents/manager.md` | **REWRITE** | Keep position management role. Replace DLMM-specific instructions with trade management. |
| `.claude/commands/screen.md` | **REWRITE** | Rename to `analyze.md`. XAU/USD signal scan instead of pool screening. |
| `.claude/commands/manage.md` | **REWRITE** | Keep concept, replace pool management with trade management. |
| `.claude/commands/balance.md` | **KEEP** | Generic enough; minor text changes only. |
| `.claude/commands/positions.md` | **KEEP** | Generic enough; minor text changes only. |
| `.claude/commands/candidates.md` | **REWRITE** | Rename to `signals.md` — show current XAU/USD setup candidates. |
| `.claude/commands/study-pool.md` | **REMOVE** | LP study command. No equivalent. |
| `.claude/commands/pool-ohlcv.md` | **REWRITE** | Rename to `ohlcv.md` — fetch XAU/USD OHLCV from market data adapter. |
| `.claude/commands/pool-compare.md` | **REMOVE** | Pool comparison has no XAU/USD equivalent. |

### Config / Data Files

| File | Classification | Reason |
|---|---|---|
| `user-config.example.json` | **REWRITE** | Replace with XAU/USD risk params template. |
| `.env.example` | **REWRITE** | Replace Solana/Helius/OpenRouter keys with broker API, data feed, LLM keys. |
| `deployer-blacklist.json` | **REMOVE** | |
| `package.json` | **REWRITE** | Remove `@meteora-ag/dlmm`, `@solana/web3.js`, `@solana/spl-token`, `bn.js`, `bs58`. Add broker SDK, TA library, forex data feed client. |
| `scripts/patch-anchor.js` | **REMOVE** | Anchor/Solana-specific patch. |
| `test/test-agent.js` | **REWRITE** | Keep agent loop test harness. Replace DEX tool mocks. |
| `test/test-screening.js` | **REMOVE** | Replace with `test/test-signals.js`. |

---

## 4. Dependencies to Remove

All Solana/DEX-specific dependencies from `package.json`:

```json
"@meteora-ag/dlmm": "latest",
"@solana/spl-token": "^0.3.11",
"@solana/web3.js": "^1.95.0",
"bn.js": "^5.2.1",
"bs58": "^5.0.0"
```

Also remove: `scripts/patch-anchor.js` (Anchor compatibility patch).

---

## 5. Dependencies to Keep

| Dependency | Reason |
|---|---|
| `openai` | LLM client (OpenAI-compatible API) — keep as-is |
| `node-cron` | Scheduler for management/analysis cycles |
| `dotenv` | Env var loading |
| `jsonrepair` | LLM JSON output repair — keep, still needed |

### New Dependencies to Add

| Dependency | Purpose |
|---|---|
| Broker SDK (e.g. `oanda-api-v20`, FXCM SDK, or custom REST client) | Execution adapter for XAU/USD trades |
| Market data client (e.g. `twelvedata`, `alpha_vantage`, `ccxt` for perpetuals) | OHLCV, tick data |
| TA library (e.g. `technicalindicators`, `ta-lib` bindings) | ATR, RSI, EMA, ADX locally |
| Economic calendar API client | Session/news filter |

---

## 6. Proposed New Module Structure

```
index.js              Orchestrator: REPL + cron + Telegram (rewrite)
agent.js              ReAct loop (rewrite — remove Solana imports)
config.js             Config: XAU/USD params (rewrite)
prompt.js             Prompts: ANALYST / MANAGER / GENERAL roles (rewrite)
state.js              Trade registry: open/closed trades, SL/TP tracking (rewrite)
lessons.js            Learning engine: perf → lessons → threshold evolution (rewrite)
trade-memory.js       Per-instrument/session/setup memory (replaces pool-memory.js)
strategy-library.js   Named strategy store (keep, minor field renames)
signal-tracker.js     Signal staging for Darwin analysis (keep as-is)
signal-weights.js     Darwin weight recalc for XAU/USD signals (rewrite)
briefing.js           Daily XAU/USD briefing (rewrite)
telegram.js           Telegram bot (keep as-is)
logger.js             Logging + audit trail (keep as-is)
cli.js                CLI subcommands for XAU/USD (rewrite)
setup.js              Setup wizard for broker/data/LLM (rewrite)

tools/
  definitions.js      XAU/USD tool schemas (rewrite)
  executor.js         Tool dispatch + safety checks (rewrite)
  market-data.js      NEW: OHLCV, tick, spread, ATR, price quotes
  execution.js        NEW: place_order, close_order, modify_sl_tp (replaces dlmm.js + wallet.js)
  account.js          NEW: balance, open positions, P&L, margin (replaces wallet.js)
  signals.js          NEW: setup detection, regime classification (replaces screening.js)
  news-filter.js      NEW: economic calendar, session windows, news proximity check
  ta.js               NEW: local TA calculations (ATR, RSI, EMA, ADX, VWAP)
```

### Component Mapping: Meridian → XAU/USD

| Meridian Concept | XAU/USD Equivalent |
|---|---|
| Pool screening cycle | Signal/setup scanning cycle |
| Position management cycle | Trade management cycle |
| `deploy_position` | `place_order` |
| `close_position` | `close_order` |
| `claim_fees` | (remove — no fee accumulation concept) |
| `swap_token` | (remove — no base token to swap) |
| Bin range / OOR detection | Price vs. SL/TP bracket |
| `fee_active_tvl_ratio` | Setup quality score (ATR ratio, breakout quality) |
| `organic_score` | Regime quality score (trend strength, ADX) |
| `volatility` | ATR (normalized) |
| `bin_step` | Spread / instrument tick size |
| `maxPositions` | `maxOpenTrades` |
| `deployAmountSol` | `lotSize` or `riskPctPerTrade` |
| `gasReserve` | `marginReserve` |
| Pool memory | Instrument/session/setup memory |
| Smart wallets | Signal source tracker (optional, later) |
| Discord listener | News feed / signal webhook (optional, later) |
| Morning briefing | Pre-session briefing (London open / NY open) |
| `outOfRangeWaitMinutes` | `maxDrawdownMinutes` before forced exit |
| Trailing TP | Trailing stop logic (reuse exact same state machine) |

---

## 7. Phased Implementation Plan

### Phase 0 — Audit (Current)

**Status: COMPLETE**

- [x] Inspect full repository structure
- [x] Classify every file
- [x] Identify Solana coupling points
- [x] Define target architecture
- [x] Document this migration plan

**Deliverable:** `docs/xauusd_migration_plan.md`

---

### Phase 1 — Skeleton Refactor (No live data, no execution)

**Goal:** Delete all Solana/DEX code. Stand up the generic skeleton with stub tool implementations.

**Steps:**

1. **Strip dependencies** — remove `@meteora-ag/dlmm`, `@solana/web3.js`, `@solana/spl-token`, `bn.js`, `bs58` from `package.json`
2. **Delete dead files** — `tools/dlmm.js`, `tools/wallet.js`, `tools/token.js`, `tools/screening.js`, `tools/study.js`, `tools/okx.js`, `discord-listener/`, `scripts/patch-anchor.js`, `dev-blocklist.js`, `deployer-blacklist.json`, `token-blacklist.json`, `smart-wallets.js`, `hive-mind.js`
3. **Rewrite `config.js`** — XAU/USD params: `maxOpenTrades`, `lotSize`, `riskPctPerTrade`, `marginReserve`, `stopLossPips`, `takeProfitPips`, `trailingStop`, `sessionFilter`, `newsBlackoutMinutes`, signal thresholds
4. **Rewrite `state.js`** — replace pool/bin fields with trade fields: `symbol`, `direction`, `entry_price`, `sl`, `tp`, `lot_size`, `broker_order_id`, trailing stop state
5. **Rewrite `lessons.js`** — replace `fee_tvl_ratio`/`organic_score`/`range_efficiency` with `atr`, `session`, `setup_type`, `regime`, `risk_reward`
6. **Rewrite `prompt.js`** — new roles: `ANALYST` (find setups), `MANAGER` (manage open trades), `GENERAL` (free chat). Strip all Meteora/DLMM language
7. **Rewrite `agent.js`** — keep ReAct loop, replace Solana-specific startup calls with XAU/USD equivalents
8. **Create stub `tools/`** — `market-data.js` (returns mock OHLCV), `execution.js` (dry-run only), `account.js` (mock balance), `signals.js` (stub), `news-filter.js` (stub), `ta.js` (real calculations using a TA library)
9. **Rewrite `tools/definitions.js`** — XAU/USD tool schemas
10. **Rewrite `tools/executor.js`** — new safety checks: max positions, lot size limit, margin check, duplicate symbol guard
11. **Rewrite `index.js`** — two cycles: `runAnalysisCycle` (find setups) + `runManagementCycle` (manage trades), same cron pattern
12. **Smoke test** — run in dry-run mode end-to-end, confirm agent loop fires tools and logs correctly

**Acceptance criteria:** `npm run dev` starts without errors; agent loop completes one analysis cycle and one management cycle against stub data.

---

### Phase 2 — Paper Trading (Live market data, simulated execution)

**Goal:** Connect real market data; simulate order placement; validate strategy logic.

**Steps:**

1. **Implement `tools/market-data.js`** — connect to a real market data feed (Twelve Data, Alpha Vantage, or similar) for XAU/USD OHLCV, current price, spread
2. **Implement `tools/ta.js`** — real ATR, RSI, EMA, ADX calculations from live OHLCV
3. **Implement `tools/signals.js`** — initial signal detection: ATR breakout, session open momentum, news proximity filter
4. **Implement `tools/news-filter.js`** — economic calendar integration (Forex Factory API or similar); flag FOMC, NFP, CPI events
5. **Implement `tools/account.js`** — simulated paper account: balance, open positions, P&L tracking in memory/JSON
6. **Implement `tools/execution.js` (paper mode)** — `place_order` writes to `paper-positions.json` at market price; `close_order` calculates P&L against current price
7. **Wire up `state.js`** — connect trailing stop + SL/TP checks to real price polling (30s interval, same as Meridian's PnL poller)
8. **Connect `lessons.js`** — ensure `recordPerformance` fires on paper trade closes; verify threshold evolution works
9. **Daily briefing** — rewrite `briefing.js` for pre-session XAU/USD brief: prior session range, ATR, open trades, upcoming news
10. **Run for 2+ weeks** — monitor paper P&L, lesson accumulation, threshold evolution

**Acceptance criteria:** Agent autonomously identifies setups, places paper orders, manages SL/TP, closes trades, and derives lessons from outcomes. Paper journal has 20+ trades.

---

### Phase 3 — Live Execution Adapter

**Goal:** Replace paper execution with a real broker adapter.

**Steps:**

1. **Choose and integrate broker** — OANDA, FXCM, Interactive Brokers, or a CFD broker with REST API. Implement `tools/execution.js` with real order placement
2. **Implement `tools/account.js` (live)** — pull real account balance, margin, and open positions from broker API
3. **Safety layer** — `DRY_RUN=true` env var bypasses all real orders; this already exists in Meridian's pattern. Verify it gates every write in `executor.js`
4. **Lot size / margin checks** — real pre-execution safety: check available margin, enforce `maxOpenTrades`, check spread vs. ATR ratio before entering
5. **Position reconciliation** — on startup, reconcile local `state.json` against broker open positions (analogous to Meridian's `syncOpenPositions`)
6. **Broker error handling** — handle partial fills, requotes, slippage, and connection drops in `execution.js`
7. **Start with micro lots** — deploy with minimum lot size (0.01 lots XAU/USD) until confident in execution
8. **Monitor and tune** — use `lessons.js` evolution, `signal-weights.js` Darwin recalculation, and Telegram alerts to tune thresholds over first 30 live trades

**Acceptance criteria:** Bot places and closes live trades autonomously; state matches broker; Telegram notifications fire correctly; emergency stop (`/stop` REPL command or `DRY_RUN=true`) works reliably.

---

## 8. Key Risks and Unknowns

### Technical Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Broker API rate limits during management cycle | Medium | Add per-request throttle in `execution.js`; cache position state locally |
| Market data gaps / stale quotes | High | Implement stale-data guard in `market-data.js`: reject signals if last candle > 2× expected interval |
| LLM hallucinating trade outcomes | High | Meridian's `requireTool` pattern already handles this — keep it. Force tool calls for any trade action intent |
| Slippage on entry in live mode | Medium | Check spread vs. ATR; reject entry if spread > 15% of ATR in `executor.js` safety checks |
| `evolveThresholds` referencing wrong field names | Low | Known bug in Meridian (noted in CLAUDE.md). When rewriting `lessons.js`, audit all field name references carefully |
| Node.js blocking on synchronous FS writes during high-frequency polling | Low | State writes are infrequent; not a concern at this scale |

### Strategic Unknowns

| Unknown | Notes |
|---|---|
| **Which broker to use** | Need to decide before Phase 3. OANDA has a good REST API and supports XAU/USD natively. FXCM has WebSocket. Decide based on spreads and API quality |
| **Signal/setup definitions** | Not defined yet. Phase 1 is intentionally setup-agnostic. Signals module is a stub until trading logic is designed |
| **Session handling** | XAU/USD is 23h/day. Need to define "analysis session windows" (London, NY overlap) and blackout periods (Asian session, pre-news) |
| **Regime detection** | Trending vs. ranging XAU/USD requires different strategies. `signals.js` needs a regime classifier. ADX + price structure are starting points |
| **Risk sizing** | `deployAmountSol` → `lotSize` mapping needs to account for leverage. Fixed % risk per trade (1-2% of account) is the standard approach |
| **News filter data source** | Economic calendar APIs vary in quality and latency. Forex Factory, Investing.com, or MetaTrader calendar feeds are options. Need evaluation |
| **Darwinian signal weights** | `signal-weights.js` rewrite requires first defining what signals exist. Defer to after Phase 2 when real signal data exists |

---

## Appendix A: Solana Coupling Inventory

Every file with hard Solana/DEX coupling that must not leak into the XAU/USD build:

| File | Coupled To | Specific Coupling |
|---|---|---|
| `tools/dlmm.js` | Meteora DLMM SDK, `@solana/web3.js` | `Connection`, `Keypair`, `PublicKey`, DLMM position lifecycle |
| `tools/wallet.js` | Helius API, Jupiter swap, `@solana/web3.js` | SOL balance, token balances, Jupiter swap API |
| `tools/screening.js` | Meteora Pool Discovery API, OKX API | Pool candidates, fee/TVL ratios, pool discovery |
| `tools/token.js` | Jupiter API, OKX OnchainOS API | Token info, holder analysis, bot detection, narrative |
| `tools/study.js` | LPAgent API | Top LPer analysis |
| `tools/okx.js` | OKX OnchainOS API | Smart money signals, bundle/sniper detection |
| `agent.js:65–66` | `tools/dlmm.js`, `tools/wallet.js` | Direct imports at module level — remove |
| `index.js:6–18` | `tools/dlmm.js`, `tools/wallet.js`, `tools/screening.js` | Startup imports — replace |
| `prompt.js` | Meteora DLMM concepts | All prompt text references bins, fee/TVL, OOR, LP strategy |
| `config.js:98–102` | Solana token mint addresses | `config.tokens.SOL`, `config.tokens.USDC`, `config.tokens.USDT` |
| `package.json` | 5 Solana packages | See Dependencies to Remove section |
| `scripts/patch-anchor.js` | Anchor framework | Postinstall Anchor patch |
| `discord-listener/` | Discord selfbot | LP Army signal channel monitoring |
| `smart-wallets.js` | Solana wallet addresses | KOL wallet tracking by address |
| `token-blacklist.js` | Solana mint addresses | Token blacklist by mint |
| `dev-blocklist.js` | Solana deployer addresses | Deployer blacklist |
| `hive-mind.js` | Meridian-specific hive server | Shared lessons/deploy sync |

---

## Appendix B: Files Requiring Zero Changes (Keep As-Is)

These files are already fully generic and can be dropped into the new project unchanged:

- `logger.js` — log categories, daily rotation, JSONL action trail
- `telegram.js` — polling, send, chatId persistence
- `signal-tracker.js` — in-memory signal staging with TTL
