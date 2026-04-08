# XAU/USD Config & State Refactor Notes

**Scope:** `config.js` and `state.js` only.
**Date:** 2026-04-08
**Preceding document:** `docs/xauusd_migration_plan.md`

---

## 1. config.js — Old Field → New Field Mapping

### Section renames

| Old section | New section | Notes |
|---|---|---|
| `config.screening` | `config.signal` | Pool screening → setup/signal thresholds |
| `config.management` | `config.management` | Kept name; all fields replaced |
| `config.risk` | `config.risk` | Kept name; fields replaced |
| `config.schedule` | `config.schedule` | Kept name; one field renamed |
| `config.strategy` | *(removed)* | DLMM LP strategy (bid_ask, curve, spot) — no equivalent |
| `config.tokens` | *(removed)* | Solana mint addresses — irrelevant |
| `config.llm` | `config.llm` | Unchanged structure; one alias added |
| *(new)* `config.instrument` | — | Symbol, pip value, lot size, precision |
| *(new)* `config.market` | — | ATR period, EMA periods, ADX, spread limit, stale-price guard |
| *(new)* `config.session` | — | Session windows, news blackout, Friday cutoff |
| *(new)* `config.cooldown` | — | Post-loss / post-trade / per-hour / per-day limits |
| *(new)* `config.paper` | — | Paper trading mode, initial balance, simulated slippage |

### Field-level mapping

| Old field | New field | Notes |
|---|---|---|
| `config.screening.timeframe` | `config.market.timeframe` | Changed from candle size string to analysis timeframe |
| `config.screening.minFeeActiveTvlRatio` | `config.signal.minAtrMultiplierForEntry` | Conceptually equivalent quality threshold |
| `config.screening.minOrganic` | `config.signal.minAdxForTrend` | Organic score → ADX trend strength |
| `config.screening.maxBotHoldersPct` | *(removed)* | Token-specific |
| `config.screening.maxTop10Pct` | *(removed)* | Token-specific |
| `config.screening.minHolders` | *(removed)* | Token-specific |
| `config.screening.minMcap / maxMcap` | *(removed)* | Token-specific |
| `config.screening.minTvl / maxTvl` | *(removed)* | Pool-specific |
| `config.screening.minVolume` | *(removed)* | Pool volume — replaced by ATR/spread logic |
| `config.screening.minBinStep / maxBinStep` | *(removed)* | DLMM bin step — irrelevant |
| `config.screening.minTokenFeesSol` | *(removed)* | Token fees in SOL — irrelevant |
| `config.screening.maxBundlePct` | *(removed)* | Token bundle detection — irrelevant |
| `config.screening.category` | *(removed)* | Pool category ("trending", "new") — irrelevant |
| `config.screening.blockedLaunchpads` | *(removed)* | Token launchpad filter — irrelevant |
| `config.screening.minTokenAgeHours / maxTokenAgeHours` | *(removed)* | Token age — irrelevant |
| `config.screening.athFilterPct` | *(removed)* | Token ATH filter — irrelevant |
| `config.management.deployAmountSol` | *(removed — computed)* | Replaced by `computeLotSize()` |
| `config.management.gasReserve` | *(removed)* | No gas cost concept in FX trading |
| `config.management.positionSizePct` | `config.risk.riskPctPerTrade` | Position sizing by % risk |
| `config.management.stopLossPct` | `config.management.stopLossPct` | Kept — now price % from entry |
| `config.management.takeProfitFeePct` | `config.management.takeProfitPct` | "FeePct" suffix removed; LP fee accrual concept gone |
| `config.management.trailingTakeProfit` | `config.management.trailingStop` | Renamed for clarity |
| `config.management.trailingTriggerPct` | `config.management.trailingTriggerPct` | Kept |
| `config.management.trailingDropPct` | `config.management.trailingDropPct` | Kept |
| `config.management.outOfRangeWaitMinutes` | `config.management.maxIdleMinutes` | OOR → idle time |
| `config.management.outOfRangeBinsToClose` | *(removed)* | DLMM-specific |
| `config.management.minClaimAmount` | *(removed)* | LP fee claiming — no equivalent |
| `config.management.autoSwapAfterClaim` | *(removed)* | LP fee claiming — no equivalent |
| `config.management.minVolumeToRebalance` | *(removed)* | Pool rebalance — no equivalent |
| `config.management.minFeePerTvl24h` | *(removed)* | Pool yield metric — no equivalent |
| `config.management.minAgeBeforeYieldCheck` | *(removed)* | Pool yield metric — no equivalent |
| `config.management.minSolToOpen` | `config.risk.minAccountBalance` | Minimum balance check recast |
| `config.management.solMode` | *(removed)* | SOL-denominated display mode — irrelevant |
| `config.risk.maxPositions` | `config.risk.maxOpenTrades` | Same concept, renamed |
| `config.risk.maxDeployAmount` | `config.risk.maxLotSize` | Same concept, renamed |
| `config.schedule.screeningIntervalMin` | `config.schedule.analysisIntervalMin` | Renamed; compat getter/setter kept |
| `config.strategy.strategy` | *(removed)* | DLMM LP strategy type — irrelevant |
| `config.strategy.binsBelow` | *(removed)* | DLMM bin range — irrelevant |
| `config.tokens.SOL / USDC / USDT` | *(removed)* | Solana mint addresses — irrelevant |
| `config.llm.screeningModel` | `config.llm.analysisModel` | Renamed; compat getter/setter kept |

