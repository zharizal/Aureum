/**
 * Interactive setup wizard.
 * Guides the user through .env + user-config.json creation
 * for the current PAXG/USDT Tokocrypto runtime.
 * Run: npm run setup
 */

import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "user-config.json");
const ENV_PATH = path.join(__dirname, ".env");

const DEFAULT_MODEL = "openai/gpt-oss-20b:free";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultVal) {
  return new Promise((resolve) => {
    const hint = defaultVal !== undefined && defaultVal !== "" ? ` (default: ${defaultVal})` : "";
    rl.question(`${question}${hint}: `, (ans) => {
      const trimmed = ans.trim();
      resolve(trimmed === "" ? defaultVal : trimmed);
    });
  });
}

function askNum(question, defaultVal, { min, max } = {}) {
  return new Promise(async (resolve) => {
    while (true) {
      const raw = await ask(question, defaultVal);
      const n = parseFloat(raw);
      if (Number.isNaN(n)) { console.log("  Please enter a number."); continue; }
      if (min !== undefined && n < min) { console.log(`  Minimum is ${min}.`); continue; }
      if (max !== undefined && n > max) { console.log(`  Maximum is ${max}.`); continue; }
      resolve(n);
      break;
    }
  });
}

function askBool(question, defaultVal) {
  return new Promise(async (resolve) => {
    while (true) {
      const hint = defaultVal ? "Y/n" : "y/N";
      const raw = await ask(`${question} [${hint}]`, "");
      if (raw === "") { resolve(defaultVal); break; }
      if (/^y(es)?$/i.test(raw)) { resolve(true); break; }
      if (/^n(o)?$/i.test(raw)) { resolve(false); break; }
      console.log("  Enter y or n.");
    }
  });
}

function askChoice(question, choices) {
  return new Promise(async (resolve) => {
    const labels = choices.map((c, i) => `  ${i + 1}. ${c.label}`).join("\n");
    while (true) {
      console.log(`\n${question}`);
      console.log(labels);
      const raw = await ask("Enter number", "");
      const idx = parseInt(raw, 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(choices[idx]);
        break;
      }
      console.log("  Invalid choice.");
    }
  });
}

function parseEnv(content) {
  const map = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return map;
}

