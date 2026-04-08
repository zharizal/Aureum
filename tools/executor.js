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

import { computeAllIndicators } from "../indicators.js";
import crypto from "crypto";
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

function buildSyntheticCandles({ price, timeframe, count = 200 }) {
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

// ─── Live market-data helpers (Tokocrypto REST API) ──────────────────────────

// Tokocrypto symbol format: XAUT_USDT (slash/dash/space → underscore, uppercase)
function toApiSymbol(symbol) {
  return symbol.replace(/[\/\-\s]/g, "_").replace(/_+/g, "_").toUpperCase();
}

function toKlineInterval(timeframe) {
  return String(timeframe).trim().toLowerCase();
}

async function fetchLiveMarketData(symbol, timeframe) {
  const base = (process.env.TOKOCRYPTO_API_URL || "https://www.tokocrypto.com").replace(/\/+$/, "");
  const apiSymbol = toApiSymbol(symbol);
  const interval = toKlineInterval(timeframe);
  const signal = AbortSignal.timeout(10_000);

  const [depthRes, klinesRes] = await Promise.all([
    fetch(`${base}/open/v1/market/depth?symbol=${apiSymbol}`, { signal }),
    fetch(`${base}/open/v1/market/klines?symbol=${apiSymbol}&interval=${interval}&limit=200`, { signal }),
  ]);

  if (!depthRes.ok) throw new Error(`Depth: HTTP ${depthRes.status}`);
  if (!klinesRes.ok) throw new Error(`Klines: HTTP ${klinesRes.status}`);

  const depth = await depthRes.json();
  const rawKlines = await klinesRes.json();

  // Tokocrypto responses are wrapped: { code, msg, data: { bids, asks } / { list } }
  const depthData = depth.data ?? depth;
  const bid = Number(depthData.bids?.[0]?.[0] ?? 0);
  const ask = Number(depthData.asks?.[0]?.[0] ?? 0);
  const price = roundTo((bid + ask) / 2, config.instrument.pricePrecision);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Invalid bid/ask from API — cannot derive price");
  }

  const klineList = (rawKlines.data?.list ?? rawKlines.data ?? rawKlines);
  const parsedCandles = (Array.isArray(klineList) ? klineList : []).map((k) => ({
    timestamp: new Date(k[0]).toISOString(),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));

  const candlesFallback = parsedCandles.length === 0;
  const candles = candlesFallback
    ? buildSyntheticCandles({ price, timeframe })
    : parsedCandles;

  return {
    success: true,
    live: true,
    exchange: config.instrument.exchange,
    symbol,
    timeframe,
    price,
    bid: roundTo(bid, config.instrument.pricePrecision),
    ask: roundTo(ask, config.instrument.pricePrecision),
    spreadPct: price > 0 ? roundTo(((ask - bid) / price) * 100, 4) : 0,
    timestamp: new Date().toISOString(),
    candles,
    ...(candlesFallback && { note: "Live klines returned empty — candles are synthetic, built from live price." }),
  };
}

// ─── getMarketData: custom URL → Tokocrypto live → paper fallback ────────────

async function getMarketData({ symbol = config.instrument.symbol, timeframe = config.market.timeframe } = {}) {
  // Path 1: Legacy custom URL override (TOKOCRYPTO_MARKET_DATA_URL)
  const customUrl = process.env.TOKOCRYPTO_MARKET_DATA_URL;
  if (customUrl) {
    try {
      const separator = customUrl.includes("?") ? "&" : "?";
      const response = await fetch(`${customUrl}${separator}symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      const price = Number(payload.price ?? payload.lastPrice ?? payload.last ?? payload.close);
      const bid = Number(payload.bid ?? payload.bestBid ?? price);
      const ask = Number(payload.ask ?? payload.bestAsk ?? price);
      const spreadPct = Number.isFinite(payload.spreadPct)
        ? Number(payload.spreadPct)
        : (price > 0 ? ((ask - bid) / price) * 100 : 0);

      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(bid) || !Number.isFinite(ask)) {
        throw new Error("Custom endpoint payload missing numeric price/bid/ask");
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
        note: `Paper fallback — custom endpoint failed: ${error.message}`,
      };
    }
  }

  // Path 2: Tokocrypto REST API (live market data)
  // Non-paper mode: always try (defaults to www.tokocrypto.com)
  // Paper mode: only try if TOKOCRYPTO_API_URL is explicitly set
  if (!config.paper.enabled || process.env.TOKOCRYPTO_API_URL) {
    try {
      return await fetchLiveMarketData(symbol, timeframe);
    } catch (error) {
      log("market", `Live market data failed: ${error.message}`);
      return {
        ...buildPaperMarketData({ symbol, timeframe }),
        liveFallback: true,
        note: `Paper fallback — live API failed: ${error.message}`,
      };
    }
  }

  // Path 3: Paper-only fallback
  return buildPaperMarketData({ symbol, timeframe });
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

// ─── Live order helpers (Tokocrypto signed API) ──────────────────────────────

async function placeMarketOrder(symbol, side, quantity) {
  const base = (process.env.TOKOCRYPTO_API_URL || "https://www.tokocrypto.com").replace(/\/+$/, "");
  const apiKey = process.env.TOKOCRYPTO_API_KEY;
  const apiSecret = process.env.TOKOCRYPTO_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("TOKOCRYPTO_API_KEY and TOKOCRYPTO_API_SECRET required");

  const apiSymbol = toApiSymbol(symbol);
  const timestamp = Date.now();
  const qs = `symbol=${apiSymbol}&side=${side.toUpperCase()}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}&recvWindow=10000`;
  const signature = signQuery(qs, apiSecret);
  const url = `${base}/open/v1/orders?${qs}&signature=${signature}`;
  const signal = AbortSignal.timeout(10_000);

  const res = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey },
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Order HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  return json.data ?? json;
}

async function getOrderStatus(symbol, orderId) {
  const base = (process.env.TOKOCRYPTO_API_URL || "https://www.tokocrypto.com").replace(/\/+$/, "");
  const apiKey = process.env.TOKOCRYPTO_API_KEY;
  const apiSecret = process.env.TOKOCRYPTO_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("TOKOCRYPTO_API_KEY and TOKOCRYPTO_API_SECRET required");

  const apiSymbol = toApiSymbol(symbol);
  const timestamp = Date.now();
  const qs = `symbol=${apiSymbol}&orderId=${orderId}&timestamp=${timestamp}&recvWindow=10000`;
  const signature = signQuery(qs, apiSecret);
  const url = `${base}/open/v1/orders/detail?${qs}&signature=${signature}`;
  const signal = AbortSignal.timeout(10_000);

  const res = await fetch(url, {
    headers: { "X-MBX-APIKEY": apiKey },
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OrderStatus HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  return json.data ?? json;
}

async function cancelOrder(symbol, orderId) {
  const base = (process.env.TOKOCRYPTO_API_URL || "https://www.tokocrypto.com").replace(/\/+$/, "");
  const apiKey = process.env.TOKOCRYPTO_API_KEY;
  const apiSecret = process.env.TOKOCRYPTO_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("TOKOCRYPTO_API_KEY and TOKOCRYPTO_API_SECRET required");

  const apiSymbol = toApiSymbol(symbol);
  const timestamp = Date.now();
  const qs = `symbol=${apiSymbol}&orderId=${orderId}&timestamp=${timestamp}&recvWindow=10000`;
  const signature = signQuery(qs, apiSecret);
  const url = `${base}/open/v1/orders/cancel?${qs}&signature=${signature}`;
  const signal = AbortSignal.timeout(10_000);

  // Tokocrypto cancel order uses POST /open/v1/orders/cancel
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": apiKey },
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CancelOrder HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  return json.data ?? json;
}

function extractFillPrice(orderResult) {
  // Tokocrypto MARKET orders return fills[] with price/qty per fill
  if (Array.isArray(orderResult.fills) && orderResult.fills.length > 0) {
    let totalQty = 0;
    let totalNotional = 0;
    for (const fill of orderResult.fills) {
      const qty = Number(fill.qty);
      const price = Number(fill.price);
      totalQty += qty;
      totalNotional += qty * price;
    }
    return totalQty > 0 ? roundTo(totalNotional / totalQty, config.instrument.pricePrecision) : 0;
  }
  // Fallback: cumulativeQuoteQty / executedQty
  const execQty = Number(orderResult.executedQty);
  const cumQuote = Number(orderResult.cumulativeQuoteQty ?? orderResult.cummulativeQuoteQty);
  if (execQty > 0 && cumQuote > 0) return roundTo(cumQuote / execQty, config.instrument.pricePrecision);
  return 0;
}

function extractFillFee(orderResult) {
  if (!Array.isArray(orderResult.fills)) return 0;
  let totalFee = 0;
  for (const fill of orderResult.fills) {
    totalFee += Number(fill.commission ?? 0);
  }
  return roundTo(totalFee, 6);
}

async function liveOpenTrade({ tradeId, symbol, direction, entryPrice, quantity, stopLoss, takeProfit, setupType, session, atrAtEntry, riskReward, signalSnapshot }) {
  const { trackTrade, recordTradeOpened } = await import("../state.js");
  const normalizedQuantity = normalizeQuantity(quantity);
  const side = direction === "long" ? "BUY" : "SELL";

  const orderResult = await placeMarketOrder(symbol, side, normalizedQuantity);

  if (orderResult.status !== "FILLED") {
    return {
      success: false,
      error: `Order not filled — status: ${orderResult.status}`,
      orderId: orderResult.orderId,
      orderResult,
    };
  }

  const fillPrice = extractFillPrice(orderResult);
  const executedQty = normalizeQuantity(Number(orderResult.executedQty));
  const notionalUsd = roundTo(fillPrice * executedQty, 2);
  const feeUsd = extractFillFee(orderResult);

  trackTrade({
    tradeId,
    symbol,
    direction,
    entryPrice: fillPrice,
    quantity: executedQty,
    notionalUsd,
    stopLoss,
    takeProfit,
    setupType,
    session,
    atrAtEntry,
    riskReward,
    signalSnapshot,
    entryFillPrice: fillPrice,
    entryFeeUsd: feeUsd,
    reservedQuoteUsd: roundTo(notionalUsd + feeUsd, 2),
    orderId: orderResult.orderId,
    live: true,
  });
  recordTradeOpened();

  log("trade", `LIVE ${direction} opened: ${symbol} qty=${executedQty} fill=${fillPrice} orderId=${orderResult.orderId}`);

  return {
    success: true,
    live: true,
    tradeId,
    symbol,
    direction,
    entryPrice: fillPrice,
    quantity: executedQty,
    notionalUsd,
    stopLoss,
    takeProfit,
    feeUsd,
    orderId: orderResult.orderId,
    orderStatus: orderResult.status,
  };
}

async function liveCloseTrade({ tradeId, exitPrice, reason }) {
  const { getTrackedTrade, recordClose } = await import("../state.js");
  const trade = getTrackedTrade(tradeId);
  if (!trade) return { success: false, error: `Trade ${tradeId} not found in state` };
  if (trade.closed) return { success: false, error: `Trade ${tradeId} is already closed` };

  const quantity = normalizeQuantity(trade.quantity ?? 0);
  // To close a long, sell the base asset; to close a short, buy it back
  const side = trade.direction === "long" ? "SELL" : "BUY";

  const orderResult = await placeMarketOrder(trade.symbol, side, quantity);

  if (orderResult.status !== "FILLED") {
    return {
      success: false,
      error: `Close order not filled — status: ${orderResult.status}`,
      orderId: orderResult.orderId,
      orderResult,
    };
  }

  const fillPrice = extractFillPrice(orderResult);
  const executedQty = normalizeQuantity(Number(orderResult.executedQty));
  const exitFeeUsd = extractFillFee(orderResult);
  const entryFeeUsd = trade.entryFeeUsd ?? 0;
  const grossPnl = trade.direction === "long"
    ? (fillPrice - (trade.entryFillPrice ?? trade.entryPrice)) * executedQty
    : ((trade.entryFillPrice ?? trade.entryPrice) - fillPrice) * executedQty;
  const pnlUsd = roundTo(grossPnl - entryFeeUsd - exitFeeUsd, 2);
  const entryRef = trade.entryFillPrice ?? trade.entryPrice;
  const pnlPct = entryRef > 0
    ? roundTo(((trade.direction === "long" ? fillPrice - entryRef : entryRef - fillPrice) / entryRef) * 100, 4)
    : 0;

  recordClose(tradeId, reason || "agent_decision", {
    exitFillPrice: fillPrice,
    exitFeeUsd,
    realizedPnlUsd: pnlUsd,
    unrealizedPnlUsd: 0,
    orderId: orderResult.orderId,
    live: true,
  });
  recordDailyPnl(pnlUsd);
  recordTradeClosed(pnlUsd < 0);

  log("trade", `LIVE ${trade.direction} closed: ${trade.symbol} qty=${executedQty} fill=${fillPrice} pnl=${pnlUsd} orderId=${orderResult.orderId}`);

  return {
    success: true,
    live: true,
    tradeId,
    symbol: trade.symbol,
    direction: trade.direction,
    entryPrice: entryRef,
    exitPrice: fillPrice,
    quantity: executedQty,
    notionalUsd: roundTo(fillPrice * executedQty, 2),
    pnlUsd,
    pnlPct,
    feesUsd: roundTo(entryFeeUsd + exitFeeUsd, 2),
    exitFeeUsd,
    reason: reason || "agent_decision",
    orderId: orderResult.orderId,
    orderStatus: orderResult.status,
  };
}

// ─── Live-trading safety guard ───────────────────────────────────────────────
const _liveOpeningLocks = new Set();
const _liveClosingLocks = new Set();

function isLiveModeExplicitlyEnabled() {
  // Fail-closed: paper must be disabled AND an explicit live env flag must be set.
  return !config.paper.enabled && process.env.TOKOCRYPTO_LIVE === "true";
}

async function validateLiveOpenGuard({ symbol, direction, quantity, entryPrice }) {
  if (!isLiveModeExplicitlyEnabled()) {
    return { ok: false, reason: "live mode not explicitly enabled (require paper.enabled=false AND env TOKOCRYPTO_LIVE=true)" };
  }
  if (!process.env.TOKOCRYPTO_API_KEY || !process.env.TOKOCRYPTO_API_SECRET) {
    return { ok: false, reason: "TOKOCRYPTO_API_KEY / TOKOCRYPTO_API_SECRET not set" };
  }
  if (symbol !== config.instrument.symbol) {
    return { ok: false, reason: `symbol mismatch: ${symbol} != configured ${config.instrument.symbol}` };
  }
  if (direction !== "long" && direction !== "short") {
    return { ok: false, reason: `invalid direction: ${direction}` };
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: `invalid quantity: ${quantity}` };
  }
  if (qty < config.instrument.minQuantity) {
    return { ok: false, reason: `quantity ${qty} < minQuantity ${config.instrument.minQuantity}` };
  }
  const px = Number(entryPrice);
  if (!Number.isFinite(px) || px <= 0) {
    return { ok: false, reason: `invalid entry price: ${entryPrice}` };
  }
  const notional = qty * px;
  if (notional < config.instrument.minNotional) {
    return { ok: false, reason: `notional ${notional} < minNotional ${config.instrument.minNotional}` };
  }
  if (notional > config.risk.maxPositionNotional) {
    return { ok: false, reason: `notional ${notional} > maxPositionNotional ${config.risk.maxPositionNotional}` };
  }
  const openTrades = getTrackedTrades(true);
  if (openTrades.length >= config.risk.maxOpenTrades) {
    return { ok: false, reason: `open trades ${openTrades.length} >= maxOpenTrades ${config.risk.maxOpenTrades}` };
  }
  const cd = checkCooldown(config.cooldown);
  if (cd.blocked) {
    return { ok: false, reason: `cooldown blocked: ${cd.reason}` };
  }
  // Fresh market data + spread check
  let market;
  try {
    market = await fetchLiveMarketData(symbol, config.market.timeframe);
  } catch (e) {
    return { ok: false, reason: `fresh market data fetch failed: ${e.message}` };
  }
  const marketAgeMs = Date.now() - new Date(market.timestamp).getTime();
  if (!Number.isFinite(marketAgeMs) || marketAgeMs > (config.market.stalePriceMaxMs ?? 30_000)) {
    return { ok: false, reason: `market data stale: ${marketAgeMs}ms` };
  }
  if (!Number.isFinite(market.spreadPct) || market.spreadPct > (config.market.maxSpreadPct ?? 0.25)) {
    return { ok: false, reason: `spreadPct ${market.spreadPct} > maxSpreadPct ${config.market.maxSpreadPct}` };
  }
  // Fresh account data + balance sanity check
  let account;
  try {
    account = await fetchLiveAccountBalance();
  } catch (e) {
    return { ok: false, reason: `fresh account data fetch failed: ${e.message}` };
  }
  const quoteBal = account.balances?.find((b) => b.asset === config.instrument.quoteAsset);
  const quoteAvailable = Number(quoteBal?.free ?? 0);
  if (!Number.isFinite(quoteAvailable) || quoteAvailable < notional) {
    return { ok: false, reason: `available ${config.instrument.quoteAsset} ${quoteAvailable} < required notional ${notional}` };
  }
  return { ok: true, reason: null };
}

async function validateLiveCloseGuard({ tradeId }) {
  if (!isLiveModeExplicitlyEnabled()) {
    return { ok: false, reason: "live mode not explicitly enabled (require paper.enabled=false AND env TOKOCRYPTO_LIVE=true)" };
  }
  if (!process.env.TOKOCRYPTO_API_KEY || !process.env.TOKOCRYPTO_API_SECRET) {
    return { ok: false, reason: "TOKOCRYPTO_API_KEY / TOKOCRYPTO_API_SECRET not set" };
  }
  if (!tradeId) {
    return { ok: false, reason: "missing tradeId" };
  }
  const { getTrackedTrade } = await import("../state.js");
  const trade = getTrackedTrade(tradeId);
  if (!trade) {
    return { ok: false, reason: `trade ${tradeId} not found in state` };
  }
  if (trade.closed) {
    return { ok: false, reason: `trade ${tradeId} is already closed` };
  }
  if (trade.symbol !== config.instrument.symbol) {
    return { ok: false, reason: `trade symbol ${trade.symbol} != configured ${config.instrument.symbol}` };
  }
  const qty = Number(trade.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: `invalid tracked quantity: ${trade.quantity}` };
  }
  if (qty < config.instrument.minQuantity) {
    return { ok: false, reason: `tracked quantity ${qty} < minQuantity ${config.instrument.minQuantity}` };
  }
  // Fresh market data + spread check
  let market;
  try {
    market = await fetchLiveMarketData(trade.symbol, config.market.timeframe);
  } catch (e) {
    return { ok: false, reason: `fresh market data fetch failed: ${e.message}` };
  }
  const marketAgeMs = Date.now() - new Date(market.timestamp).getTime();
  if (!Number.isFinite(marketAgeMs) || marketAgeMs > (config.market.stalePriceMaxMs ?? 30_000)) {
    return { ok: false, reason: `market data stale: ${marketAgeMs}ms` };
  }
  if (!Number.isFinite(market.spreadPct) || market.spreadPct > (config.market.maxSpreadPct ?? 0.25)) {
    return { ok: false, reason: `spreadPct ${market.spreadPct} > maxSpreadPct ${config.market.maxSpreadPct}` };
  }
  // Fresh account data sanity
  try {
    await fetchLiveAccountBalance();
  } catch (e) {
    return { ok: false, reason: `fresh account data fetch failed: ${e.message}` };
  }
  return { ok: true, reason: null };
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

  // Live path — run strict safety guard before any order hits the exchange
  const guard = await validateLiveOpenGuard({
    symbol,
    direction,
    quantity,
    entryPrice: entry_price,
  });
  if (!guard.ok) {
    log("trade", `Live open_trade blocked by guard: ${guard.reason}`);
    return {
      success: false,
      error: `Live guard blocked open: ${guard.reason}`,
      note: "State was NOT modified — no order placed.",
    };
  }

  // Duplicate-open prevention: only one live open in flight per symbol+direction
  const openLockKey = `${symbol}|${direction}`;
  if (_liveOpeningLocks.has(openLockKey)) {
    log("trade", `Live open_trade blocked: duplicate in-flight for ${openLockKey}`);
    return {
      success: false,
      error: `Live guard blocked open: duplicate open already in progress for ${openLockKey}`,
      note: "State was NOT modified — no order placed.",
    };
  }
  _liveOpeningLocks.add(openLockKey);

  try {
    return await liveOpenTrade({
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
  } catch (error) {
    log("trade", `Live open_trade failed: ${error.message}`);
    return {
      success: false,
      error: `Live order failed: ${error.message}`,
      note: "State was NOT modified — no trade was tracked.",
    };
  } finally {
    _liveOpeningLocks.delete(openLockKey);
  }
}

async function closeTrade(args) {
  const { trade_id, exit_price, reason } = args;

  if (config.paper.enabled) {
    return paperCloseTrade({ tradeId: trade_id, exitPrice: exit_price, reason });
  }

  // Live path — run strict safety guard before any close order hits the exchange
  const guard = await validateLiveCloseGuard({ tradeId: trade_id });
  if (!guard.ok) {
    log("trade", `Live close_trade blocked by guard: ${guard.reason}`);
    return {
      success: false,
      error: `Live guard blocked close: ${guard.reason}`,
      note: "State was NOT modified — trade remains open.",
    };
  }

  // Duplicate-close prevention: only one live close in flight per tradeId
  if (_liveClosingLocks.has(trade_id)) {
    log("trade", `Live close_trade blocked: duplicate in-flight for ${trade_id}`);
    return {
      success: false,
      error: `Live guard blocked close: duplicate close already in progress for ${trade_id}`,
      note: "State was NOT modified — trade remains open.",
    };
  }
  _liveClosingLocks.add(trade_id);

  try {
    return await liveCloseTrade({ tradeId: trade_id, exitPrice: exit_price, reason });
  } catch (error) {
    log("trade", `Live close_trade failed: ${error.message}`);
    return {
      success: false,
      error: `Live close order failed: ${error.message}`,
      note: "State was NOT modified — trade remains open.",
    };
  } finally {
    _liveClosingLocks.delete(trade_id);
  }
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

// ─── Live account balance (Tokocrypto signed API) ────────────────────────────

function signQuery(queryString, secret) {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

async function fetchLiveAccountBalance() {
  const base = (process.env.TOKOCRYPTO_API_URL || "https://www.tokocrypto.com").replace(/\/+$/, "");
  const apiKey = process.env.TOKOCRYPTO_API_KEY;
  const apiSecret = process.env.TOKOCRYPTO_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("TOKOCRYPTO_API_KEY and TOKOCRYPTO_API_SECRET required for live account");
  }

  function signedUrl(path, extraQs = "") {
    const timestamp = Date.now();
    const qs = `timestamp=${timestamp}&recvWindow=10000${extraQs ? `&${extraQs}` : ""}`;
    const signature = signQuery(qs, apiSecret);
    return `${base}${path}?${qs}&signature=${signature}`;
  }

  async function apiFetch(url) {
    const signal = AbortSignal.timeout(10_000);
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": apiKey }, signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  const quoteAsset = config.instrument.quoteAsset;
  const baseAsset = config.instrument.baseAsset;

  // Prefer per-asset endpoint: GET /open/v1/account/spot/asset?asset=X
  // Returns { asset, free, locked } under data — more targeted and reliable.
  try {
    const [quoteJson, baseJson] = await Promise.all([
      apiFetch(signedUrl("/open/v1/account/spot/asset", `asset=${quoteAsset}`)),
      apiFetch(signedUrl("/open/v1/account/spot/asset", `asset=${baseAsset}`)),
    ]);
    const quoteData = quoteJson.data ?? quoteJson;
    const baseData = baseJson.data ?? baseJson;
    if (quoteData?.asset && baseData?.asset) {
      return { balances: [quoteData, baseData], canTrade: true };
    }
  } catch (_) {
    // fall through to full account endpoint
  }

  // Fallback: GET /open/v1/account/spot — official response: data.accountAssets[]
  const json = await apiFetch(signedUrl("/open/v1/account/spot"));
  const data = json.data ?? json;
  // Normalise data.accountAssets → balances so buildLiveAccountResult can find assets.
  const accountAssets = data.accountAssets ?? data.balances ?? (Array.isArray(data) ? data : []);
  return { ...data, balances: accountAssets };
}

function buildLiveAccountResult(account) {
  const quoteAsset = config.instrument.quoteAsset;
  const baseAsset = config.instrument.baseAsset;

  // Tokocrypto balance fields: a=asset, f=free, l=locked
  const quoteBal = account.balances?.find((b) => (b.a ?? b.asset) === quoteAsset);
  const baseBal = account.balances?.find((b) => (b.a ?? b.asset) === baseAsset);

  const quoteTotal = roundTo(Number(quoteBal?.f ?? quoteBal?.free ?? 0) + Number(quoteBal?.l ?? quoteBal?.locked ?? 0), 2);
  const quoteAvailable = roundTo(Number(quoteBal?.f ?? quoteBal?.free ?? 0), 2);
  const quoteLocked = roundTo(Number(quoteBal?.l ?? quoteBal?.locked ?? 0), 2);

  const baseTotal = roundTo(Number(baseBal?.f ?? baseBal?.free ?? 0) + Number(baseBal?.l ?? baseBal?.locked ?? 0), config.instrument.quantityPrecision);
  const baseAvailable = roundTo(Number(baseBal?.f ?? baseBal?.free ?? 0), config.instrument.quantityPrecision);
  const baseLocked = roundTo(Number(baseBal?.l ?? baseBal?.locked ?? 0), config.instrument.quantityPrecision);

  return {
    success: true,
    live: true,
    exchange: config.instrument.exchange,
    symbol: config.instrument.symbol,
    canOpenTrade: quoteAvailable >= config.instrument.minNotional,
    balances: {
      [quoteAsset]: { asset: quoteAsset, total: quoteTotal, available: quoteAvailable, locked: quoteLocked },
      [baseAsset]: { asset: baseAsset, total: baseTotal, available: baseAvailable, locked: baseLocked },
    },
    quote_asset: quoteAsset,
    base_asset: baseAsset,
    balance_usd: quoteTotal,
    available_balance_usd: quoteAvailable,
    reserved_balance_usd: quoteLocked,
    min_notional_usd: config.instrument.minNotional,
    open_trade_capacity: {
      availableQuote: quoteAvailable,
      minNotional: config.instrument.minNotional,
      maxPositionNotional: config.risk.maxPositionNotional,
      canOpenTrade: quoteAvailable >= config.instrument.minNotional,
    },
    canTrade: account.canTrade ?? true,
  };
}

// ─── getAccountBalance: custom URL → Tokocrypto signed → paper fallback ──────

async function getAccountBalance() {
  // Path 1: Legacy custom URL override (TOKOCRYPTO_ACCOUNT_URL)
  const customUrl = process.env.TOKOCRYPTO_ACCOUNT_URL;
  if (customUrl) {
    try {
      const response = await fetch(customUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      return {
        success: true,
        live: true,
        exchange: config.instrument.exchange,
        symbol: config.instrument.symbol,
        balances: payload.balances ?? payload,
        quote_asset: config.instrument.quoteAsset,
        base_asset: config.instrument.baseAsset,
        note: "Live account balance fetched from custom endpoint.",
      };
    } catch (error) {
      return {
        ...buildPaperAccountBalance(),
        liveFallback: true,
        note: `Paper fallback — custom account endpoint failed: ${error.message}`,
      };
    }
  }

  // Path 2: Tokocrypto signed REST API
  // Non-paper mode: try if API key/secret are set
  // Paper mode: only try if TOKOCRYPTO_API_URL is explicitly set AND key/secret exist
  const apiKey = process.env.TOKOCRYPTO_API_KEY;
  const apiSecret = process.env.TOKOCRYPTO_API_SECRET;
  if (apiKey && apiSecret && (!config.paper.enabled || process.env.TOKOCRYPTO_API_URL)) {
    try {
      const account = await fetchLiveAccountBalance();
      return buildLiveAccountResult(account);
    } catch (error) {
      log("account", `Live account balance failed: ${error.message}`);
      return {
        ...buildPaperAccountBalance(),
        liveFallback: true,
        note: `Paper fallback — live account failed: ${error.message}`,
      };
    }
  }

  // Path 3: Paper-only fallback
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
  get_market_data: async (args) => {
    const result = await getMarketData(args);
    if (result?.candles?.length) result.indicators = computeAllIndicators(result.candles);
    return result;
  },
  get_atr: async ({ symbol = config.instrument.symbol, period } = {}) => {
    const atrPeriod = period ?? config.market.atrPeriod;
    const marketData = await getMarketData({ symbol, timeframe: config.market.timeframe });
    const candles = marketData.candles;
    if (!candles || candles.length < 2) {
      return {
        success: false,
        atr_available: false,
        error: "Not enough candle data to compute ATR.",
        price: marketData.price ?? null,
        live: marketData.live ?? false,
        paper: marketData.paper ?? false,
        exchange: config.instrument.exchange,
        symbol,
      };
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
      live: marketData.live ?? false,
      paper: marketData.paper ?? false,
      exchange: config.instrument.exchange,
      symbol,
      atr,
      period: effectivePeriod,
      price: marketData.price,
      note: marketData.live && !marketData.note
        ? "ATR computed from live candle data."
        : marketData.live && marketData.note
          ? "ATR computed from synthetic candles (live klines were empty)."
          : "ATR computed from synthetic paper candle data.",
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