### Exported functions

| Old export | New export | Notes |
|---|---|---|
| `reloadScreeningThresholds()` | `reloadSignalThresholds()` | Renamed; old name re-exported as alias |
| `computeDeployAmount(walletSol)` | `computeLotSize(balance, stopPips)` | New signature; old name re-exported as deprecated shim |

---

## 2. state.js — Old Field → New Field Mapping

### Top-level structure

| Old key | New key | Notes |
|---|---|---|
| `state.positions` | `state.trades` | LP positions → forex trades |
| *(new)* | `state.dailyStats` | Per-day P&L, trade counts, wins/losses |
| *(new)* | `state.cooldown` | Last loss timestamp, last close timestamp |
| `state.recentEvents` | `state.recentEvents` | Kept — generic event log |
| `state.lastUpdated` | `state.lastUpdated` | Kept |

### Per-trade record fields (inside `state.trades[id]`)

| Old field (positions) | New field (trades) | Notes |
|---|---|---|
| `position` (address) | `tradeId` | String ID from broker or generated |
| `pool` (address) | *(removed)* | Pool concept gone |
| `pool_name` | `symbol` | e.g. "XAU/USD" |
| `strategy` | `setupType` | "breakout" / "pullback" / "range" / etc. |
| `bin_range` | *(removed)* | DLMM-specific |
| `bin_step` | *(removed)* | DLMM-specific |
| `amount_sol` | `lotSize` | Position size |
| `amount_x` | *(removed)* | DLMM tokenX deposit |
| `active_bin_at_deploy` | *(removed)* | DLMM-specific |
| `volatility` | `atrAtEntry` | ATR at entry replaces volatility score |
| `fee_tvl_ratio` | `riskReward` | R:R at entry replaces fee/TVL metric |
| `initial_fee_tvl_24h` | *(removed)* | Pool yield metric |
| `organic_score` | *(removed)* | Token metric |
| `initial_value_usd` | *(via account)* | Not stored locally; comes from broker |
| `out_of_range_since` | *(removed)* | OOR concept replaced by `maxIdleMinutes` check |
| `last_claim_at` | *(removed)* | Fee claiming — no equivalent |
| `total_fees_claimed_usd` | *(removed)* | Fee claiming — no equivalent |
| `rebalance_count` | *(removed)* | LP rebalance — no equivalent |
| `closed` | `closed` | Kept |
| `closed_at` | `closedAt` | camelCase |
| `notes` | `notes` | Kept — free-text audit trail |
| `peak_pnl_pct` | `peakProfitPct` | camelCase |
| `trailing_active` | `trailingActive` | camelCase |
| `instruction` | `instruction` | Kept — operator note for agent |
| *(new)* | `direction` | "long" / "short" |
| *(new)* | `entryPrice` | Fill price |
| *(new)* | `stopLoss` | SL price |
| *(new)* | `takeProfit` | TP price (nullable) |
| *(new)* | `session` | Session name at entry |
| *(new)* | `openedAt` | ISO timestamp |
| *(new)* | `closeReason` | Why it was closed |
| *(new)* | `lastPnlPct` | Last known PnL % from poller |
| *(new)* | `signalSnapshot` | Raw signal values at entry |

### Exported function mapping

