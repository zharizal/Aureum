import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

if (u.llmModel) process.env.LLM_MODEL ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL ||= u.llmBaseUrl;
if (u.llmApiKey) process.env.LLM_API_KEY ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

export const config = {
  instrument: {
    exchange: u.exchange ?? "Tokocrypto",
    symbol: u.symbol ?? "XAUT/USDT",
    baseAsset: u.baseAsset ?? "XAUT",
    quoteAsset: u.quoteAsset ?? "USDT",
    pricePrecision: u.pricePrecision ?? 2,
    quantityPrecision: u.quantityPrecision ?? 4,
    minQuantity: u.minQuantity ?? 0.0001,
    minNotional: u.minNotional ?? 10,
  },

  market: {
    timeframe: u.timeframe ?? "15m",
    atrPeriod: u.atrPeriod ?? 14,
    emaFastPeriod: u.emaFastPeriod ?? 20,
    emaSlowPeriod: u.emaSlowPeriod ?? 50,
    adxPeriod: u.adxPeriod ?? 14,
    adxTrendMin: u.adxTrendMin ?? 25,
    maxSpreadPct: u.maxSpreadPct ?? 0.25,
    stalePriceMaxMs: u.stalePriceMaxMs ?? 30_000,
  },

  session: {
    enabled: u.sessionFilterEnabled ?? true,
    allowedWindows: u.allowedWindows ?? [
      { start: 0, end: 8, name: "Asia" },
      { start: 7, end: 16, name: "Europe" },
      { start: 12, end: 21, name: "US Overlap" },
    ],
    newsBlackoutMinutesBefore: u.newsBlackoutMinutesBefore ?? 30,
    newsBlackoutMinutesAfter: u.newsBlackoutMinutesAfter ?? 15,
    fridayCloseHourUtc: u.fridayCloseHourUtc ?? 19,
  },

  signal: {
    minAtrMultiplierForEntry: u.minAtrMultiplierForEntry ?? 0.5,
    minRiskReward: u.minRiskReward ?? 1.5,
    minAdxForTrend: u.minAdxForTrend ?? 25,
    maxAdxForRange: u.maxAdxForRange ?? 20,
    requireSessionConfirm: u.requireSessionConfirm ?? true,
  },

  risk: {
    maxOpenTrades: u.maxOpenTrades ?? 3,
    riskPctPerTrade: u.riskPctPerTrade ?? 1.0,
    maxDailyLossPct: u.maxDailyLossPct ?? 3.0,
    maxDrawdownPct: u.maxDrawdownPct ?? 10.0,
    minAccountBalance: u.minAccountBalance ?? 100,
    maxPositionQuantity: u.maxPositionQuantity ?? 1.0,
    maxPositionNotional: u.maxPositionNotional ?? 5_000,
  },

  management: {
    defaultSlAtr: u.defaultSlAtr ?? 1.5,
    defaultTpAtr: u.defaultTpAtr ?? 2.5,
    stopLossPct: u.stopLossPct ?? -2.0,
    takeProfitPct: u.takeProfitPct ?? 3.0,
    trailingStop: u.trailingStop ?? true,
    trailingTriggerPct: u.trailingTriggerPct ?? 1.0,
    trailingDropPct: u.trailingDropPct ?? 0.5,
    maxIdleMinutes: u.maxIdleMinutes ?? 240,
  },

  cooldown: {
    afterLossMinutes: u.cooldownAfterLossMinutes ?? 30,
    afterTradeMinutes: u.cooldownAfterTradeMinutes ?? 5,
    maxTradesPerHour: u.maxTradesPerHour ?? 3,
    maxTradesPerDay: u.maxTradesPerDay ?? 10,
  },

  schedule: {
    managementIntervalMin: u.managementIntervalMin ?? 5,
    analysisIntervalMin: u.analysisIntervalMin ?? 15,
  },

  llm: {
    temperature: u.temperature ?? 0.3,
    maxTokens: u.maxTokens ?? 4096,
    maxSteps: u.maxSteps ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    analysisModel: u.analysisModel ?? u.screeningModel ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel: u.generalModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  paper: {
    enabled: u.paperTrading ?? (process.env.DRY_RUN === "true"),
    initialBalance: u.paperBalance ?? 10_000,
    simulateSlippagePct: u.simulateSlippage ?? 0.02,
    feeRatePct: u.feeRatePct ?? 0.1,
  },
};

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Compute position size based on account balance and risk parameters.
 *
 * @param {number} accountBalance - Available account balance in USD
 * @param {number} entryPrice     - Intended entry price
 * @param {number} stopPrice      - Stop-loss price
 * @returns {number} Normalised quantity respecting min/max constraints
 */
export function computeOrderQuantity(accountBalance, entryPrice, stopPrice) {
  if (!entryPrice || entryPrice <= 0) return config.instrument.minQuantity;

  const riskUsd = accountBalance * (config.risk.riskPctPerTrade / 100);
  const stopDistance = Math.abs(entryPrice - stopPrice);
  if (!stopDistance || stopDistance <= 0) {
    return config.instrument.minQuantity;
  }

  const rawQuantity = riskUsd / stopDistance;
  const byNotional = config.risk.maxPositionNotional / entryPrice;
  const cappedQuantity = Math.min(rawQuantity, config.risk.maxPositionQuantity, byNotional);
  const bounded = Math.max(config.instrument.minQuantity, cappedQuantity);
  return roundTo(bounded, config.instrument.quantityPrecision);
}

/**
 * Hot-reload signal thresholds from user-config.json without a full restart.
 * Only updates `config.signal.*` keys.
 */
export function reloadSignalThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const sig = config.signal;
    if (fresh.minAtrMultiplierForEntry != null) sig.minAtrMultiplierForEntry = fresh.minAtrMultiplierForEntry;
    if (fresh.minRiskReward != null) sig.minRiskReward = fresh.minRiskReward;
    if (fresh.minAdxForTrend != null) sig.minAdxForTrend = fresh.minAdxForTrend;
    if (fresh.maxAdxForRange != null) sig.maxAdxForRange = fresh.maxAdxForRange;
  } catch {}
}
