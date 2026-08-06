import { describe, it, expect } from "vitest";
import {
  attributeFrontierFailures,
  attributionTableRows,
  examplePeriodRows,
  formatAttributionTable,
  pairRoundTrips,
  splitCostBps,
  summariseAttribution,
  worstCostPeriods,
  ATTRIBUTION_COLUMNS,
  EXAMPLE_PERIOD_COLUMNS,
} from "../cost-axis-attribution";
import type { SweepCell, TicketSpec, SlippageSpec } from "../cost-sweep";
import { applyMinCommission, applySlippage, scaleFrictions } from "../cost-sweep";

const BASE = {
  commissionBps: 8,
  minCommission: 3,
  buyTaxBps: 0,
  slippageBps: 5,
  impactPerUnit: 0.0002,
};

const TICKET: TicketSpec = { label: "5 x 18%", maxNames: 5, perNameWeight: 0.18 };
const TIGHT: SlippageSpec = { label: "tight 2bps", slippageBps: 1, spreadBps: 1 };
const WIDE: SlippageSpec = { label: "wide 20bps", slippageBps: 10, spreadBps: 10 };

function cell(args: {
  scale: number;
  slippage: SlippageSpec;
  minCommission: number;
  ret: number;
  bench?: number;
}): SweepCell {
  let f = scaleFrictions(BASE, args.scale);
  f = applySlippage(f, args.slippage);
  f = applyMinCommission(f, args.minCommission);
  return {
    ticket: TICKET,
    scenario: {
      label: `${args.scale}x · ${args.slippage.label} · min £${args.minCommission}`,
      scale: args.scale,
      frictions: f,
      slippage: args.slippage,
      minCommission: args.minCommission,
    },
    style: "swing",
    riskLevel: "balanced",
    totalReturnPct: args.ret,
    benchmarkReturnPct: args.bench ?? 20,
    trades: 40,
    feeDragPct: 4,
    sharpe: 0.4,
    maxDrawdownPct: 12,
  };
}

/** 2x2 grid: cheap/expensive commission × tight/wide slippage. */
function grid(returns: { cheapTight: number; cheapWide: number; dearTight: number; dearWide: number }) {
  return [
    cell({ scale: 0.1, slippage: TIGHT, minCommission: 0, ret: returns.cheapTight }),
    cell({ scale: 0.1, slippage: WIDE, minCommission: 0, ret: returns.cheapWide }),
    cell({ scale: 1, slippage: TIGHT, minCommission: 8, ret: returns.dearTight }),
    cell({ scale: 1, slippage: WIDE, minCommission: 8, ret: returns.dearWide }),
  ];
}

