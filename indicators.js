/**
 * indicators.js
 * Pure indicator computation from OHLCV candle arrays.
 * All functions return null on insufficient data (fail soft).
 */

function r(value, dp = 4) {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/**
 * EMA — exponential moving average of closes.
 * Returns last EMA value or null if not enough data.
 */
export function computeEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return r(ema, 4);
}

/**
 * RSI — Wilder's smoothed RSI.
 * Returns last RSI value or null if not enough data.
 */
export function computeRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d >= 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return r(100 - 100 / (1 + avgGain / avgLoss), 2);
}

/**
 * ATR — Average True Range.
 * Returns last ATR value or null if not enough data.
 */
export function computeATR(candles, period = 14) {
  if (!candles || candles.length < 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prev = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  const slice = trs.slice(-Math.min(period, trs.length));
  return r(slice.reduce((s, v) => s + v, 0) / slice.length, 4);
}

/**
 * 20-candle high and low.
 */
export function compute20Range(candles) {
  const last = (candles ?? []).slice(-20);
  if (last.length === 0) return { high20: null, low20: null };
  return {
    high20: r(Math.max(...last.map(c => c.high)), 4),
    low20:  r(Math.min(...last.map(c => c.low)),  4),
  };
}

/**
 * Volume spike — returns the ratio (e.g. 2.1) if last candle is >1.5× the prior average.
 * Returns null if volume data is missing or no spike.
 */
export function detectVolumeSpike(candles) {
  const last = (candles ?? []).slice(-20);
  if (last.length < 2 || last[0].volume == null) return null;
  const vols = last.map(c => Number(c.volume)).filter(v => Number.isFinite(v) && v > 0);
  if (vols.length < 2) return null;
  const avg = vols.slice(0, -1).reduce((s, v) => s + v, 0) / (vols.length - 1);
  if (avg <= 0) return null;
  const ratio = vols[vols.length - 1] / avg;
  return ratio > 1.5 ? r(ratio, 2) : null;
}

/**
 * Compute all indicators from a candles array.
 * Missing values are null (fail soft).
 */
export function computeAllIndicators(candles) {
  if (!candles || candles.length === 0) {
    return { ema20: null, ema50: null, ema200: null, rsi14: null, atr14: null, high20: null, low20: null, volumeSpike: null };
  }
  const closes = candles.map(c => c.close);
  const { high20, low20 } = compute20Range(candles);
  return {
    ema20:       computeEMA(closes, 20),
    ema50:       computeEMA(closes, 50),
    ema200:      computeEMA(closes, 200),
    rsi14:       computeRSI(closes, 14),
    atr14:       computeATR(candles, 14),
    high20,
    low20,
    volumeSpike: detectVolumeSpike(candles),
  };
}
