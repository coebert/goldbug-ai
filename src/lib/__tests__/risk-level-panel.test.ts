import { describe, it, expect } from "vitest";
import {
  computeRiskLevelPanel,
  aggregateEquity,
  normaliseRiskLevel,
  checkRiskLadder,
  type RiskPanelPortfolio,
} from "@/lib/risk-level-panel";

function pf(over: Partial<RiskPanelPortfolio> & { id: string }): RiskPanelPortfolio {
  return {
    name: over.id,
    mode: "sim",
    riskLevel: "balanced",
    currency: "GBP",
    cash: 0,
    holdings: [],
    equity: [],
    ...over,
  };
}

const curve = (vals: number[]) =>
  vals.map((v, i) => ({
    snapshot_date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    total_value: v,
  }));

describe("normaliseRiskLevel", () => {
  it("maps synonyms and unknowns", () => {
    expect(normaliseRiskLevel("Conservative")).toBe("low");
    expect(normaliseRiskLevel("MEDIUM")).toBe("balanced");
    expect(normaliseRiskLevel("aggressive")).toBe("high");
    expect(normaliseRiskLevel(null)).toBe("unknown");
  });
});

describe("aggregateEquity", () => {
  it("sums curves on a shared axis and forward-fills gaps", () => {
    const out = aggregateEquity([
      pf({ id: "a", equity: curve([100, 110, 90]) }),
      pf({
        id: "b",
        equity: [
          { snapshot_date: "2026-07-01", total_value: 50 },
          { snapshot_date: "2026-07-03", total_value: 70 },
        ],
      }),
    ]);
    expect(out.map((p) => p.total_value)).toEqual([150, 160, 160]);
  });

  it("ignores portfolios before their first snapshot", () => {
    const out = aggregateEquity([
      pf({ id: "a", equity: curve([100, 100]) }),
      pf({ id: "b", equity: [{ snapshot_date: "2026-07-02", total_value: 40 }] }),
    ]);
    expect(out.map((p) => p.total_value)).toEqual([100, 140]);
  });
});

describe("computeRiskLevelPanel", () => {
  const rows = computeRiskLevelPanel([
    pf({
      id: "low-1",
      riskLevel: "low",
      cash: 900,
      equity: curve([1000, 1010, 1005, 1015]),
      holdings: [
        { symbol: "VUSA.L", quantity: 10, price: 5 },
        { symbol: "GLD", quantity: 5, price: 10 },
      ],
    }),
    pf({
      id: "high-1",
      riskLevel: "high",
      cash: 100,
      equity: curve([1000, 1200, 800, 1100]),
      holdings: [{ symbol: "TSLA", quantity: 10, price: 90 }],
    }),
  ]);

  it("returns one row per risk level in ladder order", () => {
    expect(rows.map((r) => r.riskLevel)).toEqual(["low", "high"]);
  });

  it("scores drawdown and volatility higher for the high-risk group", () => {
    const [low, high] = rows;
    expect(Math.abs(high.maxDrawdownPct)).toBeGreaterThan(Math.abs(low.maxDrawdownPct));
    expect(high.annualisedVolPct).toBeGreaterThan(low.annualisedVolPct);
    expect(high.maxDrawdownPct).toBeLessThan(0);
  });

  it("computes diversification: positions, HHI, top weight and effective names", () => {
    const [low, high] = rows;
    expect(low.positions).toBe(2);
    expect(low.concentrationHhi).toBeCloseTo(0.5, 6);
    expect(low.topWeightPct).toBeCloseTo(50, 6);
    expect(low.effectiveNames).toBeCloseTo(2, 6);

    expect(high.positions).toBe(1);
    expect(high.concentrationHhi).toBeCloseTo(1, 6);
    expect(high.topSymbol).toBe("TSLA");
  });

  it("splits cash vs invested against latest equity", () => {
    const [low] = rows;
    expect(low.totalEquity).toBe(1015);
    expect(low.cashPct).toBeCloseTo((900 / 1015) * 100, 6);
    expect(low.investedPct).toBeCloseTo((100 / 1015) * 100, 6);
  });

  it("handles a portfolio with no history without throwing", () => {
    const [row] = computeRiskLevelPanel([pf({ id: "x", riskLevel: "low", cash: 500 })]);
    expect(row.observations).toBe(0);
    expect(row.totalEquity).toBe(500);
    expect(row.maxDrawdownPct).toBe(0);
    expect(row.positions).toBe(0);
    expect(row.effectiveNames).toBe(0);
  });
});

describe("checkRiskLadder", () => {
  it("is silent when the ladder behaves", () => {
    expect(checkRiskLadder(rowsFor([1000, 1005, 1002, 1010], [1000, 1200, 800, 1100]))).toEqual([]);
  });

  it("flags an inverted drawdown", () => {
    const warnings = checkRiskLadder(rowsFor([1000, 1200, 700, 900], [1000, 1010, 1005, 1015]));
    expect(warnings.some((w) => w.kind === "drawdown-inversion")).toBe(true);
  });

  it("flags identical low/high metrics as a mirroring bug", () => {
    const same = curve([1000, 1100, 900, 1000]);
    const holdings = [{ symbol: "AAPL", quantity: 4, price: 100 }];
    const warnings = checkRiskLadder(
      computeRiskLevelPanel([
        pf({ id: "l", riskLevel: "low", equity: same, holdings, cash: 100 }),
        pf({ id: "b", riskLevel: "balanced", equity: same, holdings, cash: 100 }),
      ]),
    );
    expect(warnings.some((w) => w.kind === "identical-metrics")).toBe(true);
  });

  it("flags a concentrated book", () => {
    const warnings = checkRiskLadder(
      computeRiskLevelPanel([
        pf({
          id: "h",
          riskLevel: "high",
          equity: curve([1000, 1010]),
          holdings: [
            { symbol: "NVDA", quantity: 9, price: 100 },
            { symbol: "MSFT", quantity: 1, price: 100 },
          ],
        }),
      ]),
    );
    expect(warnings.some((w) => w.kind === "thin-diversification")).toBe(true);
  });
});

function rowsFor(lowCurve: number[], highCurve: number[]) {
  return computeRiskLevelPanel([
    pf({
      id: "l",
      riskLevel: "low",
      equity: curve(lowCurve),
      holdings: [
        { symbol: "A", quantity: 1, price: 10 },
        { symbol: "B", quantity: 1, price: 10 },
      ],
    }),
    pf({
      id: "h",
      riskLevel: "high",
      equity: curve(highCurve),
      holdings: [
        { symbol: "C", quantity: 1, price: 10 },
        { symbol: "D", quantity: 1, price: 10 },
      ],
    }),
  ]);
}
