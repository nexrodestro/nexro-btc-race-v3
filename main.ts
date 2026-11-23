// DIP-BOLL RSI<35 twin — mean-reversion BTC bot for make.fun btc-race-24h-20261123-0511.
// "Race a BTC trading bot live for 24 hours". Pot $50, top 10 paid. Free entry.
//
// Strategy (measured spec, RSI<35 twin of DIP-BOLL): a dip entry needs THREE
// confirmations on the closing bar — RSI(14) < 35, close at least 60 bps below
// EMA-120, and close below the lower Bollinger band (20 bars, 2 population
// sigmas of typical prices (h+l+c)/3). It buys 100% of cash. Exits are fast:
// +50 bps target, back-to-trend (close back at/above EMA-120, dip entries
// only), -100 bps stop, -150 bps trail below the peak since entry, 360-bar max
// hold. 30-bar cooldown after any exit. Bleed brake: after 2 losing exits dip
// entries switch off for the window. No dip entries after bar 1200. Late
// fallback (once, bars 1200-1259, only if zero trades so far): close above
// EMA-120 and EMA-24 above EMA-120. Every order carries max_slippage_bps 100.
// Deterministic: bar data only. No clock, no environment, no randomness.
//
// Measured on three real 24h windows (dev2 +$6.89, dev1 +$2.23, race1 +$4.93;
// median +$4.93, min +$2.23) — the only variant never negative on any window.
// Best window +$6.89 is below the ~$16.90 top-10 cutoff: a robust free ticket,
// not a promised winner.
//
// Grade-local (kit CLI, --driver process, worktree, this repo): net PnL
// +$6.888244 on the kit's 20261118 dev window, 4 trades, win rate 1.0, max
// drawdown 0.36%, fees $1.61, 0 rejected orders. Deterministic: two separate
// runs gave the identical action_log_sha256
// 3dace067ff922c0e236985f61a9d4dca08bbbb6001413073abc766a01ed7a44d.
// NOTE: that is the 20261118 dev window (the dataset in the kit on disk).
// Today's dev window (btc-race-24h-20261123-0511, dataset 4872274b...) was
// NOT gradeable here: its bars ship only in the new kit, which this task
// forbids downloading. The server grades on today's window at submit time;
// the twin's robustness (never negative on 3 real windows) is the case for it.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const EMA_SLOW = 120;
const EMA_FAST = 24;
const RSI_SPAN = 14;
const RSI_ENTRY = 35;
const DIP_BPS = 60;
const TARGET_BPS = 50;
const STOP_BPS = 100;
const TRAIL_BPS = 150;
const MAX_HOLD = 360;
const COOLDOWN = 30;
const BOLL_SPAN = 20;
const BOLL_SIGMAS = 2;
const CUTOFF_BAR = 1200;
const MAX_LOSSES = 2;
const MAX_SLIPPAGE_BPS = 100;

// ---- indicator state, built bar by bar from the closes -------------------
const closes: number[] = [];
const typical: number[] = [];
let emaSlow: number | null = null;
let emaFast: number | null = null;
let rsiGain: number | null = null;
let rsiLoss: number | null = null;
let rsi: number | null = null;
let lowerBand: number | null = null;