describe("splitCostBps", () => {
  it("separates commission, slippage and tax", () => {
    const s = splitCostBps({ commissionBps: 8, minCommission: 0, slippageBps: 5, buyTaxBps: 50 }, 10_000);
    expect(s.commissionBps).toBeCloseTo(16, 8);
    expect(s.slippageBps).toBeCloseTo(10, 8);
    expect(s.taxBps).toBe(50);
    expect(s.totalBps).toBeCloseTo(76, 8);
    expect(s.commissionShare).toBeCloseTo(16 / 76, 8);
  });

  it("lets the minimum fee dominate on small tickets", () => {
    const small = splitCostBps({ commissionBps: 8, minCommission: 3, slippageBps: 5 }, 200);
    expect(small.commissionBps).toBeCloseTo(300, 6);
    expect(small.commissionShare).toBeGreaterThan(0.9);
  });

  it("returns infinities for a non-positive ticket", () => {
    expect(splitCostBps(BASE, 0).totalBps).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("attributeFrontierFailures", () => {
  it("reports no failures when every cell is profitable", () => {
    const s = attributeFrontierFailures(grid({ cheapTight: 5, cheapWide: 4, dearTight: 3, dearWide: 2 }), {
      startingCash: 10_300,
    });
    expect(s.failures).toBe(0);
    expect(s.dominantAxis).toBeNull();
    expect(summariseAttribution(s)).toMatch(/No viability failures/);
  });

  it("blames slippage when only relaxing execution cost rescues the cell", () => {
    // Wide slippage kills it; commission relief alone does not.
    const s = attributeFrontierFailures(
      grid({ cheapTight: 5, cheapWide: -2, dearTight: 4, dearWide: -3 }),
      { startingCash: 10_300 },
    );
    expect(s.failures).toBe(2);
    expect(s.counts.slippage).toBe(2);
    expect(s.counts.commission).toBe(0);
    expect(s.dominantAxis).toBe("slippage");
  });

  it("blames commission when only cost-scale relief rescues the cell", () => {
    const s = attributeFrontierFailures(
      grid({ cheapTight: 5, cheapWide: 4, dearTight: -1, dearWide: -2 }),
      { startingCash: 10_300 },
    );
    expect(s.counts.commission).toBe(2);
    expect(s.counts.slippage).toBe(0);
    expect(s.dominantAxis).toBe("commission");
  });

  it("marks a failure as either-axis when both reliefs rescue it", () => {
    const s = attributeFrontierFailures(
      grid({ cheapTight: 6, cheapWide: 2, dearTight: 1, dearWide: -4 }),
      { startingCash: 10_300 },
    );
    expect(s.failures).toBe(1);
    expect(s.counts.both).toBe(1);
    expect(s.rows[0]!.cause).toBe("both");
    expect(s.rows[0]!.slippageGain).toBeGreaterThan(0);
    expect(s.rows[0]!.commissionGain).toBeGreaterThan(0);
  });

  it("marks a failure as strategy-bound when no cost relief saves it", () => {
    const s = attributeFrontierFailures(
      grid({ cheapTight: -5, cheapWide: -6, dearTight: -7, dearWide: -8 }),
      { startingCash: 10_300 },
    );
    expect(s.failures).toBe(4);
    expect(s.counts.strategy).toBe(4);
    expect(s.dominantAxis).toBeNull();
    expect(summariseAttribution(s)).toMatch(/edge, not the cost model/);
  });

  it("uses the benchmark target when asked", () => {
    const cells = grid({ cheapTight: 25, cheapWide: 10, dearTight: 24, dearWide: 8 });
    const zero = attributeFrontierFailures(cells, { startingCash: 10_300, target: "zero" });
    const bench = attributeFrontierFailures(cells, { startingCash: 10_300, target: "benchmark" });
    expect(zero.failures).toBe(0);
    expect(bench.failures).toBe(2); // 10% and 8% both trail the 20% benchmark
    expect(bench.counts.slippage).toBe(2);
  });

  it("orders rows worst-first and records the cost split", () => {
    const s = attributeFrontierFailures(
      grid({ cheapTight: 5, cheapWide: -2, dearTight: 4, dearWide: -9 }),
      { startingCash: 10_300 },
    );
    expect(s.rows.map((r) => r.score)).toEqual([-9, -2]);
    expect(s.rows[0]!.split.slippageBps).toBeGreaterThan(0);
    expect(s.rows[0]!.split.commissionBps).toBeGreaterThan(0);
  });

  it("renders a table with one row per failure and the declared columns", () => {
    const s = attributeFrontierFailures(
      grid({ cheapTight: 5, cheapWide: -2, dearTight: 4, dearWide: -3 }),
      { startingCash: 10_300 },
    );
    const rows = attributionTableRows(s);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toHaveLength(ATTRIBUTION_COLUMNS.length);
    expect(formatAttributionTable(s)).toContain("cause");
  });
});

describe("pairRoundTrips / worstCostPeriods", () => {
  const trades = [
    { date: "2024-01-02", side: "buy" as const, symbol: "AAPL", quantity: 10, price: 100 },
    { date: "2024-01-09", side: "sell" as const, symbol: "AAPL", quantity: 10, price: 100.5 },
    { date: "2024-02-01", side: "buy" as const, symbol: "MSFT", quantity: 5, price: 200 },
    { date: "2024-03-01", side: "sell" as const, symbol: "MSFT", quantity: 5, price: 180 },
    { date: "2024-04-01", side: "buy" as const, symbol: "KO", quantity: 20, price: 50 },
  ];
  const frictions = { commissionBps: 8, minCommission: 3, slippageBps: 5 };

  it("matches buys to sells FIFO and ignores open positions", () => {
    const trips = pairRoundTrips(trades, frictions);
    expect(trips.map((t) => t.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(trips[0]!.holdingDays).toBe(7);
    expect(trips[1]!.grossPnl).toBeCloseTo(-100, 8);
  });

  it("costs each round trip and detects cost-flipped winners", () => {
    const trips = pairRoundTrips(trades, frictions);
    const aapl = trips[0]!;
    expect(aapl.grossPnl).toBeCloseTo(5, 8);
    expect(aapl.costAmount).toBeGreaterThan(0);
    expect(aapl.netPnl).toBeCloseTo(aapl.grossPnl - aapl.costAmount, 10);
    expect(aapl.flippedByCosts).toBe(true); // £6 min commission + £1 slippage > £5 gross
    expect(aapl.costShareOfGross).toBeGreaterThan(1);
  });

  it("splits partial sells across lots", () => {
    const trips = pairRoundTrips(
      [
        { date: "2024-01-02", side: "buy", symbol: "AAPL", quantity: 10, price: 100 },
        { date: "2024-01-03", side: "buy", symbol: "AAPL", quantity: 10, price: 110 },
        { date: "2024-01-10", side: "sell", symbol: "AAPL", quantity: 15, price: 120 },
      ],
      frictions,
    );
    expect(trips).toHaveLength(2);
    expect(trips[0]!.quantity).toBe(10);
    expect(trips[1]!.quantity).toBe(5);
    expect(trips[1]!.entryPrice).toBe(110);
  });

  it("ranks cost-flipped winners ahead of plain losers", () => {
    const worst = worstCostPeriods(pairRoundTrips(trades, frictions), 5);
    expect(worst[0]!.symbol).toBe("AAPL");
    expect(worst[0]!.flippedByCosts).toBe(true);
    expect(worst.length).toBeLessThanOrEqual(5);
  });

  it("renders example rows with the declared columns", () => {
    const rows = examplePeriodRows(worstCostPeriods(pairRoundTrips(trades, frictions)));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toHaveLength(EXAMPLE_PERIOD_COLUMNS.length);
    expect(rows[0]!.at(-1)).toBe("costs flipped a winner");
  });

  it("is deterministic and side-effect free", () => {
    const a = JSON.stringify(pairRoundTrips(trades, frictions));
    const b = JSON.stringify(pairRoundTrips(trades, frictions));
    expect(a).toBe(b);
  });
});
