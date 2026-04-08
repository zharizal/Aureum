# XAU/USD Final Migration Tail Notes

This pass removed the last active Solana/DLMM migration tail from the repo runtime and setup surfaces.

---

## What was deleted

Deleted as dead legacy files:

- `pool-memory.js`
- `test/test-screening.js`

Why these were safe to remove:

- `pool-memory.js` was no longer imported anywhere in the active runtime and was fully pool-address / DLMM specific.
- `test/test-screening.js` imported the already-deleted `tools/screening.js` module and only covered the retired pool-screening flow.

---

## What was rewritten

### Runtime/config cleanup

Updated these files to remove stale compatibility shims and wording:

- `config.js`
  - removed `schedule.screeningIntervalMin` getter/setter alias
  - removed `llm.screeningModel` getter/setter alias
  - removed dead `computeDeployAmount()` shim
  - removed stale migration comments
  - kept `u.screeningModel` fallback temporarily for older local config files
- `state.js`
  - removed the entire backward-compat stub block for retired DLMM position helpers
  - removed stale Solana comparison wording in the PnL/exit helper docs
- `agent.js`
  - removed legacy `SCREENER` role alias handling
  - cleaned prompt-building comments to describe current broker-placeholder behavior only
- `prompt.js`
  - removed legacy `SCREENER` alias handling from role selection/docs
- `lessons.js`
  - removed legacy `SCREENER` normalization
  - switched evolution reload call to `reloadSignalThresholds()`
  - renamed `_positionsAtEvolution` bookkeeping to `_tradesAtEvolution`
- `tools/executor.js`
  - removed `screeningIntervalMin` and `screeningModel` config aliases
  - removed related interval/lesson-filter handling
  - removed stale migration comment/import residue
- `tools/definitions.js`
  - removed legacy alias keys from the `update_config` supported-key description

### Repo/supporting surfaces

Updated these files so the remaining repo-facing surfaces match the current XAU/USD runtime:

- `README.md`
  - removed the now-outdated note that `pool-memory.js` / `test/test-screening.js` still remained
- `CLAUDE.md`
  - removed the outdated note about legacy `SCREENER` compatibility and old tail items still pending
- `.gitignore`
  - removed retired Solana/DLMM runtime data files from ignore rules
  - kept current local runtime files only
- `setup.js`
  - rewrote the setup wizard from the retired Solana/DLMM deployment flow to the current XAU/USD runtime config flow
- `user-config.example.json`
  - rewrote the example config to current XAU/USD keys and values

---

## What was kept temporarily

These compatibility pieces were retained on purpose:

- `config.js` still accepts `u.screeningModel` as a fallback when loading `analysisModel`
  - keeps older local `user-config.json` files readable during upgrade
- `lessons.js` still accepts older performance-record fields such as `pool`, `pool_name`, `position`, and `deployed_at`
  - keeps older `lessons.json` history readable without affecting new XAU/USD records
- historical migration docs under `docs/xauusd_*`
  - these remain as migration/audit notes, not active operator/runtime docs

---

## Remaining non-blocking gaps

Small non-blocking items may still exist, but they are outside the active runtime consistency problem:

- historical migration notes still reference retired Solana/DLMM concepts by design
- future broker/account integration is still intentionally incomplete
- strategy content may still deserve a separate review if the project wants strategy-library defaults/examples rewritten more aggressively later

---

## Final readiness assessment

The active repo now presents a consistent XAU/USD bot framework:

- active runtime files use XAU/USD trade terminology
- dead pool/DLMM files from the final cleanup tail are removed
- obsolete runtime aliases were trimmed down to only low-risk local-data fallbacks
- setup and example-config surfaces now match the current architecture

Final assessment:

**Ready as a coherent XAU/USD framework, with only non-blocking historical or future-work items remaining.**
