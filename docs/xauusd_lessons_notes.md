# XAU/USD Lessons Refactor Notes

`lessons.js` was rewritten to remove Solana/DLMM pool-learning logic and align the learning layer with the current XAU/USD trade runtime.

---

## Removed legacy learning concepts

Removed LP/token/on-chain-specific learning assumptions, including:

- pool / pool_name / pool memory update flows
- position address as the primary trade identity
- bin range / bin step reasoning
- out-of-range efficiency logic
- fee/TVL and yield-based lesson derivation
- organic score / token quality heuristics
- amount_sol sizing assumptions
- fee claiming / rebalance / volume-collapse lesson branches
- Darwinian signal-weight recalculation tied to LP-shaped performance records
- fire-and-forget hive-mind sync from the learning path
- threshold evolution against deleted `config.screening.*` keys
- legacy role routing centered on `SCREENER` and token/pool tags

---

## New lesson/performance model

### Performance records

`recordPerformance(perf)` now normalizes trade-oriented data instead of LP-position data.

Current normalized fields include:

- `trade_id`
- `symbol`
- `direction`
- `setup_type`
- `session`
- `entry_price`
- `exit_price`
- `stop_loss`
- `take_profit`
- `lot_size`
- `atr_at_entry`
- `risk_reward`
- `pnl_usd`
- `pnl_pct`
- `r_multiple`
- `peak_profit_pct`
- `last_pnl_pct`
- `trailing_active`
- `close_reason`
- `signal_snapshot`
- `opened_at`
- `closed_at`
- `recorded_at`

It still tolerates older mixed records by normalizing legacy fields when possible.

### Lesson derivation

`deriveLesson()` now creates XAU/USD-native lessons based on:

- setup type
- direction
- session
- planned risk-reward
- ATR context when available
- realized PnL / R-multiple
- close reason (`stop_loss`, `take_profit`, `trailing_stop`, `idle_exit`, etc.)
- trailing-stop behavior

Lesson phrasing now uses trade language only:

- trade
- setup
- ATR
- risk-reward
- stop loss
- take profit
- trailing stop
- session
- PnL

### Performance summaries

`getPerformanceHistory()` and `getPerformanceSummary()` now report trade-based metrics such as:

- total PnL in USD
- average PnL %
- average R multiple
- win rate
- close reason breakdown
- whether legacy records are still present

These outputs are now compatible with the current `prompt.js` performance-summary block.

---

## Threshold/config evolution changes

### Deleted evolution targets removed

Removed deleted targets:

- `config.screening.maxVolatility`
- `config.screening.minFeeTvlRatio`
- `config.screening.minOrganic`

### Current evolution targets

`evolveThresholds()` now considers only current signal keys from `config.js`:

- `config.signal.minRiskReward`
- `config.signal.minAtrMultiplierForEntry`
- `config.signal.minAdxForTrend`
- `config.signal.maxAdxForRange`

### Evolution behavior

The new evolution pass stays conservative:

- no-op unless there are enough closed trade records
- bounded by `MAX_CHANGE_PER_STEP`
- writes only supported top-level keys into `user-config.json`
- applies changes back to the live `config.signal` object
- still relies on `reloadScreeningThresholds()` alias from `config.js` for runtime pickup

This keeps the existing config reload flow intact while removing the deleted screening schema dependency.

---

## Legacy compatibility handling

The rewrite keeps the file tolerant of older stored data:

- old lessons with role `SCREENER` are treated as `ANALYST`
- old performance records are normalized where numeric fields still exist
- listing, prompt injection, history, and summary paths avoid crashing on mixed schemas
- history returns both `trades` and legacy-compatible `positions` keys pointing to the same normalized data
- summary includes `legacy_records_present` so remaining stale data is visible

This means old lesson data can still be read while all newly generated data uses current XAU/USD terminology.

---

## Remaining risks

| Risk | File | Severity | Notes |
|---|---|---|---|
| `recordPerformance()` callers may still pass legacy LP-shaped payloads from untouched code paths | `index.js`, adjacent runtime surfaces | Medium | The file now tolerates mixed data, but upstream callers should eventually be made fully trade-native. |
| Some stored manual lessons may still contain Solana-era wording | `lessons.json` | Medium | Runtime is safe, but prompt quality can still be affected until stale lesson content is cleaned up. |
| ADX / ATR threshold evolution depends on optional `signal_snapshot` content that may not always be present | `lessons.js`, upstream callers | Medium | Evolution stays safe and becomes a no-op when signal detail is missing. |
| Briefing and other adjacent presentation layers may still describe LP-era concepts | `briefing.js`, other docs/runtime surfaces | Medium | This change fixes lessons/performance handling only. |

---

## Recommended next target

**Next target: `briefing.js`**

Why:
- `agent.js`, `tools/definitions.js`, `prompt.js`, and now `lessons.js` are aligned on the active XAU/USD trade vocabulary.
- `briefing.js` is still listed in migration notes as an adjacent surface that may emit LP-era wording.
- Fixing it next will reduce stale terminology in operator-facing summaries outside the core prompt/learning loop.

---

## Summary

This pass completed the learning-layer migration for the active runtime:

- removed pool/token/DLMM learning logic
- added trade-based XAU/USD performance normalization
- replaced deleted screening-threshold evolution with current signal-key evolution
- preserved public lesson/performance APIs
- added compatibility handling for older stored `SCREENER` lessons and mixed legacy records
