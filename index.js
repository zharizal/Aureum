import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { fileURLToPath } from "url";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { config, reloadSignalThresholds } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendHTML,
  isEnabled as telegramEnabled,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import {
  getLastBriefingDate,
  setLastBriefingDate,
  getTrackedTrades,
  getTodayStats,
  updatePnlAndCheckExits,
  setTradeInstruction,
  checkCooldown,
} from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";

/**
 * Sanitize and reformat analyst LLM output into the exact compact template.
 * Extracts key/value pairs regardless of how verbose or markdown-heavy the response is.
 */
function formatAnalystOutput(raw, { symbol, timeframe, paperMode }) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  // Helper: find first match across all lines for a set of patterns
  function extract(...patterns) {
    for (const pat of patterns) {
      for (const line of lines) {
        const m = line.match(pat);
        if (m) return m[1].trim();
      }
    }
    return null;
  }

  // Status: look for known keywords on any line
  let status = "-";
  for (const line of lines) {
    const l = line.toUpperCase();
    if (/OPEN TRADE/.test(l)) { status = "OPEN TRADE"; break; }
    if (/NO SETUP/.test(l))   { status = "NO SETUP";   break; }
    if (/HOLD/.test(l))       { status = "HOLD";        break; }
    if (/WAIT/.test(l))       { status = "WAIT";        break; }
  }

  const mode = paperMode ? "PAPER" : "LIVE";

  const harga = extract(
    /^Harga\s*:\s*([0-9.,]+)/i,
    /harga[^\d]*([0-9.,]+)/i,
    /price[^\d]*([0-9.,]+)/i,
    /last\s*price[^\d]*([0-9.,]+)/i
  ) || "-";

  // EMA — try combined line first, then individual
  let ema20 = "-", ema50 = "-", ema200 = "-";
  const emaLine = extract(/EMA20\/50\/200\s*:\s*([0-9.,/ ]+)/i, /EMA[^:\n]*:\s*([0-9.,/ ]+)/i);
  if (emaLine) {
    const parts = emaLine.split(/\s*\/\s*/);
    if (parts[0]) ema20  = parts[0].trim();
    if (parts[1]) ema50  = parts[1].trim();
    if (parts[2]) ema200 = parts[2].trim();
  }
  ema20  = extract(/EMA20\s*:\s*([0-9.,]+)/i,  /\bema20[^\d]*([0-9.,]+)/i)  || ema20;
  ema50  = extract(/EMA50\s*:\s*([0-9.,]+)/i,  /\bema50[^\d]*([0-9.,]+)/i)  || ema50;
  ema200 = extract(/EMA200\s*:\s*([0-9.,]+)/i, /\bema200[^\d]*([0-9.,]+)/i) || ema200;

  const rsi = extract(/RSI14?\s*:\s*([0-9.,]+)/i, /\brsi[^\d]*([0-9.,]+)/i) || "-";
  const atr = extract(/ATR14?\s*:\s*([0-9.,]+)/i, /\batr[^\d]*([0-9.,]+)/i) || "-";

  let rangeLow = "-", rangeHigh = "-";
  const rangeLine = extract(/Range\s*:\s*([0-9.,]+)\s*[-–]\s*([0-9.,]+)/i);
  if (rangeLine) {
    // rangeLine matched group 1 only — re-match for both groups
    for (const line of lines) {
      const m = line.match(/Range\s*:\s*([0-9.,]+)\s*[-–]\s*([0-9.,]+)/i);
      if (m) { rangeLow = m[1].trim(); rangeHigh = m[2].trim(); break; }
    }
  }
  if (rangeLow === "-") {
    const low  = extract(/low20?\s*:\s*([0-9.,]+)/i,  /\blow[^\d]*([0-9.,]+)/i);
    const high = extract(/high20?\s*:\s*([0-9.,]+)/i, /\bhigh[^\d]*([0-9.,]+)/i);
    if (low)  rangeLow  = low;
    if (high) rangeHigh = high;
  }

  const saldo = extract(
    /Saldo\s*:\s*([0-9.,]+)/i,
    /balance[^\d]*([0-9.,]+)/i,
    /available[^\d]*([0-9.,]+)/i
  ) || "-";

  const entry = extract(/^Entry\s*:\s*([^\n]+)/im) || "-";
  const sl    = extract(/^SL\s*:\s*([^\n]+)/im, /stop.?loss\s*:\s*([0-9.,]+)/i) || "-";
  const tp    = extract(/^TP\s*:\s*([^\n]+)/im, /take.?profit\s*:\s*([0-9.,]+)/i) || "-";
  const rr    = extract(/^RR\s*:\s*([^\n]+)/im, /risk.?reward\s*:\s*([0-9.,]+)/i) || "-";

  let wr = "N/A", tpCount = "0", slCount = "0", total = "0";
  const wrLine = extract(/WR\s*:\s*([^\n|]+)/i);
  if (wrLine) wr = wrLine.replace(/[%\s]/g, "").trim() || "N/A";
  const tpC = extract(/\bTP\s*:\s*(\d+)/i);           if (tpC) tpCount = tpC;
  const slC = extract(/\bSL\s*:\s*(\d+)/i);           if (slC) slCount = slC;
  const tot = extract(/Trade\s*:\s*(\d+)/i, /Total\s*:\s*(\d+)/i); if (tot) total = tot;

  // WR line — try the structured pattern first
  for (const line of lines) {
    const m = line.match(/WR\s*:\s*([0-9.]+%?|N\/A)\s*\|\s*TP\s*:\s*(\d+)\s*\|\s*SL\s*:\s*(\d+)\s*\|\s*Trade\s*:\s*(\d+)/i);
    if (m) { wr = m[1]; tpCount = m[2]; slCount = m[3]; total = m[4]; break; }
  }

  const aksi = extract(/^Aksi\s*:\s*(.+)/im) || "-";

  const sym = symbol || "PAXG/USDT";
  const tf  = timeframe || "15m";

  return [
    `${sym} ${tf} | ${status}`,
    `Mode: ${mode}`,
    ``,
    `Harga: ${harga}`,
    `EMA20/50/200: ${ema20} / ${ema50} / ${ema200}`,
    `RSI14: ${rsi}`,
    `ATR14: ${atr}`,
    `Range: ${rangeLow} - ${rangeHigh}`,
    `Saldo: ${saldo}`,
    ``,
    `Entry: ${entry}`,
    `SL: ${sl}`,
    `TP: ${tp}`,
    `RR: ${rr}`,
    ``,
    `WR: ${wr} | TP: ${tpCount} | SL: ${slCount} | Trade: ${total}`,
    `Aksi: ${aksi}`,
  ].join("\n");
}

