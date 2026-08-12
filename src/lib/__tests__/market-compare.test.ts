import { describe, expect, it } from "vitest";

import {
  MAX_COMPARE_SYMBOLS,
  buildComparison,
  buildRollingCorrelation,
  clusterCorrelation,
  parseCompareParam,
  serialiseCompareParam,
  toggleCompareSymbol,
} from "../market-compare";
import type { HistoryPoint, SymbolHistory } from "../market-symbol-history";

function history(symbol: string, series: Array<[string, number]>): SymbolHistory {
  const points: HistoryPoint[] = series.map(([date, close]) => ({
    date,
    close,
    indexed: 100,
    sma20: null,
    sma50: null,
    sma100: null,
    sma200: null,
  }));
  return {
    symbol,
    label: symbol.toUpperCase(),
    kind: "Market",
    days: 90,
    points,
    last: points.at(-1)?.close ?? null,
    asOf: points.at(-1)?.date ?? null,
    changePct: null,
    changeAbs: null,
    high: null,
    low: null,
    volatilityPct: null,
    maxDrawdownPct: null,
    rsi14: null,
    sma50: null,
    sma200: null,
    aboveSma50: null,
    aboveSma200: null,
    smaLatest: { 20: null, 50: null, 100: null, 200: null },
    aboveSma: { 20: null, 50: null, 100: null, 200: null },
  };
}

describe("compare param handling", () => {
  it("parses, dedupes and drops the primary symbol", () => {
    expect(parseCompareParam("^GSPC, GLD ,^GSPC,BTC", "^GSPC")).toEqual(["GLD", "BTC"]);
  });

  it("caps the list", () => {
    expect(parseCompareParam("A,B,C,D,E,F")).toHaveLength(MAX_COMPARE_SYMBOLS);
  });

  it("round-trips through serialise", () => {
    expect(serialiseCompareParam(["A", "B"])).toBe("A,B");
    expect(serialiseCompareParam([])).toBeUndefined();
  });

  it("toggles on and off and respects the cap", () => {
    expect(toggleCompareSymbol(["A"], "B")).toEqual(["A", "B"]);
    expect(toggleCompareSymbol(["A", "B"], "A")).toEqual(["B"]);
    const full = ["A", "B", "C", "D"];
    expect(toggleCompareSymbol(full, "E")).toEqual(full);
  });
});

describe("buildComparison", () => {
  it("rebases every series to 100 on the shared start date", () => {
    const cmp = buildComparison([
      history("A", [
        ["2026-01-01", 100],
        ["2026-01-02", 110],
        ["2026-01-03", 120],
      ]),
      // B starts a day later, so the shared window is Jan 2-3.
      history("B", [
        ["2026-01-02", 50],
        ["2026-01-03", 45],
      ]),
    ]);

    expect(cmp.from).toBe("2026-01-02");
    expect(cmp.to).toBe("2026-01-03");
    expect(cmp.points[0]["A"]).toBe(100);
    expect(cmp.points[0]["B"]).toBe(100);
    // A: 110 -> 120 = +9.09%, B: 50 -> 45 = -10%
    expect(cmp.series[0].changePct).toBeCloseTo(9.0909, 3);
    expect(cmp.series[1].changePct).toBeCloseTo(-10, 6);
  });

  it("reports peak, trough and drawdown inside the shared window", () => {
    const cmp = buildComparison([
      history("A", [
        ["2026-01-01", 100],
        ["2026-01-02", 120],
        ["2026-01-03", 90],
      ]),
    ]);
    expect(cmp.series[0].peakPct).toBeCloseTo(20, 6);
    expect(cmp.series[0].troughPct).toBeCloseTo(-10, 6);
    expect(cmp.series[0].maxDrawdownPct).toBeCloseTo(-25, 6);
  });

  it("gives each series a distinct colour", () => {
    const cmp = buildComparison([
      history("A", [
        ["2026-01-01", 1],
        ["2026-01-02", 2],
      ]),
      history("B", [
        ["2026-01-01", 1],
        ["2026-01-02", 2],
      ]),
    ]);
    expect(cmp.series[0].color).not.toBe(cmp.series[1].color);
  });

  it("returns an empty comparison when the overlap is too short", () => {
    const cmp = buildComparison([
      history("A", [
        ["2026-01-01", 1],
        ["2026-01-02", 2],
      ]),
      history("B", [
        ["2026-02-01", 1],
        ["2026-02-02", 2],
      ]),
    ]);
    expect(cmp.points).toEqual([]);
    expect(cmp.series).toEqual([]);
  });
});

describe("correlation matrix", () => {
  const hist = (symbol: string, closes: number[]) => ({
    symbol,
    label: symbol,
    kind: "index",
    points: closes.map((close, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      close,
    })),
  }) as never;

  const wave = (n: number, sign: number, base = 100) =>
    Array.from({ length: n }, (_, i) => base * (1 + sign * 0.01 * (i % 2 === 0 ? 1 : -1) * (1 + i / 50)));

  it("returns +1 on the diagonal and −1 for mirrored series", () => {
    const a = wave(30, 1);
    const b = wave(30, -1);
    const { correlation } = buildComparison([hist("A", a), hist("B", b)]);
    expect(correlation.symbols).toEqual(["A", "B"]);
    expect(correlation.cells[0][0].value).toBe(1);
    expect(correlation.cells[0][1].value).toBeLessThan(-0.9);
    expect(correlation.cells[0][1].value).toBe(correlation.cells[1][0].value);
  });

  it("suppresses correlations with too few overlapping returns", () => {
    const { correlation } = buildComparison([
      hist("A", [100, 101, 102, 103]),
      hist("B", [50, 51, 50, 52]),
    ]);
    expect(correlation.cells[0][1].value).toBeNull();
    expect(correlation.cells[0][1].n).toBeLessThan(10);
  });

  it("is empty when there is no shared window", () => {
    const { correlation } = buildComparison([]);
    expect(correlation.cells).toEqual([]);
  });
});

