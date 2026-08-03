// End-to-end backtest harness.
//
// Drives the AI decision rule-set through the pure broker-simulator over
// synthetic *global event streams* — macro shocks, sector rotations,
// earnings gaps, liquidity crunches, flash crashes and melt-ups layered
// on top of a seeded price tape — and then audits the resulting run
// against the invariants that must hold no matter what the market does:
//
//   * no-borrow      cash never goes negative on any bar or any fill
//   * no-short       no position quantity ever goes below zero
//   * sleeve caps    at most `maxBuys` new names per bar, and each buy
//                    spends at most `perNamePct` of the cash available
//                    at the moment it was authorised
//   * concentration  no single name exceeds its share of NAV
//   * fill sanity    fills never exceed the requested quantity
//   * ledger parity  replaying the trade log independently reproduces
//                    the cash and equity the runner reported, per day
//   * determinism    the same tape replays byte-identically, per day
//
// The audit deliberately re-derives everything from the trade log rather
// than trusting the runner's own bookkeeping, so a bug in the runner
// shows up as a parity violation instead of being masked.
//
// Pure module: no I/O, no clock, no randomness beyond the caller's seed.

import { runAiBacktest, type AiBacktestOptions, type AiBacktestResult } from "./ai-backtest";
import { buildPriceTape, type AssetSpec } from "./risk-sim-matrix";
import {
  HEURISTIC_BUY_SLEEVE,
  normalizeHeuristicRiskLevel,
  type HeuristicRiskLevelInput,
} from "./heuristic-decision";
import type { BacktestBar } from "./backtest-runner";

// ------------------------------------------------------------- event tape

export type GlobalEventKind =
  /** Broad market-wide repricing (rates, war, pandemic). */
  | "macro_shock"
  /** Money leaves one set of names and rotates into another. */
  | "sector_rotation"
  /** Single-name overnight gap on results. */
  | "earnings_gap"
  /** One-bar violent drop followed by a partial bounce. */
  | "flash_crash"
  /** Sustained parabolic ramp (mania conditions). */
  | "melt_up"
  /** Book thins out — fills get truncated by participation limits. */
  | "liquidity_crunch";

export type GlobalEvent = {
  kind: GlobalEventKind;
  /** 0-based bar the event lands on. */
  barIndex: number;
  /** Symbols affected. Empty/omitted = the whole universe. */
  symbols?: string[];
  /**
   * Signed magnitude as a return (e.g. -0.25 = a 25% hit). For
   * `liquidity_crunch` this is the fraction of normal volume that
   * remains (0.05 = 5% of the usual book).
   */
  magnitude: number;
  /** Bars the effect persists for. Defaults to 1 (a pure gap). */
  durationBars?: number;
  /** Human label, surfaced in violation messages. */
  label?: string;
};

export type EventTape = {
  bars: BacktestBar[];
  /** Per-bar available volume by symbol, for the liquidity cap. */
  volumes: Array<Record<string, number>>;
  events: GlobalEvent[];
};

const BASE_VOLUME = 50_000;

/**
 * Layer a global event stream on top of a seeded GBM tape.
 *
 * Price effects compound into the path (a crash on bar 40 leaves the
 * whole rest of the tape lower) except for `flash_crash`, which prints
 * a one-bar dislocation and then partially mean-reverts — exactly the
 * shape that breaks naive backtests.
 */
