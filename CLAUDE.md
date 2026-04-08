# Aureum — CLAUDE.md

Autonomous XAUT/USDT spot trading agent for Tokocrypto-oriented execution.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (ANALYST / MANAGER / GENERAL)
state.js            Trade registry (state.json): open/closed trades, cooldowns, daily stats, notes
lessons.js          Learning engine: records closed-trade performance, derives lessons, evolves thresholds
strategy-library.js Saved strategy definitions
briefing.js         Daily operator briefing (HTML)
telegram.js         Telegram bot: polling and notifications
logger.js           Daily-rotating log files + action audit trail
cli.js              Operator CLI for status, trades, risk, config, lessons, and performance

tools/
  definitions.js    Tool schemas in OpenAI format (what the LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
```

---

## Agent Roles & Tool Access

Three roles shape the current runtime:

| Role | Purpose | Typical tools |
|------|---------|---------------|
| `ANALYST` | Review setup/trading-window context and decide whether to look for new trades | `get_market_data`, `get_atr`, `get_open_trades`, `get_account_balance`, `get_session_info`, `check_cooldown` |
| `MANAGER` | Review open trades and manage hold/close decisions | `get_open_trades`, `close_trade`, `set_trade_instruction`, `get_account_balance`, `check_cooldown` |
| `GENERAL` | Operator chat, status, config, lessons, and performance actions | Current tool set routed by intent |

---

## CLI Surface

The current operator CLI is intentionally compact and XAUT/USDT-focused:

- `node cli.js status`
- `node cli.js open-trades`
- `node cli.js recent-trades --limit 10`
- `node cli.js risk`
- `node cli.js briefing`
- `node cli.js analyze`
- `node cli.js manage`
- `node cli.js start`
- `node cli.js config get`
- `node cli.js config set <key> <value>`
- `node cli.js lessons`
- `node cli.js lessons add <text>`
- `node cli.js performance --limit 20`
- `node cli.js evolve`

These commands are for operator visibility and current runtime control only. They do not imply live Tokocrypto implementation details beyond what the active code already supports.

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime changes go through `update_config` in `tools/executor.js`, which:
- updates the live `config` object immediately
- persists changes to `user-config.json`
- restarts cron jobs if schedule settings changed

Current config sections:
- `instrument`
- `market`
- `session`
- `signal`
- `risk`
- `management`
- `cooldown`
- `schedule`
- `llm`
- `paper`

Representative live keys include:
- `exchange`, `symbol`, `baseAsset`, `quoteAsset`
- `pricePrecision`, `quantityPrecision`, `minQuantity`, `minNotional`
- `timeframe`, `atrPeriod`, `maxSpreadPct`
- `minRiskReward`, `minAtrMultiplierForEntry`, `minAdxForTrend`, `maxAdxForRange`
- `maxOpenTrades`, `riskPctPerTrade`, `maxDailyLossPct`, `maxDrawdownPct`
- `maxPositionQuantity`, `maxPositionNotional`
- `stopLossPct`, `takeProfitPct`, `trailingStop`, `maxIdleMinutes`
- `cooldownAfterLossMinutes`, `cooldownAfterTradeMinutes`
- `analysisIntervalMin`, `managementIntervalMin`
- `paperTrading`, `paperBalance`, `feeRatePct`

---

## Runtime Flow

1. **Analyze** — the analyst reviews current trading-window, cooldown, risk, and trade context before considering new setups.
2. **Open trade** — `open_trade` passes executor safety checks and writes the new trade into `state.js`.
3. **Manage** — the manager evaluates tracked open trades using current PnL, trailing state, instructions, and timing rules.
4. **Close trade** — `close_trade` records outcomes and feeds `lessons.js`.
5. **Learn** — `lessons.js` can evolve supported `config.signal.*` thresholds from recorded performance.
6. **Brief** — `briefing.js` produces an operator-facing XAUT/USDT summary.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `OPENROUTER_API_KEY` or `LLM_API_KEY` | Yes | LLM API key |
| `LLM_BASE_URL` | No | Override for local/OpenAI-compatible endpoint |
| `LLM_MODEL` | No | Override default model |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `DRY_RUN` | No | Forces paper/dry-run mode |

The current runtime is intentionally exchange-agnostic at the execution layer. Live Tokocrypto/account integration remains future work.

---

## Notes / Remaining Migration Debt

The active runtime path is XAUT/USDT-aligned.
Any remaining migration debt should be treated as historical or future exchange-integration work rather than an active operator-surface mismatch.

When editing the system, keep operator-facing wording in current XAUT/USDT spot terms only.
