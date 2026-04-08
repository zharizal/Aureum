# XAU/USD Prompt Refactor Notes

`prompt.js` was rewritten to produce XAU/USD-native prompts for `ANALYST`, `MANAGER`, and `GENERAL` roles using only the current runtime vocabulary, config shape, state shape, and supported tool set.

---

## Removed old prompt concepts

Removed Solana/DLMM/LP-specific prompt concepts and instructions, including:

- Meteora / Solana framing
- DLMM LP agent wording
- pool screening / deployment language
- pool, pool_address, pool detail, pool memory
- token holder / token narrative / token info reasoning
- smart wallet checks
- fee/TVL reasoning
- gas-efficiency rules tied to token swap flows
- swap-after-close instructions
- claim fees flows
- active bin / bins above / bins below logic
- out-of-range / OOR LP management language
- deploy_position / close_position / swap_token tool references
- deleted config references such as `config.screening.*`, `minTokenFeesSol`, `maxBotHoldersPct`
- wallet/portfolio assumptions tied to old Solana adapters

---

## New role prompt structure

### Shared base prompt

The new shared prompt now provides:
- XAU/USD-only operating context
- hard anti-hallucination rules
- current runtime config summary from valid sections only
- local trade-state summary from `state.js`
- graceful note when external broker/account snapshots are unavailable
- current valid tool families only
- optional lessons and performance summary blocks

### ANALYST

Focus:
- market scan
- setup qualification
- open-trade candidate generation

Behavior:
- start with session/cooldown context when relevant
- use `get_market_data`, `get_atr`, `get_open_trades`, `get_account_balance`
- open trades only with explicit tool-backed values
- respect risk/session/cooldown constraints
- acknowledge market-data stubs instead of inventing signals

### MANAGER

Focus:
- manage existing open trades
- hold/close decisions
- respect stored `instruction`

Behavior:
- rely on tracked trade state such as `lastPnlPct`, `peakProfitPct`, `trailingActive`, age, stop loss, and take profit
- use `get_open_trades`, `get_account_balance`, `close_trade`, `set_trade_instruction`
- avoid fabricating live prices or untracked trade state

### GENERAL

Focus:
- status/help/config/performance/strategy/lesson reasoning
- user-driven trade/status/config actions

Behavior:
- route through current tools only
- use `update_config` with current XAU/USD keys only
- avoid drifting into removed Solana-era workflows

---

## Deleted config/state references replaced

### Deleted config references removed

Removed:
- `config.screening`
- `config.tokens`
- `config.management.deployAmountSol`
- `config.management.takeProfitFeePct`
- `config.management.outOfRangeWaitMinutes`
- `config.management.outOfRangeBinsToClose`
- `config.management.minClaimAmount`
- `config.screening.minTokenFeesSol`
- `config.screening.maxBotHoldersPct`
- any pool/token/bin-specific threshold references

Replaced with current valid sections:
- `config.instrument`
- `config.market`
- `config.session`
- `config.signal`
- `config.risk`
- `config.management`
- `config.cooldown`
- `config.paper`

### Deleted state assumptions removed

Removed:
- wallet portfolio assumptions from Solana adapters
- open-position assumptions based on old LP position shape
- position/pool/bin/OOR-specific language

Replaced with current trade-based state vocabulary from `state.js`:
- `open_trades`
- `closed_trades`
- `today`
- `cooldown`
- `trades`
- `recent_events`
- trade fields such as `tradeId`, `symbol`, `direction`, `entryPrice`, `stopLoss`, `takeProfit`, `openedAt`, `peakProfitPct`, `trailingActive`, `lastPnlPct`, `instruction`

### Null broker/account handling

Previously `portfolio` and `positions` were stringified directly, producing degraded prompt context when null.

Now:
- null broker/account snapshots are handled explicitly
- prompt instructs the model to use `get_account_balance` and `get_open_trades` instead
- no undefined-heavy blocks are emitted

---

## Remaining prompt risks

| Risk | File | Severity | Notes |
|---|---|---|---|
| `get_market_data` and `get_atr` are still executor stubs | `tools/executor.js` | Medium | Prompt now handles this honestly, but analysis quality remains limited until live market data is implemented. |
| Lesson content may still contain legacy Solana-era wording depending on stored lesson data | `lessons.js`, `lessons.json` | Medium | Prompt layer is fixed, but injected lesson text may still carry stale concepts until lessons handling is migrated. |
| Performance summary content depends on `lessons.js` and may still reflect older assumptions | `lessons.js` | Medium | Prompt will render it safely, but underlying summary quality may still lag the XAU/USD migration. |
| Briefing and other adjacent layers may still contain LP-era wording outside prompt.js | `briefing.js`, other docs/runtime surfaces | Medium | This change fixes prompt generation only. |

---

## Recommended next target

**Next target: `lessons.js`**

Why:
- `agent.js`, `tools/definitions.js`, and `prompt.js` now align on the active XAU/USD tool surface and role model.
- Existing migration notes still identify `lessons.js` as a known compatibility gap, especially threshold evolution.
- Fixing `lessons.js` next will reduce stale/legacy learning content entering otherwise-correct prompts.

---

## Summary

This pass completed the prompt-layer migration for the active runtime:
- removed Solana/DLMM prompt content
- added XAU/USD-native role framing
- replaced deleted config/state references with current trade-based vocabulary
- handled null external account snapshots gracefully
- aligned prompt guidance with the current `agent.js` role model and `tools/definitions.js` tool set
