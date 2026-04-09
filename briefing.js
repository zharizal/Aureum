import { config } from "./config.js";
import { log } from "./logger.js";
import { getPerformanceHistory, getPerformanceSummary, listLessons } from "./lessons.js";
import { checkCooldown, getStateSummary, getTodayStats, getTrackedTrades } from "./state.js";
import { getAccountSnapshot } from "./tools/executor.js";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatMoney(value) {
  if (value == null || Number.isNaN(value)) return "N/A";
  return `${value >= 0 ? "+" : ""}$${Number(value).toFixed(2)}`;
}

function formatPct(value) {
  if (value == null || Number.isNaN(value)) return "N/A";
  return `${value >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
}

function formatDateTime(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function formatAgeMinutes(openedAt) {
  if (!openedAt) return "N/A";
  const opened = new Date(openedAt).getTime();
  if (Number.isNaN(opened)) return "N/A";
  return `${Math.max(0, Math.floor((Date.now() - opened) / 60_000))}m`;
}

function getCurrentSessionInfo() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const activeWindows = (config.session.allowedWindows || []).filter((window) => utcHour >= window.start && utcHour <= window.end);
  return {
    utcHour,
    day: now.getUTCDay(),
    activeWindows,
  };
}

function buildSessionLine() {
  const sessionInfo = getCurrentSessionInfo();
  const active = sessionInfo.activeWindows.length > 0
    ? sessionInfo.activeWindows.map((window) => window.name).join(", ")
    : "Outside configured windows";
  const fridayCutoff = sessionInfo.day === 5 && sessionInfo.utcHour >= config.session.fridayCloseHourUtc
    ? " | Friday cutoff active"
    : "";

  return `UTC hour ${sessionInfo.utcHour} | Trading-window filter ${config.session.enabled ? "ON" : "OFF"} | Active: ${active}${fridayCutoff}`;
}

function buildRiskLine(todayStats, openTrades, perfSummary) {
  const todayPnl = todayStats?.pnlUsd ?? 0;
  const allTimePnl = perfSummary?.total_pnl_usd ?? 0;

  // When balance source is real exchange, skip percentage-based limits derived from paper initialBalance
  if (config.paper.balanceSource === "real_exchange") {
    const todayRiskStatus = todayPnl < 0 ? `daily PnL: $${todayPnl.toFixed(2)}` : "within daily risk";
    return `${openTrades.length}/${config.risk.maxOpenTrades} open trades | ${todayRiskStatus} | all-time PnL: $${allTimePnl.toFixed(2)}`;
  }

  const dailyLossLimitUsd = config.paper.initialBalance * (config.risk.maxDailyLossPct / 100);
  const drawdownLimitUsd = config.paper.initialBalance * (config.risk.maxDrawdownPct / 100);
  const todayRiskStatus = todayPnl <= -dailyLossLimitUsd
    ? "daily loss limit breached"
    : todayPnl < 0
      ? "daily drawdown active"
      : "within daily risk";
  const drawdownStatus = allTimePnl <= -drawdownLimitUsd
    ? "max drawdown breached"
    : "within max drawdown";

  return `${openTrades.length}/${config.risk.maxOpenTrades} open trades | ${todayRiskStatus} | ${drawdownStatus}`;
}

function buildCooldownLine() {
  const cooldown = checkCooldown(config.cooldown);
  if (cooldown.blocked) return cooldown.reason;
  return "No active cooldown";
}

function buildOpenTradesSection(openTrades) {
  if (openTrades.length === 0) {
    return [`No open ${config.instrument.symbol} trades.`];
  }

  return openTrades.slice(0, 5).map((trade) => {
    const flags = [];
    if (trade.trailingActive) flags.push("trailing");
    if (trade.instruction) flags.push("instruction");
    return [
      `<b>${escapeHtml(trade.symbol || config.instrument.symbol)} ${escapeHtml(String(trade.direction || "").toUpperCase())}</b> | ${escapeHtml(trade.tradeId || "unknown")}`,
      `Entry ${escapeHtml(trade.entryPrice ?? "N/A")} | Qty ${escapeHtml(trade.quantity ?? "N/A")} | SL ${escapeHtml(trade.stopLoss ?? "N/A")} | TP ${escapeHtml(trade.takeProfit ?? "none")}`,
      `PnL ${escapeHtml(formatPct(trade.lastPnlPct))} | Age ${escapeHtml(formatAgeMinutes(trade.openedAt))}${flags.length ? ` | ${escapeHtml(flags.join(", "))}` : ""}`,
    ].join("\n");
  });
}

function buildRecentTradesSection(perfHistory) {
  if (!perfHistory?.trades?.length) {
    return ["No recent closed trades in the selected window."];
  }

  return perfHistory.trades.slice(-5).reverse().map((trade) => {
    const setup = trade.setup_type ? ` | setup ${trade.setup_type}` : "";
    const session = trade.session ? ` | session ${trade.session}` : "";
    const reason = trade.close_reason ? ` | ${trade.close_reason}` : "";
    const qty = trade.quantity != null ? ` | qty ${trade.quantity}` : "";
    return `${escapeHtml(trade.symbol || config.instrument.symbol)} ${escapeHtml(String(trade.direction || "").toUpperCase())}${qty} | ${escapeHtml(formatMoney(trade.pnl_usd))} | ${escapeHtml(formatPct(trade.pnl_pct))}${setup}${session}${reason}`;
  });
}

function buildLessonsSection() {
  const recentLessons = listLessons({ limit: 3 }).lessons || [];
  if (recentLessons.length === 0) {
    return ["No recent lessons recorded."];
  }

  return recentLessons.reverse().map((lesson) => `• ${escapeHtml(lesson.rule)}`);
}

export async function generateBriefing() {
  try {
    const now = new Date();
    const stateSummary = getStateSummary();
    const todayStats = getTodayStats();
    const openTrades = getTrackedTrades(true);
    const perfSummary = getPerformanceSummary();
    const perfHistory = getPerformanceHistory({ hours: 24, limit: 5 });

    const accountSnap = getAccountSnapshot();
    const quoteAsset = config.instrument.quoteAsset;
    const baseAsset = config.instrument.baseAsset;
    const availUsdt = accountSnap.balances?.[quoteAsset]?.available ?? accountSnap.available_balance_usd ?? 0;
    const totalUsdt = accountSnap.balances?.[quoteAsset]?.total ?? accountSnap.balance_usd ?? 0;
    const availBase = accountSnap.available_base_asset ?? accountSnap.balances?.[baseAsset]?.available ?? 0;
    const totalBase = accountSnap.total_base_asset ?? accountSnap.balances?.[baseAsset]?.total ?? 0;
    const balSrc = accountSnap.balance_source ?? "MANUAL_PAPER";
    const balanceLine = [
      `Available ${escapeHtml(quoteAsset)}: <b>$${Number(availUsdt).toFixed(2)}</b>`,
      `Available ${escapeHtml(baseAsset)}: <b>${Number(availBase).toFixed(4)}</b>`,
      `Total ${escapeHtml(baseAsset)} (incl. locked): <b>${Number(totalBase).toFixed(4)}</b>`,
      `Total ${escapeHtml(quoteAsset)}: <b>$${Number(totalUsdt).toFixed(2)}</b>`,
      `Balance source: ${escapeHtml(balSrc)}`,
    ].join(" | ");

    const lines = [
      `☀️ <b>${escapeHtml(config.instrument.symbol)} Briefing</b>`,
      `${escapeHtml(formatDateTime(now.toISOString()))}`,
      "────────────────",
      `<b>Venue Context</b>`,
      `Exchange: <b>${escapeHtml(config.instrument.exchange)}</b> | Symbol: <b>${escapeHtml(config.instrument.symbol)}</b> | Timeframe: <b>${escapeHtml(config.market.timeframe)}</b>`,
      escapeHtml(buildSessionLine()),
      "",
      `<b>Account Balance</b>`,
      balanceLine,
      "",
      `<b>Status</b>`,
      `Mode: <b>${escapeHtml(config.paper.enabled ? "PAPER" : "LIVE")}</b> | Quote asset: <b>${escapeHtml(config.instrument.quoteAsset)}</b> | Fee rate: <b>${escapeHtml(config.paper.feeRatePct)}%</b>`,
      escapeHtml(buildRiskLine(todayStats, openTrades, perfSummary)),
      `Cooldown: ${escapeHtml(buildCooldownLine())}`,
      "",
      `<b>Daily Performance</b>`,
      `PnL: ${escapeHtml(formatMoney(todayStats?.pnlUsd ?? 0))}`,
      `Trades opened: ${escapeHtml(todayStats?.tradesOpened ?? 0)} | closed: ${escapeHtml(todayStats?.tradesClosed ?? 0)} | wins: ${escapeHtml(todayStats?.wins ?? 0)} | losses: ${escapeHtml(todayStats?.losses ?? 0)}`,
      perfSummary
        ? `All-time closed trades: ${escapeHtml(perfSummary.total_trades_closed)} | Win rate: ${escapeHtml(perfSummary.win_rate_pct)}% | Avg PnL: ${escapeHtml(formatPct(perfSummary.avg_pnl_pct))}`
        : "All-time performance: no closed-trade data yet.",
      "",
      `<b>Open Trades</b>`,
      ...buildOpenTradesSection(openTrades),
      "",
      `<b>Recent Closed Trades (24h)</b>`,
      ...buildRecentTradesSection(perfHistory),
      "",
      `<b>Setup / Learning Context</b>`,
      `Open trades tracked: ${escapeHtml(stateSummary.open_trades ?? 0)} | Closed trades tracked: ${escapeHtml(stateSummary.closed_trades ?? 0)} | Max open trades: ${escapeHtml(config.risk.maxOpenTrades)}`,
      perfSummary?.close_reasons
        ? `Close reasons: ${escapeHtml(Object.entries(perfSummary.close_reasons).map(([reason, count]) => `${reason}=${count}`).join(", "))}`
        : "Close reasons: no closed-trade data yet.",
      ...buildLessonsSection(),
      "────────────────",
    ];

    return lines.join("\n");
  } catch (error) {
    log("briefing_error", `Failed to generate ${config.instrument.symbol} briefing: ${error.message}`);
    return [
      `☀️ <b>${escapeHtml(config.instrument.symbol)} Briefing</b>`,
      "Unable to build the full briefing from current local data.",
      `Reason: ${escapeHtml(error.message)}`,
    ].join("\n");
  }
}
