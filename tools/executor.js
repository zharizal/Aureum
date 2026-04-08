/**
 * tools/executor.js
 *
 * Central tool dispatch layer for the XAUT/USDT spot-trading agent.
 */

import {
  addLesson,
  clearAllLessons,
  clearPerformance,
  removeLessonsByKeyword,
  getPerformanceHistory,
  pinLesson,
  unpinLesson,
  listLessons,
} from "../lessons.js";
import {
  setTradeInstruction,
  getTrackedTrades,
  getTodayStats,
  checkCooldown,
  recordTradeClosed,
  recordDailyPnl,
} from "../state.js";
import {
  addStrategy,
  listStrategies,
  getStrategy,
  setActiveStrategy,
  removeStrategy,
} from "../strategy-library.js";
import { config } from "../config.js";
import { log, logAction } from "../logger.js";
import {
  notifyTradeOpen,
  notifyTradeClose,
} from "../telegram.js";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");

let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function roundTo(value, decimals = 8) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function normalizeQuantity(quantity) {
  return roundTo(quantity, config.instrument.quantityPrecision);
}

function timeframeToMs(timeframe = config.market.timeframe) {
  const match = String(timeframe).trim().match(/^(\d+)([mhd])$/i);
  if (!match) return 15 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return value * (multipliers[unit] ?? 15 * 60 * 1000);
}

function buildSyntheticCandles({ price, timeframe, count = 20 }) {
  const stepMs = timeframeToMs(timeframe);
  const now = Date.now();
  const candles = [];

  for (let index = count - 1; index >= 0; index -= 1) {
    const timestamp = now - (index * stepMs);
    const wave = Math.sin(timestamp / 600_000) * 0.0025;
    const drift = Math.cos(timestamp / 900_000) * 0.0015;
    const close = roundTo(price * (1 + wave + drift), config.instrument.pricePrecision);
    const open = roundTo(close * (1 - (wave / 2)), config.instrument.pricePrecision);
    const high = roundTo(Math.max(open, close) * 1.0015, config.instrument.pricePrecision);
    const low = roundTo(Math.min(open, close) * 0.9985, config.instrument.pricePrecision);
    candles.push({
      timestamp: new Date(timestamp).toISOString(),
      open,
      high,
      low,
      close,
      volume: roundTo(10 + Math.abs(wave * 1000), 4),
    });
  }

  return candles;
}

function buildPaperMarketData({ symbol = config.instrument.symbol, timeframe = config.market.timeframe }) {
  const openTrades = getTrackedTrades(true).filter((trade) => trade.symbol === symbol);
  const anchorPrice = openTrades.length > 0
    ? openTrades.reduce((sum, trade) => sum + (trade.entryPrice || 0), 0) / openTrades.length
    : 3300;
  const drift = Math.sin(Date.now() / 300_000) * 0.0015;
  const price = roundTo(anchorPrice * (1 + drift), config.instrument.pricePrecision);
  const spreadPct = roundTo(Math.max(Math.min(config.market.maxSpreadPct ?? 0.25, 0.05), 0.01), 4);
  const halfSpread = price * (spreadPct / 100) / 2;
  const bid = roundTo(price - halfSpread, config.instrument.pricePrecision);
  const ask = roundTo(price + halfSpread, config.instrument.pricePrecision);

  return {
    success: true,
    paper: true,
    exchange: config.instrument.exchange,
    symbol,
    timeframe,
    price,
    bid,
    ask,
    spreadPct,
    timestamp: new Date().toISOString(),
    candles: buildSyntheticCandles({ price, timeframe }),
    note: openTrades.length > 0
      ? "Paper market data derived from tracked trade context with synthetic candles."
      : "Paper market data fallback with synthetic price and candles.",
  };
}

