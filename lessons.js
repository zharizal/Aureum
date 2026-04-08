import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const LESSONS_FILE = "./lessons.json";
const MIN_EVOLVE_POSITIONS = 5;
const MAX_CHANGE_PER_STEP = 0.20;

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    return {
      lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
      performance: Array.isArray(parsed.performance) ? parsed.performance : [],
    };
  } catch {
    return { lessons: [], performance: [] };
  }
}

function save(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

function normalizeRole(role) {
  if (!role) return null;
  const normalized = String(role).toUpperCase();
  if (["ANALYST", "MANAGER", "GENERAL"].includes(normalized)) return normalized;
  return normalized;
}

function getPromptRole(role) {
  return normalizeRole(role) || "GENERAL";
}

function isFiniteNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function toNum(...values) {
  for (const value of values) {
    if (isFiniteNum(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function safeIso(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function round(value, digits = 2) {
  if (!isFiniteNum(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function avg(arr) {
  return arr.reduce((sum, value) => sum + value, 0) / arr.length;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = Math.abs(current) > 0 ? Math.abs(current) * maxChange : maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

function getSignalMetric(signalSnapshot, ...keys) {
  if (!signalSnapshot || typeof signalSnapshot !== "object") return null;
  for (const key of keys) {
    const value = signalSnapshot[key];
    const parsed = toNum(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function computeRMultiple(direction, entryPrice, stopLoss, exitPrice) {
  if (!direction || !isFiniteNum(entryPrice) || !isFiniteNum(stopLoss) || !isFiniteNum(exitPrice)) return null;
  const riskPerUnit = direction === "short" ? stopLoss - entryPrice : entryPrice - stopLoss;
  if (!isFiniteNum(riskPerUnit) || riskPerUnit <= 0) return null;
  const rewardPerUnit = direction === "short" ? entryPrice - exitPrice : exitPrice - entryPrice;
  return rewardPerUnit / riskPerUnit;
}

function inferOutcome(record) {
  const pnlPct = toNum(record.pnl_pct, record.pnlPct);
  const rMultiple = toNum(record.r_multiple, record.rMultiple);

  if (pnlPct != null && pnlPct >= 1.5) return "good";
  if (rMultiple != null && rMultiple >= 1.0) return "good";
  if (pnlPct != null && pnlPct <= -1.0) return "bad";
  if (rMultiple != null && rMultiple <= -1.0) return "bad";
  if (pnlPct != null && pnlPct < 0) return "poor";
  return "neutral";
}

function normalizePerformanceRecord(record = {}) {
  if (!record || typeof record !== "object") return null;

  const signalSnapshot = record.signal_snapshot ?? record.signalSnapshot ?? null;
  const direction = (record.direction || null)?.toLowerCase?.() || null;
  const entryPrice = toNum(record.entry_price, record.entryPrice);
  const exitPrice = toNum(record.exit_price, record.exitPrice);
  const stopLoss = toNum(record.stop_loss, record.stopLoss);
  const takeProfit = toNum(record.take_profit, record.takeProfit);
  const quantity = toNum(record.quantity, record.base_quantity, record.baseQuantity, record.lot_size, record.lotSize);
  const atrAtEntry = toNum(record.atr_at_entry, record.atrAtEntry, record.atr);
  const riskReward = toNum(record.risk_reward, record.riskReward);
  const peakProfitPct = toNum(record.peak_profit_pct, record.peakProfitPct);
  const lastPnlPct = toNum(record.last_pnl_pct, record.lastPnlPct);
  const notionalUsd = toNum(record.notional_usd, record.notionalUsd, record.initial_value_usd, record.initialValueUsd);

  let pnlUsd = toNum(record.pnl_usd, record.pnlUsd);
  if (pnlUsd == null) {
    const finalValueUsd = toNum(record.final_value_usd, record.finalValueUsd);
    const feesEarnedUsd = toNum(record.fees_earned_usd, record.feesEarnedUsd) ?? 0;
    const initialValueUsd = toNum(record.initial_value_usd, record.initialValueUsd, record.notional_usd, record.notionalUsd);
    if (finalValueUsd != null && initialValueUsd != null) {
      pnlUsd = finalValueUsd + feesEarnedUsd - initialValueUsd;
    }
  }

  let pnlPct = toNum(record.pnl_pct, record.pnlPct);
  if (pnlPct == null && pnlUsd != null) {
    const initialValueUsd = toNum(record.initial_value_usd, record.initialValueUsd, record.notional_usd, record.notionalUsd);
    if (initialValueUsd != null && initialValueUsd > 0) {
      pnlPct = (pnlUsd / initialValueUsd) * 100;
    }
  }

  let rMultiple = toNum(record.r_multiple, record.rMultiple);
  if (rMultiple == null) {
    rMultiple = computeRMultiple(direction, entryPrice, stopLoss, exitPrice);
  }

  const setupType = record.setup_type ?? record.setupType ?? null;
  const session = record.session ?? null;
  const closeReason = record.close_reason ?? record.closeReason ?? null;
  const tradeId = record.trade_id ?? record.tradeId ?? record.position ?? null;
  const symbol = record.symbol ?? record.pool_name ?? record.pool ?? null;

  return {
    trade_id: tradeId,
    symbol,
    direction,
    setup_type: setupType,
    session,
    entry_price: entryPrice,
    exit_price: exitPrice,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    quantity: quantity,
    notional_usd: round(notionalUsd),
    atr_at_entry: atrAtEntry,
    risk_reward: riskReward,
    pnl_usd: round(pnlUsd),
    pnl_pct: round(pnlPct),
    r_multiple: round(rMultiple),
    peak_profit_pct: round(peakProfitPct),
    last_pnl_pct: round(lastPnlPct),
    trailing_active: !!(record.trailing_active ?? record.trailingActive),
    close_reason: closeReason,
    signal_snapshot: signalSnapshot,
    opened_at: safeIso(record.opened_at ?? record.openedAt ?? record.deployed_at),
    closed_at: safeIso(record.closed_at ?? record.closedAt),
    recorded_at: safeIso(record.recorded_at) || new Date().toISOString(),
    outcome: record.outcome || inferOutcome(record),
    legacy: !!(record.pool || record.pool_name || record.bin_step || record.fee_tvl_ratio || record.organic_score || record.lot_size || record.lotSize),
  };
}

function buildTradeContext(record) {
  const parts = [];
  if (record.symbol) parts.push(record.symbol);
  if (record.direction) parts.push(record.direction.toUpperCase());
  if (record.setup_type) parts.push(`setup=${record.setup_type}`);
  if (record.session) parts.push(`session=${record.session}`);
  if (isFiniteNum(record.risk_reward)) parts.push(`rr=${record.risk_reward}`);
  if (isFiniteNum(record.atr_at_entry)) parts.push(`atr=${record.atr_at_entry}`);
  return parts.join(", ") || "trade";
}

function deriveTags(record) {
  const tags = [];
  if (record.setup_type) tags.push(String(record.setup_type).toLowerCase());
  if (record.direction) tags.push(record.direction);
  if (record.session) tags.push(String(record.session).toLowerCase());
  if (record.close_reason) tags.push(String(record.close_reason).toLowerCase());
  if (record.trailing_active) tags.push("trailing");
  if (isFiniteNum(record.r_multiple)) tags.push(record.r_multiple >= 0 ? "r_positive" : "r_negative");
  if (isFiniteNum(record.pnl_pct)) tags.push(record.pnl_pct >= 0 ? "winner" : "loser");
  return [...new Set(tags.filter(Boolean))];
}

function deriveLesson(record) {
  const outcome = inferOutcome(record);
  if (outcome === "neutral") return null;

  const context = buildTradeContext(record);
  const tags = deriveTags(record);
  const pnlText = isFiniteNum(record.pnl_pct) ? `${record.pnl_pct}%` : "unknown PnL";
  const rText = isFiniteNum(record.r_multiple) ? `${record.r_multiple}R` : null;
  let rule = "";

  if (outcome === "good") {
    if (record.close_reason === "trailing_stop" || record.trailing_active) {
      rule = `PREFER: let strong ${context} spot trades run when trailing protection is active — this outcome closed well at ${pnlText}${rText ? ` (${rText})` : ""}.`;
    } else if (record.setup_type && isFiniteNum(record.risk_reward) && record.risk_reward >= 1.5) {
      rule = `PREFER: ${context} when the planned risk-reward is at least ${record.risk_reward} — realized ${pnlText}${rText ? ` (${rText})` : ""}.`;
    } else {
      rule = `WORKED: ${context} closed profitably at ${pnlText}${rText ? ` (${rText})` : ""}.`;
    }
  } else if (outcome === "bad") {
    if (record.close_reason === "stop_loss") {
      rule = `AVOID: low-quality ${context} entries that quickly resolve at stop loss — result ${pnlText}${rText ? ` (${rText})` : ""}.`;
    } else if (record.close_reason === "idle_exit") {
      rule = `AVOID: ${context} setups that stall without momentum into an idle exit — result ${pnlText}${rText ? ` (${rText})` : ""}.`;
    } else if (record.close_reason) {
      rule = `FAILED: ${context} ended via ${record.close_reason} at ${pnlText}${rText ? ` (${rText})` : ""}.`;
    } else {
      rule = `FAILED: ${context} closed poorly at ${pnlText}${rText ? ` (${rText})` : ""}.`;
    }
  } else {
    rule = `CAUTION: ${context} produced a weak outcome at ${pnlText}${rText ? ` (${rText})` : ""}.`;
  }

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    context,
    pnl_pct: record.pnl_pct,
    r_multiple: record.r_multiple,
    symbol: record.symbol,
    role: record.close_reason === "stop_loss" || record.close_reason === "trailing_stop" || record.close_reason === "take_profit"
      ? "MANAGER"
      : "ANALYST",
    created_at: new Date().toISOString(),
  };
}

function getTrendAdx(record) {
  const setup = String(record.setup_type || "").toLowerCase();
  if (!["trend", "breakout", "pullback"].includes(setup)) return null;
  return getSignalMetric(record.signal_snapshot, "adx", "adxValue", "trendAdx");
}

function getRangeAdx(record) {
  const setup = String(record.setup_type || "").toLowerCase();
  if (setup !== "range") return null;
  return getSignalMetric(record.signal_snapshot, "adx", "adxValue", "rangeAdx");
}

function getAtrMultiplier(record) {
  return getSignalMetric(record.signal_snapshot, "atrMultiplier", "atr_multiplier", "atrMoveMultiple", "entryAtrMultiplier");
}

function persistConfigChanges(perfData, config, changes, rationale) {
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    } catch {
      userConfig = {};
    }
  }

  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._tradesAtEvolution = perfData.length;
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  const signal = config.signal;
  if (changes.minRiskReward != null) signal.minRiskReward = changes.minRiskReward;
  if (changes.minAtrMultiplierForEntry != null) signal.minAtrMultiplierForEntry = changes.minAtrMultiplierForEntry;
  if (changes.minAdxForTrend != null) signal.minAdxForTrend = changes.minAdxForTrend;
  if (changes.maxAdxForRange != null) signal.maxAdxForRange = changes.maxAdxForRange;

  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${perfData.length} trades] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "config_change"],
    outcome: "manual",
    role: "GENERAL",
    created_at: new Date().toISOString(),
  });
  save(data);
}

export async function recordPerformance(perf) {
  const data = load();
  const entry = normalizePerformanceRecord(perf);
  if (!entry) return;

  data.performance.push(entry);

  const lesson = deriveLesson(entry);
  if (lesson) {
    data.lessons.push(lesson);
    log("lessons", `New lesson: ${lesson.rule}`);
  }

  save(data);

  if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
    const { config, reloadSignalThresholds } = await import("./config.js");
    const result = evolveThresholds(data.performance, config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadSignalThresholds();
      log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    }
  }
}

export function evolveThresholds(perfData, config) {
  if (!Array.isArray(perfData) || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  const normalized = perfData.map(normalizePerformanceRecord).filter(Boolean);
  const winners = normalized.filter((record) => isFiniteNum(record.pnl_pct) && record.pnl_pct > 0);
  const losers = normalized.filter((record) => isFiniteNum(record.pnl_pct) && record.pnl_pct < 0);

  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) return null;

  const changes = {};
  const rationale = {};

  {
    const winnerRr = winners.map((record) => record.risk_reward).filter(isFiniteNum);
    const loserRr = losers.map((record) => record.risk_reward).filter(isFiniteNum);
    const current = config.signal.minRiskReward;

    if (winnerRr.length >= 2) {
      const minWinnerRr = Math.min(...winnerRr);
      if (minWinnerRr > current * 1.1) {
        const target = minWinnerRr * 0.9;
        const rounded = round(clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.5, 5.0), 2);
        if (rounded > current) {
          changes.minRiskReward = rounded;
          rationale.minRiskReward = `Winning trades clustered above planned risk-reward ${minWinnerRr.toFixed(2)} — raised floor from ${current} to ${rounded}`;
        }
      }
    }

    if (loserRr.length >= 3 && winnerRr.length === 0) {
      const loserMedianRr = percentile(loserRr, 50);
      if (loserMedianRr < current * 0.9) {
        const target = loserMedianRr;
        const rounded = round(clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.5, 5.0), 2);
        if (rounded < current && !changes.minRiskReward) {
          changes.minRiskReward = rounded;
          rationale.minRiskReward = `Only losing trades had planned risk-reward around ${loserMedianRr.toFixed(2)} — lowered floor from ${current} to ${rounded}`;
        }
      }
    }
  }

  {
    const atrWinners = winners.map(getAtrMultiplier).filter(isFiniteNum);
    const atrLosers = losers.map(getAtrMultiplier).filter(isFiniteNum);
    const current = config.signal.minAtrMultiplierForEntry;

    if (atrWinners.length >= 2) {
      const minWinnerAtr = Math.min(...atrWinners);
      if (minWinnerAtr > current * 1.1) {
        const target = minWinnerAtr * 0.9;
        const rounded = round(clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.1, 5.0), 2);
        if (rounded > current) {
          changes.minAtrMultiplierForEntry = rounded;
          rationale.minAtrMultiplierForEntry = `Winning setups needed stronger ATR expansion (${minWinnerAtr.toFixed(2)} minimum) — raised floor from ${current} to ${rounded}`;
        }
      }
    } else if (atrLosers.length >= 3 && atrWinners.length === 0) {
      const loserMedianAtr = percentile(atrLosers, 50);
      if (loserMedianAtr < current * 0.9) {
        const rounded = round(clamp(nudge(current, loserMedianAtr, MAX_CHANGE_PER_STEP), 0.1, 5.0), 2);
        if (rounded < current) {
          changes.minAtrMultiplierForEntry = rounded;
          rationale.minAtrMultiplierForEntry = `Observed losing setups at weaker ATR expansion (~${loserMedianAtr.toFixed(2)}) — lowered floor from ${current} to ${rounded}`;
        }
      }
    }
  }

  {
    const trendWinnerAdx = winners.map(getTrendAdx).filter(isFiniteNum);
    const trendLoserAdx = losers.map(getTrendAdx).filter(isFiniteNum);
    const current = config.signal.minAdxForTrend;

    if (trendWinnerAdx.length >= 2 && trendLoserAdx.length >= 2) {
      const avgWinnerAdx = avg(trendWinnerAdx);
      const avgLoserAdx = avg(trendLoserAdx);
      if (avgWinnerAdx - avgLoserAdx >= 5) {
        const target = Math.min(...trendWinnerAdx) - 1;
        const rounded = Math.round(clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 10, 50));
        if (rounded > current) {
          changes.minAdxForTrend = rounded;
          rationale.minAdxForTrend = `Trend winners showed stronger ADX (${avgWinnerAdx.toFixed(1)} vs ${avgLoserAdx.toFixed(1)}) — raised floor from ${current} to ${rounded}`;
        }
      }
    }
  }

  {
    const rangeWinnerAdx = winners.map(getRangeAdx).filter(isFiniteNum);
    const rangeLoserAdx = losers.map(getRangeAdx).filter(isFiniteNum);
    const current = config.signal.maxAdxForRange;

    if (rangeWinnerAdx.length >= 2 && rangeLoserAdx.length >= 2) {
      const avgWinnerAdx = avg(rangeWinnerAdx);
      const avgLoserAdx = avg(rangeLoserAdx);
      if (avgLoserAdx - avgWinnerAdx >= 5) {
        const target = Math.max(...rangeWinnerAdx) + 1;
        const rounded = Math.round(clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 5, 40));
        if (rounded < current) {
          changes.maxAdxForRange = rounded;
          rationale.maxAdxForRange = `Range losers showed higher ADX (${avgLoserAdx.toFixed(1)} vs ${avgWinnerAdx.toFixed(1)}) — tightened ceiling from ${current} to ${rounded}`;
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) {
    return { changes: {}, rationale: {} };
  }

  persistConfigChanges(normalized, config, changes, rationale);
  return { changes, rationale };
}

export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const data = load();
  const normalizedRole = normalizeRole(role);
  data.lessons.push({
    id: Date.now(),
    rule,
    tags,
    outcome: "manual",
    pinned: !!pinned,
    role: normalizedRole,
    created_at: new Date().toISOString(),
  });
  save(data);
  log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${normalizedRole ? ` [${normalizedRole}]` : ""}: ${rule}`);
}

export function pinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((entry) => entry.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

export function unpinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((entry) => entry.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const data = load();
  const normalizedRole = normalizeRole(role);
  let lessons = [...data.lessons];

  if (pinned !== null) lessons = lessons.filter((entry) => !!entry.pinned === pinned);
  if (normalizedRole) {
    lessons = lessons.filter((entry) => {
      const entryRole = normalizeRole(entry.role);
      return !entryRole || entryRole === normalizedRole;
    });
  }
  if (tag) lessons = lessons.filter((entry) => entry.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((entry) => ({
      id: entry.id,
      rule: entry.rule.slice(0, 120),
      tags: entry.tags,
      outcome: entry.outcome,
      pinned: !!entry.pinned,
      role: normalizeRole(entry.role) || "all",
      created_at: entry.created_at?.slice(0, 10),
    })),
  };
}

export function removeLesson(id) {
  const data = load();
  const before = data.lessons.length;
  data.lessons = data.lessons.filter((entry) => entry.id !== id);
  save(data);
  return before - data.lessons.length;
}

export function removeLessonsByKeyword(keyword) {
  const data = load();
  const before = data.lessons.length;
  const lowered = keyword.toLowerCase();
  data.lessons = data.lessons.filter((entry) => !entry.rule.toLowerCase().includes(lowered));
  save(data);
  return before - data.lessons.length;
}

export function clearAllLessons() {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

export function clearPerformance() {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

const ROLE_TAGS = {
  ANALYST: ["breakout", "pullback", "range", "entry", "setup", "session", "winner", "loser", "long", "short"],
  MANAGER: ["management", "risk", "stop_loss", "take_profit", "trailing_stop", "idle_exit", "pnl", "trailing", "winner", "loser"],
  GENERAL: [],
};

export function getLessonsForPrompt(opts = {}) {
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;
  const promptRole = getPromptRole(agentType);
  const data = load();
  if (data.lessons.length === 0) return null;

  const isAutoCycle = promptRole === "ANALYST" || promptRole === "MANAGER";
  const PINNED_CAP = isAutoCycle ? 5 : 10;
  const ROLE_CAP = isAutoCycle ? 6 : 15;
  const RECENT_CAP = maxLessons ?? (isAutoCycle ? 10 : 35);

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  const pinned = data.lessons
    .filter((entry) => {
      const entryRole = normalizeRole(entry.role);
      return entry.pinned && (!entryRole || entryRole === promptRole || promptRole === "GENERAL");
    })
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((entry) => entry.id));
  const roleTags = ROLE_TAGS[promptRole] || [];

  const roleMatched = data.lessons
    .filter((entry) => {
      if (usedIds.has(entry.id)) return false;
      const entryRole = normalizeRole(entry.role);
      const roleOk = !entryRole || entryRole === promptRole || promptRole === "GENERAL";
      const tagOk = roleTags.length === 0 || !entry.tags?.length || entry.tags.some((tag) => roleTags.includes(tag));
      return roleOk && tagOk;
    })
    .sort(byPriority)
    .slice(0, ROLE_CAP);

  roleMatched.forEach((entry) => usedIds.add(entry.id));

  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? data.lessons
        .filter((entry) => !usedIds.has(entry.id))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  if (selected.length === 0) return null;

  const sections = [];
  if (pinned.length) sections.push(`── PINNED (${pinned.length}) ──\n${formatLessons(pinned)}`);
  if (roleMatched.length) sections.push(`── ${promptRole} (${roleMatched.length}) ──\n${formatLessons(roleMatched)}`);
  if (recent.length) sections.push(`── RECENT (${recent.length}) ──\n${formatLessons(recent)}`);

  return sections.join("\n\n");
}

function formatLessons(lessons) {
  return lessons.map((entry) => {
    const date = entry.created_at ? entry.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin = entry.pinned ? "[PINNED] " : "";
    return `${pin}[${String(entry.outcome || "manual").toUpperCase()}] [${date}] ${entry.rule}`;
  }).join("\n");
}

export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const normalized = data.performance.map(normalizePerformanceRecord).filter(Boolean);
  if (normalized.length === 0) return { trades: [], positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const filtered = normalized
    .filter((record) => (record.recorded_at || "") >= cutoff)
    .slice(-limit)
    .map((record) => ({
      trade_id: record.trade_id,
      symbol: record.symbol,
      direction: record.direction,
      setup_type: record.setup_type,
      session: record.session,
      quantity: record.quantity,
      notional_usd: record.notional_usd,
      pnl_usd: record.pnl_usd,
      pnl_pct: record.pnl_pct,
      r_multiple: record.r_multiple,
      close_reason: record.close_reason,
      closed_at: record.closed_at || record.recorded_at,
    }));

  const totalPnl = filtered.reduce((sum, record) => sum + (record.pnl_usd ?? 0), 0);
  const wins = filtered.filter((record) => (record.pnl_usd ?? 0) > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: round(totalPnl),
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    trades: filtered,
    positions: filtered,
  };
}

export function getPerformanceSummary() {
  const data = load();
  const normalized = data.performance.map(normalizePerformanceRecord).filter(Boolean);
  if (normalized.length === 0) return null;

  const pnlRecords = normalized.filter((record) => isFiniteNum(record.pnl_usd));
  const pnlPctRecords = normalized.filter((record) => isFiniteNum(record.pnl_pct));
  const rRecords = normalized.filter((record) => isFiniteNum(record.r_multiple));
  const wins = normalized.filter((record) => (record.pnl_usd ?? -Infinity) > 0 || (record.pnl_pct ?? -Infinity) > 0).length;

  const closeReasonBreakdown = {};
  for (const record of normalized) {
    const reason = record.close_reason || "unknown";
    closeReasonBreakdown[reason] = (closeReasonBreakdown[reason] || 0) + 1;
  }

  return {
    total_trades_closed: normalized.length,
    total_pnl_usd: pnlRecords.length ? round(pnlRecords.reduce((sum, record) => sum + record.pnl_usd, 0)) : null,
    avg_pnl_pct: pnlPctRecords.length ? round(avg(pnlPctRecords.map((record) => record.pnl_pct))) : null,
    avg_r_multiple: rRecords.length ? round(avg(rRecords.map((record) => record.r_multiple))) : null,
    win_rate_pct: Math.round((wins / normalized.length) * 100),
    close_reasons: closeReasonBreakdown,
    total_lessons: data.lessons.length,
    legacy_records_present: normalized.some((record) => record.legacy),
  };
}
