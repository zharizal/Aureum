#!/usr/bin/env node
/**
 * aureum — PAXG/USDT Tokocrypto operator CLI
 * Direct operator/runtime access with JSON output.
 */

import "dotenv/config";
import { parseArgs } from "util";
import os from "os";
import fs from "fs";
import path from "path";

if (process.argv.includes("--dry-run")) process.env.DRY_RUN = "true";

const aureumDir = path.join(os.homedir(), ".aureum");
const aureumEnv = path.join(aureumDir, ".env");
if (fs.existsSync(aureumEnv)) {
  const { config: loadDotenv } = await import("dotenv");
  loadDotenv({ path: aureumEnv, override: false });
}

function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function die(msg, extra = {}) {
  process.stderr.write(JSON.stringify({ error: msg, ...extra }) + "\n");
  process.exit(1);
}

const SKILL_MD = `# aureum — PAXG/USDT Tokocrypto operator CLI

Data dir: ~/.aureum/

## Commands

### aureum help
Returns this command reference.

### aureum status
Returns the current operator summary.
\`\`\`
Output: { mode, instrument, timeframe, open_trades, closed_trades, today, cooldown, risk, recent_events, performance_summary }
\`\`\`

### aureum open-trades
Returns tracked open trades from local state.
\`\`\`
Output: { total_trades, trades: [{ tradeId, symbol, direction, entryPrice, quantity, stopLoss, takeProfit, lastPnlPct, peakProfitPct, trailingActive, instruction, openedAt }] }
\`\`\`

### aureum recent-trades [--limit 10]
Returns recent closed-trade history.
\`\`\`
Output: { count, trades: [{ trade_id, symbol, direction, quantity, pnl_usd, pnl_pct, close_reason, closed_at }] }
\`\`\`

### aureum risk
Returns current risk, cooldown, and paper/live status.
\`\`\`
Output: { mode, max_open_trades, risk_pct_per_trade, max_daily_loss_pct, max_drawdown_pct, cooldown, today }
\`\`\`

### aureum briefing
Returns the current PAXG/USDT operator briefing.
\`\`\`
Output: { briefing }
\`\`\`

### aureum analyze [--silent]
Runs one analysis cycle.
\`\`\`
Output: { done: true, report: "..." }
\`\`\`

### aureum manage [--silent]
Runs one management cycle.
\`\`\`
Output: { done: true, report: "..." }
\`\`\`

### aureum start [--dry-run]
Starts the autonomous agent with cron jobs.

### aureum config get
Returns the full runtime config.

### aureum config set <key> <value>
Updates a runtime config key. Parses value as JSON when possible.

### aureum lessons [--limit 50]
Lists saved lessons.
\`\`\`
Output: { total, lessons: [{ id, rule, tags, outcome, pinned, role, created_at }] }
\`\`\`

### aureum lessons add <text>
Adds a manual lesson.
\`\`\`
Output: { saved: true, rule, outcome, role }
\`\`\`

### aureum performance [--limit 200]
Returns closed-trade performance summary and history.
\`\`\`
Output: { summary, trades }
\`\`\`

### aureum evolve
Runs threshold evolution over recorded closed trades.
\`\`\`
Output: { evolved, changes, rationale }
\`\`\`

## Flags
--dry-run     Force paper/dry-run mode for this invocation
--silent      Suppress Telegram notifications for cycle commands
--limit       Limit output size for list/history commands
`;

fs.mkdirSync(aureumDir, { recursive: true });
fs.writeFileSync(path.join(aureumDir, "SKILL.md"), SKILL_MD);

const argv = process.argv.slice(2);
const subcommand = argv.find((a) => !a.startsWith("-"));
const sub2 = argv.filter((a) => !a.startsWith("-"))[1];
const silent = argv.includes("--silent");

if (!subcommand || subcommand === "help" || argv.includes("--help")) {
  process.stdout.write(SKILL_MD);
  process.exit(0);
}

const { values: flags } = parseArgs({
  args: argv,
  options: {
    limit: { type: "string" },
    reason: { type: "string" },
    "dry-run": { type: "boolean" },
    silent: { type: "boolean" },
  },
  allowPositionals: true,
  strict: false,
});

