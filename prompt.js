import { config } from "./config.js";

function safeJson(value, fallback = "Unavailable") {
  if (value == null) return fallback;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

function buildRuntimeBlock() {
  return {
    instrument: config.instrument,
    market: {
      timeframe: config.market.timeframe,
      atrPeriod: config.market.atrPeriod,
      emaFastPeriod: config.market.emaFastPeriod,
      emaSlowPeriod: config.market.emaSlowPeriod,
      adxPeriod: config.market.adxPeriod,
      adxTrendMin: config.market.adxTrendMin,
      maxSpreadPct: config.market.maxSpreadPct,
      stalePriceMaxMs: config.market.stalePriceMaxMs,
    },
    session: {
      enabled: config.session.enabled,
      allowedWindows: config.session.allowedWindows,
      newsBlackoutMinutesBefore: config.session.newsBlackoutMinutesBefore,
      newsBlackoutMinutesAfter: config.session.newsBlackoutMinutesAfter,
      fridayCloseHourUtc: config.session.fridayCloseHourUtc,
    },
    signal: config.signal,
    risk: config.risk,
    management: config.management,
    cooldown: config.cooldown,
    mode: config.paper.enabled ? "PAPER" : "LIVE",
  };
}

function buildStateBlock(stateSummary) {
  if (!stateSummary) return "No local state summary available.";

  const compact = {
    open_trades: stateSummary.open_trades,
    closed_trades: stateSummary.closed_trades,
    today: stateSummary.today,
    cooldown: stateSummary.cooldown,
    trades: stateSummary.trades,
    recent_events: stateSummary.recent_events,
    last_updated: stateSummary.last_updated,
  };

  return safeJson(compact, "No local state summary available.");
}

function buildPerformanceBlock(perfSummary) {
  return perfSummary ? safeJson(perfSummary) : "No closed-trade performance summary available yet.";
}

function buildExchangeContext(portfolio, positions) {
  if (portfolio == null && positions == null) {
    return [
      "External exchange/account snapshot is not preloaded in this phase.",
      "Use get_account_balance and get_open_trades for current runtime state instead of assuming exchange data is present.",
    ].join(" ");
  }

  const parts = [];
  if (portfolio != null) parts.push(`Account snapshot: ${safeJson(portfolio)}`);
  if (positions != null) parts.push(`External positions snapshot: ${safeJson(positions)}`);
  return parts.join("\n");
}

function buildSharedPrompt(role, portfolio, positions, stateSummary, lessons, perfSummary) {
  return `You are an autonomous XAUT/USDT spot trading agent for Tokocrypto.
Role: ${role}

Operate only within the current XAUT/USDT spot-trading system. Use only the provided tools and only the current runtime vocabulary.

HARD RULES:
- Never claim a trade was opened, closed, updated, or checked unless you actually called the relevant tool and received a real tool result.
- Do not invent market data, ATR values, account balances, or open trades.
- If a tool is stubbed or unavailable, say so plainly and continue with only confirmed information.
- Paper vs live execution is controlled by runtime configuration. Do not assume live exchange routing already exists.
- Prefer explicit XAUT/USDT spot terminology: quantity, notional, entry, stop loss, take profit, ATR, cooldown, balance, setup, fee, slippage, and risk.
- Do not reference Solana, pools, LPing, wallets, bins, or forex lot/pip concepts.

CURRENT RUNTIME:
${safeJson(buildRuntimeBlock())}

LOCAL STATE SUMMARY:
${buildStateBlock(stateSummary)}

EXTERNAL ACCOUNT CONTEXT:
${buildExchangeContext(portfolio, positions)}

PERFORMANCE SUMMARY:
${buildPerformanceBlock(perfSummary)}

VALID TOOL FAMILIES:
- Trade actions: open_trade, close_trade, get_open_trades, get_account_balance
- Market/session checks: get_market_data, get_atr, get_session_info, check_cooldown
- Trade note/config: set_trade_instruction, update_config
- Generic utilities: get_performance_history, add_lesson, pin_lesson, unpin_lesson, list_lessons, clear_lessons, add_strategy, list_strategies, get_strategy, set_active_strategy, remove_strategy, self_update

${lessons ? `LESSONS LEARNED:\n${lessons}\n` : ""}Timestamp: ${new Date().toISOString()}`;
}

function buildAnalystPrompt() {
  return `
ROLE FOCUS — ANALYST:
- Scan for XAUT/USDT spot setups on Tokocrypto.
- Qualify opportunities using session context, cooldown state, volatility context, risk-reward, and existing open trades.
- Generate open-trade candidates only when the setup is concrete and tool-backed.

ANALYST BEHAVIOR:
- Start with get_session_info and check_cooldown when entry timing matters.
- Use get_market_data and get_atr for current market context when those tools are needed.
- Use get_open_trades and get_account_balance to avoid conflicting or over-capacity entries.
- Open a trade only when you have clear direction, entry_price, quantity, and stop_loss.
- Respect config.risk.maxOpenTrades, config.signal.minRiskReward, session limits, and cooldown limits.
- If market-data tools return stubs, do not pretend a live setup was confirmed. Report that live analysis context is incomplete.

ANALYST OUTPUT STYLE:
- Plain text only. No markdown, no bold, no tables.
- Always follow the exact format from the task prompt: header with Mode, market snapshot, trade levels, performance line, action.
- Action: one short line starting with "Aksi:".
- If no qualified setup exists, header status is HOLD or NO SETUP.`;
}

function buildManagerPrompt() {
  return `
ROLE FOCUS — MANAGER:
- Manage existing XAUT/USDT spot trades.
- Decide whether to hold, close, or preserve trade instructions based on confirmed state and tool output.
- Respect persistent operator instructions attached to trades.

MANAGER BEHAVIOR:
- Prioritize tracked open trades, lastPnlPct, peakProfitPct, trailingActive, age, stop loss, take profit, quantity, and stored instruction.
- Use get_open_trades for current trade context and get_account_balance when account context matters.
- If a trade has an instruction, treat it as high priority context.
- Use close_trade only when exit conditions or operator intent are actually satisfied.
- Use set_trade_instruction when the user gives durable trade-specific guidance.
- Do not invent live prices or PnL. If an exit needs a price and no live price is available, rely only on valid runtime/tool guidance.
- Focus on trade management, not new setup hunting, unless the user explicitly asks for broader help.

MANAGER OUTPUT STYLE:
- Plain text only. No markdown, no bold, no tables.
- After executing actions, output 2-4 short bullet points explaining what happened.
- End with one "Action:" line summarizing the outcome.
- Keep reasoning tied to actual tool results only.`;
}

function buildGeneralPrompt() {
  return `
ROLE FOCUS — GENERAL:
- Handle free-form requests about status, configuration, performance, lessons, strategies, sessions, and trade actions.
- Route your reasoning through the current tool surface instead of assuming hidden state.

GENERAL BEHAVIOR:
- For status/account questions, prefer get_account_balance and get_open_trades.
- For session/cooldown questions, prefer get_session_info and check_cooldown.
- For performance/lessons/strategy questions, use the corresponding generic tools.
- For config changes, use update_config with supported XAUT/USDT spot keys only.
- For open/close trade requests, use the current trade tools and report only real results.
- If the user asks for unsupported capabilities, say so plainly rather than implying that full Tokocrypto execution is already implemented.

GENERAL OUTPUT STYLE:
- Be concise, tool-backed, and action-oriented.
- Use current XAUT/USDT system language only.`;
}

export function buildSystemPrompt(agentType, portfolio, positions, stateSummary = null, lessons = null, perfSummary = null) {
  const role = agentType || "GENERAL";
  const shared = buildSharedPrompt(role, portfolio, positions, stateSummary, lessons, perfSummary);

  if (role === "ANALYST") {
    return `${shared}${buildAnalystPrompt()}\n`;
  }

  if (role === "MANAGER") {
    return `${shared}${buildManagerPrompt()}\n`;
  }

  return `${shared}${buildGeneralPrompt()}\n`;
}
