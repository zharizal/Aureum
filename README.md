# Aureum

**Autonomous XAUT/USDT spot trading agent powered by LLMs.**

Aureum runs continuous analysis and management cycles around the current Tokocrypto-oriented XAUT/USDT runtime, tracks open and closed trades locally, and learns from recorded trade outcomes.

---

## What it does

- **Analyzes setup context** — reviews trading-window timing, cooldown, open-trade load, and current runtime constraints before looking for new trades
- **Manages open trades** — tracks open trades, operator instructions, trailing state, and close reasons in local runtime state
- **Learns from performance** — records trade outcomes, produces recent performance summaries, and evolves supported signal thresholds
- **Publishes operator briefings** — generates a current XAUT/USDT summary with venue, risk, open-trade, and recent-trade context
- **Supports operator control** — exposes a compact CLI for status, open trades, recent trades, risk, config, lessons, and performance

---

## Current runtime scope

The current repo is aligned around an XAUT/USDT spot-trading runtime for Tokocrypto-style execution.

Important constraints:
- live exchange/account integration is not fully implemented yet
- paper/dry-run mode is the default safe operating path
- market-data and ATR tool surfaces still contain explicit stub paths in some areas
- the active operator surface is the current CLI, prompt/runtime flow, and briefing/performance system

---

## Requirements

- Node.js 18+
- an OpenAI-compatible or OpenRouter-compatible LLM API key
- Telegram bot token (optional)
- Claude Code CLI (optional)

Do not expect Solana, DLMM, pool, token, or forex lot/pip setup in the current runtime.

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/zharizal/Aureum
cd aureum
npm install
```

### 2. Configure environment

Create `.env` with the runtime values you actually use:

```env
OPENROUTER_API_KEY=sk-or-...
LLM_BASE_URL=
LLM_MODEL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DRY_RUN=true
```

> Keep secrets in `.env`, not `user-config.json`.

### 3. Optional runtime config

If you want to override defaults, create `user-config.json` from the example file:

```bash
cp user-config.example.json user-config.json
```

The current config shape centers on:
- instrument
- market
- session
- signal
- risk
- management
- cooldown
- schedule
- llm
- paper

### 4. Run

```bash
npm run dev
npm start
```

- `npm run dev` runs the runtime in dry-run/paper mode
- `npm start` starts the current agent entrypoint

---

## Running modes

### Autonomous agent

```bash
npm start
```

Starts the current autonomous runtime with analysis + management cycles and an interactive REPL.

### Claude Code terminal

```bash
cd aureum
claude
```

Claude Code can use the current CLI/operator surface for status, open-trade review, risk review, and cycle control.

---

## CLI

The `aureum` CLI is the current operator-facing entrypoint.

```bash
node cli.js help
```

### Current commands

```bash
node cli.js status
node cli.js open-trades
node cli.js recent-trades --limit 10
node cli.js risk
node cli.js briefing
node cli.js analyze
node cli.js manage
node cli.js start
node cli.js config get
node cli.js config set <key> <value>
node cli.js lessons
node cli.js lessons add "your lesson text"
node cli.js performance --limit 20
node cli.js evolve
```

### What these commands cover

- **status** — current runtime summary
- **open-trades** — tracked open trades from local state
- **recent-trades** — recent closed trade history
- **risk** — current risk + cooldown context
- **briefing** — full operator briefing
- **analyze / manage** — one-shot cycle execution
- **config** — inspect/update supported runtime keys
- **lessons / performance / evolve** — learning and performance surfaces

---

## Claude Code command/docs note

Some `.claude/*` files were retained but rewritten to match the current XAUT/USDT operator surface. They should now be read as operator helpers around the current CLI/runtime, not as Solana/DLMM deploy tooling.

---

## Current architecture

```text
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop: LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env
prompt.js           System prompt builder (ANALYST / MANAGER / GENERAL roles)
state.js            Trade registry (state.json)
lessons.js          Learning engine: records performance, derives lessons, evolves thresholds
briefing.js         Operator briefing
strategy-library.js Strategy storage
telegram.js         Telegram bot integration
logger.js           Logging + action trail
cli.js              Operator CLI

tools/
  definitions.js    Tool schemas
  executor.js       Tool dispatch + safety checks
```

---

## Remaining migration gaps

The active runtime and operator surface are now XAUT/USDT-aligned.
Small non-blocking cleanup may still remain in historical migration notes or future exchange-integration work, but the retired Solana/DLMM and forex lot/pip framing has been removed from the active framework.

---

## Disclaimer

This software is provided as-is, with no warranty. Autonomous trading carries real financial risk. Start in dry-run/paper mode, verify the runtime behavior, and do not assume live Tokocrypto execution beyond what the current code explicitly implements.
