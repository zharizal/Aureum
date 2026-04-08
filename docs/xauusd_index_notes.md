# XAU/USD Index.js Refactor Notes

`index.js` — Phase 1 rewrite completed.

---

## Old flow → New flow

| Old concept | New concept |
|---|---|
| `runScreeningCycle()` | `runAnalysisCycle()` |
| `runManagementCycle()` — position-based | `runManagementCycle()` — trade-based |
| `_screeningBusy` | `_analysisBusy` |
| `timers.screeningLastRun` | `timers.analysisLastRun` |
| `getMyPositions()` (Solana RPC) | `getTrackedTrades(true)` (local state) |
| `getWalletBalances()` (Solana RPC) | `getTodayStats()` + `config.paper.initialBalance` |
| `getTopCandidates()` (Meteora API) | Removed — LLM calls `get_market_data` / `get_atr` stubs |
| Startup: pool list table + SOL balance | Startup: open trades + session + paper balance |
| REPL `1/2/3`: deploy into pool N | Removed |
| REPL `auto`: agent picks pool | Removed |
| REPL `/candidates`: refresh pools | Removed |
| REPL `/status`: wallet + positions | `/status`: session + trades + paper balance |
| REPL `/learn`: study top LPers | Removed |
| Telegram `/positions` | Telegram `/trades` (alias: `/positions` still works) |
| Telegram `/close <n>` — calls `closePosition()` directly | Telegram `/close <n>` — delegates to `agentLoop` with MANAGER role |
| Telegram `/set <n>` — calls `setPositionInstruction()` | Telegram `/set <n>` — calls `setTradeInstruction()` directly |
| Telegram deploy intent → SCREENER role | Telegram open intent → ANALYST role |
| Non-TTY startup: get_wallet_balance + deploy | Non-TTY startup: get_account_balance + get_open_trades + status report |

---

## Removed imports

| Removed | Reason |
|---|---|
| `tools/dlmm.js` (`getMyPositions`, `closePosition`, `getActiveBin`) | Solana LP position management |
| `tools/wallet.js` (`getWalletBalances`) | Solana wallet |
| `tools/screening.js` (`getTopCandidates`) | Meteora pool screening |
| `pool-memory.js` (`recordPositionSnapshot`, `recallForPool`, `addPoolNote`) | Pool memory store |
| `smart-wallets.js` (`checkSmartWalletsOnPool`) | On-chain wallet tracker |
| `tools/token.js` (`getTokenNarrative`, `getTokenInfo`) | Jupiter / OKX token data |
| `config.js: computeDeployAmount` | Replaced by `computeLotSize()` |
| `config.js: reloadScreeningThresholds` | Replaced by `reloadSignalThresholds()` |
| `state.js: getTrackedPosition`, `setPositionInstruction` | Deprecated stubs — replaced by `getTrackedTrade`, `setTradeInstruction` |
| `telegram.js: notifyOutOfRange` | OOR concept removed |

---

## Removed management rules

| Old rule | Reason removed |
|---|---|
| Rule 3: `active_bin > upper_bin + outOfRangeBinsToClose` | DLMM bin range concept — no equivalent |
| Rule 4: `active_bin > upper_bin && minutes_out_of_range >= outOfRangeWaitMinutes` | OOR concept replaced by `maxIdleMinutes` |
| Rule 5: `fee_per_tvl_24h < minFeePerTvl24h` | LP yield metric — no equivalent |
| Claim rule: `unclaimed_fees_usd >= minClaimAmount` | LP fee claiming — removed entirely |
| Suspect PnL guard (cross-check against tracked deposit vs. API data) | Solana position data quality issue — broker data will be authoritative |
| `recordPositionSnapshot` / `recallForPool` enrichment on each position | Pool memory — replaced by trade state fields |
| Smart wallets check per pool | On-chain tracker — removed |

## New management rules

| Rule | Trigger |
|---|---|
| SL | `lastPnlPct <= config.management.stopLossPct` |
| TP | `lastPnlPct >= config.management.takeProfitPct` |
| TRAIL | `trailingActive && (peakProfitPct - lastPnlPct) >= trailingDropPct` |
| IDLE | `minutesHeld >= maxIdleMinutes && lastPnlPct <= 0` |
| INSTRUCTION | `trade.instruction` present → LLM evaluates condition |

---

## Hard guards in analysis cycle

The analysis cycle skips LLM invocation entirely if any of these fire:

1. `openTrades.length >= config.risk.maxOpenTrades`
2. `checkCooldown(config.cooldown).blocked === true`
3. `config.session.enabled` and current UTC hour is outside `allowedWindows`
4. `config.session.enabled` and it is Friday after `fridayCloseHourUtc`