| Old export | New export | Notes |
|---|---|---|
| `trackPosition(args)` | `trackTrade(args)` | Full rename; old name kept as deprecated stub |
| `recordClose(posAddr, reason)` | `recordClose(tradeId, reason)` | Same name, arg renamed from position address to trade ID |
| `setPositionInstruction(addr, instr)` | `setTradeInstruction(tradeId, instr)` | Renamed; old name kept as deprecated stub |
| `getTrackedPosition(addr)` | `getTrackedTrade(tradeId)` | Renamed; old name kept as deprecated stub |
| `getTrackedPositions(openOnly)` | `getTrackedTrades(openOnly)` | Renamed |
| `syncOpenPositions(addrs)` | `syncOpenTrades(tradeIds)` | Renamed; old name kept as deprecated stub |
| `updatePnlAndCheckExits(addr, data, cfg)` | `updatePnlAndCheckExits(tradeId, data, cfg)` | Same name; first arg changes from position address to trade ID; `in_range` field removed from `liveData` |
| `markOutOfRange(addr)` | *(stub only)* | OOR concept removed |
| `markInRange(addr)` | *(stub only)* | OOR concept removed |
| `minutesOutOfRange(addr)` | *(stub returns 0)* | OOR concept removed |
| `recordClaim(addr, fees)` | *(stub only)* | LP claiming — removed |
| `recordRebalance(old, new)` | *(stub only)* | LP rebalance — removed |
| `getLastBriefingDate()` | `getLastBriefingDate()` | Kept unchanged |
| `setLastBriefingDate()` | `setLastBriefingDate()` | Kept unchanged |
| *(new)* | `recordDailyPnl(pnlUsd)` | Daily P&L accumulation |
| *(new)* | `recordTradeOpened()` | Daily trade count |
| *(new)* | `getTodayStats()` | Today's P&L and trade count summary |
| *(new)* | `recordTradeClosed(wasLoss)` | Updates cooldown timestamps |
| *(new)* | `checkCooldown(cooldownConfig)` | Returns `{blocked, reason}` |

---

## 3. Removed Fields — Complete List

### config.js removals
All fields that only make sense for LP / token / Solana trading:

```
config.screening.minTvl / maxTvl
config.screening.minVolume
config.screening.minOrganic (replaced by config.signal.minAdxForTrend)
config.screening.minHolders
config.screening.minMcap / maxMcap
config.screening.minBinStep / maxBinStep
config.screening.minFeeActiveTvlRatio (replaced by config.signal.minAtrMultiplierForEntry)
config.screening.minTokenFeesSol
config.screening.maxBundlePct
config.screening.maxBotHoldersPct
config.screening.maxTop10Pct
config.screening.category
config.screening.blockedLaunchpads
config.screening.minTokenAgeHours / maxTokenAgeHours
config.screening.athFilterPct
config.management.deployAmountSol (→ computeLotSize())
config.management.gasReserve
config.management.positionSizePct (→ config.risk.riskPctPerTrade)
config.management.minClaimAmount
config.management.autoSwapAfterClaim
config.management.outOfRangeBinsToClose
config.management.minVolumeToRebalance
config.management.minFeePerTvl24h
config.management.minAgeBeforeYieldCheck
config.management.solMode
config.strategy (entire section)
config.tokens (entire section)
```

### state.js removals (from per-position record)
```
pool (address)
bin_range
bin_step
amount_x
active_bin_at_deploy
fee_tvl_ratio
initial_fee_tvl_24h
organic_score
initial_value_usd (now comes from broker/account adapter)
out_of_range_since
last_claim_at
total_fees_claimed_usd
rebalance_count
```

---

## 4. Compatibility Risks Introduced by This Refactor

The following files reference config or state fields that have been renamed or removed. They will **not** crash at import time (stubs and compat aliases prevent that), but their **runtime behaviour is now broken** until they are rewritten.

### Critical — logic silently wrong

| File | Problem |
|---|---|
| `index.js:24` | `config.management.takeProfitFeePct` → now `config.management.takeProfitPct`. The REPL startup reads this for `TP_PCT` constant. Wrong value (undefined). |
| `index.js:25` | `config.management.deployAmountSol` → removed. `DEPLOY` constant will be `undefined`. |
| `index.js:172-202` | Management cycle rule engine references `config.management.outOfRangeBinsToClose`, `.outOfRangeWaitMinutes`, `.minFeePerTvl24h`, `.minClaimAmount` — all removed. Rules will not fire correctly. |
| `index.js:280,313,373` | `config.risk.maxPositions` → `config.risk.maxOpenTrades`. Screening pre-check will get `undefined` and never block on position count. |
| `index.js:318` | `config.management.deployAmountSol + config.management.gasReserve` → both removed. Min-SOL check is broken. |
| `tools/executor.js:362-363` | `config.screening.minBinStep / maxBinStep` → removed. Bin step safety check will skip (both undefined). |
| `tools/executor.js:373,376` | `config.risk.maxPositions` → `config.risk.maxOpenTrades`. Max-position guard broken. |
| `tools/executor.js:411,418,427` | `config.management.deployAmountSol`, `config.risk.maxDeployAmount`, `config.management.gasReserve` → removed/renamed. SOL amount safety checks broken. |
| `lessons.js:238,273,313` | `config.screening.maxVolatility`, `.minFeeTvlRatio`, `.minOrganic` → removed. `evolveThresholds()` is already a no-op for two of these (noted as known bug in CLAUDE.md); now all three fail silently. |
| `prompt.js:94,106,107` | `config.screening.timeframe`, `.minTokenFeesSol`, `.maxBotHoldersPct` → removed. Prompt will print "undefined" for these values. |

