/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks trade metadata that is not available from the exchange adapter:
 * - When a trade was opened and with what parameters
 * - Trailing stop / peak-profit state updated by the PnL poller
 * - Drawdown tracking (daily and total)
 * - Cooldown timestamps (after loss, after any close)
 * - Last signal and last action metadata for prompt injection
 */

import fs from "fs";
import { log } from "./logger.js";

const STATE_FILE = "./state.json";
const MAX_RECENT_EVENTS = 20;

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      trades: {},
      dailyStats: {},
      cooldown: {},
      recentEvents: [],
      lastUpdated: null,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return {
      trades: {},
      dailyStats: {},
      cooldown: {},
      recentEvents: [],
      lastUpdated: null,
    };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Record a newly opened trade.
 *
 * @param {Object} trade
 * @param {string} trade.tradeId
 * @param {string} trade.symbol
 * @param {string} trade.direction
 * @param {number} trade.entryPrice
 * @param {number} trade.quantity
 * @param {number} trade.notionalUsd
 * @param {number} trade.stopLoss
 * @param {number} trade.takeProfit
 * @param {string} [trade.setupType]
 * @param {string} [trade.session]
 * @param {number} [trade.atrAtEntry]
 * @param {number} [trade.riskReward]
 * @param {Object} [trade.signalSnapshot]
 */
export function trackTrade({
  tradeId,
  symbol,
  direction,
  entryPrice,
  quantity,
  notionalUsd = null,
  stopLoss,
  takeProfit = null,
  setupType = null,
  session = null,
  atrAtEntry = null,
  riskReward = null,
  signalSnapshot = null,
  entryFillPrice = null,
  entryBid = null,
  entryAsk = null,
  entrySpreadPct = null,
  entrySlippagePct = null,
  entryFeeUsd = 0,
  reservedQuoteUsd = null,
}) {
  const state = load();
  if (!state.trades) state.trades = {};

  state.trades[tradeId] = {
    tradeId,
    symbol,
    direction,
    entryPrice,
    quantity,
    notionalUsd,
    stopLoss,
    takeProfit,
    setupType,
    session,
    atrAtEntry,
    riskReward,
    signalSnapshot: signalSnapshot || null,
    entryFillPrice,
    entryBid,
    entryAsk,
    entrySpreadPct,
    entrySlippagePct,
    entryFeeUsd,
    reservedQuoteUsd,
    exitFillPrice: null,
    exitBid: null,
    exitAsk: null,
    exitSpreadPct: null,
    exitSlippagePct: null,
    exitFeeUsd: 0,
    realizedPnlUsd: null,
    unrealizedPnlUsd: 0,
    openedAt: new Date().toISOString(),
    closed: false,
    closedAt: null,
    closeReason: null,
    peakProfitPct: 0,
    trailingActive: false,
    lastPnlPct: null,
    instruction: null,
    notes: [],
  };

  pushEvent(state, { action: "open", tradeId, symbol, direction, entryPrice, quantity });
  save(state);
  log("state", `Tracked new trade: ${tradeId} ${symbol} ${direction} @ ${entryPrice} qty=${quantity}`);
}

export function recordClose(tradeId, reason, closeData = {}) {
  const state = load();
  const trade = state.trades?.[tradeId];
  if (!trade) return;
  trade.closed = true;
  trade.closedAt = new Date().toISOString();
  trade.closeReason = reason;
  Object.assign(trade, closeData);
  trade.notes.push(`Closed at ${trade.closedAt}: ${reason}`);
  pushEvent(state, { action: "close", tradeId, symbol: trade.symbol, reason, realizedPnlUsd: trade.realizedPnlUsd ?? null });
  save(state);
  log("state", `Trade ${tradeId} closed: ${reason}`);
}

export function setTradeInstruction(tradeId, instruction) {
  const state = load();
  const trade = state.trades?.[tradeId];
  if (!trade) return false;
  trade.instruction = instruction || null;
  save(state);
  log("state", `Trade ${tradeId} instruction set: ${instruction}`);
  return true;
}

export function getTrackedTrade(tradeId) {
  const state = load();
  const trade = state.trades?.[tradeId] || null;
  if (trade && trade.quantity == null && trade.lotSize != null) {
    trade.quantity = trade.lotSize;
  }
  return trade;
}

