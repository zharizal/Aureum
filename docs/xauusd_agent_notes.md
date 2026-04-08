# XAU/USD Agent.js Refactor Notes

`agent.js` — Phase 1 rewrite completed.

---

## Startup crash causes fixed

| Crash source | Root cause | Fix |
|---|---|---|
| `import { getWalletBalances } from "./tools/wallet.js"` | `wallet.js` references `config.tokens.SOL` at module level — `config.tokens` was removed in config.js rewrite → `TypeError: Cannot read properties of undefined` on import | Removed import entirely |
| `import { getMyPositions } from "./tools/dlmm.js"` | `dlmm.js` imports `@meteora-ag/dlmm` which calls Solana web3.js at module level | Removed import entirely |
| `const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()])` at the start of every `agentLoop()` call | Both functions removed → crash on every invocation | Replaced with `null` stubs with Phase 3 comment |

---

## Removed imports

| Removed | Reason |
|---|---|
| `./tools/wallet.js` (`getWalletBalances`) | Solana wallet — crashes on `config.tokens.SOL` |
| `./tools/dlmm.js` (`getMyPositions`) | Solana DLMM SDK — crashes on Solana web3.js |

## Kept imports (unchanged)

- `openai` — LLM client
- `jsonrepair` — malformed JSON repair
- `./prompt.js` — system prompt builder (not yet rewritten — will produce partial output)
- `./tools/executor.js` — tool dispatch
- `./tools/definitions.js` — tool schemas (not yet rewritten — still has Solana schemas)
- `./logger.js` — logging
- `./config.js` — config
- `./state.js` — `getStateSummary()`
- `./lessons.js` — `getLessonsForPrompt()`, `getPerformanceSummary()`

---

## Old tool groups → new tool groups

### MANAGER_TOOLS

| Old (Solana) | New (XAU/USD) |
|---|---|
| `close_position` | `close_trade` |
| `claim_fees` | _(removed — no equivalent)_ |
| `swap_token` | _(removed — no equivalent)_ |
| `get_position_pnl` | _(removed — P&L comes from state)_ |
| `get_my_positions` | `get_open_trades` |
| `set_position_note` | `set_trade_instruction` |
| `add_pool_note` | _(removed)_ |
| `get_wallet_balance` | `get_account_balance` |
| _(new)_ | `get_session_info` |
| _(new)_ | `check_cooldown` |
| `update_config` | `update_config` |
| _(new)_ | All lessons tools |
| _(new)_ | All strategy tools |

### SCREENER_TOOLS → ANALYST_TOOLS

Old `SCREENER` role is now `ANALYST`. The legacy string `"SCREENER"` is accepted as an alias.

| Old (Solana) | New (XAU/USD) |
|---|---|
| `deploy_position` | `open_trade` |
| `get_active_bin` | _(removed)_ |
| `get_top_candidates` | _(removed — market data stubs in Phase 2)_ |
| `check_smart_wallets_on_pool` | _(removed)_ |
| `get_token_holders/narrative/info` | _(removed)_ |
| `search_pools` | _(removed)_ |
| `get_pool_memory` | _(removed)_ |
| `add_pool_note` | _(removed)_ |
| `add_to_blacklist` | _(removed)_ |
| `get_wallet_balance` | `get_account_balance` |
| `get_my_positions` | `get_open_trades` |
| _(new)_ | `get_market_data` (Phase 2 stub) |
| _(new)_ | `get_atr` (Phase 2 stub) |
| _(new)_ | `get_session_info` |
| _(new)_ | `check_cooldown` |

### GENERAL / INTENT_TOOLS

Old intents replaced:

| Old intent | New intent | Notes |
|---|---|---|
| `deploy` | `trade` | Open a new XAU/USD trade |
| `close` | `close` | Close an existing trade |
| `claim` | _(removed)_ | LP fee claiming gone |
| `swap` | _(removed)_ | Token swap gone |
| `screen` | `analyze` | Setup/signal scanning |
| `balance` | `balance` | Account balance |
| `positions` | `positions` | Open trades |
| `memory` | _(removed)_ | Pool memory gone |
| `smartwallet` | _(removed)_ | On-chain wallet tracker gone |
| `study` | _(removed)_ | Top LPer study gone |
| _(new)_ | `session` | Session window / cooldown status |
| `config` | `config` | Kept |
| `selfupdate` | `selfupdate` | Kept |
| `strategy` | `strategy` | Kept |
| `performance` | `performance` | Kept |
| `lessons` | `lessons` | Kept |

---

## Fallback guard for definitions.js mismatch

`getToolsForRole()` now checks if the filtered set is empty and falls back to the full `tools` array. This prevents the agent sending `tools: []` to the API (which would cause an API error) while `definitions.js` still has Solana schemas that don't match any XAU/USD tool name.

---

## Once-per-session locks updated

| Old | New |
|---|---|
| `deploy_position` | `open_trade` |
| `close_position` | `close_trade` |
| `swap_token` | _(removed)_ |
| `NO_RETRY_TOOLS: deploy_position` | `NO_RETRY_TOOLS: open_trade` |

`close_trade` still only locks on `success === true` so genuine failures can be retried.

---

## Remaining compatibility risks

| Risk | File | Severity |
|---|---|---|
| `prompt.js` builds system prompt with `portfolio` (now `null`) and `positions` (now `null`) — will produce incomplete/undefined values | `prompt.js` | **High** — LLM gets degraded context. Rewrite prompt.js next. |
| `tools/definitions.js` still has Solana tool schemas — LLM receives wrong tool descriptions and parameter shapes | `definitions.js` | **High** — every tool call uses wrong schema. Rewrite definitions.js. |
| `getToolsForRole()` falls back to all tools (Solana schemas) when no XAU/USD match — LLM gets wrong names | `definitions.js` | **High** — same as above; acceptable temporary state |
| `lessons.js` `evolveThresholds()` no-op for all XAU/USD signal fields | `lessons.js` | Medium |
| `briefing.js` references pool/fee fields | `briefing.js` | Medium |

---

## Next files to refactor (priority order)

| Priority | File | Reason |
|---|---|---|
| 1 | `tools/definitions.js` | LLM receives Solana tool schemas for every call. Until this is fixed the agent loop functions but uses wrong tool signatures — it will attempt to call `deploy_position` etc. which executor.js will return `unknown tool` for. |
| 2 | `prompt.js` | System prompt receives `null` for portfolio/positions. Produces incomplete context for every cycle. |
| 3 | `lessons.js` | `evolveThresholds()` is a no-op. Learning system stores lessons but cannot evolve signal thresholds. |
| 4 | `briefing.js` | Daily briefing content is LP-specific. |
| 5 | Delete dead files | `tools/dlmm.js`, `tools/wallet.js`, `tools/screening.js`, `tools/token.js`, `tools/study.js`, `tools/okx.js`, `pool-memory.js`, `smart-wallets.js`, `hive-mind.js`, `dev-blocklist.js`, `token-blacklist.js` |

---

## Files modified in this pass

- `agent.js` — targeted rewrite
- `docs/xauusd_agent_notes.md` — this file
