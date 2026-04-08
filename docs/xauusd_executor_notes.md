# XAU/USD Executor Refactor Notes

`tools/executor.js` — Phase 1 rewrite completed.

---

## What changed

### Imports removed

All Solana/DLMM/DEX tool imports deleted:

| Removed | Reason |
|---|---|
| `tools/dlmm.js` | Solana LP position management |
| `tools/wallet.js` | Solana wallet / SOL balance |
| `tools/screening.js` | Token screener / Meteora |
| `tools/token.js` | Token metadata / blacklist |
| `tools/study.js` | DLMM fee/IL analysis |
| `tools/okx.js` | OKX DEX aggregator |
| `pool-memory.js` | Position memory store |
| `token-blacklist.js` | Token filter |
| `dev-blocklist.js` | Dev wallet filter |
| `smart-wallets.js` | On-chain wallet tracker |

### Imports kept

- `lessons.js` — fully generic, no Solana coupling
- `state.js` — fully rewritten to XAU/USD schema
- `strategy-library.js` — fully generic
- `config.js` — fully rewritten to XAU/USD config
- `logger.js` — unchanged
- `telegram.js` — `notifyTradeOpen` / `notifyTradeClose` added in this pass

---

## toolMap — old vs new

| Old tool | New tool | Notes |
|---|---|---|
| `deploy_position` | `open_trade` | Paper mode only until Phase 3 |
| `close_position` | `close_trade` | Paper mode only until Phase 3 |
| `get_positions` | `get_open_trades` | Reads from state.js |
| `get_wallet_balances` | `get_account_balance` | Returns paper balance |
| `set_position_instruction` | `set_trade_instruction` | Renamed |
| `get_market_data` | `get_market_data` | Phase 2 stub |
| _(new)_ | `get_atr` | Phase 2 stub |
| _(new)_ | `get_session_info` | Live UTC hour check |
| _(new)_ | `check_cooldown` | Reads state cooldown block |
| `rebalance_position` | _(removed)_ | No equivalent in spot trading |
| `claim_fees` | _(removed)_ | Solana-only |
| `get_pools` | _(removed)_ | Solana-only |
| `get_token_info` | _(removed)_ | Solana-only |

Kept unchanged: `get_performance_history`, `add_lesson`, `pin_lesson`, `unpin_lesson`, `list_lessons`, `clear_lessons`, `add_strategy`, `list_strategies`, `get_strategy`, `set_active_strategy`, `remove_strategy`, `self_update`, `update_config`.

---

## WRITE_TOOLS

Only `open_trade` and `close_trade`. `set_trade_instruction` and `update_config` are local state mutations with no external broker effects.

---

## Safety checks — open_trade (9 guards)

1. **Required fields** — direction ("long"/"short"), entry_price > 0, lot_size > 0, stop_loss > 0
2. **SL direction** — long: SL < entry; short: SL > entry
3. **Lot size cap** — lot_size ≤ config.risk.maxLotSize
4. **Max open trades** — open count < config.risk.maxOpenTrades
5. **Duplicate symbol** — one trade per symbol at a time
6. **Cooldown** — checkCooldown(config.cooldown) must not be blocked
7. **Daily loss limit** — paper P&L vs config.risk.maxDailyLossPct (paper mode only until live balance available)
8. **Session filter** — current UTC hour must be in config.session.allowedWindows (when session.enabled && signal.requireSessionConfirm)
9. **Friday cutoff** — blocks new entries after config.session.fridayCloseHourUtc on Fridays

## Safety checks — close_trade (3 guards)

1. trade_id required
2. exit_price > 0
3. trade exists in open state

---

## CONFIG_MAP — update_config

Full mapping for all new config sections:

- `instrument.*` — symbol, pipValue, lotSize, precision
- `market.*` — timeframe, atrPeriod, emaFast/SlowPeriod, adxPeriod, adxTrendMin, maxSpreadPips, stalePriceMaxMs
- `session.*` — sessionFilterEnabled, newsBlackoutMinutesBefore/After, fridayCloseHourUtc
- `signal.*` — minAtrMultiplierForEntry, minRiskReward, minAdxForTrend, maxAdxForRange, requireSessionConfirm
- `risk.*` — maxOpenTrades, riskPctPerTrade, maxDailyLossPct, maxDrawdownPct, minAccountBalance, maxLotSize
- `management.*` — defaultSlAtr, defaultTpAtr, stopLossPct, takeProfitPct, trailingStop, trailingTriggerPct, trailingDropPct, maxIdleMinutes
- `cooldown.*` — cooldownAfterLossMinutes, cooldownAfterTradeMinutes, maxTradesPerHour, maxTradesPerDay
- `schedule.*` — managementIntervalMin, analysisIntervalMin (+ legacy alias `screeningIntervalMin`)
- `paper.*` — paperTrading, paperBalance, simulateSlippage
- `llm.*` — managementModel, analysisModel (+ legacy alias `screeningModel`), generalModel, temperature, maxTokens, maxSteps

All removed Solana keys (`deployAmountSol`, `minFeeTvlRatio`, `maxVolatility`, `positionSizeUsd`, etc.) no longer exist in CONFIG_MAP — the LLM will receive `unknown` back if it tries to use them.

---

## Paper execution path

`paperOpenTrade()` — calls `trackTrade()` + `recordTradeOpened()` from state.js, returns a synthetic fill result.

`paperCloseTrade()` — calls `getTrackedTrade()` to fetch entry data, calculates pip-based P&L:
```
priceDelta = exitPrice - entryPrice  (long)
           = entryPrice - exitPrice  (short)
pnlUsd = priceDelta * lotSize * instrument.lotSize * (1 / pipValue)
```
Then calls `recordClose()`, `recordDailyPnl()`, `recordTradeClosed()`.

Live broker path returns a clear error until Phase 3.

---

## Telegram integration

`notifyTradeOpen` and `notifyTradeClose` were added to `telegram.js` in this pass. They use `sendHTML` matching the style of existing helpers.

Old helpers kept (not deleted):
- `notifyDeploy` — still called by `index.js` (not yet rewritten)
- `notifyClose` — still called by `index.js`
- `notifySwap` — still called by `index.js`
- `notifyOutOfRange` — still called by `index.js`

---

## Known issues / deferred work

| Issue | File | Priority |
|---|---|---|
| `reloadSignalThresholds` imported but never called in executor | executor.js | Low — no crash, just unused import |
| `index.js` still calls `notifyDeploy`, `notifyClose`, `config.management.takeProfitFeePct`, etc. | index.js | High — Phase 1 rewrite target |
| `lessons.js` `evolveThresholds()` references removed config keys — threshold evolution is a no-op | lessons.js | Medium — Phase 2 fix |
| `tools/definitions.js` still has Solana tool schemas | definitions.js | High — Phase 1 rewrite target |
| Phase 2 stubs (`get_market_data`, `get_atr`) return stub errors | executor.js | Expected — Phase 2 |
| Live broker execution path not implemented | executor.js | Expected — Phase 3 |

---

## Files modified in this pass

- `tools/executor.js` — full rewrite
- `telegram.js` — added `notifyTradeOpen`, `notifyTradeClose`
- `docs/xauusd_executor_notes.md` — this file