export function getTrackedTrades(openOnly = false) {
  const state = load();
  const all = Object.values(state.trades || {}).map((trade) => {
    if (trade.quantity == null && trade.lotSize != null) {
      return { ...trade, quantity: trade.lotSize };
    }
    return trade;
  });
  return openOnly ? all.filter((t) => !t.closed) : all;
}

const SYNC_GRACE_MS = 5 * 60_000;

export function syncOpenTrades(activeTradeIds) {
  const state = load();
  if (!state.trades) return;
  const activeSet = new Set(activeTradeIds);
  let changed = false;

  for (const id in state.trades) {
    const trade = state.trades[id];
    if (trade.closed || activeSet.has(id)) continue;

    const openedAt = trade.openedAt ? new Date(trade.openedAt).getTime() : 0;
    if (Date.now() - openedAt < SYNC_GRACE_MS) {
      log("state", `Trade ${id} not visible at exchange yet — within grace period, skipping auto-close`);
      continue;
    }

    trade.closed = true;
    trade.closedAt = new Date().toISOString();
    trade.closeReason = "auto_sync";
    trade.notes.push("Auto-closed during state sync (not found in exchange position snapshot)");
    changed = true;
    log("state", `Trade ${id} auto-closed (missing from exchange data)`);
  }

  if (changed) save(state);
}

