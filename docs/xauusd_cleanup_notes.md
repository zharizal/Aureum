# XAU/USD Dead Legacy Cleanup Notes

This pass removed clearly dead Solana/DLMM-era files and stale metadata that were no longer part of the active XAU/USD runtime path.

---

## Deleted files/items

### Deleted legacy modules

Removed these legacy-only files:

- `tools/dlmm.js`
- `tools/wallet.js`
- `tools/token.js`
- `tools/screening.js`
- `tools/study.js`
- `tools/okx.js`
- `hive-mind.js`
- `smart-wallets.js`
- `token-blacklist.js`
- `dev-blocklist.js`

### Deleted legacy support files

Removed these legacy-only support files/directories:

- `deployer-blacklist.json`
- `scripts/patch-anchor.js`
- `discord-listener/`
  - `discord-listener/index.js`
  - `discord-listener/pre-checks.js`
  - `discord-listener/package.json`
  - `discord-listener/package-lock.json`

### Deleted stale package metadata

Removed from `package.json`:

- Solana/DLMM dependencies:
  - `@meteora-ag/dlmm`
  - `@solana/spl-token`
  - `@solana/web3.js`
  - `bn.js`
  - `bs58`
- obsolete scripts:
  - `test:screen`
  - `postinstall`

Also updated package metadata from DLMM/Solana wording to XAU/USD wording.

---

## Deprecated-but-kept items

These legacy surfaces were intentionally kept for safety in this pass:

- `cli.js`
  - still contains many retired Solana/DLMM commands and imports
  - kept temporarily because it is the current `bin` entry in `package.json`, so aggressive removal or rewrite would be riskier than this cleanup pass allows
- `state.js` backward-compat stubs
  - kept to tolerate stale callers while cleanup continues
  - these include deprecated position/OOR/claim/rebalance helpers
- `pool-memory.js`
  - not part of the active XAU/USD runtime, but the migration plan classified it as rewrite/defer rather than unconditional delete
- `.claude/agents/screener.md` and several `.claude/commands/*` files
  - still contain old screening/pool wording
  - not part of the active runtime import path, so left for a focused Claude/docs cleanup pass

---

## Risky items not deleted

These still contain legacy wording or behavior but were not deleted because doing so now would be less surgical:

- `README.md`
  - still contains substantial retired Solana/DLMM documentation
  - only minimal warning text was added in this pass
- `CLAUDE.md`
  - top-level identity text was corrected, but much of the document still reflects old architecture/details
- `cli.js`
  - still references deleted files and would fail if those legacy commands are invoked
  - acceptable for this pass because the active XAU/USD runtime does not depend on those command paths
- `test/test-screening.js`
  - still belongs to the retired screening path and is now stale after deleting `tools/screening.js`
  - not used by active runtime verification in this pass
- `state.js` compat comments/stubs
  - still mention `tools/dlmm.js` as historical callers
  - intentionally retained until the remaining legacy command surface is cleaned up

---

## Remaining migration gaps

After this cleanup, the main remaining legacy debt is concentrated in a smaller set of non-runtime or compatibility surfaces:

- `cli.js` still exposes many Solana/DLMM commands
- `.claude/agents/*` and `.claude/commands/*` still contain legacy screening/management language
- `README.md` and `CLAUDE.md` still contain broad stale documentation outside the active runtime path
- `pool-memory.js` remains as unresolved migration debt
- `test/test-screening.js` is stale and should be removed or replaced with an XAU/USD equivalent

---

## Recommended next target

**Next target: `cli.js` and stale Claude/docs surfaces**

Why:
- the active runtime path is now much cleaner and no longer imports the removed Solana helper modules
- the biggest remaining source of confusion is legacy command/documentation surface area rather than core runtime code
- cleaning `cli.js`, `.claude/agents/*`, `.claude/commands/*`, and the remaining stale top-level docs will reduce accidental use of removed features and make the repo state much easier to understand

---

## Summary

This pass completed the first safe dead-code cleanup after the XAU/USD migration:

- removed clearly dead Solana/DLMM modules
- removed the Discord listener and Anchor patch script
- removed obsolete Solana package dependencies and scripts
- cleaned stale runtime metadata/comments in active files
- left risky or still-entangled legacy surfaces in place for a follow-up pass
