/**
 * Thesis-break exit replay (pure).
 *
 * Two arms on the same tape and the same entries:
 *   A "stop-only"      ATR-scaled hard stop + take-profit only.
 *   B "thesis-break"   same, plus `evaluateThesisBreak` running each bar,
 *                      with the decaying loss post-mortem memory tightening
 *                      the stop for symbols that already cost money.
 *
 * The point of the harness is not to find alpha — it is to answer a
 * behavioural question: *when* does the thesis-break layer fire, and does
 * a symbol's realised loss history make it fire sooner? Every firing is
 * tagged with how many losing round-trips that symbol already had, so the
 * caller can split "first loss" from "repeat loser".
 *
 * Pure and I/O-free; the caller supplies the tape.
 */

import { evaluateThesisBreak } from "../exits/thesis-break";
import { buildLossPostmortems, type RoundTrip } from "../alpha/loss-postmortem";
import { evidenceFor, type EvidenceTape } from "./thesis-break-evidence";

export type ReplayBar = { date: string; close: number };
export type ReplayTape = Record<string, ReplayBar[]>;

export type ArmName = "stop-only" | "thesis-break";

export type ReplayTrade = {
  symbol: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  holdDays: number;
  exitReason: string;
  /** Losing round-trips this symbol had already booked before this trade. */
  priorLosses: number;
  /** Did the thesis-break layer close (or trim) this trade? */
  thesisBreak: boolean;
  /** Agreeing evidence streams at the moment of the cut. */
  signals: string[];
  /** Thesis-break actions taken while the position was open, in order. */
  thesisActions: ThesisBreakEvent[];
  /** Fraction of the original size the thesis layer took off before the exit. */
  trimmedFraction: number;
};

/** One thesis-break action: a half trim, or the full close. */
export type ThesisBreakEvent = {
  symbol: string;
  date: string;
  entryDate: string;
  action: "trim" | "close";
  /** Fraction of the *remaining* position sold by this action. */
  sellFraction: number;
  /** Unrealised return at the moment the layer fired. */
  unrealisedPct: number;
  effectiveStopPct: number;
  /** Losing round-trips already booked on this symbol before the trade. */
  priorLosses: number;
  /** Every evidence stream that agreed at that moment. */
  signals: string[];
  reason: string;
};

export type ArmResult = {
  arm: ArmName;
  equity: Array<{ date: string; value: number }>;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  avgLossPct: number;
  trades: ReplayTrade[];
  exitMix: Record<string, number>;
  /** Every thesis-break action, trims included (empty on the stop-only arm). */
  thesisEvents: ThesisBreakEvent[];
  /** How often each evidence stream agreed, across all firings. */
  signalCounts: Record<string, number>;
  /** Trim vs close split of the thesis-break firings. */
  actionMix: { trim: number; close: number };
};

/** Collapse "news hostile (-0.32)" to "news hostile" for tallying. */
export function signalKind(signal: string): string {
  return signal.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

export type ReplayOptions = {
  /** Cash allocated to each symbol sleeve. */
  sleeveCash?: number;
  /** Base hard stop as a fraction (scaled by the memory's tighten mult). */
  stopPct?: number;
  /** Take-profit as a fraction. */
  takeProfitPct?: number;
  /** Round-trip cost applied on entry+exit, as a fraction. */
  costPct?: number;
  /** Enable the thesis-break layer (arm B). */
  thesisBreak: boolean;
  /**
   * Real news / insider / fundamentals evidence. When supplied it replaces the
   * price-derived stand-ins for those three streams (trend and failed breakout
   * stay price facts). When omitted the harness falls back to the proxies.
   */
  evidence?: EvidenceTape | null;
};

const sma = (xs: readonly number[], i: number, n: number): number | null => {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += xs[k]!;
  return s / n;
};

const daysBetween = (a: string, b: string) =>
  Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000));

/** Price-derived stand-ins for the live evidence streams. */
function evidenceAt(closes: readonly number[], i: number, entryIdx: number) {
  const s20 = sma(closes, i, 20);
  const s50 = sma(closes, i, 50);
  const trendBroken = s20 != null && s50 != null && s20 < s50;

  // 10-bar sentiment proxy: recent price drift, squashed to roughly −1..1.
  const back = closes[Math.max(0, i - 10)]!;
  const drift = back > 0 ? (closes[i]! - back) / back : 0;
  const newsMomentum = Math.max(-1, Math.min(1, drift * 5));

  // Failed breakout: cleared the prior 20-bar high after entry, then closed
  // back below it.
  let priorHigh = 0;
  for (let k = Math.max(0, entryIdx - 20); k < entryIdx; k++) priorHigh = Math.max(priorHigh, closes[k]!);
  let cleared = false;
  for (let k = entryIdx; k <= i; k++) if (closes[k]! > priorHigh) cleared = true;
  const breakoutFailed = cleared && priorHigh > 0 && closes[i]! < priorHigh;

  return {
    newsScore: null,
    newsMomentum,
    insiderNudge: null,
    fundamentalsScore: null,
    trendBroken,
    breakoutFailed,
  };
}