function parseLimit(defaultValue) {
  const parsed = parseInt(flags.limit || String(defaultValue), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

async function getRuntimeModules() {
  const [{ config }, state, lessons] = await Promise.all([
    import("./config.js"),
    import("./state.js"),
    import("./lessons.js"),
  ]);
  return { config, state, lessons };
}

switch (subcommand) {
  case "status": {
    const { config, state, lessons } = await getRuntimeModules();
    const stateSummary = state.getStateSummary();
    const today = state.getTodayStats();
    const cooldown = state.checkCooldown(config.cooldown);
    const perfSummary = lessons.getPerformanceSummary();

    out({
      mode: config.paper.enabled ? "PAPER" : "LIVE",
      instrument: config.instrument.symbol,
      timeframe: config.market.timeframe,
      open_trades: stateSummary.open_trades,
      closed_trades: stateSummary.closed_trades,
      today,
      cooldown,
      risk: {
        max_open_trades: config.risk.maxOpenTrades,
        risk_pct_per_trade: config.risk.riskPctPerTrade,
        max_daily_loss_pct: config.risk.maxDailyLossPct,
        max_drawdown_pct: config.risk.maxDrawdownPct,
      },
      recent_events: stateSummary.recent_events,
      performance_summary: perfSummary,
    });
    break;
  }

  case "open-trades": {
    const { state } = await getRuntimeModules();
    const trades = state.getTrackedTrades(true);
    out({ total_trades: trades.length, trades });
    break;
  }

  case "recent-trades": {
    const { lessons } = await getRuntimeModules();
    const limit = parseLimit(10);
    const history = lessons.getPerformanceHistory({ hours: 24 * 30, limit });
    out({ count: history.trades?.length || 0, trades: history.trades || [] });
    break;
  }

  case "risk": {
    const { config, state } = await getRuntimeModules();
    out({
      mode: config.paper.enabled ? "PAPER" : "LIVE",
      instrument: config.instrument.symbol,
      exchange: config.instrument.exchange,
      max_open_trades: config.risk.maxOpenTrades,
      risk_pct_per_trade: config.risk.riskPctPerTrade,
      max_daily_loss_pct: config.risk.maxDailyLossPct,
      max_drawdown_pct: config.risk.maxDrawdownPct,
      cooldown: state.checkCooldown(config.cooldown),
      today: state.getTodayStats(),
    });
    break;
  }

  case "briefing": {
    const { generateBriefing } = await import("./briefing.js");
    out({ briefing: await generateBriefing() });
    break;
  }

  case "analyze": {
    const { runAnalysisCycle } = await import("./index.js");
    const report = await runAnalysisCycle({ silent });
    out({ done: true, report: report || "No action taken" });
    break;
  }

  case "manage": {
    const { runManagementCycle } = await import("./index.js");
    const report = await runManagementCycle({ silent });
    out({ done: true, report: report || "No action taken" });
    break;
  }

  case "start": {
    const { startCronJobs } = await import("./index.js");
    process.stderr.write("[aureum] Starting PAXG/USDT Tokocrypto trading agent...\n");
    startCronJobs();
    break;
  }

  case "config": {
    if (sub2 === "get" || !sub2) {
      const { config } = await import("./config.js");
      out(config);
    } else if (sub2 === "set") {
      const key = argv.filter((a) => !a.startsWith("-"))[2];
      const rawVal = argv.filter((a) => !a.startsWith("-"))[3];
      if (!key || rawVal === undefined) die("Usage: aureum config set <key> <value>");
      let value = rawVal;
      try { value = JSON.parse(rawVal); } catch {}
      const { executeTool } = await import("./tools/executor.js");
      out(await executeTool("update_config", { changes: { [key]: value }, reason: flags.reason || "CLI config set" }));
    } else {
      die(`Unknown config subcommand: ${sub2}. Use: get, set`);
    }
    break;
  }

  case "lessons": {
    if (sub2 === "add") {
      const text = argv.filter((a) => !a.startsWith("-")).slice(2).join(" ");
      if (!text) die("Usage: aureum lessons add <text>");
      const { addLesson } = await import("./lessons.js");
      addLesson(text, [], { pinned: false, role: null });
      out({ saved: true, rule: text, outcome: "manual", role: null });
    } else {
      const { listLessons } = await import("./lessons.js");
      out(listLessons({ limit: parseLimit(50) }));
    }
    break;
  }

  case "performance": {
    const { getPerformanceHistory, getPerformanceSummary } = await import("./lessons.js");
    const limit = parseLimit(200);
    const history = getPerformanceHistory({ hours: 999999, limit });
    const summary = getPerformanceSummary();
    out({ summary, ...history });
    break;
  }

  case "evolve": {
    const { config } = await import("./config.js");
    const { evolveThresholds } = await import("./lessons.js");
    const lessonsFile = "./lessons.json";
    let perfData = [];
    if (fs.existsSync(lessonsFile)) {
      try {
        perfData = JSON.parse(fs.readFileSync(lessonsFile, "utf8")).performance || [];
      } catch {
        perfData = [];
      }
    }
    const result = evolveThresholds(perfData, config);
    if (!result) {
      out({ evolved: false, reason: `Need at least 5 closed trades (have ${perfData.length})` });
    } else {
      out({ evolved: Object.keys(result.changes).length > 0, changes: result.changes, rationale: result.rationale });
    }
    break;
  }

  default:
    die(`Unknown command: ${subcommand}. Run 'aureum help' for usage.`);
}