log("startup", "PAXG/USDT Tokocrypto trading agent starting...");
log("startup", `Mode: ${config.paper.enabled ? "PAPER" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || config.llm.generalModel}`);

const timers = {
  managementLastRun: null,
  analysisLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const anal = formatCountdown(nextRunIn(timers.analysisLastRun, config.schedule.analysisIntervalMin));
  return `[manage: ${mgmt} | analyze: ${anal}]\n> `;
}

let _cronTasks = [];
let _managementBusy = false;
let _analysisBusy = false;
let _analysisLastTriggered = 0;
let _pollTriggeredAt = 0;

function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function formatPerfSnapshot(perfSummary) {
  if (!perfSummary) {
    return "WR: N/A | TP: 0 | SL: 0 | Trade: 0";
  }
  const reasons = perfSummary.close_reasons ?? {};
  let tp = 0, sl = 0;
  for (const [key, val] of Object.entries(reasons)) {
    const k = key.toLowerCase();
    if (k.includes("take profit") || k.includes("take_profit")) tp += val;
    else if (k.includes("stop loss") || k.includes("stop_loss")) sl += val;
  }
  const wr = perfSummary.win_rate_pct != null ? `${perfSummary.win_rate_pct}%` : "N/A";
  const pnlLine = perfSummary.total_pnl_usd != null ? ` | PnL: $${perfSummary.total_pnl_usd.toFixed(2)}` : "";
  return `WR: ${wr} | TP: ${tp} | SL: ${sl} | Trade: ${perfSummary.total_trades_closed}${pnlLine}`;
}