export function replayArm(tape: ReplayTape, opts: ReplayOptions): ArmResult {
  const sleeve = opts.sleeveCash ?? 1000;
  const baseStop = opts.stopPct ?? 0.08;
  const tp = opts.takeProfitPct ?? 0.15;
  const cost = opts.costPct ?? 0.004;

  const symbols = Object.keys(tape).sort();
  const dates = [...new Set(symbols.flatMap((s) => tape[s]!.map((b) => b.date)))].sort();
  const idxBySymbol = new Map<string, Map<string, number>>();
  for (const s of symbols) {
    const m = new Map<string, number>();
    tape[s]!.forEach((b, i) => m.set(b.date, i));
    idxBySymbol.set(s, m);
  }

  const trades: ReplayTrade[] = [];
  const cash: Record<string, number> = Object.fromEntries(symbols.map((s) => [s, sleeve]));
  const open: Record<
    string,
    {
      entryIdx: number;
      entryDate: string;
      entryPrice: number;
      qty: number;
      /** Size at entry, so trims can be expressed as a fraction of it. */
      qty0: number;
      actions: ThesisBreakEvent[];
    } | null
  > = Object.fromEntries(symbols.map((s) => [s, null]));
  const thesisEvents: ThesisBreakEvent[] = [];
  const equity: Array<{ date: string; value: number }> = [];

  for (const date of dates) {
    // Memory is rebuilt from trades closed strictly before today — no look-ahead.
    const closed: RoundTrip[] = trades
      .filter((t) => t.exitDate < date)
      .map((t) => ({
        symbol: t.symbol,
        exitDate: t.exitDate,
        returnPct: t.returnPct,
        holdDays: t.holdDays,
        exitReason: t.exitReason,
        costPct: cost * 2,
      }));
    const memory = buildLossPostmortems(closed, date);

    for (const sym of symbols) {
      const bars = tape[sym]!;
      const i = idxBySymbol.get(sym)!.get(date);
      if (i == null) continue;
      const closes = bars.map((b) => b.close);
      const price = closes[i]!;
      const pos = open[sym];
      const mem = memory.get(sym.toUpperCase());
      const stop = baseStop * (opts.thesisBreak ? (mem?.stopTightenMult ?? 1) : 1);

      if (pos) {
        const unrealised = (price - pos.entryPrice) / pos.entryPrice;
        let reason: string | null = null;
        let signals: string[] = [];
        let viaThesis = false;

        if (unrealised <= -stop) reason = "stop-loss triggered";
        else if (unrealised >= tp) reason = "take-profit";
        else if (opts.thesisBreak) {
          const priced = evidenceAt(closes, i, pos.entryIdx);
          const ext = opts.evidence ? evidenceFor(opts.evidence, sym, date) : null;
          const tb = evaluateThesisBreak({
            unrealisedPct: unrealised,
            effectiveStopPct: stop,
            evidence: ext
              ? {
                  newsScore: ext.newsScore,
                  newsMomentum: ext.newsMomentum,
                  insiderNudge: ext.insiderNudge,
                  fundamentalsScore: ext.fundamentalsScore,
                  trendBroken: priced.trendBroken,
                  breakoutFailed: priced.breakoutFailed,
                }
              : priced,
          });
          if (tb.fire) {
            const priorLosses = trades.filter((t) => t.symbol === sym && t.returnPct < 0).length;
            const full = tb.sellFraction >= 1;
            // One trim per position: a half trim is a warning shot, not a
            // ratchet that bleeds the sleeve out a slice at a time.
            const alreadyTrimmed = pos.actions.some((a) => a.action === "trim");
            if (full || !alreadyTrimmed) {
              const event: ThesisBreakEvent = {
                symbol: sym,
                date,
                entryDate: pos.entryDate,
                action: full ? "close" : "trim",
                sellFraction: full ? 1 : tb.sellFraction,
                unrealisedPct: unrealised,
                effectiveStopPct: stop,
                priorLosses,
                signals: tb.signals,
                reason: tb.reason ?? "thesis break",
              };
              pos.actions.push(event);
              thesisEvents.push(event);

              if (full) {
                reason = tb.reason ?? "thesis break";
                signals = tb.signals;
                viaThesis = true;
              } else {
                // Half trim: bank the slice, keep the rest of the position.
                const sellQty = pos.qty * tb.sellFraction;
                cash[sym] = cash[sym]! + sellQty * price * (1 - cost);
                pos.qty -= sellQty;
              }
            }
          }
        }

        if (reason) {
          const gross = pos.qty * price;
          cash[sym] = gross * (1 - cost);
          const priorLosses = trades.filter((t) => t.symbol === sym && t.returnPct < 0).length;
          trades.push({
            symbol: sym,
            entryDate: pos.entryDate,
            exitDate: date,
            entryPrice: pos.entryPrice,
            exitPrice: price,
            returnPct: unrealised - cost * 2,
            holdDays: daysBetween(pos.entryDate, date),
            exitReason: reason,
            priorLosses,
            thesisBreak: viaThesis,
            signals,
            thesisActions: pos.actions,
            trimmedFraction:
              pos.qty0 > 0 ? Math.max(0, Math.min(1, 1 - pos.qty / pos.qty0)) : 0,
          });
          open[sym] = null;
        }
      } else {
        // Entry: SMA20 crosses above SMA50.
        const s20 = sma(closes, i, 20);
        const s50 = sma(closes, i, 50);
        const p20 = sma(closes, i - 1, 20);
        const p50 = sma(closes, i - 1, 50);
        if (s20 != null && s50 != null && p20 != null && p50 != null && p20 <= p50 && s20 > s50) {
          const spend = cash[sym]! * (1 - cost);
          if (spend > 0 && price > 0) {
            open[sym] = {
              entryIdx: i,
              entryDate: date,
              entryPrice: price,
              qty: spend / price,
              qty0: spend / price,
              actions: [],
            };
            cash[sym] = 0;
          }
        }
      }
    }

    let total = 0;
    for (const sym of symbols) {
      const i = idxBySymbol.get(sym)!.get(date);
      const pos = open[sym];
      const px = i != null ? tape[sym]![i]!.close : undefined;
      total += cash[sym]! + (pos && px != null ? pos.qty * px : pos ? pos.qty * pos.entryPrice : 0);
    }
    equity.push({ date, value: total });
  }

  const start = equity[0]?.value ?? 1;
  const end = equity[equity.length - 1]?.value ?? start;
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.value);
    maxDd = Math.max(maxDd, (peak - p.value) / peak);
  }
  const wins = trades.filter((t) => t.returnPct > 0).length;
  const losses = trades.filter((t) => t.returnPct < 0);
  const exitMix: Record<string, number> = {};
  for (const t of trades) {
    const k = t.thesisBreak ? "thesis-break" : t.exitReason.split("(")[0]!.trim();
    exitMix[k] = (exitMix[k] ?? 0) + 1;
  }
  const signalCounts: Record<string, number> = {};
  const actionMix = { trim: 0, close: 0 };
  for (const e of thesisEvents) {
    actionMix[e.action] += 1;
    for (const s of e.signals) {
      const k = signalKind(s);
      signalCounts[k] = (signalCounts[k] ?? 0) + 1;
    }
  }

  return {
    arm: opts.thesisBreak ? "thesis-break" : "stop-only",
    equity,
    totalReturnPct: ((end - start) / start) * 100,
    maxDrawdownPct: maxDd * 100,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    avgLossPct: losses.length ? (losses.reduce((a, b) => a + b.returnPct, 0) / losses.length) * 100 : 0,
    trades,
    exitMix,
  };
}