async function getMarketData({ symbol = config.instrument.symbol, timeframe = config.market.timeframe } = {}) {
  const liveUrl = process.env.TOKOCRYPTO_MARKET_DATA_URL;

  if (!liveUrl) {
    return buildPaperMarketData({ symbol, timeframe });
  }

  try {
    const separator = liveUrl.includes("?") ? "&" : "?";
    const response = await fetch(`${liveUrl}${separator}symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const price = Number(payload.price ?? payload.lastPrice ?? payload.last ?? payload.close);
    const bid = Number(payload.bid ?? payload.bestBid ?? price);
    const ask = Number(payload.ask ?? payload.bestAsk ?? price);
    const spreadPct = Number.isFinite(payload.spreadPct)
      ? Number(payload.spreadPct)
      : (price > 0 ? ((ask - bid) / price) * 100 : 0);

    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(bid) || !Number.isFinite(ask)) {
      throw new Error("Live payload missing numeric price/bid/ask fields");
    }

    return {
      success: true,
      live: true,
      exchange: config.instrument.exchange,
      symbol,
      timeframe,
      price: roundTo(price, config.instrument.pricePrecision),
      bid: roundTo(bid, config.instrument.pricePrecision),
      ask: roundTo(ask, config.instrument.pricePrecision),
      spreadPct: roundTo(spreadPct, 4),
      timestamp: payload.timestamp ?? payload.time ?? new Date().toISOString(),
      candles: Array.isArray(payload.candles) ? payload.candles : buildSyntheticCandles({ price, timeframe }),
    };
  } catch (error) {
    return {
      ...buildPaperMarketData({ symbol, timeframe }),
      liveFallback: true,
      note: `Paper fallback used because live market data fetch failed: ${error.message}`,
    };
  }
}

async function paperOpenTrade({ tradeId, symbol, direction, entryPrice, quantity, stopLoss, takeProfit, setupType, session, atrAtEntry, riskReward, signalSnapshot }) {
  const { trackTrade, recordTradeOpened } = await import("../state.js");
  const normalizedQuantity = normalizeQuantity(quantity);
  const marketData = buildPaperMarketData({ symbol, timeframe: config.market.timeframe });
  const spreadPct = marketData.spreadPct ?? 0;
  const halfSpread = entryPrice * (spreadPct / 100) / 2;
  const slippagePct = config.paper.simulateSlippagePct ?? 0;
  const entryBid = roundTo(entryPrice - halfSpread, config.instrument.pricePrecision);
  const entryAsk = roundTo(entryPrice + halfSpread, config.instrument.pricePrecision);
  const fillBasePrice = direction === "long" ? entryAsk : entryBid;
  const fillMultiplier = direction === "long" ? 1 + (slippagePct / 100) : 1 - (slippagePct / 100);
  const entryFillPrice = roundTo(fillBasePrice * fillMultiplier, config.instrument.pricePrecision);
  const notionalUsd = roundTo(entryFillPrice * normalizedQuantity, config.instrument.pricePrecision + config.instrument.quantityPrecision);
  const entryFeeUsd = roundTo(notionalUsd * ((config.paper.feeRatePct ?? 0) / 100), 2);
  const reservedQuoteUsd = roundTo(notionalUsd + entryFeeUsd, 2);

  trackTrade({
    tradeId,
    symbol,
    direction,
    entryPrice: entryFillPrice,
    quantity: normalizedQuantity,
    notionalUsd,
    stopLoss,
    takeProfit,
    setupType,
    session,
    atrAtEntry,
    riskReward,
    signalSnapshot,
    entryFillPrice,
    entryBid,
    entryAsk,
    entrySpreadPct: spreadPct,
    entrySlippagePct: slippagePct,
    entryFeeUsd,
    reservedQuoteUsd,
  });
  recordTradeOpened();
  return {
    success: true,
    paper: true,
    tradeId,
    symbol,
    direction,
    entryPrice: entryFillPrice,
    quantity: normalizedQuantity,
    notionalUsd,
    stopLoss,
    takeProfit,
    entryBid,
    entryAsk,
    spreadPct,
    slippagePct,
    feeUsd: entryFeeUsd,
    reservedQuoteUsd,
    note: "Paper spot trade simulated — no real exchange order placed.",
  };
}

async function paperCloseTrade({ tradeId, exitPrice, reason }) {
  const { getTrackedTrade, recordClose } = await import("../state.js");
  const trade = getTrackedTrade(tradeId);
  if (!trade) return { success: false, error: `Trade ${tradeId} not found in state` };
  if (trade.closed) return { success: false, error: `Trade ${tradeId} is already closed` };

  const quantity = trade.quantity ?? trade.lotSize ?? 0;
  const spreadPct = config.market.maxSpreadPct ?? 0;
  const halfSpread = exitPrice * (spreadPct / 100) / 2;
  const slippagePct = config.paper.simulateSlippagePct ?? 0;
  const exitBid = roundTo(exitPrice - halfSpread, config.instrument.pricePrecision);
  const exitAsk = roundTo(exitPrice + halfSpread, config.instrument.pricePrecision);
  const fillBasePrice = trade.direction === "long" ? exitBid : exitAsk;
  const fillMultiplier = trade.direction === "long" ? 1 - (slippagePct / 100) : 1 + (slippagePct / 100);
  const exitFillPrice = roundTo(fillBasePrice * fillMultiplier, config.instrument.pricePrecision);
  const notionalEntry = (trade.entryFillPrice ?? trade.entryPrice) * quantity;
  const notionalExit = exitFillPrice * quantity;
  const entryFeeUsd = trade.entryFeeUsd ?? roundTo(notionalEntry * ((config.paper.feeRatePct ?? 0) / 100), 2);
  const exitFeeUsd = roundTo(notionalExit * ((config.paper.feeRatePct ?? 0) / 100), 2);
  const grossPnl = trade.direction === "long"
    ? (exitFillPrice - (trade.entryFillPrice ?? trade.entryPrice)) * quantity
    : ((trade.entryFillPrice ?? trade.entryPrice) - exitFillPrice) * quantity;
  const pnlUsd = roundTo(grossPnl - entryFeeUsd - exitFeeUsd, 2);
  const pnlPct = (trade.entryFillPrice ?? trade.entryPrice) > 0
    ? roundTo(((trade.direction === "long" ? exitFillPrice - (trade.entryFillPrice ?? trade.entryPrice) : (trade.entryFillPrice ?? trade.entryPrice) - exitFillPrice) / (trade.entryFillPrice ?? trade.entryPrice)) * 100, 4)
    : 0;

  recordClose(tradeId, reason || "agent_decision", {
    exitFillPrice,
    exitBid,
    exitAsk,
    exitSpreadPct: spreadPct,
    exitSlippagePct: slippagePct,
    exitFeeUsd,
    realizedPnlUsd: pnlUsd,
    unrealizedPnlUsd: 0,
  });
  recordDailyPnl(pnlUsd);
  recordTradeClosed(pnlUsd < 0);

  return {
    success: true,
    paper: true,
    tradeId,
    symbol: trade.symbol,
    direction: trade.direction,
    entryPrice: trade.entryFillPrice ?? trade.entryPrice,
    exitPrice: exitFillPrice,
    quantity,
    notionalUsd: roundTo(notionalExit, 2),
    pnlUsd,
    pnlPct,
    feesUsd: roundTo(entryFeeUsd + exitFeeUsd, 2),
    exitFeeUsd,
    spreadPct,
    slippagePct,
    reason: reason || "agent_decision",
    note: "Paper spot trade close simulated — no real exchange order closed.",
  };
}

async function openTrade(args) {
  const {
    symbol = config.instrument.symbol,
    direction,
    entry_price,
    quantity,
    stop_loss,
    take_profit = null,
    setup_type = null,
    session = null,
    atr_at_entry = null,
    risk_reward = null,
    signal_snapshot = null,
  } = args;

  const tradeId = `T${Date.now()}`;

  if (config.paper.enabled) {
    return paperOpenTrade({
      tradeId,
      symbol,
      direction,
      entryPrice: entry_price,
      quantity,
      stopLoss: stop_loss,
      takeProfit: take_profit,
      setupType: setup_type,
      session,
      atrAtEntry: atr_at_entry,
      riskReward: risk_reward,
      signalSnapshot: signal_snapshot,
    });
  }

  return {
    success: false,
    error: "Live Tokocrypto execution not yet implemented. Set paper.enabled=true or DRY_RUN=true to use paper mode.",
  };
}

async function closeTrade(args) {
  const { trade_id, exit_price, reason } = args;

  if (config.paper.enabled) {
    return paperCloseTrade({ tradeId: trade_id, exitPrice: exit_price, reason });
  }

  return {
    success: false,
    error: "Live Tokocrypto execution not yet implemented. Set paper.enabled=true or DRY_RUN=true to use paper mode.",
  };
}

async function getOpenTrades() {
  const trades = getTrackedTrades(true);
  return {
    success: true,
    total_trades: trades.length,
    trades: trades.map((t) => ({
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
      lastPnlPct: t.lastPnlPct,
      peakProfitPct: t.peakProfitPct,
      trailingActive: t.trailingActive,
      instruction: t.instruction || null,
    })),
    today: getTodayStats(),
  };
}

function buildPaperAccountBalance() {
  const openTrades = getTrackedTrades(true).filter((trade) => trade.symbol === config.instrument.symbol);
  const today = getTodayStats();
  const pnlToday = today?.pnlUsd ?? 0;
  const quoteAsset = config.instrument.quoteAsset;
  const baseAsset = config.instrument.baseAsset;
  const totalQuoteBalance = roundTo(config.paper.initialBalance + pnlToday, 2);
  const reservedQuote = roundTo(
    openTrades.reduce((sum, trade) => sum + (trade.reservedQuoteUsd ?? ((trade.entryPrice ?? 0) * (trade.quantity ?? 0))), 0),
    2,
  );
  const baseLocked = roundTo(
    openTrades
      .filter((trade) => trade.direction === "long")
      .reduce((sum, trade) => sum + (trade.quantity ?? 0), 0),
    config.instrument.quantityPrecision,
  );
  const availableQuote = roundTo(Math.max(0, totalQuoteBalance - reservedQuote), 2);

  return {
    success: true,
    paper: true,
    exchange: config.instrument.exchange,
    symbol: config.instrument.symbol,
    canOpenTrade: availableQuote >= config.instrument.minNotional,
    balances: {
      [quoteAsset]: {
        asset: quoteAsset,
        total: totalQuoteBalance,
        available: availableQuote,
        locked: reservedQuote,
      },
      [baseAsset]: {
        asset: baseAsset,
        total: baseLocked,
        available: 0,
        locked: baseLocked,
      },
    },
    quote_asset: quoteAsset,
    base_asset: baseAsset,
    balance_usd: totalQuoteBalance,
    initial_usd: config.paper.initialBalance,
    pnl_today_usd: pnlToday,
    available_balance_usd: availableQuote,
    reserved_balance_usd: reservedQuote,
    min_notional_usd: config.instrument.minNotional,
    open_trade_capacity: {
      availableQuote,
      minNotional: config.instrument.minNotional,
      maxPositionNotional: config.risk.maxPositionNotional,
      canOpenTrade: availableQuote >= config.instrument.minNotional,
    },
    note: "Paper account balances are derived from configured paper balance and tracked open trades.",
  };
}

async function getAccountBalance() {
  const liveUrl = process.env.TOKOCRYPTO_ACCOUNT_URL;

  if (!config.paper.enabled && liveUrl) {
    try {
      const response = await fetch(liveUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      return {
        success: true,
        live: true,
        exchange: config.instrument.exchange,
        symbol: config.instrument.symbol,
        balances: payload.balances ?? payload,
        quote_asset: config.instrument.quoteAsset,
        base_asset: config.instrument.baseAsset,
        note: "Live account balance fetched from configured account endpoint.",
      };
    } catch (error) {
      if (!config.paper.enabled) {
        return {
          ...buildPaperAccountBalance(),
          liveFallback: true,
          note: `Paper fallback used because live account fetch failed: ${error.message}`,
        };
      }
    }
  }

  return buildPaperAccountBalance();
}

function setTradeInstructionTool({ trade_id, instruction }) {
  const ok = setTradeInstruction(trade_id, instruction || null);
  if (!ok) return { error: `Trade ${trade_id} not found in state` };
  return { saved: true, tradeId: trade_id, instruction: instruction || null };
}

const toolMap = {
  open_trade: openTrade,
  close_trade: closeTrade,
  get_open_trades: getOpenTrades,
  get_account_balance: getAccountBalance,
  set_trade_instruction: setTradeInstructionTool,
  get_market_data: getMarketData,
  get_atr: async ({ symbol = config.instrument.symbol, period } = {}) => {
    const atrPeriod = period ?? config.market.atrPeriod;
    const marketData = buildPaperMarketData({ symbol, timeframe: config.market.timeframe });
    const candles = marketData.candles;
    if (!candles || candles.length < 2) {
      return { success: false, error: "Not enough candle data to compute ATR." };
    }
    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const { high, low } = candles[i];
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);
    }
    const effectivePeriod = Math.min(atrPeriod, trueRanges.length);
    const recent = trueRanges.slice(-effectivePeriod);
    const atr = roundTo(recent.reduce((sum, v) => sum + v, 0) / recent.length, config.instrument.pricePrecision);
    return {
      success: true,
      paper: true,
      exchange: config.instrument.exchange,
      symbol,
      atr,
      period: effectivePeriod,
      price: marketData.price,
      note: "ATR computed from synthetic paper candle data.",
    };
  },
  get_session_info: async () => {
    const now = new Date();
    const hourUtc = now.getUTCHours();
    const windows = config.session.allowedWindows ?? [];
    const active = windows.filter((w) => hourUtc >= w.start && hourUtc < w.end).map((w) => w.name);
    return {
      success: true,
      exchange: config.instrument.exchange,
      utc_hour: hourUtc,
      active_sessions: active,
      session_filter_enabled: config.session.enabled,
    };
  },
  check_cooldown: async () => ({ success: true, ...checkCooldown(config.cooldown) }),
  get_performance_history: getPerformanceHistory,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson: ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  add_strategy: addStrategy,
  list_strategies: listStrategies,
  get_strategy: getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy: removeStrategy,
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  update_config: ({ changes, reason = "" }) => {
    const CONFIG_MAP = {
      exchange: ["instrument", "exchange"],
      symbol: ["instrument", "symbol"],
      baseAsset: ["instrument", "baseAsset"],
      quoteAsset: ["instrument", "quoteAsset"],
      pricePrecision: ["instrument", "pricePrecision"],
      quantityPrecision: ["instrument", "quantityPrecision"],
      minQuantity: ["instrument", "minQuantity"],
      minNotional: ["instrument", "minNotional"],
      timeframe: ["market", "timeframe"],
      atrPeriod: ["market", "atrPeriod"],
      emaFastPeriod: ["market", "emaFastPeriod"],
      emaSlowPeriod: ["market", "emaSlowPeriod"],
      adxPeriod: ["market", "adxPeriod"],
      adxTrendMin: ["market", "adxTrendMin"],
      maxSpreadPct: ["market", "maxSpreadPct"],
      stalePriceMaxMs: ["market", "stalePriceMaxMs"],
      sessionFilterEnabled: ["session", "enabled"],
      newsBlackoutMinutesBefore: ["session", "newsBlackoutMinutesBefore"],
      newsBlackoutMinutesAfter: ["session", "newsBlackoutMinutesAfter"],
      fridayCloseHourUtc: ["session", "fridayCloseHourUtc"],
      minAtrMultiplierForEntry: ["signal", "minAtrMultiplierForEntry"],
      minRiskReward: ["signal", "minRiskReward"],
      minAdxForTrend: ["signal", "minAdxForTrend"],
      maxAdxForRange: ["signal", "maxAdxForRange"],
      requireSessionConfirm: ["signal", "requireSessionConfirm"],
      maxOpenTrades: ["risk", "maxOpenTrades"],
      riskPctPerTrade: ["risk", "riskPctPerTrade"],
      maxDailyLossPct: ["risk", "maxDailyLossPct"],
      maxDrawdownPct: ["risk", "maxDrawdownPct"],
      minAccountBalance: ["risk", "minAccountBalance"],
      maxPositionQuantity: ["risk", "maxPositionQuantity"],
      maxPositionNotional: ["risk", "maxPositionNotional"],
      defaultSlAtr: ["management", "defaultSlAtr"],
      defaultTpAtr: ["management", "defaultTpAtr"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      trailingStop: ["management", "trailingStop"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      maxIdleMinutes: ["management", "maxIdleMinutes"],
      cooldownAfterLossMinutes: ["cooldown", "afterLossMinutes"],
      cooldownAfterTradeMinutes: ["cooldown", "afterTradeMinutes"],
      maxTradesPerHour: ["cooldown", "maxTradesPerHour"],
      maxTradesPerDay: ["cooldown", "maxTradesPerDay"],
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      analysisIntervalMin: ["schedule", "analysisIntervalMin"],
      paperTrading: ["paper", "enabled"],
      paperBalance: ["paper", "initialBalance"],
      simulateSlippage: ["paper", "simulateSlippagePct"],
      feeRatePct: ["paper", "feeRatePct"],
      managementModel: ["llm", "managementModel"],
      analysisModel: ["llm", "analysisModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
    };

    const applied = {};
    const unknown = [];
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      applied[match[0]] = val;
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const before = config[section]?.[field];
      if (config[section]) {
        config[section][field] = val;
        log("config", `update_config: config.${section}.${field} ${before} → ${val}`);
      }
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch {}
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    const intervalChanged = applied.managementIntervalMin != null || applied.analysisIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, analysis: ${config.schedule.analysisIntervalMin}m`);
    }

    const lessonKeys = Object.keys(applied).filter((k) => k !== "managementIntervalMin" && k !== "analysisIntervalMin");
    if (lessonKeys.length > 0) {
      const summary = lessonKeys.map((k) => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

const WRITE_TOOLS = new Set(["open_trade", "close_trade"]);

export async function executeTool(name, args) {
  const startTime = Date.now();
  name = name.replace(/<.*$/, "").trim();

  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  if (WRITE_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return { blocked: true, reason: safetyCheck.reason };
    }
  }

  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error && !result?.stub;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "open_trade") {
        notifyTradeOpen({
          symbol: result.symbol,
          direction: result.direction,
          entryPrice: result.entryPrice,
          quantity: result.quantity,
          stopLoss: result.stopLoss,
          takeProfit: result.takeProfit,
          tradeId: result.tradeId,
          paper: result.paper ?? false,
        }).catch(() => {});
      } else if (name === "close_trade") {
        notifyTradeClose({
          symbol: result.symbol,
          direction: result.direction,
          pnlUsd: result.pnlUsd ?? 0,
          pnlPct: result.pnlPct ?? 0,
          tradeId: result.tradeId,
          reason: result.reason,
          paper: result.paper ?? false,
        }).catch(() => {});
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    logAction({ tool: name, args, error: error.message, duration_ms: duration, success: false });
    return { error: error.message, tool: name };
  }
}

async function runSafetyChecks(name, args) {
  switch (name) {
    case "open_trade": {
      const { direction, entry_price, quantity, stop_loss } = args;

      if (!direction || !["long", "short"].includes(direction)) {
        return { pass: false, reason: `direction must be "long" or "short". Got: ${direction}` };
      }
      if (!entry_price || entry_price <= 0) {
        return { pass: false, reason: `entry_price must be a positive number. Got: ${entry_price}` };
      }
      if (!quantity || quantity <= 0) {
        return { pass: false, reason: `quantity must be a positive number. Got: ${quantity}` };
      }
      if (!stop_loss || stop_loss <= 0) {
        return { pass: false, reason: "stop_loss is required for every trade. No SL = trade blocked." };
      }

      if (direction === "long" && stop_loss >= entry_price) {
        return { pass: false, reason: `Long trade: stop_loss (${stop_loss}) must be below entry_price (${entry_price}).` };
      }
      if (direction === "short" && stop_loss <= entry_price) {
        return { pass: false, reason: `Short trade: stop_loss (${stop_loss}) must be above entry_price (${entry_price}).` };
      }

      if (quantity > config.risk.maxPositionQuantity) {
        return {
          pass: false,
          reason: `quantity ${quantity} exceeds maxPositionQuantity (${config.risk.maxPositionQuantity}). Reduce position size.`,
        };
      }

      const notional = entry_price * quantity;
      if (notional < config.instrument.minNotional) {
        return {
          pass: false,
          reason: `Order notional ${notional.toFixed(2)} ${config.instrument.quoteAsset} is below minNotional (${config.instrument.minNotional}).`,
        };
      }

      if (config.paper.enabled) {
        const paperBalance = buildPaperAccountBalance();
        if ((paperBalance.available_balance_usd ?? 0) < notional) {
          return {
            pass: false,
            reason: `Available ${config.instrument.quoteAsset} balance ${roundTo(paperBalance.available_balance_usd ?? 0, 2)} is below required notional ${roundTo(notional, 2)}.`,
          };
        }
      }
      if (notional > config.risk.maxPositionNotional) {
        return {
          pass: false,
          reason: `Order notional ${notional.toFixed(2)} exceeds maxPositionNotional (${config.risk.maxPositionNotional}).`,
        };
      }

      const openTrades = getTrackedTrades(true);
      if (openTrades.length >= config.risk.maxOpenTrades) {
        return {
          pass: false,
          reason: `Max open trades reached (${openTrades.length}/${config.risk.maxOpenTrades}). Close a trade before opening a new one.`,
        };
      }

      const symbol = args.symbol ?? config.instrument.symbol;
      const alreadyHasSymbol = openTrades.some((t) => t.symbol === symbol);
      if (alreadyHasSymbol) {
        return {
          pass: false,
          reason: `Already have an open trade on ${symbol}. Close it before opening another.`,
        };
      }

      const cooldownResult = checkCooldown(config.cooldown);
      if (cooldownResult.blocked) {
        return { pass: false, reason: cooldownResult.reason };
      }

      const today = getTodayStats();
      if (today && config.risk.maxDailyLossPct && config.paper.enabled) {
        const paperBalance = config.paper.initialBalance;
        const dailyLossPct = paperBalance > 0
          ? Math.abs(Math.min(0, today.pnlUsd) / paperBalance) * 100
          : 0;
        if (dailyLossPct >= config.risk.maxDailyLossPct) {
          return {
            pass: false,
            reason: `Daily loss limit reached: -${dailyLossPct.toFixed(2)}% >= ${config.risk.maxDailyLossPct}% max. No new trades today.`,
          };
        }
      }

      if (config.session.enabled && config.signal.requireSessionConfirm) {
        const hourUtc = new Date().getUTCHours();
        const windows = config.session.allowedWindows ?? [];
        const inWindow = windows.some((w) => hourUtc >= w.start && hourUtc < w.end);
        if (!inWindow) {
          return {
            pass: false,
            reason: `Current UTC hour (${hourUtc}:00) is outside all configured trading windows. Wait for an active session.`,
          };
        }
        const dayUtc = new Date().getUTCDay();
        if (dayUtc === 5 && hourUtc >= config.session.fridayCloseHourUtc) {
          return {
            pass: false,
            reason: `Friday close cutoff reached (UTC ${config.session.fridayCloseHourUtc}:00). No new trades until Monday.`,
          };
        }
      }

      if (config.paper.enabled) {
        log("executor", `[PAPER] open_trade: ${symbol} ${direction} @ ${entry_price}, qty=${quantity}, SL=${stop_loss}`);
      }

      return { pass: true };
    }

    case "close_trade": {
      const { trade_id, exit_price } = args;
      if (!trade_id) {
        return { pass: false, reason: "trade_id is required to close a trade." };
      }
      if (!exit_price || exit_price <= 0) {
        return { pass: false, reason: `exit_price must be a positive number. Got: ${exit_price}` };
      }

      const openTrades = getTrackedTrades(true);
      const exists = openTrades.some((t) => t.tradeId === trade_id);
      if (!exists) {
        return {
          pass: false,
          reason: `Trade ${trade_id} not found in open trades. It may already be closed or the ID is wrong.`,
        };
      }

      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

function summarizeResult(result) {
  const str = JSON.stringify(result);
  return str.length > 1000 ? str.slice(0, 1000) + "...(truncated)" : result;
}
