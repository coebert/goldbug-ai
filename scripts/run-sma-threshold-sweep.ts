// Grid sweep of the configurable SMA crossover parameters, scored
// out-of-sample on rolling walk-forward test windows.
//
//   bun run scripts/run-sma-threshold-sweep.ts
//   bun run scripts/run-sma-threshold-sweep.ts --from 2005-01-01 --test 126
//
// Swept axes (these map 1:1 onto SmaCrossRuleConfig):
//   fastSeparationPct    |SMA20-SMA50|/SMA50 needed for a fast cross to count
//   regimeSeparationPct  |SMA50-SMA200|/SMA200 needed for the regime filter
//                        (`off` = no SMA200 gate at all)
//   confirmBars          bars the new ordering must persist before acting
//   maxCrossAgeBars      how stale a cross may be and still open a position
//
// Every combination is replayed over the SAME rolling test windows used by
// run-sma-variant-walk-forward.ts, net of live cost-governor frictions. The
// ranking prefers *robust* settings: a combo is scored on its own results and
// on its immediate grid neighbours, so a lucky isolated spike cannot win.

import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { buildRealTape, type PriceMode } from "../src/lib/real-market-tape";
import type { BacktestBar } from "../src/lib/backtest-runner";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "JPM", "XOM", "JNJ", "KO", "PG", "SPY", "GLD"];