export type FiringSplit = {
  /** Fires where the symbol had no prior losing round-trip. */
  firstLoss: number;
  /** Fires where the symbol had already booked at least one loss. */
  repeatLoser: number;
  /** Losing trades (any exit) with no prior loss on that symbol. */
  firstLossOpportunities: number;
  /** Losing trades (any exit) where the symbol had prior losses. */
  repeatOpportunities: number;
  firstLossFireRatePct: number;
  repeatFireRatePct: number;
};

/** Split thesis-break firings by whether the symbol was already a loser. */
export function splitFiringsByHistory(trades: readonly ReplayTrade[]): FiringSplit {
  const fires = trades.filter((t) => t.thesisBreak);
  const losers = trades.filter((t) => t.returnPct < 0);
  const firstLoss = fires.filter((t) => t.priorLosses === 0).length;
  const repeatLoser = fires.length - firstLoss;
  const firstOpp = losers.filter((t) => t.priorLosses === 0).length;
  const repeatOpp = losers.length - firstOpp;
  return {
    firstLoss,
    repeatLoser,
    firstLossOpportunities: firstOpp,
    repeatOpportunities: repeatOpp,
    firstLossFireRatePct: firstOpp ? (firstLoss / firstOpp) * 100 : 0,
    repeatFireRatePct: repeatOpp ? (repeatLoser / repeatOpp) * 100 : 0,
  };
}

export function runThesisBreakReplay(tape: ReplayTape, opts?: Omit<ReplayOptions, "thesisBreak">) {
  const base = replayArm(tape, { ...opts, thesisBreak: false });
  const tb = replayArm(tape, { ...opts, thesisBreak: true });
  return { base, tb, firing: splitFiringsByHistory(tb.trades) };
}