describe("rolling correlation", () => {
  const days = 140;
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

  function history(symbol: string, closes: number[]): SymbolHistory {
    return {
      symbol,
      label: symbol,
      kind: "Market",
      points: closes.map((close, i) => ({ date: dates[i], close })),
      changePct: 0,
      asOf: dates[dates.length - 1],
    } as unknown as SymbolHistory;
  }

  // A moves on a fixed wave; B tracks it for the first half then inverts.
  const a: number[] = [];
  const b: number[] = [];
  let pa = 100;
  let pb = 100;
  for (let i = 0; i < days; i++) {
    const step = i % 2 === 0 ? 0.01 : -0.008;
    pa *= 1 + step;
    pb *= 1 + (i < days / 2 ? step : -step);
    a.push(Number(pa.toFixed(4)));
    b.push(Number(pb.toFixed(4)));
  }

  const comparison = buildComparison([history("AAA", a), history("BBB", b)]);

  it("exposes aligned returns for rolling analysis", () => {
    expect(Object.keys(comparison.returns).sort()).toEqual(["AAA", "BBB"]);
    expect(comparison.returns.AAA).toHaveLength(comparison.dates.length);
    expect(comparison.returns.AAA[0]).toBeNull();
  });

  it("tracks a relationship that flips inside the window", () => {
    const rolling = buildRollingCorrelation(comparison, 30);
    expect(rolling.window).toBe(30);
    expect(rolling.pairs).toHaveLength(1);

    const pair = rolling.pairs[0];
    const early = pair.values.find((v) => v != null)!;
    expect(early).toBeGreaterThan(0.9);
    expect(pair.latest).toBeLessThan(-0.9);
    expect(pair.min).toBeLessThan(pair.max!);
    expect(rolling.dates).toHaveLength(pair.values.length);
  });

  it("leaves points blank until the window has enough observations", () => {
    const rolling = buildRollingCorrelation(comparison, 90);
    const firstIdx = rolling.pairs[0].values.findIndex((v) => v != null);
    expect(firstIdx).toBe(0);
    expect(rolling.dates.length).toBeLessThan(comparison.dates.length);
  });

  it("returns no pairs for a single symbol", () => {
    const single = buildComparison([history("AAA", a)]);
    expect(buildRollingCorrelation(single, 30).pairs).toEqual([]);
  });
});

describe("correlation clustering", () => {
  const symbols = ["A", "B", "C", "D"];
  const labels = symbols;
  // A & C move together, B & D move together, blocks are uncorrelated.
  const r: Record<string, number> = {
    "A|C": 0.95,
    "B|D": 0.9,
    "A|B": 0.05,
    "A|D": 0.0,
    "C|B": -0.02,
    "C|D": 0.03,
  };
  const cells = symbols.map((a) =>
    symbols.map((b) => {
      if (a === b) return { value: 1, n: 100 };
      const v = r[`${a}|${b}`] ?? r[`${b}|${a}`]!;
      return { value: v, n: 100 };
    }),
  );
  const matrix = { symbols, labels, cells, observations: 100 };

  it("puts co-moving markets next to each other", () => {
    const { matrix: out, groups } = clusterCorrelation(matrix);
    const pos = (s: string) => out.symbols.indexOf(s);
    expect(Math.abs(pos("A") - pos("C"))).toBe(1);
    expect(Math.abs(pos("B") - pos("D"))).toBe(1);
    expect(groups[pos("A")]).toBe(groups[pos("C")]);
    expect(groups[pos("B")]).toBe(groups[pos("D")]);
    expect(groups[pos("A")]).not.toBe(groups[pos("B")]);
  });

  it("keeps the matrix consistent after reordering", () => {
    const { matrix: out, order } = clusterCorrelation(matrix);
    expect([...out.symbols].sort()).toEqual([...symbols].sort());
    out.symbols.forEach((_, i) => {
      expect(out.cells[i][i].value).toBe(1);
      out.symbols.forEach((__, j) => {
        expect(out.cells[i][j].value).toBe(cells[order[i]][order[j]].value);
      });
    });
  });

  it("leaves two-symbol matrices untouched", () => {
    const small = {
      symbols: ["A", "B"],
      labels: ["A", "B"],
      cells: [
        [{ value: 1, n: 20 }, { value: -0.9, n: 20 }],
        [{ value: -0.9, n: 20 }, { value: 1, n: 20 }],
      ],
      observations: 20,
    };
    const out = clusterCorrelation(small);
    expect(out.matrix.symbols).toEqual(["A", "B"]);
    expect(out.order).toEqual([0, 1]);
  });

  it("treats unmeasurable pairs as unrelated without crashing", () => {
    const gappy = {
      ...matrix,
      cells: cells.map((row, i) => row.map((c, j) => (i === 0 && j === 3 ? { value: null, n: 2 } : c))),
    };
    const out = clusterCorrelation(gappy);
    expect(out.matrix.symbols).toHaveLength(4);
    expect(out.groups).toHaveLength(4);
  });
});