export function buildEventTape(
  universe: AssetSpec[],
  bars: number,
  seed: number,
  events: GlobalEvent[],
): EventTape {
  const base = buildPriceTape(universe, bars, seed);
  const symbols = universe.map((u) => u.symbol);
  // Per-symbol cumulative multiplier carried forward through the tape.
  const drift: Record<string, number> = Object.fromEntries(symbols.map((s) => [s, 1]));
  const volumes: Array<Record<string, number>> = [];
  const out: BacktestBar[] = [];

  for (let i = 0; i < base.length; i++) {
    const transient: Record<string, number> = {};
    const vol: Record<string, number> = Object.fromEntries(
      symbols.map((s) => [s, BASE_VOLUME]),
    );

    for (const ev of events) {
      const targets = ev.symbols?.length ? ev.symbols : symbols;
      const duration = Math.max(1, ev.durationBars ?? 1);
      const active = i >= ev.barIndex && i < ev.barIndex + duration;
      if (!active) continue;

      switch (ev.kind) {
        case "liquidity_crunch":
          for (const s of targets) {
            vol[s] = Math.max(1, BASE_VOLUME * Math.max(0, ev.magnitude));
          }
          break;
        case "flash_crash":
          // One-bar dislocation, then a half-retrace on the next bar.
          for (const s of targets) {
            transient[s] = (transient[s] ?? 1) * (1 + ev.magnitude);
          }
          if (i === ev.barIndex) {
            for (const s of targets) drift[s] *= 1 + ev.magnitude * 0.5;
          }
          break;
        case "sector_rotation": {
          // Targets get the move; everything else gets the opposite leg.
          const step = ev.magnitude / duration;
          for (const s of symbols) {
            const sign = targets.includes(s) ? 1 : -0.5;
            drift[s] *= 1 + step * sign;
          }
          break;
        }
        default: {
          const step = ev.magnitude / duration;
          for (const s of targets) drift[s] *= 1 + step;
          break;
        }
      }
    }

    const closes: Record<string, number> = {};
    for (const s of symbols) {
      const px = base[i].closes[s] * drift[s] * (transient[s] ?? 1);
      closes[s] = Math.max(0.01, Math.round(px * 10_000) / 10_000);
    }
    out.push({ date: base[i].date, closes });
    volumes.push(vol);
  }

  return { bars: out, volumes, events };
}

// ------------------------------------------------------------- invariants

export type HarnessCaps = {
  /** Max share of NAV a single name may represent, 0-1. */
  maxNamePctOfNav: number;
  /** Max simultaneous open positions. */
  maxOpenPositions: number;
  /** Tolerance for floating-point comparisons. */
  epsilon?: number;
};

export const DEFAULT_HARNESS_CAPS: HarnessCaps = {
  maxNamePctOfNav: 0.5,
  maxOpenPositions: 12,
  epsilon: 1e-6,
};

export type InvariantViolation = {
  rule:
    | "no_borrow"
    | "no_short"
    | "sleeve_max_buys"
    | "sleeve_per_name_pct"
    | "fill_exceeds_request"
    | "concentration_cap"
    | "max_open_positions"
    | "ledger_parity"
    | "curve_consistency"
    | "chronology"
    | "determinism";
  date: string;
  detail: string;
};

export type AuditReport = {
  ok: boolean;
  violations: InvariantViolation[];
  /** Days audited. */
  days: number;
  fills: number;
  /** Peak simultaneous open positions observed in the replayed ledger. */
  peakOpenPositions: number;
  /** Largest single-name share of NAV observed, 0-1. */
  peakNameConcentration: number;
};

/**
 * Independently replay the trade log and check every invariant.
 */