async function refreshOpenTradeSnapshots(openTrades) {
  for (const trade of openTrades) {
    const market = await executeTool("get_market_data", { symbol: trade.symbol, timeframe: config.market.timeframe });
    if (!market?.success || !market.price) continue;

    const referenceEntry = trade.entryFillPrice ?? trade.entryPrice;
    const markPrice = trade.direction === "long"
      ? (market.bid ?? market.price)
      : (market.ask ?? market.price);
    const grossPnlUsd = trade.direction === "long"
      ? (markPrice - referenceEntry) * trade.quantity
      : (referenceEntry - markPrice) * trade.quantity;
    const exitFeeUsd = (markPrice * trade.quantity) * ((config.paper.feeRatePct ?? 0) / 100);
    const pnlUsd = Math.round((grossPnlUsd - (trade.entryFeeUsd ?? 0) - exitFeeUsd) * 100) / 100;
    const pnlPct = referenceEntry > 0
      ? (((trade.direction === "long" ? markPrice - referenceEntry : referenceEntry - markPrice) / referenceEntry) * 100)
      : 0;

    updatePnlAndCheckExits(
      trade.tradeId,
      { pnlPct, pnlUsd, price: markPrice, timestamp: market.timestamp },
      config.management,
    );
  }
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) await sendHTML(briefing);
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();
  if (lastSent === todayUtc) return;
  const nowUtc = new Date();
  if (nowUtc.getUTCHours() < 1) return;
  log("cron", `Missed briefing detected (last: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  const analysisScreeningCooldownMs = 5 * 60_000;

  try {
    let openTrades = getTrackedTrades(true);

    if (openTrades.length === 0) {
      log("cron", "No open trades — triggering analysis cycle");
      runAnalysisCycle().catch((e) => log("cron_error", `Triggered analysis failed: ${e.message}`));
      return null;
    }

    await refreshOpenTradeSnapshots(openTrades);
    openTrades = getTrackedTrades(true);

    const actionMap = new Map();
    for (const trade of openTrades) {
      if (trade.instruction) {
        actionMap.set(trade.tradeId, { action: "INSTRUCTION" });
        continue;
      }

      const pnl = trade.lastPnlPct;

      if (pnl != null && pnl <= config.management.stopLossPct) {
        actionMap.set(trade.tradeId, {
          action: "CLOSE",
          rule: "SL",
          reason: `stop loss hit (PnL ${pnl.toFixed(2)}% ≤ ${config.management.stopLossPct}%)`,
        });
        continue;
      }
      if (pnl != null && pnl >= config.management.takeProfitPct) {
        actionMap.set(trade.tradeId, {
          action: "CLOSE",
          rule: "TP",
          reason: `take profit hit (PnL ${pnl.toFixed(2)}% ≥ ${config.management.takeProfitPct}%)`,
        });
        continue;
      }
      if (trade.trailingActive && pnl != null) {
        const dropFromPeak = (trade.peakProfitPct ?? 0) - pnl;
        if (dropFromPeak >= config.management.trailingDropPct) {
          actionMap.set(trade.tradeId, {
            action: "CLOSE",
            rule: "TRAIL",
            reason: `trailing stop (peak ${(trade.peakProfitPct ?? 0).toFixed(2)}% → ${pnl.toFixed(2)}%, retraced ${dropFromPeak.toFixed(2)}%)`,
          });
          continue;
        }
      }
      if (config.management.maxIdleMinutes && trade.openedAt) {
        const minutesHeld = Math.floor((Date.now() - new Date(trade.openedAt).getTime()) / 60_000);
        if (minutesHeld >= config.management.maxIdleMinutes && (pnl ?? 0) <= 0) {
          actionMap.set(trade.tradeId, {
            action: "CLOSE",
            rule: "IDLE",
            reason: `idle ${minutesHeld}m with no profit (limit: ${config.management.maxIdleMinutes}m)`,
          });
          continue;
        }
      }

      actionMap.set(trade.tradeId, { action: "HOLD" });
    }

    const needsAction = [...actionMap.values()].filter((a) => a.action !== "HOLD" && a.action !== "INSTRUCTION");
    const overallStatus = needsAction.length > 0 ? "CLOSE" : "HOLD";

    const tradeLines = openTrades.map((trade) => {
      const act = actionMap.get(trade.tradeId);
      const pnl = trade.lastPnlPct != null ? `${trade.lastPnlPct >= 0 ? "+" : ""}${trade.lastPnlPct.toFixed(2)}%` : "?";
      const minutesHeld = trade.openedAt ? Math.floor((Date.now() - new Date(trade.openedAt).getTime()) / 60_000) : "?";
      const trailingTag = trade.trailingActive ? " trailing" : "";
      const statusLabel = act.action === "INSTRUCTION" ? "EVAL" : act.action;
      let line = `- ${trade.symbol} ${trade.direction.toUpperCase()} | PnL: ${pnl}${trailingTag} | Age: ${minutesHeld}m | ${statusLabel}`;
      if (act.action === "CLOSE") line += ` (${act.rule}: ${act.reason})`;
      if (trade.instruction) line += `\n  Note: "${trade.instruction}"`;
      return line;
    });

    const perfSnap = formatPerfSnapshot(getPerformanceSummary());
    const actionSummary = needsAction.length > 0
      ? `Closing ${needsAction.length} trade(s)`
      : `All ${openTrades.length} position(s) held`;

    mgmtReport = [
      `${config.instrument.symbol} ${config.market.timeframe} | ${overallStatus}`,
      "",
      perfSnap,
      "",
      tradeLines.join("\n"),
      "",
      `Action: ${actionSummary}`,
    ].join("\n");

    const actionTrades = openTrades.filter((t) => actionMap.get(t.tradeId).action !== "HOLD");

    if (actionTrades.length > 0) {
      log("cron", `Management: ${actionTrades.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks = actionTrades.map((trade) => {
        const act = actionMap.get(trade.tradeId);
        const pnl = trade.lastPnlPct != null ? `${trade.lastPnlPct.toFixed(2)}%` : "unknown";
        const minutesHeld = trade.openedAt ? Math.floor((Date.now() - new Date(trade.openedAt).getTime()) / 60_000) : "?";
        return [
          `TRADE: ${trade.symbol} ${trade.direction.toUpperCase()} (ID: ${trade.tradeId})`,
          `  entry: ${trade.entryPrice} | quantity: ${trade.quantity} | SL: ${trade.stopLoss} | TP: ${trade.takeProfit ?? "none"}`,
          `  pnl: ${pnl} | peak: ${(trade.peakProfitPct ?? 0).toFixed(2)}% | trailing: ${trade.trailingActive ? "ACTIVE" : "off"} | age: ${minutesHeld}m`,
          `  action: ${act.action}${act.rule ? ` — Rule ${act.rule}: ${act.reason}` : ""}`,
          trade.instruction ? `  instruction: "${trade.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${actionTrades.length} trade(s)

${actionBlocks}

RULES:
- CLOSE: call get_market_data to get the current price, then call close_trade with trade_id and the current bid (long) or ask (short) as exit_price.
- INSTRUCTION: evaluate the instruction condition. If met → call get_market_data then close_trade with current market price. If not met → HOLD, do nothing.

Execute the required actions. Then output 2-4 short bullet points explaining what happened, followed by one Action line. Plain text only, no markdown.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048);

      mgmtReport += `\n\n${stripThink(content)}`;
    } else {
      log("cron", "Management: all trades HOLD — skipping LLM");
    }

    const afterOpenCount = getTrackedTrades(true).length;
    if (
      afterOpenCount < config.risk.maxOpenTrades &&
      Date.now() - _analysisLastTriggered > analysisScreeningCooldownMs
    ) {
      log("cron", `Post-management: ${afterOpenCount}/${config.risk.maxOpenTrades} trades — triggering analysis`);
      runAnalysisCycle().catch((e) => log("cron_error", `Triggered analysis failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) sendMessage(mgmtReport).catch(() => {});
    }
  }
  return mgmtReport;
}

export async function runAnalysisCycle({ silent = false } = {}) {
  if (_analysisBusy) {
    log("cron", "Analysis skipped — previous cycle still running");
    return null;
  }
  _analysisBusy = true;
  _analysisLastTriggered = Date.now();

  const openTrades = getTrackedTrades(true);
  if (openTrades.length >= config.risk.maxOpenTrades) {
    log("cron", `Analysis skipped — max open trades (${openTrades.length}/${config.risk.maxOpenTrades})`);
    _analysisBusy = false;
    return null;
  }

  const cooldown = checkCooldown(config.cooldown);
  if (cooldown.blocked) {
    log("cron", `Analysis skipped — cooldown: ${cooldown.reason}`);
    _analysisBusy = false;
    return null;
  }

  if (config.session.enabled) {
    const hourUtc = new Date().getUTCHours();
    const dayUtc = new Date().getUTCDay();
    const inWindow = (config.session.allowedWindows ?? []).some((w) => hourUtc >= w.start && hourUtc < w.end);
    if (!inWindow) {
      log("cron", `Analysis skipped — outside configured trading windows (UTC ${hourUtc}:00)`);
      _analysisBusy = false;
      return null;
    }
    if (dayUtc === 5 && hourUtc >= config.session.fridayCloseHourUtc) {
      log("cron", `Analysis skipped — Friday close cutoff (UTC ${config.session.fridayCloseHourUtc}:00)`);
      _analysisBusy = false;
      return null;
    }
  }

  timers.analysisLastRun = Date.now();
  log("cron", `Starting analysis cycle [model: ${config.llm.analysisModel}]`);
  let analysisReport = null;

  try {
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — ${activeStrategy.description ?? ""}`
      : "No active strategy — use default breakout/pullback setups.";

    const today = getTodayStats();
    const todayLine = today
      ? `Today: ${today.tradesOpened ?? 0} opened, P&L: $${(today.pnlUsd ?? 0).toFixed(2)}`
      : "No trades today yet.";

    const openBlock = openTrades.length > 0
      ? openTrades.map((t) => `  ${t.symbol} ${t.direction.toUpperCase()} @ ${t.entryPrice} | Qty: ${t.quantity} | SL: ${t.stopLoss} | TP: ${t.takeProfit ?? "none"}`).join("\n")
      : "  None";

    const { content } = await agentLoop(`
ANALYSIS CYCLE — Scan for PAXG/USDT setup opportunities on Tokocrypto

${strategyBlock}
Exchange: ${config.instrument.exchange}
Symbol: ${config.instrument.symbol} | Timeframe: ${config.market.timeframe}
Open trades: ${openTrades.length}/${config.risk.maxOpenTrades} | ${todayLine}
Currently open:
${openBlock}

STEPS:
1. Call get_session_info to confirm we are in an active trading window.
2. Call check_cooldown to confirm no cooldown is blocking new entries.
3. Call get_market_data — it returns price, bid/ask, candles, and indicators (EMA20/50/200, RSI14, ATR14, Range, volume spike).
4. Call get_account_balance to get available USDT balance.
5. Assess whether a valid setup is present based on indicators and available data.
6. If a valid setup exists AND all guards pass:
   - Call open_trade with: symbol, direction ("long"/"short"), entry_price, quantity, stop_loss (required), take_profit (optional).
   - Only enter if risk_reward >= ${config.signal.minRiskReward}.
7. Output ONLY plain text in this exact format. No markdown, no bold, no headers:

${config.instrument.symbol} ${config.market.timeframe} | <OPEN TRADE | HOLD | NO SETUP>
Mode: ${config.paper.enabled ? "PAPER" : "LIVE"}

Harga: <price from get_market_data>
EMA20/50/200: <indicators.ema20 or N/A> / <indicators.ema50 or N/A> / <indicators.ema200 or N/A>
RSI14: <indicators.rsi14 or N/A>
ATR14: <indicators.atr14 or N/A>
Range: <indicators.low20 or N/A> - <indicators.high20 or N/A>
Saldo: <available_balance_usd from get_account_balance> USDT

Entry: <entry_price if trade opened, else ->
SL: <stop_loss if trade opened, else ->
TP: <take_profit if trade opened, else ->
RR: <risk_reward if trade opened, else ->

WR: <win rate % or N/A> | TP: <tp_count> | SL: <sl_count> | Trade: <total_closed>
Aksi: <one short action line>
    `, config.llm.maxSteps, [], "ANALYST", config.llm.analysisModel, 2048);

    analysisReport = formatAnalystOutput(content, {
      symbol:    config.instrument.symbol,
      timeframe: config.market.timeframe,
      paperMode: config.paper.enabled,
    });
  } catch (error) {
    log("cron_error", `Analysis cycle failed: ${error.message}`);
    analysisReport = `Analysis cycle failed: ${error.message}`;
  } finally {
    _analysisBusy = false;
    if (!silent && telegramEnabled()) {
      if (analysisReport) sendMessage(stripThink(analysisReport)).catch(() => {});
    }
  }
  return analysisReport;
}

export function startCronJobs() {
  stopCronJobs();

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const analysisTask = cron.schedule(`*/${Math.max(1, config.schedule.analysisIntervalMin)} * * * *`, runAnalysisCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting hourly health check");
    try {
      const openTrades = getTrackedTrades(true);
      const today = getTodayStats();
      const summary = `Open: ${openTrades.length} | Today P&L: $${(today?.pnlUsd ?? 0).toFixed(2)}`;
      await agentLoop(`
HOURLY HEALTH CHECK
${summary}

Summarise current trade status, today's P&L, and whether any adjustments are needed to open positions.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: "UTC" });

  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: "UTC" });

  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _analysisBusy || _pnlPollBusy) return;
    _pnlPollBusy = true;
    try {
      const openTrades = getTrackedTrades(true);
      if (!openTrades.length) return;

      for (const trade of openTrades) {
        if (trade.lastPnlPct == null) continue;
        const exit = updatePnlAndCheckExits(
          trade.tradeId,
          { pnlPct: trade.lastPnlPct },
          config.management
        );
        if (exit) {
          const cooldownMs = config.schedule.managementIntervalMin * 60_000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${trade.tradeId} ${trade.symbol} — ${exit.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) =>
              log("cron_error", `Poll-triggered management failed: ${e.message}`)
            );
          } else {
            log("state", `[PnL poll] Exit alert: ${trade.tradeId} ${trade.symbol} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, analysisTask, healthTask, briefingTask, briefingWatchdog];
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, analysis every ${config.schedule.analysisIntervalMin}m`);
}

async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const openTrades = getTrackedTrades(true);
  log("shutdown", `Open trades at shutdown: ${openTrades.length}`);
  process.exit(0);
}