### Non-critical — stubs return safe no-op values

| File | Problem |
|---|---|
| `tools/dlmm.js:387-388` | Calls `markOutOfRange()` / `markInRange()` — now stubs that log a warning. No crash; state just not updated (dlmm.js is scheduled for removal anyway). |
| `tools/dlmm.js:444` | Calls `syncOpenPositions()` — now a stub. No crash. |
| `tools/dlmm.js:567` | Calls `recordClaim()` — now a stub. No crash. |
| `tools/dlmm.js:698` | Calls `recordClose()` — same function name, but first arg is a position address string, not a tradeId. Will not find the trade in `state.trades` (different key format). No crash; trade state just not updated. |
| `index.js:14` | Imports `getTrackedPosition`, `setPositionInstruction`, `updatePnlAndCheckExits` from state.js. All present. `getTrackedPosition` and `setPositionInstruction` are stubs. `updatePnlAndCheckExits` is real but expects `tradeId` not position address — will silently find no matching trade. |
| `tools/executor.js:15` | Imports `setPositionInstruction` — stub, logs warning. No crash. |
| `tools/wallet.js:63-64,146` | `config.tokens.SOL / USDC` → removed. Will throw `Cannot read properties of undefined` when wallet.js is actually loaded. wallet.js is a dead file (scheduled for removal) but if it's imported it will fail. |

### Compat aliases (safe but temporary)

| Alias | Points to | Remove when |
|---|---|---|
| `config.schedule.screeningIntervalMin` | `config.schedule.analysisIntervalMin` | `index.js` rewritten |
| `config.llm.screeningModel` | `config.llm.analysisModel` | `index.js`, `agent.js` rewritten |
| `reloadScreeningThresholds` export | `reloadSignalThresholds()` | `index.js`, `tools/executor.js` rewritten |
| `computeDeployAmount` export | `computeLotSize(bal, 100)` shim | `index.js` rewritten |

---

## 5. Next Files to Update (Priority Order)

Based on the severity of breakage above:

### Priority 1 — `tools/executor.js`
**Why first:** Contains the safety guard layer for all write operations. Currently references `config.risk.maxPositions`, `config.management.deployAmountSol`, `config.management.gasReserve`, `config.risk.maxDeployAmount`, `config.screening.minBinStep/maxBinStep`. All are gone. Any `deploy_position` call will pass safety checks with bad data.

**Specific fields to fix:**
- `config.risk.maxPositions` → `config.risk.maxOpenTrades`
- `config.management.deployAmountSol` → remove (use `computeLotSize()`)
- `config.risk.maxDeployAmount` → `config.risk.maxLotSize`
- `config.management.gasReserve` → `config.risk.marginReserve` (not yet in config — add when rewriting executor)
- `config.screening.minBinStep/maxBinStep` → remove entirely (no bin step concept)
- `config.management.autoSwapAfterClaim` reference → remove (claiming removed)

### Priority 2 — `index.js`
**Why second:** The main orchestrator. Most field references are in the management cycle rule engine and startup code. Broken fields cause silent misfires in the core loop. However, index.js is a large file; it should be rewritten holistically (Phase 1 target), not patched.

**Specific fields to fix:**
- `config.management.takeProfitFeePct` → `config.management.takeProfitPct`
- `config.management.deployAmountSol` → replace `DEPLOY` constant with `computeLotSize()` call
- `config.risk.maxPositions` → `config.risk.maxOpenTrades`
- `config.management.outOfRangeBinsToClose`, `.outOfRangeWaitMinutes` → replace management rules with XAU/USD equivalents
- `config.management.minFeePerTvl24h`, `.minClaimAmount` → remove those rule blocks

### Priority 3 — `prompt.js`
**Why third:** Broken field references cause the LLM system prompt to contain `undefined` values. Affects every agent cycle quality. Straightforward to fix — it's a single file with a clear rewrite scope.

### Priority 4 — `lessons.js`
**Why fourth:** `evolveThresholds()` references `config.screening.maxVolatility`, `.minFeeTvlRatio`, `.minOrganic` (all removed). The function already had known bugs with two of these keys (per CLAUDE.md). Now all three are no-ops. The learning system still works for lesson storage; only threshold evolution is silently broken.

### Priority 5 — `tools/wallet.js`, `tools/dlmm.js`, `tools/screening.js`, `tools/token.js`, `tools/study.js`, `tools/okx.js`
**Why last:** These are dead files scheduled for removal. The only live risk is that `wallet.js` will throw on `config.tokens.SOL` if it's actually imported at runtime (it is — by `tools/executor.js` via the `swap_token` path). If the `swap_token` tool is never called, it will not crash. Safe to leave until the full tools layer is replaced.
