import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";

// ─── Role-gated tool sets ──────────────────────────────────────────────────────
// Tools available to each agent role. Only current XAU/USD tool names belong here.

const MANAGER_TOOLS = new Set([
  "close_trade",
  "get_open_trades",
  "get_account_balance",
  "get_market_data",
  "set_trade_instruction",
  "get_session_info",
  "check_cooldown",
  "update_config",
  "get_performance_history",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "list_lessons",
  "clear_lessons",
  "add_strategy",
  "list_strategies",
  "get_strategy",
  "set_active_strategy",
]);

const ANALYST_TOOLS = new Set([
  "open_trade",
  "get_open_trades",
  "get_account_balance",
  "get_market_data",
  "get_atr",
  "get_session_info",
  "check_cooldown",
  "update_config",
  "get_performance_history",
  "add_lesson",
  "list_lessons",
  "add_strategy",
  "list_strategies",
  "get_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  trade:       new Set(["open_trade", "get_open_trades", "get_account_balance", "get_market_data", "get_atr", "get_session_info", "check_cooldown"]),
  close:       new Set(["close_trade", "get_open_trades", "get_account_balance", "set_trade_instruction"]),
  analyze:     new Set(["get_market_data", "get_atr", "get_session_info", "check_cooldown", "get_open_trades"]),
  balance:     new Set(["get_account_balance", "get_open_trades"]),
  positions:   new Set(["get_open_trades", "get_account_balance", "set_trade_instruction"]),
  session:     new Set(["get_session_info", "check_cooldown", "get_market_data"]),
  config:      new Set(["update_config"]),
  selfupdate:  new Set(["self_update"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "remove_strategy", "set_active_strategy"]),
  performance: new Set(["get_performance_history", "get_open_trades", "get_account_balance"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "trade",       re: /\b(open|buy|long|short|enter|place.*trade|new.*trade|trade now)\b/i },
  { intent: "close",       re: /\b(close|exit|sell|shut|end.*trade|close.*trade)\b/i },
  { intent: "analyze",     re: /\b(analyz|analys|screen|setup|signal|market|price|atr|adx|ema|trend|scan|look for|find.*trade)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|set |change|update config)\b/i },
  { intent: "balance",     re: /\b(balance|account|how much|funds|equity)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open trade|pnl|profit|loss|trade status)\b/i },
  { intent: "session",     re: /\b(session|london|new york|ny open|cooldown|trading hours|blocked)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

/**
 * Get the filtered tool list for a given role.
 * Falls back to all tools when the filtered set is empty.
 */
function getToolsForRole(agentType, goal = "") {
  const role = agentType;

  if (role === "MANAGER") {
    const filtered = tools.filter(t => MANAGER_TOOLS.has(t.function.name));
    return filtered.length > 0 ? filtered : tools;
  }
  if (role === "ANALYST") {
    const filtered = tools.filter(t => ANALYST_TOOLS.has(t.function.name));
    return filtered.length > 0 ? filtered : tools;
  }

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  if (matched.size === 0) return tools;
  const filtered = tools.filter(t => matched.has(t.function.name));
  return filtered.length > 0 ? filtered : tools;
}

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "no-key-configured",
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";

const TOOL_REQUIRED_INTENTS = /\b(open|buy|long|short|close|exit|sell|trade|analyze|screen|setup|signal|self.?update|pull latest|git pull|update yourself|config|setting|threshold|set |change|balance|account|position|portfolio|pnl|profit|loss|session|performance|history|stats|report|lesson|learned|teach|pin|unpin)\b/i;

function shouldRequireRealToolUse(goal, agentType, requireTool) {
  if (requireTool) return true;
  if (agentType === "MANAGER") return false;
  return TOOL_REQUIRED_INTENTS.test(goal);
}

/**
 * Core ReAct agent loop.
 *
 * @param {string}   goal           - The task description for the agent
 * @param {number}   maxSteps       - Safety limit on iterations (default from config)
 * @param {Array}    sessionHistory - Prior conversation turns to inject
 * @param {string}   agentType      - "MANAGER" | "ANALYST" | "GENERAL"
 * @param {string}   model          - Override model (null = DEFAULT_MODEL)
 * @param {number}   maxOutputTokens - Override max_tokens (null = config default)
 * @param {Object}   options        - { requireTool: boolean }
 * @returns {{ content: string, userMessage: string }}
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { requireTool = false } = options;

  // Build dynamic system prompt.
  // External portfolio/position snapshots remain null until the broker adapter exists.
  // prompt.js receives null here and falls back to local runtime state.
  const portfolio = null;  // Phase 3: replace with broker account balance call
  const positions = null;  // Phase 3: replace with broker open positions call

  const stateSummary = getStateSummary();
  const lessons      = getLessonsForPrompt({ agentType });
  const perfSummary  = getPerformanceSummary();
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary);

  const messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];

  // Track write tools fired this session — prevent duplicate destructive calls
  // (e.g. open_trade twice, close_trade twice on the same ID)
  const ONCE_PER_SESSION = new Set(["open_trade", "close_trade"]);
  // These lock after first attempt regardless of success — retrying is never right
  const NO_RETRY_TOOLS   = new Set(["open_trade"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, requireTool);
  let sawToolCall = false;
  let noToolRetryCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;
      const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";
      let response;
      let usedModel = activeModel;

      // Force a tool call on step 0 for action intents — prevents hallucinated outcomes
      const ACTION_INTENTS = /\b(open|buy|long|short|close|exit|sell|trade)\b/i;
      const toolChoice = (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";

      // Retry up to 3 times on transient provider errors
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await client.chat.completions.create({
          model: usedModel,
          messages,
          tools: getToolsForRole(agentType, goal),
          tool_choice: toolChoice,
          temperature: config.llm.temperature,
          max_tokens: maxOutputTokens ?? config.llm.maxTokens,
        });
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise(r => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }

      const msg = response.choices[0].message;

      // Repair malformed tool call JSON before pushing to history —
      // the API rejects the next request if history contains invalid JSON args
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // No tool calls → final answer
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Some models return null content on first attempt — pop and retry
        if (!msg.content) {
          messages.pop();
          log("agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: "system",
            content: "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            functionArgs = {};
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              blocked: true,
              reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.`,
            }),
          };
        }

        const result = await executeTool(functionName, functionArgs);

        // open_trade: lock after first attempt regardless of outcome
        // close_trade: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
