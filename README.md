# nexro-btc-race-v3 — DIP-BOLL RSI<35 twin

BTC trading bot for make.fun competition **btc-race-24h-20261123-0511**
("Race a BTC trading bot live for 24 hours"). Pot $50, top 10 paid. Free entry.

## Strategy

Mean-reversion dip bot (DIP-BOLL family). A dip entry needs three
confirmations on the closing bar: RSI(14) < 35, close at least 60 bps below
EMA-120, and close below the lower Bollinger band (20 bars, 2 population
sigmas of typical prices). It buys 100% of cash. Fast exits: +50 bps target,
back-to-trend (close back at/above EMA-120, dip entries only), -100 bps stop,
-150 bps trail below the peak since entry, 360-bar max hold. 30-bar cooldown
after an exit. Bleed brake: after 2 losing exits dip entries switch off. No
dip entries after bar 1200. Late fallback (once, bars 1200-1259, only if zero
trades so far): close above EMA-120 and EMA-24 above EMA-120.

## Measured

The RSI<35 twin is the only DIP-BOLL variant never negative on any real 24h
window: dev2 +$6.89, dev1 +$2.23, race1 +$4.93 (median +$4.93, min +$2.23).
Best window +$6.89 is below the ~$16.90 top-10 cutoff — a robust free ticket,
not a promised winner.

Grade-local on the kit's 20261118 dev window: net PnL +$6.888244, 4 trades,
win rate 1.0, max drawdown 0.36%, fees $1.61, 0 rejected. Deterministic
(identical action_log_sha256 across two runs). Today's dev window was not
gradeable here (its dataset ships only in the new kit); the server grades on
it at submit time.

## Files

- `main.ts` — the bot (Node 22, `agent-fun/bars-replay/v1`).
- `vendor/makefun-bars.ts` — byte-identical kit SDK shim.
- `LICENSE` — MIT (SPDX-License-Identifier: MIT).