const from = arg("from", "2005-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const priceMode = arg("price-mode", "total_return") as PriceMode;
const symbols = arg("symbols", DEFAULT_SYMBOLS.join(",")).split(",").map((s) => s.trim());
const startingCash = Number(arg("cash", "10300"));
const testDays = Number(arg("test", "126"));
const maxPositions = Number(arg("max-positions", "5"));
const commissionBps = Number(arg("commission-bps", "8"));
const commissionMin = Number(arg("commission-min", "3"));
const slippageBps = Number(arg("slippage-bps", "5"));
const topN = Number(arg("top", "12"));

// ------------------------------------------------------------------ grid

const FAST_SEP = [0, 0.002, 0.005, 0.01];
/** null = SMA200 regime filter disabled. */
const REGIME_SEP: Array<number | null> = [null, 0, 0.005, 0.01];
const CONFIRM = [1, 2, 3, 5];
/** Infinity = "regime state" mode — hold while the ordering is bullish. */
const MAX_AGE = [3, 5, 10, 20, Infinity];

type Combo = {
  fastSep: number;
  regimeSep: number | null;
  confirm: number;
  maxAge: number;
};

const combos: Combo[] = [];
for (const fastSep of FAST_SEP)
  for (const regimeSep of REGIME_SEP)
    for (const confirm of CONFIRM)
      for (const maxAge of MAX_AGE) combos.push({ fastSep, regimeSep, confirm, maxAge });

const key = (c: Combo) =>
  `${c.fastSep}|${c.regimeSep === null ? "off" : c.regimeSep}|${c.confirm}|${c.maxAge}`;

// ------------------------------------------------------------- indicators

function smaSeries(closes: readonly number[], window: number): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!;
    if (i >= window) sum -= closes[i - window]!;
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

type SymbolIndicators = {
  closes: number[];
  s20: Array<number | null>;
  s50: Array<number | null>;
  s200: Array<number | null>;
};

/** Ordering at bar i for a given separation band: 1 bull, -1 bear, 0 neutral. */
function ordering(a: number | null, b: number | null, sep: number): 0 | 1 | -1 {
  if (a == null || b == null || !(b > 0)) return 0;
  const d = (a - b) / b;
  if (d >= sep) return 1;
  if (d <= -sep) return -1;
  return 0;
}

/**
 * Precompute, per symbol and per (fastSep, confirm) pair, the bull/bear state
 * and the age of the current fast ordering. Ages are what `maxCrossAgeBars`
 * gates on, so they must be measured on the confirmed ordering, not raw SMAs.
 */
type FastState = { state: Int8Array; age: Int32Array };

function fastStates(ind: SymbolIndicators, sep: number, confirm: number): FastState {
  const n = ind.closes.length;
  const raw = new Int8Array(n);
  for (let i = 0; i < n; i++) raw[i] = ordering(ind.s20[i]!, ind.s50[i]!, sep);

  const state = new Int8Array(n); // confirmed ordering
  const age = new Int32Array(n).fill(1 << 29);
  let current: 0 | 1 | -1 = 0;
  let since = 1 << 29;
  for (let i = 0; i < n; i++) {
    // Confirmed when the last `confirm` bars all agree and are non-neutral.
    let agree: 0 | 1 | -1 = raw[i] as 0 | 1 | -1;
    if (agree !== 0) {
      for (let k = i - 1; k > i - confirm; k--) {
        if (k < 0 || raw[k] !== agree) {
          agree = 0;
          break;
        }
      }
    }
    if (agree !== 0 && agree !== current) {
      current = agree;
      since = 0;
    } else if (since < 1 << 29) {
      since++;
    }
    state[i] = current;
    age[i] = since;
  }
  return { state, age };
}

// -------------------------------------------------------------- simulator

type SegmentResult = {
  returnPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  trades: number;
  costs: number;
};

function tradeCost(notional: number): number {
  return Math.max(commissionMin, (notional * commissionBps) / 10_000)
    + (notional * slippageBps) / 10_000;
}

type PreparedSymbol = {
  symbol: string;
  ind: SymbolIndicators;
  fast: FastState;
};

function simulate(
  prepared: readonly PreparedSymbol[],
  combo: Combo,
  start: number,
  end: number,
): SegmentResult {
  let cash = startingCash;
  const shares = new Map<string, number>();
  const equityCurve: number[] = [];
  let trades = 0;
  let costs = 0;

  const priceOf = new Map(prepared.map((p) => [p.symbol, p.ind.closes]));

  for (let i = start; i <= end; i++) {
    const wanted: Array<{ symbol: string; age: number }> = [];
    const exits: string[] = [];

    for (const p of prepared) {
      const held = (shares.get(p.symbol) ?? 0) > 0;
      const st = p.fast.state[i]!;
      const age = p.fast.age[i]!;

      // Regime gate (optional): SMA50 vs SMA200 with its own separation band.
      let regimeBlocked = false;
      if (combo.regimeSep !== null) {
        const r = ordering(p.ind.s50[i]!, p.ind.s200[i]!, combo.regimeSep);
        if (p.ind.s200[i] == null) regimeBlocked = true; // unknown regime: no new longs
        else if (r < 0) regimeBlocked = true; // death regime: exit and stay out
      }

      if (held) {
        if (st === -1 || regimeBlocked) exits.push(p.symbol);
      } else if (st === 1 && !regimeBlocked && age <= combo.maxAge) {
        wanted.push({ symbol: p.symbol, age });
      }
    }

    for (const sym of exits) {
      const qty = shares.get(sym)!;
      const notional = qty * priceOf.get(sym)![i]!;
      const c = tradeCost(notional);
      cash += notional - c;
      costs += c;
      trades++;
      shares.delete(sym);
    }

    const openSlots = maxPositions - shares.size;
    if (openSlots > 0 && wanted.length) {
      // Freshest cross first — a deterministic, order-invariant tie-break.
      wanted.sort((a, b) => a.age - b.age || a.symbol.localeCompare(b.symbol));
      const equityNow =
        cash + [...shares].reduce((a, [s, q]) => a + q * priceOf.get(s)![i]!, 0);
      const target = equityNow / maxPositions;
      for (const w of wanted.slice(0, openSlots)) {
        const price = priceOf.get(w.symbol)![i]!;
        const notional = Math.min(target, cash * 0.98);
        if (notional < 250) continue; // cost-governor minimum ticket
        const c = tradeCost(notional);
        const qty = (notional - c) / price;
        if (!(qty > 0)) continue;
        cash -= notional;
        costs += c;
        trades++;
        shares.set(w.symbol, qty);
      }
    }

    equityCurve.push(cash + [...shares].reduce((a, [s, q]) => a + q * priceOf.get(s)![i]!, 0));
  }

  let finalEquity = cash;
  for (const [sym, qty] of shares) {
    const notional = qty * priceOf.get(sym)![end]!;
    finalEquity += notional - tradeCost(notional);
  }

  const rets: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) rets.push(equityCurve[i]! / equityCurve[i - 1]! - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const sd = Math.sqrt(varr);

  let peak = -Infinity;
  let maxDd = 0;
  for (const e of equityCurve) {
    peak = Math.max(peak, e);
    maxDd = Math.min(maxDd, e / peak - 1);
  }

  return {
    returnPct: (finalEquity / startingCash - 1) * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
    maxDrawdownPct: maxDd * 100,
    trades,
    costs,
  };
}

// ------------------------------------------------------------------- main

type ComboScore = {
  combo: Combo;
  meanRet: number;
  medianRet: number;
  worstFold: number;
  winRate: number;
  meanSharpe: number;
  worstDd: number;
  trades: number;
  costs: number;
  /** Profit per unit of pain: mean fold return / worst fold drawdown. */
  calmar: number;
  neighbourScore: number;
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

async function main() {
  console.log(`Fetching ${symbols.length} symbols ${from} → ${to} …`);
  const histories = await fetchUniverseHistory(symbols, {
    from,
    to,
    pauseMs: 250,
    onProgress: (m) => console.log(`  ${m}`),
  });
  const tape = buildRealTape(histories, { mode: priceMode, from, to });
  const bars = tape.bars as BacktestBar[];

  const indicators = new Map<string, SymbolIndicators>();
  for (const sym of tape.symbols) {
    const closes = bars.map((b) => b.closes[sym] ?? NaN);
    let lastGood = NaN;
    for (let i = 0; i < closes.length; i++) {
      if (Number.isFinite(closes[i]!) && closes[i]! > 0) lastGood = closes[i]!;
      else closes[i] = lastGood;
    }
    if (!closes.every((v) => Number.isFinite(v) && v > 0)) continue;
    indicators.set(sym, {
      closes,
      s20: smaSeries(closes, 20),
      s50: smaSeries(closes, 50),
      s200: smaSeries(closes, 200),
    });
  }
  console.log(`Tape: ${bars.length} bars · symbols ${[...indicators.keys()].join(", ")}`);

  // Rolling out-of-sample windows (same cadence as the walk-forward run).
  const warm = 220;
  const windows: Array<{ start: number; end: number }> = [];
  for (let c = warm; c + testDays <= bars.length; c += testDays) {
    windows.push({ start: c, end: c + testDays - 1 });
  }
  console.log(
    `Sweeping ${combos.length} combos over ${windows.length} rolling ${testDays}d windows …\n`,
  );

  // Fast-state caches are shared across every combo with the same (sep, confirm).
  const fastCache = new Map<string, PreparedSymbol[]>();
  const preparedFor = (fastSep: number, confirm: number): PreparedSymbol[] => {
    const k = `${fastSep}|${confirm}`;
    let hit = fastCache.get(k);
    if (!hit) {
      hit = [...indicators].map(([symbol, ind]) => ({
        symbol,
        ind,
        fast: fastStates(ind, fastSep, confirm),
      }));
      fastCache.set(k, hit);
    }
    return hit;
  };

  const scores: ComboScore[] = [];
  for (const [n, combo] of combos.entries()) {
    const prepared = preparedFor(combo.fastSep, combo.confirm);
    const results = windows.map((w) => simulate(prepared, combo, w.start, w.end));
    const rets = results.map((r) => r.returnPct);
    const sorted = [...rets].sort((a, b) => a - b);
    const worstDd = Math.min(...results.map((r) => r.maxDrawdownPct));
    scores.push({
      combo,
      meanRet: mean(rets),
      medianRet: sorted[Math.floor(sorted.length / 2)] ?? 0,
      worstFold: sorted[0] ?? 0,
      winRate: (rets.filter((r) => r > 0).length / rets.length) * 100,
      meanSharpe: mean(results.map((r) => r.sharpe)),
      worstDd,
      trades: results.reduce((a, r) => a + r.trades, 0),
      costs: results.reduce((a, r) => a + r.costs, 0),
      calmar: worstDd < 0 ? mean(rets) / Math.abs(worstDd) : 0,
      neighbourScore: 0,
    });
    if ((n + 1) % 40 === 0) console.log(`  … ${n + 1}/${combos.length}`);
  }

  // ---- robustness: average each combo's calmar with its grid neighbours.
  const byKey = new Map(scores.map((s) => [key(s.combo), s]));
  const idx = <T,>(arr: readonly T[], v: T) => arr.indexOf(v);
  for (const s of scores) {
    const vals: number[] = [s.calmar];
    const fi = idx(FAST_SEP, s.combo.fastSep);
    const ri = REGIME_SEP.findIndex((x) => x === s.combo.regimeSep);
    const ci = idx(CONFIRM, s.combo.confirm);
    const ai = idx(MAX_AGE, s.combo.maxAge);
    const neighbours: Combo[] = [];
    for (const d of [-1, 1]) {
      if (FAST_SEP[fi + d] !== undefined) neighbours.push({ ...s.combo, fastSep: FAST_SEP[fi + d]! });
      if (REGIME_SEP[ri + d] !== undefined)
        neighbours.push({ ...s.combo, regimeSep: REGIME_SEP[ri + d]! });
      if (CONFIRM[ci + d] !== undefined) neighbours.push({ ...s.combo, confirm: CONFIRM[ci + d]! });
      if (MAX_AGE[ai + d] !== undefined) neighbours.push({ ...s.combo, maxAge: MAX_AGE[ai + d]! });
    }
    for (const nb of neighbours) {
      const hit = byKey.get(key(nb));
      if (hit) vals.push(hit.calmar);
    }
    s.neighbourScore = mean(vals);
  }

  const fmtAge = (a: number) => (a === Infinity ? "state" : String(a));
  const fmtReg = (r: number | null) => (r === null ? "off" : `${(r * 100).toFixed(1)}%`);

  const table = (rows: ComboScore[], title: string) => {
    console.log(`\n=== ${title} ===`);
    const header = [
      "fastSep".padStart(8),
      "regime".padStart(7),
      "conf".padStart(5),
      "maxAge".padStart(7),
      "mean%".padStart(7),
      "med%".padStart(7),
      "worst%".padStart(8),
      "win%".padStart(6),
      "Sharpe".padStart(7),
      "worstDD".padStart(8),
      "calmar".padStart(7),
      "robust".padStart(7),
      "trades".padStart(7),
      "costs£".padStart(8),
    ].join(" ");
    console.log(header);
    console.log("-".repeat(header.length));
    for (const s of rows) {
      console.log(
        [
          `${(s.combo.fastSep * 100).toFixed(1)}%`.padStart(8),
          fmtReg(s.combo.regimeSep).padStart(7),
          String(s.combo.confirm).padStart(5),
          fmtAge(s.combo.maxAge).padStart(7),
          s.meanRet.toFixed(2).padStart(7),
          s.medianRet.toFixed(2).padStart(7),
          s.worstFold.toFixed(2).padStart(8),
          s.winRate.toFixed(0).padStart(6),
          s.meanSharpe.toFixed(2).padStart(7),
          s.worstDd.toFixed(1).padStart(8),
          s.calmar.toFixed(3).padStart(7),
          s.neighbourScore.toFixed(3).padStart(7),
          String(s.trades).padStart(7),
          s.costs.toFixed(0).padStart(8),
        ].join(" "),
      );
    }
  };

  table([...scores].sort((a, b) => b.neighbourScore - a.neighbourScore).slice(0, topN),
    `MOST ROBUST (return vs drawdown, neighbourhood-averaged) — top ${topN}`);
  table([...scores].sort((a, b) => b.meanRet - a.meanRet).slice(0, 5), "HIGHEST RAW RETURN — top 5");
  table([...scores].sort((a, b) => b.worstDd - a.worstDd).slice(0, 5), "SHALLOWEST DRAWDOWN — top 5");

  // ---- marginal effect of each axis, averaged over everything else.
  console.log("\n=== MARGINAL EFFECT OF EACH AXIS (averaged over all other settings) ===");
  const axis = <T,>(name: string, values: readonly T[], pick: (c: Combo) => T, fmt: (v: T) => string) => {
    console.log(`\n${name}`);
    console.log(
      `${"value".padStart(8)} ${"mean%".padStart(7)} ${"worstDD".padStart(8)} ${"calmar".padStart(7)} ${"trades".padStart(8)}`,
    );
    for (const v of values) {
      const subset = scores.filter((s) => pick(s.combo) === v);
      console.log(
        [
          fmt(v).padStart(8),
          mean(subset.map((s) => s.meanRet)).toFixed(2).padStart(7),
          mean(subset.map((s) => s.worstDd)).toFixed(1).padStart(8),
          mean(subset.map((s) => s.calmar)).toFixed(3).padStart(7),
          Math.round(mean(subset.map((s) => s.trades))).toString().padStart(8),
        ].join(" "),
      );
    }
  };
  axis("fastSeparationPct", FAST_SEP, (c) => c.fastSep, (v) => `${(v * 100).toFixed(1)}%`);
  axis("regimeSeparationPct", REGIME_SEP, (c) => c.regimeSep, fmtReg);
  axis("confirmBars", CONFIRM, (c) => c.confirm, String);
  axis("maxCrossAgeBars", MAX_AGE, (c) => c.maxAge, fmtAge);

  // ---- how the current shipped defaults score.
  const current = byKey.get(key({ fastSep: 0.002, regimeSep: 0.005, confirm: 1, maxAge: 10 }));
  if (current) table([current], "CURRENT DEFAULTS (fastSep 0.2% / regime 0.5% / confirm 1 / maxAge 10)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
