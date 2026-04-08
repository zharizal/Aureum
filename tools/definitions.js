export const tools = [
  {
    type: "function",
    function: {
      name: "open_trade",
      description: `Open a new trade on the configured instrument.

Use this only when a concrete setup is present and you have explicit entry, sizing, and stop-loss values.
Runtime decides whether this becomes a paper trade or a live order based on configuration.
Keep arguments explicit and exchange-agnostic.`,
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Instrument symbol. Defaults to the configured instrument when omitted, typically XAUT/USDT."
          },
          direction: {
            type: "string",
            enum: ["long", "short"],
            description: "Trade direction."
          },
          entry_price: {
            type: "number",
            description: "Planned or current entry price."
          },
          quantity: {
            type: "number",
            description: "Trade size in base-asset quantity. Must respect risk limits."
          },
          stop_loss: {
            type: "number",
            description: "Stop-loss price. Required for every trade."
          },
          take_profit: {
            type: "number",
            description: "Optional take-profit price."
          },
          setup_type: {
            type: "string",
            description: "Optional setup label such as breakout, pullback, or range."
          },
          session: {
            type: "string",
            description: "Optional session label such as Asia, Europe, or US Overlap."
          },
          atr_at_entry: {
            type: "number",
            description: "Optional ATR value captured at entry time."
          },
          risk_reward: {
            type: "number",
            description: "Optional expected risk-reward ratio for the setup."
          },
          signal_snapshot: {
            type: "object",
            description: "Optional raw signal context captured at entry time for later review and learning."
          }
        },
        required: ["direction", "entry_price", "quantity", "stop_loss"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "close_trade",
      description: `Close an existing open trade by trade ID.

Use this when a stop, target, trailing rule, idle rule, or explicit operator instruction requires exit.
Provide the actual exit price when available. In paper mode, a fallback exit price may be used if live pricing is unavailable.`,
      parameters: {
        type: "object",
        properties: {
          trade_id: {
            type: "string",
            description: "Tracked trade ID to close."
          },
          exit_price: {
            type: "number",
            description: "Exit price for the close action."
          },
          reason: {
            type: "string",
            description: "Optional reason for the close, e.g. stop_loss, take_profit, trailing_stop, idle_exit, or agent_decision."
          }
        },
        required: ["trade_id", "exit_price"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_open_trades",
      description: `List all currently open tracked trades.
Returns local trade state including entry, stop, target, timing, quantity, notional, and latest tracked PnL fields.
Use at the start of management, status, and portfolio review flows.`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_account_balance",
      description: `Get current account balance context.
In paper mode this returns simulated balance information derived from initial balance and recorded PnL.
Use before opening trades or when the user asks about account status.`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_market_data",
      description: `Get market data context for the configured instrument or a provided symbol.
Returns current price, bid, ask, spread, and synthetic candles in paper mode; falls back to paper data if live adapter is unavailable.
Use it for setup analysis, price context, exit pricing, and session-aware trade decisions.`,
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Instrument symbol. Defaults to the configured instrument when omitted."
          },
          timeframe: {
            type: "string",
            description: "Optional timeframe override for the request, e.g. 5m, 15m, 1h."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_atr",
      description: `Get ATR (Average True Range) for the configured instrument or a provided symbol.
In paper mode, ATR is computed from synthetic candle data. Use it to assess volatility, stop distance context, and setup quality.`,
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Instrument symbol. Defaults to the configured instrument when omitted."
          },
          period: {
            type: "number",
            description: "Optional ATR lookback period override."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_session_info",
      description: `Get the current configured trading-window context.
Returns UTC-hour and active configured windows so the agent can decide whether new entries are allowed.`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_cooldown",
      description: `Check whether trading is currently blocked by cooldown rules.
Use this before considering any new entry and when the user asks whether the bot is currently blocked.`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_trade_instruction",
      description: `Save a persistent instruction for a tracked trade.
Use this when the operator gives trade-specific guidance that future management cycles must respect.
Pass an empty string to clear an existing instruction.`,
      parameters: {
        type: "object",
        properties: {
          trade_id: {
            type: "string",
            description: "Tracked trade ID to attach the instruction to."
          },
          instruction: {
            type: "string",
            description: "Instruction text to persist for future management cycles. Use an empty string to clear it."
          }
        },
        required: ["trade_id", "instruction"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_config",
      description: `Update supported runtime configuration values.
Changes persist to user-config.json and apply immediately.

Supported keys:
Instrument: exchange, symbol, baseAsset, quoteAsset, pricePrecision, quantityPrecision, minQuantity, minNotional
Market: timeframe, atrPeriod, emaFastPeriod, emaSlowPeriod, adxPeriod, adxTrendMin, maxSpreadPct, stalePriceMaxMs
Session: sessionFilterEnabled, newsBlackoutMinutesBefore, newsBlackoutMinutesAfter, fridayCloseHourUtc
Signal: minAtrMultiplierForEntry, minRiskReward, minAdxForTrend, maxAdxForRange, requireSessionConfirm
Risk: maxOpenTrades, riskPctPerTrade, maxDailyLossPct, maxDrawdownPct, minAccountBalance, maxPositionQuantity, maxPositionNotional
Management: defaultSlAtr, defaultTpAtr, stopLossPct, takeProfitPct, trailingStop, trailingTriggerPct, trailingDropPct, maxIdleMinutes
Cooldown: cooldownAfterLossMinutes, cooldownAfterTradeMinutes, maxTradesPerHour, maxTradesPerDay
Schedule: managementIntervalMin, analysisIntervalMin
Paper: paperTrading, paperBalance, simulateSlippage, feeRatePct
LLM: managementModel, analysisModel, generalModel, temperature, maxTokens, maxSteps

Reason is optional but useful for audit and lesson tracking.`,
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "object",
            description: "Key-value pairs of supported config settings to update."
          },
          reason: {
            type: "string",
            description: "Optional reason for the change."
          }
        },
        required: ["changes"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "self_update",
      description: `Pull the latest code from git and restart the agent.
Use when the user explicitly asks to update the bot or pull the latest changes.`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_lesson",
      description: `Save a lesson to persistent memory.
Use for concrete, reusable rules that should influence future analysis or management decisions.
Role can target the lesson to ANALYST, MANAGER, or GENERAL flows.`,
      parameters: {
        type: "object",
        properties: {
          rule: { type: "string", description: "Specific actionable lesson to save." },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags for filtering and organization." },
          role: { type: "string", enum: ["ANALYST", "MANAGER", "GENERAL"], description: "Optional role this lesson applies to. Omit to make it available broadly." },
          pinned: { type: "boolean", description: "Pin this lesson so it is always injected regardless of normal limits." }
        },
        required: ["rule"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_lessons",
      description: `List saved lessons with optional filtering.
Use to inspect current memory, find IDs, or audit what the agent has learned.`,
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["ANALYST", "MANAGER", "GENERAL"], description: "Optional role filter." },
          pinned: { type: "boolean", description: "Optional pinned/unpinned filter." },
          tag: { type: "string", description: "Optional tag filter." },
          limit: { type: "number", description: "Maximum number of lessons to return." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "pin_lesson",
      description: `Pin a lesson by ID so it is always injected into future prompts.`,
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "Lesson ID from list_lessons." } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "unpin_lesson",
      description: `Unpin a previously pinned lesson by ID.`,
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "Lesson ID from list_lessons." } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "clear_lessons",
      description: `Remove lessons or performance records from memory.
Modes:
- keyword: remove lessons whose text matches a keyword
- all: remove all lessons
- performance: clear stored performance records`,
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["keyword", "all", "performance"], description: "What to clear." },
          keyword: { type: "string", description: "Required when mode=keyword." }
        },
        required: ["mode"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_performance_history",
      description: `Retrieve closed-trade performance history over a recent time window.
Use for reporting, reviews, and self-assessment.`,
      parameters: {
        type: "object",
        properties: {
          hours: { type: "number", description: "How many hours back to look." },
          limit: { type: "number", description: "Maximum number of records to return." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_strategy",
      description: `Save a named strategy profile to the strategy library.
Use when the user provides a reusable strategy definition that should be stored for future analysis cycles.`,
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Short strategy ID or slug." },
          name: { type: "string", description: "Human-readable strategy name." },
          author: { type: "string", description: "Optional strategy author or source." },
          lp_strategy: { type: "string", enum: ["bid_ask", "spot", "curve"], description: "Legacy strategy-library field kept for compatibility with the current strategy storage layer." },
          token_criteria: { type: "object", description: "Optional strategy-library compatibility payload." },
          entry: { type: "object", description: "Optional entry criteria payload." },
          range: { type: "object", description: "Optional range/config payload retained for current strategy-library compatibility." },
          exit: { type: "object", description: "Optional exit criteria payload." },
          best_for: { type: "string", description: "Optional summary of ideal conditions for this strategy." },
          raw: { type: "string", description: "Optional original text or source material." }
        },
        required: ["id", "name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_strategies",
      description: `List all saved strategies and identify the active one.`,
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_strategy",
      description: `Get full details of a saved strategy by ID.`,
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Strategy ID from list_strategies." } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_active_strategy",
      description: `Set which saved strategy should be considered active for future analysis cycles.`,
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Strategy ID to activate." } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remove_strategy",
      description: `Remove a strategy from the strategy library.`,
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Strategy ID to remove." } },
        required: ["id"]
      }
    }
  }
];