These replicate the Solana screening guards (maxPositions, min SOL balance) with XAU/USD equivalents.

---

## PnL poller (30s interval)

Phase 1: reads `trade.lastPnlPct` from state (last value stored by the execution adapter / paper engine). Sufficient for trailing stop state machine and exit detection.

Phase 2: will pass `{ pnlPct, currentPrice }` from the market data adapter for real-time accuracy.

---

## Agent role changes

| Old role | New role | Used for |
|---|---|---|
| `SCREENER` | `ANALYST` | Find and evaluate trade setups, open new trades |
| `MANAGER` | `MANAGER` | Manage open trades, evaluate close decisions |
| `GENERAL` | `GENERAL` | Free-form chat, status queries, config changes |

`agent.js` still has `SCREENER` and `MANAGER` in its `MANAGER_TOOLS` / `SCREENER_TOOLS` sets — those sets reference old Solana tool names. This is not yet fixed. Until `agent.js` is rewritten, the role-gated tool filtering will pass incorrect tool subsets to the LLM. **This is the next high-priority target.**

---

## Remaining compatibility risks

| Risk | File | Severity | Notes |
|---|---|---|---|
| `agent.js` imports `getWalletBalances` from `wallet.js` and `getMyPositions` from `dlmm.js` at module level | `agent.js:65–66` | **HIGH** | Will throw on import since `wallet.js` uses removed config keys (`config.tokens.SOL`). Crashes the entire startup. Fix by rewriting `agent.js`. |
| `agent.js` MANAGER_TOOLS / SCREENER_TOOLS reference old tool names | `agent.js:7–8` | High | Wrong tool subsets sent to LLM. Rewrite `agent.js`. |
| `prompt.js` references `config.screening.timeframe`, `.minTokenFeesSol`, `.maxBotHoldersPct` | `prompt.js` | High | LLM system prompt contains "undefined". Rewrite `prompt.js`. |
| `tools/definitions.js` still has Solana tool schemas | `definitions.js` | High | LLM gets wrong tool descriptions. Rewrite `definitions.js`. |
| `lessons.js` `evolveThresholds()` no-op | `lessons.js` | Medium | All three threshold fields it tries to evolve are removed. `/evolve` command runs but changes nothing meaningful. |
| `briefing.js` likely references removed pool/fee fields | `briefing.js` | Medium | Not yet audited. Will generate a broken briefing until rewritten. |
| Old Telegram helpers `notifyDeploy`, `notifyClose`, `notifySwap`, `notifyOutOfRange` still in `telegram.js` | `telegram.js` | Low | Dead code — no callers in the new index.js. Safe to remove when cleaning up. |

---

## Backward-compat aliases still in play

These aliases in `config.js` and `state.js` are no longer needed by `index.js` after this rewrite:

| Alias | Safe to remove when |
|---|---|
| `config.schedule.screeningIntervalMin` getter/setter | `agent.js` rewritten |
| `config.llm.screeningModel` getter/setter | `agent.js` rewritten |
| `reloadScreeningThresholds` export from `config.js` | `agent.js` rewritten |
| `computeDeployAmount` export from `config.js` | All callers removed |
| `getTrackedPosition` stub from `state.js` | All callers removed |
| `setPositionInstruction` stub from `state.js` | All callers removed |
| `syncOpenPositions` stub from `state.js` | `dlmm.js` deleted |
| `trackPosition`, `markOutOfRange`, `markInRange`, etc. | `dlmm.js` deleted |

---

## Next files to refactor (priority order)

| Priority | File | Reason |
|---|---|---|
| 1 | `agent.js` | Imports `wallet.js` and `dlmm.js` at module level → crash on startup. Also has wrong MANAGER/SCREENER tool sets. |
| 2 | `tools/definitions.js` | LLM receives Solana tool schemas — every agent loop gets wrong tool descriptions. |
| 3 | `prompt.js` | LLM system prompt contains "undefined" for removed config fields. |
| 4 | `lessons.js` | `evolveThresholds()` is a no-op for all XAU/USD fields. |
| 5 | `briefing.js` | Pre-session briefing content is LP-specific. |
| 6 | Delete dead files | `tools/dlmm.js`, `tools/wallet.js`, `tools/screening.js`, `tools/token.js`, `tools/study.js`, `tools/okx.js`, `pool-memory.js`, `smart-wallets.js`, `hive-mind.js`, `dev-blocklist.js`, `token-blacklist.js` |

---

## Files modified in this pass

- `index.js` — full rewrite
- `docs/xauusd_index_notes.md` — this file