const isMainModule = process.argv[1]
  ? fileURLToPath(import.meta.url) === process.argv[1]
  : false;

const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = [];
const sessionHistory = [];
const MAX_HISTORY = 20;

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isMainModule) {
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (isMainModule && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });

  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.analysisLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  console.log(`
╔═══════════════════════════════════════════╗
║   PAXG/USDT Tokocrypto Agent — Ready     ║
╚═══════════════════════════════════════════╝
`);

  busy = true;
  try {
    const openTrades = getTrackedTrades(true);
    const today = getTodayStats();
    const cooldown = checkCooldown(config.cooldown);
    const hourUtc = new Date().getUTCHours();
    const windows = config.session.allowedWindows ?? [];
    const activeSessions = windows.filter((w) => hourUtc >= w.start && hourUtc < w.end).map((w) => w.name);
    const paperBalance = config.paper.initialBalance + (today?.pnlUsd ?? 0);
    const balSrc = config.paper.balanceSource === "real_exchange" ? "REAL_EXCHANGE" : "MANUAL_PAPER";

    console.log(`Execution: ${config.paper.enabled ? "PAPER" : "LIVE"}`);
    console.log(`Exchange:  ${config.instrument.exchange}`);
    if (config.paper.enabled) {
      console.log(`Bal.Src:   ${balSrc}`);
      if (balSrc === "REAL_EXCHANGE") {
        console.log(`Balance:   (fetched from exchange on first cycle) ${config.instrument.quoteAsset}`);
      } else {
        console.log(`Balance:   $${paperBalance.toFixed(2)} ${config.instrument.quoteAsset} (paper)`);
      }
    }
    console.log(`Session:  ${activeSessions.length ? activeSessions.join(", ") : "Outside configured windows"} (UTC ${hourUtc}:00)`);
    console.log(`Trades:   ${openTrades.length}/${config.risk.maxOpenTrades} open`);
    if (cooldown.blocked) console.log(`Cooldown: ${cooldown.reason}`);
    console.log();

    if (openTrades.length > 0) {
      console.log("Open trades:");
      for (const t of openTrades) {
        const pnl = t.lastPnlPct != null ? `PnL: ${t.lastPnlPct.toFixed(2)}%` : "PnL: unknown";
        const age = t.openedAt ? `${Math.floor((Date.now() - new Date(t.openedAt).getTime()) / 60_000)}m` : "?";
        console.log(`  ${t.symbol} ${t.direction.toUpperCase()} @ ${t.entryPrice} | Qty: ${t.quantity} | SL: ${t.stopLoss} | TP: ${t.takeProfit ?? "none"} | ${pnl} | ${age}`);
      }
      console.log();
    }

    if (today) {
      console.log(`Today:    ${today.tradesOpened ?? 0} opened, ${today.tradesClosed ?? 0} closed, P&L: $${(today.pnlUsd ?? 0).toFixed(2)}\n`);
    }
  } catch (e) {
    console.error(`Startup check failed: ${e.message}`);
  } finally {
    busy = false;
  }

  launchCron();
  maybeRunMissedBriefing().catch(() => {});

  async function drainTelegramQueue() {
    while (_telegramQueue.length > 0 && !_managementBusy && !_analysisBusy && !busy) {
      const queued = _telegramQueue.shift();
      await telegramHandler(queued);
    }
  }

  async function telegramHandler(text) {
    if (_managementBusy || _analysisBusy || busy) {
      if (_telegramQueue.length < 5) {
        _telegramQueue.push(text);
        sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
      } else {
        sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
      }
      return;
    }

    if (text === "/briefing") {
      try {
        const briefing = await generateBriefing();
        await sendHTML(briefing);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    if (text === "/trades" || text === "/positions") {
      try {
        const trades = getTrackedTrades(true);
        if (trades.length === 0) { await sendMessage("No open trades."); return; }
        const lines = trades.map((t, i) => {
          const pnl = t.lastPnlPct != null ? `PnL: ${t.lastPnlPct >= 0 ? "+" : ""}${t.lastPnlPct.toFixed(2)}%` : "PnL: ?";
          const age = t.openedAt ? `${Math.floor((Date.now() - new Date(t.openedAt).getTime()) / 60_000)}m` : "?";
          const trail = t.trailingActive ? " [trailing]" : "";
          return `${i + 1}. ${t.symbol} ${t.direction.toUpperCase()} @ ${t.entryPrice} | Qty: ${t.quantity} | ${pnl}${trail} | ${age}`;
        });
        await sendMessage(`📊 Open Trades (${trades.length}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to add instruction`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    const closeMatch = text.match(/^\/close\s+(\d+)$/i);
    if (closeMatch) {
      try {
        const idx = parseInt(closeMatch[1]) - 1;
        const trades = getTrackedTrades(true);
        if (idx < 0 || idx >= trades.length) { await sendMessage("Invalid number. Use /trades first."); return; }
        const trade = trades[idx];
        await sendMessage(`Closing ${trade.symbol} ${trade.direction.toUpperCase()} (${trade.tradeId})…`);
        const { content } = await agentLoop(
          `Close trade ID ${trade.tradeId} (${trade.symbol} ${trade.direction} @ ${trade.entryPrice}). Call get_market_data to get the current price, then call close_trade with the correct trade_id and the current market price as exit_price. Report the result.`,
          config.llm.maxSteps, [], "MANAGER", config.llm.managementModel
        );
        await sendMessage(stripThink(content));
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
    if (setMatch) {
      try {
        const idx = parseInt(setMatch[1]) - 1;
        const note = setMatch[2].trim();
        const trades = getTrackedTrades(true);
        if (idx < 0 || idx >= trades.length) { await sendMessage("Invalid number. Use /trades first."); return; }
        const trade = trades[idx];
        const ok = setTradeInstruction(trade.tradeId, note);
        if (ok) {
          await sendMessage(`✅ Instruction set for ${trade.symbol} (${trade.tradeId}):\n"${note}"`);
        } else {
          await sendMessage(`❌ Trade not found: ${trade.tradeId}`);
        }
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
      return;
    }

    busy = true;
    try {
      log("telegram", `Incoming: ${text}`);
      const hasCloseIntent = /\bclose\b|\bexit\b|\bsell\b/i.test(text);
      const hasOpenIntent = !hasCloseIntent && /\bopen\b|\bbuy\b|\blong\b|\bshort\b|\btrade\b/i.test(text);
      const agentRole = hasCloseIntent ? "MANAGER" : hasOpenIntent ? "ANALYST" : "GENERAL";
      const agentModel = hasCloseIntent ? config.llm.managementModel : hasOpenIntent ? config.llm.analysisModel : config.llm.generalModel;
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, { requireTool: true });
      appendHistory(text, content);
      await sendMessage(stripThink(content));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally {
      busy = false;
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
      drainTelegramQueue().catch(() => {});
    }
  }

  startPolling(telegramHandler);

  console.log(`Commands:
  analyze        Trigger analysis cycle now
  manage         Trigger management cycle now
  /status        Refresh account + open trades
  /trades        List open trades (numbered for /close)
  /close <n>     Close trade number <n>
  /set <n> <note> Set instruction on trade <n>
  /briefing      Show morning briefing
  /thresholds    Show current signal thresholds
  /evolve        Trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input.toLowerCase() === "analyze" || input.toLowerCase() === "analyse") {
      await runBusy(async () => {
        console.log("\nTriggering analysis cycle…\n");
        const report = await runAnalysisCycle({ silent: true });
        console.log(`\n${report ?? "(no report)"}\n`);
      });
      return;
    }

    if (input.toLowerCase() === "manage") {
      await runBusy(async () => {
        console.log("\nTriggering management cycle…\n");
        const report = await runManagementCycle({ silent: true });
        console.log(`\n${report ?? "(no report)"}\n`);
      });
      return;
    }

    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const openTrades = getTrackedTrades(true);
        const today = getTodayStats();
        const cooldown = checkCooldown(config.cooldown);
        const hourUtc = new Date().getUTCHours();
        const windows = config.session.allowedWindows ?? [];
        const activeSessions = windows.filter((w) => hourUtc >= w.start && hourUtc < w.end).map((w) => w.name);
        const paperBalance = config.paper.initialBalance + (today?.pnlUsd ?? 0);

        console.log();
        if (config.paper.enabled) console.log(`Balance:  $${paperBalance.toFixed(2)} ${config.instrument.quoteAsset} (paper)`);
        console.log(`Exchange: ${config.instrument.exchange}`);
        console.log(`Session:  ${activeSessions.length ? activeSessions.join(", ") : "Outside configured windows"} (UTC ${hourUtc}:00)`);
        console.log(`Trades:   ${openTrades.length}/${config.risk.maxOpenTrades} open`);
        if (cooldown.blocked) console.log(`Cooldown: ${cooldown.reason}`);
        for (const t of openTrades) {
          const pnl = t.lastPnlPct != null ? `PnL: ${t.lastPnlPct.toFixed(2)}%` : "PnL: ?";
          const trail = t.trailingActive ? " [trailing]" : "";
          console.log(`  ${t.symbol} ${t.direction.toUpperCase()} @ ${t.entryPrice} | Qty: ${t.quantity} | SL: ${t.stopLoss} | TP: ${t.takeProfit ?? "none"} | ${pnl}${trail}`);
        }
        if (today) console.log(`Today:    P&L $${(today.pnlUsd ?? 0).toFixed(2)} | ${today.wins ?? 0}W / ${today.losses ?? 0}L`);
        console.log();
      });
      return;
    }

    if (input === "/trades") {
      await runBusy(async () => {
        const trades = getTrackedTrades(true);
        if (trades.length === 0) { console.log("\nNo open trades.\n"); return; }
        console.log(`\nOpen trades (${trades.length}):`);
        trades.forEach((t, i) => {
          const pnl = t.lastPnlPct != null ? `PnL: ${t.lastPnlPct.toFixed(2)}%` : "PnL: ?";
          const age = t.openedAt ? `${Math.floor((Date.now() - new Date(t.openedAt).getTime()) / 60_000)}m` : "?";
          const trail = t.trailingActive ? " [trailing]" : "";
          console.log(`  [${i + 1}] ${t.symbol} ${t.direction.toUpperCase()} @ ${t.entryPrice} | Qty: ${t.quantity} | SL: ${t.stopLoss} | TP: ${t.takeProfit ?? "none"} | ${pnl}${trail} | ${age}`);
          if (t.instruction) console.log(`       Note: "${t.instruction}"`);
        });
        console.log("\n  /close <n> to close | /set <n> <note> to add instruction\n");
      });
      return;
    }

    const closeMatch = input.match(/^\/close\s+(\d+)$/i);
    if (closeMatch) {
      await runBusy(async () => {
        const idx = parseInt(closeMatch[1]) - 1;
        const trades = getTrackedTrades(true);
        if (idx < 0 || idx >= trades.length) { console.log("Invalid number. Use /trades first.\n"); return; }
        const trade = trades[idx];
        console.log(`\nClosing ${trade.symbol} ${trade.direction.toUpperCase()} (${trade.tradeId})…\n`);
        const { content: reply } = await agentLoop(
          `Close trade ID ${trade.tradeId} (${trade.symbol} ${trade.direction} @ ${trade.entryPrice}). Call get_market_data to get the current price, then call close_trade with the correct trade_id and the current market price as exit_price. Report the result.`,
          config.llm.maxSteps, [], "MANAGER", config.llm.managementModel
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    const setMatch = input.match(/^\/set\s+(\d+)\s+(.+)$/i);
    if (setMatch) {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const trades = getTrackedTrades(true);
      if (idx < 0 || idx >= trades.length) { console.log("Invalid number. Use /trades first.\n"); rl.prompt(); return; }
      const trade = trades[idx];
      const ok = setTradeInstruction(trade.tradeId, note);
      if (ok) {
        console.log(`✅ Instruction set for ${trade.symbol} (${trade.tradeId}):\n"${note}"\n`);
      } else {
        console.log(`❌ Trade not found: ${trade.tradeId}\n`);
      }
      rl.prompt();
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.signal;
      const m = config.market;
      console.log("\nCurrent signal thresholds:");
      console.log(`  minAtrMultiplierForEntry: ${s.minAtrMultiplierForEntry}`);
      console.log(`  minRiskReward:            ${s.minRiskReward}`);
      console.log(`  minAdxForTrend:           ${s.minAdxForTrend}`);
      console.log(`  maxAdxForRange:           ${s.maxAdxForRange}`);
      console.log(`  requireSessionConfirm:    ${s.requireSessionConfirm}`);
      console.log("\nMarket config:");
      console.log(`  timeframe:    ${m.timeframe}`);
      console.log(`  atrPeriod:    ${m.atrPeriod}`);
      console.log(`  adxPeriod:    ${m.adxPeriod}`);
      console.log(`  adxTrendMin:  ${m.adxTrendMin}`);
      console.log(`  maxSpreadPct: ${m.maxSpreadPct}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_trades_closed} closed trades`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed trades yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_trades_closed < 5) {
          const needed = 5 - (perf?.total_trades_closed || 0);
          console.log(`\nNeed at least 5 closed trades to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes ?? {}).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadSignalThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale?.[key] ?? val}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(
        input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { requireTool: true }
      );
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMainModule) {
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => {});

  (async () => {
    try {
      await agentLoop(`
STARTUP CHECK
1. Call get_account_balance to confirm available balance.
2. Call get_open_trades to review any existing positions.
3. Call get_session_info to determine the current trading window.
4. Call check_cooldown to see if a cooldown is active.
5. Report status in this exact plain-text format (no markdown):

Bot: RUNNING | Mode: ${config.paper.enabled ? "PAPER" : "LIVE"} | Exchange: ${config.instrument.exchange}
Available ${config.instrument.quoteAsset}: <available_quote_asset from get_account_balance>
Available ${config.instrument.baseAsset}: <available_base_asset from get_account_balance>
Total ${config.instrument.baseAsset}: <total_base_asset from get_account_balance>
Balance source: <balance_source from get_account_balance>
Open trades: <count>/<maxOpenTrades>
Session: <active window name or INACTIVE>
Cooldown: <ACTIVE reason | CLEAR>
Can open trade: <YES | NO — reason>
      `, config.llm.maxSteps, [], "GENERAL");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
