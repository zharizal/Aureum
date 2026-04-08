# XAU/USD Definitions Refactor Notes

`tools/definitions.js` was rewritten to remove Solana/DLMM schemas and align the tool schema layer with the current XAU/USD executor and agent flow.

---

## Removed old tools

Removed Solana/pool/token/DLMM-specific schemas:

- `discover_pools`
- `get_top_candidates`
- `get_pool_detail`
- `get_active_bin`
- `deploy_position`
- `get_position_pnl`
- `get_my_positions`
- `claim_fees`
- `close_position`
- `get_wallet_positions`
- `get_wallet_balance`
- `swap_token`
- `add_smart_wallet`
- `remove_smart_wallet`
- `list_smart_wallets`
- `check_smart_wallets_on_pool`
- `get_token_info`
- `get_token_holders`
- `get_token_narrative`
- `search_pools`
- `get_top_lpers`
- `study_top_lpers`
- `set_position_note`
- `get_pool_memory`
- `add_pool_note`
- `add_to_blacklist`
- `remove_from_blacklist`
- `list_blacklist`
- `block_deployer`
- `unblock_deployer`
- `list_blocked_deployers`

Also removed all Solana-specific descriptions, pool/bin terminology, and token/wallet assumptions from the remaining schema layer.

---

## Final XAU/USD tool list

### Core trade tools
- `open_trade`
- `close_trade`
- `get_open_trades`
- `get_account_balance`
- `get_market_data`
- `get_atr`
- `get_session_info`
- `check_cooldown`
- `set_trade_instruction`
- `update_config`
- `self_update`

### Lesson tools kept
- `add_lesson`
- `list_lessons`
- `pin_lesson`
- `unpin_lesson`
- `clear_lessons`
- `get_performance_history`

### Strategy tools kept
- `add_strategy`
- `list_strategies`
- `get_strategy`
- `set_active_strategy`
- `remove_strategy`

---

## Tool compatibility with executor.js

### Direct executor alignment

| Tool | definitions.js params | executor.js support | Status |
|---|---|---|---|
| `open_trade` | `direction`, `entry_price`, `lot_size`, `stop_loss` required; optional `symbol`, `take_profit`, `setup_type`, `session`, `atr_at_entry`, `risk_reward`, `signal_snapshot` | `openTrade(args)` in `tools/executor.js` | Aligned |
| `close_trade` | `trade_id`, `exit_price` required; optional `reason` | `closeTrade(args)` | Aligned |
| `get_open_trades` | no args | `getOpenTrades()` | Aligned |
| `get_account_balance` | no args | `getAccountBalance()` | Aligned |
| `get_market_data` | optional `symbol`, `timeframe` | `toolMap.get_market_data` stub | Aligned |
| `get_atr` | optional `symbol`, `period` | `toolMap.get_atr` stub | Aligned |
| `get_session_info` | no args | `toolMap.get_session_info` | Aligned |
| `check_cooldown` | no args | `toolMap.check_cooldown` | Aligned |
| `set_trade_instruction` | `trade_id`, `instruction` required | `setTradeInstructionTool()` | Aligned |
| `update_config` | `changes` required; optional `reason` | `toolMap.update_config` | Aligned |
| `self_update` | no args | `toolMap.self_update` | Aligned |
| `get_performance_history` | optional `hours`, `limit` | `getPerformanceHistory` | Aligned |
| `add_lesson` | `rule` required; optional `tags`, `role`, `pinned` | `toolMap.add_lesson` | Mostly aligned |
| `list_lessons` | optional `role`, `pinned`, `tag`, `limit` | `toolMap.list_lessons` | Mostly aligned |
| `pin_lesson` | `id` required | `toolMap.pin_lesson` | Aligned |
| `unpin_lesson` | `id` required | `toolMap.unpin_lesson` | Aligned |
| `clear_lessons` | `mode` required; optional `keyword` | `toolMap.clear_lessons` | Aligned |
| `add_strategy` | `id`, `name` required; compatibility payload fields retained | `addStrategy` in `strategy-library.js` via executor | Compatible with current storage layer |
| `list_strategies` | no args | `listStrategies` | Aligned |
| `get_strategy` | `id` required | `getStrategy` | Aligned |
| `set_active_strategy` | `id` required | `setActiveStrategy` | Aligned |
| `remove_strategy` | `id` required | `removeStrategy` | Aligned |

### agent.js alignment

`agent.js` now role-filters using only XAU/USD/generic tool names. After this rewrite, `tools/definitions.js` now contains those names, so the prior fallback path described in `docs/xauusd_agent_notes.md` should no longer be needed during normal operation.

Relevant aligned sets:
- `MANAGER_TOOLS` in `agent.js`
- `ANALYST_TOOLS` in `agent.js`
- `INTENT_TOOLS` in `agent.js`

This means `agent.js` + `tools/executor.js` + `tools/definitions.js` now align on tool naming and argument shape for the active tool surface.

---

## Remaining compatibility risks

| Risk | File | Severity | Notes |
|---|---|---|---|
| Lesson role enums were updated to `ANALYST` / `MANAGER` / `GENERAL`, but older stored lessons may still use legacy `SCREENER` labels | `lessons.json`, `lessons.js` | Medium | Schema layer is now correct for the new agent role model, but old lesson data may need migration or alias handling if role-filtered retrieval expects old labels. |
| Strategy schemas are still shaped around the existing generic-but-legacy strategy storage fields such as `lp_strategy`, `token_criteria`, and `range` | `tools/definitions.js`, `strategy-library.js` | Medium | Kept intentionally for compatibility because strategy storage has not been rewritten yet. Descriptions were made more generic, but the payload shape is still partially legacy. |
| `get_market_data` and `get_atr` are aligned to executor, but executor currently returns stubs | `tools/executor.js` | Medium | Tool schema is correct, but live market/ATR behavior is still not implemented. |
| `prompt.js` is still a known migration gap from earlier notes | `prompt.js` | High | Tool schema alignment is fixed, but prompt content can still degrade decision quality until prompt migration is completed. |
| `index.js` and surrounding orchestration may still contain migration debt unrelated to schemas | `index.js`, `briefing.js`, `lessons.js` | Medium | This definitions rewrite fixes tool names and params only. |

---

## Recommended next target

**Next target: `prompt.js`**

Why:
- `agent.js`, `tools/executor.js`, and `tools/definitions.js` are now aligned on the active tool surface.
- Existing migration notes still flag `prompt.js` as a high-severity source of degraded context.
- Fixing `prompt.js` next will improve LLM decision quality without changing broker implementation scope.

---

## Summary

This pass completed the schema-layer migration for active tools:
- removed Solana/DLMM tool schemas
- added XAU/USD trade schemas
- preserved only still-supported generic lesson/strategy/self-update tools
- aligned tool names and argument shapes with `tools/executor.js` and `agent.js`