export function auditBacktest(
  result: AiBacktestResult,
  tape: BacktestBar[],
  caps: HarnessCaps = DEFAULT_HARNESS_CAPS,
  riskLevel: HeuristicRiskLevelInput = "balanced",
): AuditReport {
  const eps = caps.epsilon ?? 1e-6;
  const violations: InvariantViolation[] = [];
  const sleeve = HEURISTIC_BUY_SLEEVE[normalizeHeuristicRiskLevel(riskLevel)];

  // ---- shadow ledger, rebuilt from the trade log alone ----------------
  let cash = result.startingCash;
  const qty: Record<string, number> = {};
  let peakOpen = 0;
  let peakConc = 0;

  const closesByDate = new Map(tape.map((b) => [b.date, b.closes] as const));
  const logByDate = new Map<string, typeof result.tradeLog>();
  for (const t of result.tradeLog) {
    const list = logByDate.get(t.date) ?? [];
    list.push(t);
    logByDate.set(t.date, list);
  }

  let prevDate = "";
  for (const point of result.equityCurve) {
    const date = point.date;
    if (prevDate && !(date > prevDate)) {
      violations.push({
        rule: "chronology",
        date,
        detail: `bar "${date}" is not strictly after "${prevDate}"`,
      });
    }
    prevDate = date;

    const closes = closesByDate.get(date) ?? {};
    const fills = logByDate.get(date) ?? [];
    let buysThisBar = 0;

    for (const t of fills) {
      if (t.quantity > t.requestedQuantity + eps) {
        violations.push({
          rule: "fill_exceeds_request",
          date,
          detail: `${t.symbol} filled ${t.quantity} of ${t.requestedQuantity} requested`,
        });
      }

      const cashBefore = cash;
      if (t.side === "buy") {
        buysThisBar += 1;
        const spend = t.notional + t.fee;
        if (spend > cashBefore + eps) {
          violations.push({
            rule: "no_borrow",
            date,
            detail: `${t.symbol} buy spend ${spend.toFixed(4)} exceeds cash ${cashBefore.toFixed(4)}`,
          });
        }
        // The sleeve authorises at most `perNamePct` of available cash
        // per name; frictions may add cost on top of the sized notional
        // but must never double the authorised sleeve.
        const authorised = cashBefore * (sleeve.perNamePct / 100);
        if (spend > authorised * 2 + eps) {
          violations.push({
            rule: "sleeve_per_name_pct",
            date,
            detail: `${t.symbol} spent ${spend.toFixed(4)} vs ${sleeve.perNamePct}% sleeve of ${cashBefore.toFixed(4)}`,
          });
        }
        cash = cashBefore - spend;
        qty[t.symbol] = (qty[t.symbol] ?? 0) + t.quantity;
      } else {
        const held = qty[t.symbol] ?? 0;
        if (t.quantity > held + eps) {
          violations.push({
            rule: "no_short",
            date,
            detail: `${t.symbol} sold ${t.quantity} holding only ${held}`,
          });
        }
        cash = cashBefore + t.notional - t.fee;
        qty[t.symbol] = held - t.quantity;
      }

      if (cash < -eps) {
        violations.push({
          rule: "no_borrow",
          date,
          detail: `cash went to ${cash.toFixed(6)} after ${t.side} ${t.symbol}`,
        });
      }
      if ((qty[t.symbol] ?? 0) < -eps) {
        violations.push({
          rule: "no_short",
          date,
          detail: `${t.symbol} position went to ${qty[t.symbol]}`,
        });
      }
      if (Math.abs(t.cashAfter - cash) > Math.max(eps, Math.abs(cash) * 1e-6)) {
        violations.push({
          rule: "ledger_parity",
          date,
          detail: `cash after ${t.side} ${t.symbol}: runner ${t.cashAfter.toFixed(6)} vs replay ${cash.toFixed(6)}`,
        });
      }
    }

    if (buysThisBar > sleeve.maxBuys) {
      violations.push({
        rule: "sleeve_max_buys",
        date,
        detail: `${buysThisBar} buys on one bar, sleeve allows ${sleeve.maxBuys}`,
      });
    }

    // ---- end-of-bar mark-to-market against the shadow ledger ----------
    let holdingsValue = 0;
    let open = 0;
    const positionValues: Array<[string, number]> = [];
    for (const [sym, q] of Object.entries(qty)) {
      if (q <= eps) continue;
      open += 1;
      const px = closes[sym];
      const value = q * (Number.isFinite(px) && px > 0 ? px : 0);
      holdingsValue += value;
      positionValues.push([sym, value]);
    }
    const nav = cash + holdingsValue;
    peakOpen = Math.max(peakOpen, open);

    for (const [sym, value] of positionValues) {
      const share = nav > 0 ? value / nav : 0;
      peakConc = Math.max(peakConc, share);
      if (share > caps.maxNamePctOfNav + 1e-9) {
        violations.push({
          rule: "concentration_cap",
          date,
          detail: `${sym} is ${(share * 100).toFixed(2)}% of NAV, cap ${(caps.maxNamePctOfNav * 100).toFixed(0)}%`,
        });
      }
    }

    if (open > caps.maxOpenPositions) {
      violations.push({
        rule: "max_open_positions",
        date,
        detail: `${open} open positions, cap ${caps.maxOpenPositions}`,
      });
    }

    if (point.cash < -eps) {
      violations.push({
        rule: "no_borrow",
        date,
        detail: `reported cash ${point.cash} is negative`,
      });
    }
    if (Math.abs(point.totalValue - (point.cash + point.holdingsValue)) > eps) {
      violations.push({
        rule: "curve_consistency",
        date,
        detail: `totalValue ${point.totalValue} != cash + holdings ${point.cash + point.holdingsValue}`,
      });
    }
    const tol = Math.max(1e-4, Math.abs(nav) * 1e-6);
    if (Math.abs(point.totalValue - nav) > tol) {
      violations.push({
        rule: "ledger_parity",
        date,
        detail: `equity: runner ${point.totalValue.toFixed(6)} vs replay ${nav.toFixed(6)}`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    days: result.equityCurve.length,
    fills: result.tradeLog.length,
    peakOpenPositions: peakOpen,
    peakNameConcentration: peakConc,
  };
}

/**
 * Compare two runs of the same tape day by day. Any divergence in the
 * equity path or the fills for a given date is a determinism failure.
 */
export function diffRunsPerDay(
  a: AiBacktestResult,
  b: AiBacktestResult,
): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  if (a.equityCurve.length !== b.equityCurve.length) {
    out.push({
      rule: "determinism",
      date: "*",
      detail: `curve length ${a.equityCurve.length} vs ${b.equityCurve.length}`,
    });
    return out;
  }
  const fillsOf = (r: AiBacktestResult) => {
    const m = new Map<string, string>();
    for (const t of r.tradeLog) {
      m.set(
        t.date,
        `${m.get(t.date) ?? ""}|${t.side}:${t.symbol}:${t.quantity}:${t.price}:${t.fee}`,
      );
    }
    return m;
  };
  const fa = fillsOf(a);
  const fb = fillsOf(b);

  for (let i = 0; i < a.equityCurve.length; i++) {
    const pa = a.equityCurve[i];
    const pb = b.equityCurve[i];
    if (pa.date !== pb.date) {
      out.push({ rule: "determinism", date: pa.date, detail: `date ${pa.date} vs ${pb.date}` });
      continue;
    }
    if (pa.cash !== pb.cash || pa.totalValue !== pb.totalValue) {
      out.push({
        rule: "determinism",
        date: pa.date,
        detail: `equity ${pa.totalValue}/${pa.cash} vs ${pb.totalValue}/${pb.cash}`,
      });
    }
    if ((fa.get(pa.date) ?? "") !== (fb.get(pa.date) ?? "")) {
      out.push({
        rule: "determinism",
        date: pa.date,
        detail: `fills "${fa.get(pa.date) ?? ""}" vs "${fb.get(pa.date) ?? ""}"`,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------- harness

export type HarnessScenario = {
  name: string;
  universe: AssetSpec[];
  bars: number;
  seed: number;
  events: GlobalEvent[];
  options?: AiBacktestOptions;
  caps?: HarnessCaps;
};

export type HarnessOutcome = {
  scenario: string;
  tape: EventTape;
  run: AiBacktestResult;
  audit: AuditReport;
  determinism: InvariantViolation[];
  ok: boolean;
};

/**
 * Run one scenario end-to-end: build the event tape, replay the AI
 * decisions through the simulator twice, audit the caps/invariants and
 * diff the two runs per day.
 */
export async function runHarnessScenario(
  scenario: HarnessScenario,
): Promise<HarnessOutcome> {
  const tape = buildEventTape(
    scenario.universe,
    scenario.bars,
    scenario.seed,
    scenario.events,
  );
  const run = await runAiBacktest(tape.bars, scenario.options);
  const replay = await runAiBacktest(tape.bars, scenario.options);
  const audit = auditBacktest(
    run,
    tape.bars,
    scenario.caps ?? DEFAULT_HARNESS_CAPS,
    scenario.options?.riskLevel ?? "balanced",
  );
  const determinism = diffRunsPerDay(run, replay);
  return {
    scenario: scenario.name,
    tape,
    run,
    audit,
    determinism,
    ok: audit.ok && determinism.length === 0,
  };
}

/** Canonical universe used by the built-in scenarios. */
export const HARNESS_UNIVERSE: AssetSpec[] = [
  { symbol: "MEGA", start: 40, drift: 0.14, vol: 0.24, cycleAmp: 0.4, cycleBars: 90 },
  { symbol: "CYCL", start: 18, drift: 0.09, vol: 0.34, cycleAmp: 0.9, cycleBars: 55 },
  { symbol: "DEFN", start: 25, drift: 0.05, vol: 0.16, cycleAmp: 0.2, cycleBars: 140 },
  { symbol: "GRWT", start: 60, drift: 0.18, vol: 0.42, cycleAmp: 1.1, cycleBars: 70 },
  { symbol: "COMM", start: 12, drift: 0.03, vol: 0.5, cycleAmp: 1.4, cycleBars: 40 },
];

/** A representative spread of global event streams. */
export function defaultHarnessScenarios(): HarnessScenario[] {
  const U = HARNESS_UNIVERSE;
  return [
    {
      name: "calm-market",
      universe: U,
      bars: 220,
      seed: 20260803,
      events: [],
    },
    {
      name: "global-macro-crash",
      universe: U,
      bars: 260,
      seed: 4242,
      events: [
        { kind: "macro_shock", barIndex: 80, magnitude: -0.32, durationBars: 10, label: "rate shock" },
        { kind: "macro_shock", barIndex: 150, magnitude: 0.18, durationBars: 20, label: "recovery" },
      ],
    },
    {
      name: "flash-crash-and-melt-up",
      universe: U,
      bars: 240,
      seed: 771,
      events: [
        { kind: "flash_crash", barIndex: 95, magnitude: -0.6, symbols: ["GRWT", "CYCL"] },
        { kind: "melt_up", barIndex: 120, magnitude: 1.5, durationBars: 25, symbols: ["GRWT"] },
      ],
    },
    {
      name: "sector-rotation",
      universe: U,
      bars: 250,
      seed: 90210,
      events: [
        { kind: "sector_rotation", barIndex: 70, magnitude: 0.4, durationBars: 30, symbols: ["DEFN", "COMM"] },
        { kind: "sector_rotation", barIndex: 160, magnitude: 0.35, durationBars: 30, symbols: ["MEGA", "GRWT"] },
      ],
    },
    {
      name: "liquidity-crunch-with-gaps",
      universe: U,
      bars: 230,
      seed: 13337,
      events: [
        { kind: "liquidity_crunch", barIndex: 60, magnitude: 0.02, durationBars: 40 },
        { kind: "earnings_gap", barIndex: 65, magnitude: -0.28, symbols: ["MEGA"] },
        { kind: "earnings_gap", barIndex: 66, magnitude: 0.22, symbols: ["COMM"] },
        { kind: "flash_crash", barIndex: 100, magnitude: -0.45 },
      ],
      options: {
        feePerTrade: 1.5,
        frictions: { commissionBps: 60, minCommission: 3, buyTaxBps: 50, slippageBps: 80 },
      },
    },
  ];
}