function updateIndicators(close: number, high: number, low: number): void {
  closes.push(close);
  typical.push((high + low + close) / 3);
  // EMA-120: seed = mean of the first 120 closes, then k = 2/121.
  if (closes.length === EMA_SLOW) {
    let s = 0;
    for (let j = 0; j < EMA_SLOW; j++) s += closes[j];
    emaSlow = s / EMA_SLOW;
  } else if (closes.length > EMA_SLOW && emaSlow !== null) {
    emaSlow = emaSlow + (2 / (EMA_SLOW + 1)) * (close - emaSlow);
  }
  // EMA-24: same shape, k = 2/25.
  if (closes.length === EMA_FAST) {
    let s = 0;
    for (let j = 0; j < EMA_FAST; j++) s += closes[j];
    emaFast = s / EMA_FAST;
  } else if (closes.length > EMA_FAST && emaFast !== null) {
    emaFast = emaFast + (2 / (EMA_FAST + 1)) * (close - emaFast);
  }
  // Wilder RSI(14): seed = mean of the first 14 changes, then Wilder smoothing.
  if (closes.length === RSI_SPAN + 1) {
    let g = 0;
    let l = 0;
    for (let j = 1; j <= RSI_SPAN; j++) {
      const ch = closes[j] - closes[j - 1];
      g += Math.max(ch, 0);
      l += Math.max(-ch, 0);
    }
    rsiGain = g / RSI_SPAN;
    rsiLoss = l / RSI_SPAN;
    rsi = rsiGain + rsiLoss === 0 ? 50 : (100 * rsiGain) / (rsiGain + rsiLoss);
  } else if (closes.length > RSI_SPAN + 1 && rsiGain !== null && rsiLoss !== null) {
    const ch = closes[closes.length - 1] - closes[closes.length - 2];
    rsiGain = (rsiGain * (RSI_SPAN - 1) + Math.max(ch, 0)) / RSI_SPAN;
    rsiLoss = (rsiLoss * (RSI_SPAN - 1) + Math.max(-ch, 0)) / RSI_SPAN;
    rsi = rsiGain + rsiLoss === 0 ? 50 : (100 * rsiGain) / (rsiGain + rsiLoss);
  }
  // Lower Bollinger band of typical prices: mean - 2 * population sd, 20 bars.
  if (typical.length >= BOLL_SPAN) {
    let m = 0;
    for (let j = typical.length - BOLL_SPAN; j < typical.length; j++) m += typical[j];
    m /= BOLL_SPAN;
    let v = 0;
    for (let j = typical.length - BOLL_SPAN; j < typical.length; j++) {
      v += (typical[j] - m) * (typical[j] - m);
    }
    v /= BOLL_SPAN;
    lowerBand = m - BOLL_SIGMAS * Math.sqrt(v);
  }
}

// ---- position state -------------------------------------------------------
let coolUntil = -1;
let peakClose = 0;
let entryBar = 0;
let entryType: "dip" | "late" = "dip";
let trades = 0;
let losses = 0;
let lateFired = false;

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL) ?? batch.bars[0];
  if (bar === undefined) return [];
  const close = Number(bar.c);
  const high = Number(bar.h);
  const low = Number(bar.l);
  updateIndicators(close, high, low);
  const i = closes.length - 1;
  if (state.warmingUp) return [];
  const pos = state.positions.get(SYMBOL);
  const qty = pos?.qty ?? 0n;
  const cost = pos?.cost ?? 0n;

  if (qty === 0n) {
    // Late fallback first: once, bars 1200-1259, only if zero trades so far.
    // It bypasses the cooldown / cutoff / bleed-brake guard below.
    if (
      trades === 0 &&
      !lateFired &&
      i >= 1200 &&
      i < 1260 &&
      emaSlow !== null &&
      emaFast !== null &&
      close > emaSlow &&
      emaFast > emaSlow
    ) {
      lateFired = true;
      peakClose = close;
      entryBar = i;
      entryType = "late";
      trades += 1;
      return [
        {
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    if (i < coolUntil || i >= CUTOFF_BAR || losses >= MAX_LOSSES) return [];
    if (emaSlow === null || rsi === null || lowerBand === null) return [];
    const dipOk = close * 10000 < emaSlow * (10000 - DIP_BPS);
    const rsiOk = rsi < RSI_ENTRY;
    const bollOk = close < lowerBand;
    if (dipOk && rsiOk && bollOk) {
      peakClose = close;
      entryBar = i;
      entryType = "dip";
      trades += 1;
      return [
        {
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }

  // Holding: track the peak since entry, then test the five exits.
  if (close > peakClose) peakClose = close;
  const value = state.value(SYMBOL, qty);
  const hitTarget = value * 10000n >= cost * BigInt(10000 + TARGET_BPS);
  const backToTrend = entryType === "dip" && emaSlow !== null && close >= emaSlow;
  const hitStop = value * 10000n <= cost * BigInt(10000 - STOP_BPS);
  const hitTrail = close * 10000 <= peakClose * (10000 - TRAIL_BPS);
  const timedOut = i - entryBar >= MAX_HOLD;
  if (hitTarget || backToTrend || hitStop || hitTrail || timedOut) {
    if (value < cost) losses += 1;
    coolUntil = i + COOLDOWN;
    return [
      {
        side: "sell",
        symbol: SYMBOL,
        qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  return [];
}

await runBars({ onBatch });
