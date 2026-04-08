# XAUT/USDT Tokocrypto Migration Notes

This pass pivots the active runtime from XAU/USD forex-style semantics to XAUT/USDT spot-trading semantics on Tokocrypto while keeping the existing architecture intact.

---

## XAU/USD -> XAUT/USDT concept mapping

- `XAU/USD` -> `XAUT/USDT`
- broker-oriented gold pair framing -> Tokocrypto-oriented spot market framing
- lot size -> quantity
- pip / pip-value sizing -> quote-currency notional sizing
- spread in pips -> spread percentage placeholder
- broker/account wording -> exchange/account wording
- paper broker fill simulation -> paper spot-trade simulation with fee placeholder

---

## Renamed config/state fields

### Config

Renamed or replaced in active runtime surfaces:

- `instrument.pipValue` -> removed
- `instrument.lotSize` -> removed
- `instrument.precision` -> `instrument.pricePrecision`
- `risk.maxLotSize` -> `risk.maxPositionQuantity`
- added `risk.maxPositionNotional`
- `market.maxSpreadPips` -> `market.maxSpreadPct`
- added `instrument.exchange`
- added `instrument.baseAsset`
- added `instrument.quoteAsset`
- added `instrument.quantityPrecision`
- added `instrument.minQuantity`
- added `instrument.minNotional`
- added `paper.feeRatePct`

### State / runtime payloads

- `lotSize` / `lot_size` -> `quantity`
- added `notionalUsd` / `notional_usd` where relevant in tracked or historical trade records
- operator summaries and tool payloads now report quantity instead of lots

---

## Forex concepts removed

Removed from the active runtime/operator surface:

- lot-based sizing language
- pip-value sizing math
- spread-in-pips wording
- XAU/USD-only prompt, CLI, README, and briefing wording
- broker-specific wording where the runtime is only using a local/paper skeleton

Kept intentionally:

- ATR / ADX / risk-reward logic, because those are still usable strategy abstractions and not inherently forex-only
- existing session-window and cooldown mechanisms, now reframed as configured trading-window logic
- legacy performance-record fallbacks in `lessons.js` so old stored trade history can still be read safely

---

## Tokocrypto-specific placeholders added

Added or made explicit for future exchange integration:

- `exchange`
- `symbol`
- `baseAsset`
- `quoteAsset`
- `pricePrecision`
- `quantityPrecision`
- `minQuantity`
- `minNotional`
- `feeRatePct`
- `maxPositionNotional`
- `maxSpreadPct`

These are active config/runtime placeholders only. They do not imply that full REST/WebSocket/API-key order routing is implemented yet.

---

## Remaining gaps before paper-trading phase

The paper-trading skeleton is still the active safe path, but a few realism gaps remain:

- `get_market_data` is still a stub
- `get_atr` is still a stub
- paper fills still use simplified local execution assumptions
- session windows are configurable placeholders, not exchange-native market session logic
- strategy defaults were not broadly redesigned beyond semantic pivoting

---

## Remaining gaps before real exchange execution

Still not implemented:

- Tokocrypto REST authentication and API key flow
- live order placement/cancel/close routing
- live open-order / balance / position sync
- live market-data websocket or polling adapter
- exchange rule validation against real symbol filters
- production-grade fee/slippage and partial-fill handling

---

## Final assessment

The active runtime now reads as a coherent XAUT/USDT spot-trading framework oriented around Tokocrypto terminology.

- active config/state/operator surfaces use XAUT/USDT wording
- lot/pip semantics were removed from the active runtime
- paper mode remains the safe execution path
- Tokocrypto integration points are explicit placeholders rather than implied live functionality

**Ready as an XAUT/USDT paper-trading skeleton, but not yet ready for real Tokocrypto-backed execution.**
