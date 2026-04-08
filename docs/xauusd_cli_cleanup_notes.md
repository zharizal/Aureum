# XAU/USD CLI and Operator Surface Cleanup Notes

This pass rewrote the operator CLI and cleaned the main repo-facing operator docs so they describe the current XAU/USD runtime instead of the retired Solana/DLMM pool workflow.

---

## Removed legacy CLI/docs concepts

Removed or replaced these retired concepts from the main operator surface:

- Solana wallet balance / token balance operator flow
- DLMM positions / pool / active-bin / pool-detail commands
- token-info / token-holders / token-narrative research commands
- deploy / claim / swap / add-liquidity / withdraw-liquidity LP actions
- blacklist / discord-signals CLI flows
- pool-memory and top-LPer study as active operator commands
- Meteora / OKX / on-chain smart money wording in the main CLI/docs surface
- LP / fee / OOR / bin / pool screening language in the main operator-facing `.claude/*` files

---

## New CLI command surface

`cli.js` now exposes a compact XAU/USD operator surface:

- `status`
- `open-trades`
- `recent-trades`
- `risk`
- `briefing`
- `analyze`
- `manage`
- `start`
- `config get`
- `config set <key> <value>`
- `lessons`
- `lessons add <text>`
- `performance`
- `evolve`
- `help`

These commands now map to current runtime helpers in:

- `config.js`
- `state.js`
- `lessons.js`
- `briefing.js`
- `index.js`
- `tools/executor.js`

The built-in CLI help/SKILL text was rewritten to describe only these current commands.

---

## Stale items cleaned

### `cli.js`

Cleaned:
- header text
- generated SKILL/help text
- flag parsing for retired pool/token commands
- command switch cases for deleted Solana/DLMM modules
- imports of removed files like `tools/dlmm.js`, `tools/wallet.js`, `tools/token.js`, `tools/screening.js`, `tools/study.js`, and blacklist/discord surfaces

### `README.md`

Cleaned:
- top-level project description
- requirements
- setup wording
- run modes
- CLI section
- architecture section
- remaining-gap summary

### `CLAUDE.md`

Cleaned:
- architecture overview
- role descriptions
- CLI surface description
- config overview
- runtime flow
- environment variable section
- remaining migration debt summary

### `.claude/*`

Rewritten to current XAU/USD operator usage:
- `.claude/commands/balance.md`
- `.claude/commands/positions.md`
- `.claude/commands/screen.md`
- `.claude/commands/manage.md`
- `.claude/commands/candidates.md`
- `.claude/commands/study-pool.md`
- `.claude/commands/pool-ohlcv.md`
- `.claude/commands/pool-compare.md`
- `.claude/agents/manager.md`
- `.claude/agents/screener.md`

These now point at current `node cli.js ...` XAU/USD operator commands instead of retired DLMM research/deploy flows.

---

## Remaining migration gaps

A small final cleanup tail still remains:

- `pool-memory.js` remains in the repo as unresolved legacy debt
- `test/test-screening.js` still reflects the retired screening path
- some compatibility aliases/comments still exist in `config.js`, `state.js`, and adjacent runtime files to support the migration
- broader historical docs outside the main operator path may still contain legacy references

---

## Recommended final target

**Final target: remove the last compatibility/dead-tail surfaces**

Recommended focus:
- `pool-memory.js`
- `test/test-screening.js`
- obsolete compatibility shims/comments in `config.js`, `state.js`, and any remaining adjacent files
- any remaining stale non-operator historical docs if still worth keeping

Why:
- the main operator surface is now XAU/USD-aligned
- the remaining debt is mostly low-level compatibility baggage rather than user-facing runtime confusion
- finishing that tail will leave the repo substantially cleaner without changing the active runtime behavior

---

## Summary

This pass completed the operator-surface migration cleanup:

- rewrote `cli.js` to a current XAU/USD command set
- removed CLI references to deleted Solana/DLMM modules
- cleaned the main README / CLAUDE operator-facing docs
- rewrote the main `.claude/*` operator command and agent docs
- left only a smaller final tail of compatibility and historical cleanup debt