function buildEnv(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

const PRESETS = {
  aggressive: {
    label: "Aggressive",
    timeframe: "5m",
    riskPctPerTrade: 1.5,
    maxOpenTrades: 3,
    maxDailyLossPct: 4,
    stopLossPct: -2.0,
    takeProfitPct: 3.0,
    trailingTriggerPct: 0.8,
    trailingDropPct: 0.4,
    analysisIntervalMin: 5,
    managementIntervalMin: 3,
    description: "Faster cadence with tighter management and higher trade frequency.",
  },
  balanced: {
    label: "Balanced",
    timeframe: "15m",
    riskPctPerTrade: 1.0,
    maxOpenTrades: 2,
    maxDailyLossPct: 3,
    stopLossPct: -2.0,
    takeProfitPct: 3.0,
    trailingTriggerPct: 1.0,
    trailingDropPct: 0.5,
    analysisIntervalMin: 15,
    managementIntervalMin: 5,
    description: "Balanced defaults for paper trading and general evaluation.",
  },
  conservative: {
    label: "Conservative",
    timeframe: "30m",
    riskPctPerTrade: 0.5,
    maxOpenTrades: 1,
    maxDailyLossPct: 2,
    stopLossPct: -1.5,
    takeProfitPct: 2.5,
    trailingTriggerPct: 1.0,
    trailingDropPct: 0.5,
    analysisIntervalMin: 20,
    managementIntervalMin: 10,
    description: "Lower trade frequency and tighter overall risk.",
  },
};

const existingConfig = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  : {};
const existingEnv = fs.existsSync(ENV_PATH)
  ? parseEnv(fs.readFileSync(ENV_PATH, "utf8"))
  : {};

const e = (key, fallback) => existingConfig[key] ?? fallback;
const ev = (key, fallback) => existingEnv[key] ?? fallback;
const alreadySet = (val) => (val ? "*** (already set — Enter to keep)" : "");

console.log(`
╔═══════════════════════════════════════════════╗
║          Aureum — Setup Wizard               ║
║      PAXG/USDT Tokocrypto Runtime            ║
╚═══════════════════════════════════════════════╝

This wizard creates your .env and user-config.json.
Press Enter to keep the current or default value.
`);

console.log("-- LLM and notifications -------------------------------------");

const openrouterKey = await ask(
  "OpenRouter API key (optional if using another provider)",
  alreadySet(ev("OPENROUTER_API_KEY", ""))
);

const telegramToken = await ask(
  "Telegram bot token (optional)",
  alreadySet(ev("TELEGRAM_BOT_TOKEN", ""))
);

const telegramChatId = await ask(
  "Telegram chat ID (optional)",
  ev("TELEGRAM_CHAT_ID", e("telegramChatId", ""))
);

const presetChoice = await askChoice("Select a runtime preset:", [
  { label: `${PRESETS.aggressive.label} — ${PRESETS.aggressive.description}`, key: "aggressive" },
  { label: `${PRESETS.balanced.label} — ${PRESETS.balanced.description}`, key: "balanced" },
  { label: `${PRESETS.conservative.label} — ${PRESETS.conservative.description}`, key: "conservative" },
  { label: "Custom — configure values manually", key: "custom" },
]);

const preset = presetChoice.key === "custom" ? null : PRESETS[presetChoice.key];
const p = (key, fallback) => preset?.[key] ?? e(key, fallback);

console.log(preset
  ? `\n${preset.label} preset selected. Override any value below if needed.\n`
  : "\nCustom mode selected.\n");

console.log("-- Runtime ----------------------------------------------------");

const dryRun = await askBool("Paper / dry-run mode?", e("dryRun", true));
const exchange = await ask("Exchange venue", e("exchange", "Tokocrypto"));
const symbol = await ask("Trading symbol", e("symbol", "PAXG/USDT"));
const baseAsset = await ask("Base asset", e("baseAsset", "PAXG"));
const quoteAsset = await ask("Quote asset", e("quoteAsset", "USDT"));
const timeframe = await ask("Analysis timeframe", p("timeframe", "15m"));
const paperBalance = await askNum(`Paper balance (${quoteAsset})`, e("paperBalance", 10000), { min: 100 });
const pricePrecision = await askNum("Price precision", e("pricePrecision", 2), { min: 0, max: 8 });
const quantityPrecision = await askNum("Quantity precision", e("quantityPrecision", 4), { min: 0, max: 8 });
const minQuantity = await askNum("Minimum quantity", e("minQuantity", 0.0001), { min: 0.00000001 });
const minNotional = await askNum(`Minimum notional (${quoteAsset})`, e("minNotional", 10), { min: 0 });
const feeRatePct = await askNum("Fee rate per side (%)", e("feeRatePct", 0.1), { min: 0, max: 5 });

console.log("\n-- Risk -------------------------------------------------------");

const maxOpenTrades = await askNum("Max open trades", p("maxOpenTrades", 2), { min: 1, max: 10 });
const riskPctPerTrade = await askNum("Risk per trade (%)", p("riskPctPerTrade", 1.0), { min: 0.1, max: 10 });
const maxDailyLossPct = await askNum("Max daily loss (%)", p("maxDailyLossPct", 3.0), { min: 0.5, max: 50 });
const maxDrawdownPct = await askNum("Max total drawdown (%)", e("maxDrawdownPct", 10.0), { min: 1, max: 80 });
const minAccountBalance = await askNum(`Min account balance (${quoteAsset})`, e("minAccountBalance", 100), { min: 0 });
const maxPositionQuantity = await askNum("Max position quantity", e("maxPositionQuantity", 1.0), { min: 0.0001, max: 1000000 });
const maxPositionNotional = await askNum(`Max position notional (${quoteAsset})`, e("maxPositionNotional", 5000), { min: 1, max: 100000000 });

console.log("\n-- Trade management -------------------------------------------");

const stopLossPct = await askNum("Emergency stop loss (%)", p("stopLossPct", -2.0), { min: -50, max: -0.1 });
const takeProfitPct = await askNum("Emergency take profit (%)", p("takeProfitPct", 3.0), { min: 0.1, max: 100 });
const trailingStop = await askBool("Enable trailing stop?", e("trailingStop", true));
const trailingTriggerPct = await askNum("Trailing trigger (%)", p("trailingTriggerPct", 1.0), { min: 0.1, max: 50 });
const trailingDropPct = await askNum("Trailing drop (%)", p("trailingDropPct", 0.5), { min: 0.1, max: 50 });
const maxIdleMinutes = await askNum("Max idle minutes", e("maxIdleMinutes", 240), { min: 1, max: 10080 });

console.log("\n-- Signal and session filters ---------------------------------");

const atrPeriod = await askNum("ATR period", e("atrPeriod", 14), { min: 2, max: 200 });
const minAtrMultiplierForEntry = await askNum("Min ATR multiplier for entry", e("minAtrMultiplierForEntry", 0.5), { min: 0.1, max: 10 });
const minRiskReward = await askNum("Min risk-reward", e("minRiskReward", 1.5), { min: 0.5, max: 10 });
const minAdxForTrend = await askNum("Min ADX for trend setups", e("minAdxForTrend", 25), { min: 1, max: 100 });
const maxAdxForRange = await askNum("Max ADX for range setups", e("maxAdxForRange", 20), { min: 1, max: 100 });
const requireSessionConfirm = await askBool("Require active trading window for entries?", e("requireSessionConfirm", true));
const sessionFilterEnabled = await askBool("Enable trading-window filter?", e("sessionFilterEnabled", true));
const maxSpreadPct = await askNum("Max spread (%)", e("maxSpreadPct", 0.25), { min: 0, max: 10 });

console.log("\n-- Cooldown and scheduling ------------------------------------");

const cooldownAfterLossMinutes = await askNum("Cooldown after loss (minutes)", e("cooldownAfterLossMinutes", 30), { min: 0, max: 10080 });
const cooldownAfterTradeMinutes = await askNum("Cooldown after trade close (minutes)", e("cooldownAfterTradeMinutes", 5), { min: 0, max: 10080 });
const maxTradesPerHour = await askNum("Max trades per hour", e("maxTradesPerHour", 3), { min: 1, max: 100 });
const maxTradesPerDay = await askNum("Max trades per day", e("maxTradesPerDay", 10), { min: 1, max: 500 });
const managementIntervalMin = await askNum("Management cycle interval (minutes)", p("managementIntervalMin", 5), { min: 1, max: 1440 });
const analysisIntervalMin = await askNum("Analysis cycle interval (minutes)", p("analysisIntervalMin", 15), { min: 1, max: 1440 });

console.log("\n-- LLM provider -----------------------------------------------");

const providers = [
  { label: "OpenRouter", key: "openrouter", baseUrl: "https://openrouter.ai/api/v1", keyHint: "sk-or-...", modelDefault: DEFAULT_MODEL },
  { label: "OpenAI", key: "openai", baseUrl: "https://api.openai.com/v1", keyHint: "sk-...", modelDefault: "gpt-4o-mini" },
  { label: "Local / OpenAI-compatible", key: "local", baseUrl: "http://localhost:1234/v1", keyHint: "optional", modelDefault: "local-model" },
  { label: "Custom OpenAI-compatible", key: "custom", baseUrl: "", keyHint: "your API key", modelDefault: DEFAULT_MODEL },
];

const providerChoice = await askChoice(
  "Select LLM provider:",
  providers.map((provider) => ({ label: provider.label, key: provider.key }))
);
const provider = providers.find((item) => item.key === providerChoice.key);

let llmBaseUrl = provider.baseUrl;
if (provider.key === "local" || provider.key === "custom") {
  llmBaseUrl = await ask("Base URL", e("llmBaseUrl", provider.baseUrl || "http://localhost:1234/v1"));
}

const llmApiKeyExisting = e("llmApiKey", existingEnv.LLM_API_KEY || existingEnv.OPENROUTER_API_KEY || "");
const llmApiKeyRaw = await ask("API key", llmApiKeyExisting ? "*** (already set)" : provider.keyHint);
const llmApiKey = llmApiKeyRaw.startsWith("***") ? llmApiKeyExisting : llmApiKeyRaw;
const llmModel = await ask("Model name", e("llmModel", process.env.LLM_MODEL || provider.modelDefault));

rl.close();

const isKept = (val) => !val || val.startsWith("***");
const envMap = {
  ...existingEnv,
  ...(isKept(openrouterKey) ? {} : { OPENROUTER_API_KEY: openrouterKey }),
  ...(isKept(telegramToken) ? {} : { TELEGRAM_BOT_TOKEN: telegramToken }),
  ...(telegramChatId ? { TELEGRAM_CHAT_ID: telegramChatId } : {}),
  DRY_RUN: dryRun ? "true" : "false",
};
fs.writeFileSync(ENV_PATH, buildEnv(envMap));

const userConfig = {
  ...existingConfig,
  preset: presetChoice.key,
  exchange,
  symbol,
  baseAsset,
  quoteAsset,
  timeframe,
  atrPeriod,
  minAtrMultiplierForEntry,
  minRiskReward,
  minAdxForTrend,
  maxAdxForRange,
  requireSessionConfirm,
  sessionFilterEnabled,
  maxSpreadPct,
  maxOpenTrades,
  riskPctPerTrade,
  maxDailyLossPct,
  maxDrawdownPct,
  minAccountBalance,
  maxPositionQuantity,
  maxPositionNotional,
  pricePrecision,
  quantityPrecision,
  minQuantity,
  minNotional,
  stopLossPct,
  takeProfitPct,
  trailingStop,
  trailingTriggerPct,
  trailingDropPct,
  maxIdleMinutes,
  cooldownAfterLossMinutes,
  cooldownAfterTradeMinutes,
  maxTradesPerHour,
  maxTradesPerDay,
  managementIntervalMin,
  analysisIntervalMin,
  paperTrading: dryRun,
  paperBalance,
  simulateSlippage: e("simulateSlippage", 0.02),
  feeRatePct,
  llmProvider: provider.key,
  llmBaseUrl,
  llmModel,
  ...(llmApiKey ? { llmApiKey } : {}),
  telegramChatId: telegramChatId || "",
  dryRun,
};

fs.writeFileSync(CONFIG_PATH, JSON.stringify(userConfig, null, 2));

console.log(`
╔═══════════════════════════════════════════════╗
║               Setup Complete                 ║
╚═══════════════════════════════════════════════╝

  Preset:         ${preset ? preset.label : "Custom"}
  Mode:           ${dryRun ? "Paper / dry-run" : "Live mode configuration"}
  Exchange:       ${exchange}
  Symbol:         ${symbol}
  Timeframe:      ${timeframe}
  Max trades:     ${maxOpenTrades} open / ${maxTradesPerDay} per day
  Risk/trade:     ${riskPctPerTrade}%
  Daily stop:     ${maxDailyLossPct}%
  Max position:   ${maxPositionQuantity} ${baseAsset} / ${maxPositionNotional} ${quoteAsset}
  Fee rate:       ${feeRatePct}%
  Cycles:         management every ${managementIntervalMin}m · analysis every ${analysisIntervalMin}m
  Provider:       ${provider.label}
  Model:          ${llmModel}
  Base URL:       ${llmBaseUrl}
  Telegram:       ${telegramToken ? "enabled" : "disabled"}

  .env:           ${ENV_PATH}
  Config:         ${CONFIG_PATH}

Run "npm start" to launch the runtime.
`);