export function updatePnlAndCheckExits(tradeId, liveData, mgmtConfig) {
  const { pnlPct: currentPnlPct } = liveData;
  const state = load();
  const trade = state.trades?.[tradeId];
  if (!trade || trade.closed) return null;

  let changed = false;

  if (currentPnlPct != null && currentPnlPct !== trade.lastPnlPct) {
    trade.lastPnlPct = currentPnlPct;
    changed = true;
  }

  if (liveData?.pnlUsd != null && liveData.pnlUsd !== trade.unrealizedPnlUsd) {
    trade.unrealizedPnlUsd = liveData.pnlUsd;
    changed = true;
  }

  if (currentPnlPct != null && currentPnlPct > (trade.peakProfitPct ?? 0)) {
    trade.peakProfitPct = currentPnlPct;
    changed = true;
  }

  if (
    mgmtConfig.trailingStop &&
    !trade.trailingActive &&
    currentPnlPct >= mgmtConfig.trailingTriggerPct
  ) {
    trade.trailingActive = true;
    changed = true;
    log("state", `Trade ${tradeId} trailing stop activated at ${currentPnlPct}% (peak: ${trade.peakProfitPct}%)`);
  }

  if (changed) save(state);

  if (
    currentPnlPct != null &&
    mgmtConfig.stopLossPct != null &&
    currentPnlPct <= mgmtConfig.stopLossPct
  ) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  if (
    currentPnlPct != null &&
    mgmtConfig.takeProfitPct != null &&
    currentPnlPct >= mgmtConfig.takeProfitPct
  ) {
    return {
      action: "TAKE_PROFIT",
      reason: `Take profit: PnL ${currentPnlPct.toFixed(2)}% >= ${mgmtConfig.takeProfitPct}%`,
    };
  }

  if (trade.trailingActive) {
    const dropFromPeak = trade.peakProfitPct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_STOP",
        reason: `Trailing stop: peak ${trade.peakProfitPct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (retraced ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
      };
    }
  }

  if (mgmtConfig.maxIdleMinutes && trade.openedAt) {
    const minutesHeld = Math.floor((Date.now() - new Date(trade.openedAt).getTime()) / 60_000);
    if (minutesHeld >= mgmtConfig.maxIdleMinutes && (currentPnlPct ?? 0) <= 0) {
      return {
        action: "IDLE_EXIT",
        reason: `Trade idle for ${minutesHeld}m (limit: ${mgmtConfig.maxIdleMinutes}m) with no profit — exiting`,
      };
    }
  }

  return null;
}

export function recordDailyPnl(pnlUsd) {
  const state = load();
  const today = todayUtc();
  if (!state.dailyStats) state.dailyStats = {};
  if (!state.dailyStats[today]) {
    state.dailyStats[today] = { pnlUsd: 0, tradesOpened: 0, tradesClosed: 0, wins: 0, losses: 0 };
  }
  const d = state.dailyStats[today];
  d.pnlUsd = Math.round(((d.pnlUsd || 0) + pnlUsd) * 100) / 100;
  d.tradesClosed = (d.tradesClosed || 0) + 1;
  if (pnlUsd > 0) d.wins = (d.wins || 0) + 1;
  else d.losses = (d.losses || 0) + 1;
  save(state);
}

export function recordTradeOpened() {
  const state = load();
  const today = todayUtc();
  if (!state.dailyStats) state.dailyStats = {};
  if (!state.dailyStats[today]) {
    state.dailyStats[today] = { pnlUsd: 0, tradesOpened: 0, tradesClosed: 0, wins: 0, losses: 0 };
  }
  state.dailyStats[today].tradesOpened = (state.dailyStats[today].tradesOpened || 0) + 1;
  save(state);
}

export function getTodayStats() {
  const state = load();
  return state.dailyStats?.[todayUtc()] || null;
}

export function recordTradeClosed(wasLoss) {
  const state = load();
  if (!state.cooldown) state.cooldown = {};
  state.cooldown.lastTradeClosedAt = new Date().toISOString();
  if (wasLoss) {
    state.cooldown.lastLossAt = new Date().toISOString();
  }
  save(state);
}

export function checkCooldown(cooldownConfig) {
  const state = load();
  const cd = state.cooldown || {};
  const now = Date.now();

  if (cd.lastLossAt) {
    const msSinceLoss = now - new Date(cd.lastLossAt).getTime();
    const requiredMs = (cooldownConfig.afterLossMinutes ?? 30) * 60_000;
    if (msSinceLoss < requiredMs) {
      const remaining = Math.ceil((requiredMs - msSinceLoss) / 60_000);
      return { blocked: true, reason: `Post-loss cooldown: ${remaining}m remaining` };
    }
  }

  if (cd.lastTradeClosedAt) {
    const msSinceClose = now - new Date(cd.lastTradeClosedAt).getTime();
    const requiredMs = (cooldownConfig.afterTradeMinutes ?? 5) * 60_000;
    if (msSinceClose < requiredMs) {
      const remaining = Math.ceil((requiredMs - msSinceClose) / 60_000);
      return { blocked: true, reason: `Post-trade cooldown: ${remaining}m remaining` };
    }
  }

  return { blocked: false, reason: null };
}

export function getStateSummary() {
  const state = load();
  const openTrades = Object.values(state.trades || {})
    .map((trade) => (trade.quantity == null && trade.lotSize != null ? { ...trade, quantity: trade.lotSize } : trade))
    .filter((t) => !t.closed);
  const closedCount = Object.values(state.trades || {}).filter((t) => t.closed).length;
  const todayStats = state.dailyStats?.[todayUtc()] || null;
  const cooldown = state.cooldown || {};

  return {
    open_trades: openTrades.length,
    closed_trades: closedCount,
    today: todayStats
      ? {
          pnl_usd: todayStats.pnlUsd,
          trades_opened: todayStats.tradesOpened,
          trades_closed: todayStats.tradesClosed,
          wins: todayStats.wins,
          losses: todayStats.losses,
        }
      : null,
    cooldown: {
      last_loss_at: cooldown.lastLossAt || null,
      last_trade_closed_at: cooldown.lastTradeClosedAt || null,
    },
    trades: openTrades.map((t) => ({
      tradeId: t.tradeId,
      symbol: t.symbol,
      direction: t.direction,
      entryPrice: t.entryPrice,
      quantity: t.quantity,
      notionalUsd: t.notionalUsd ?? null,
      stopLoss: t.stopLoss,
      takeProfit: t.takeProfit,
      openedAt: t.openedAt,
      setupType: t.setupType,
      session: t.session,
      peakProfitPct: t.peakProfitPct,
      trailingActive: t.trailingActive,
      lastPnlPct: t.lastPnlPct,
      instruction: t.instruction || null,
    })),
    recent_events: (state.recentEvents || []).slice(-10),
    last_updated: state.lastUpdated,
  };
}

export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = todayUtc();
  save(state);
}
