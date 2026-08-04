import { describe, expect, it } from "vitest";
import {
  analysePositions,
  buildPortfolioDataQuality,
  describeCashReconstruction,
  fillCoverage,
  summariseDataQuality,
  type DqFill,
  type DqHolding,
} from "../data-quality-report";

const fx = new Map<string, number>([
  ["GBP", 1],
  ["USD", 0.8],
]);

const buy = (symbol: string, quantity: number, price: number, at: string): DqFill => ({
  symbol,
  side: "buy",
  quantity,
  fill_price: price,
  filled_at: at,
});
const sell = (symbol: string, quantity: number, price: number, at: string): DqFill => ({
  ...buy(symbol, quantity, price, at),
  side: "sell",
});

describe("fillCoverage", () => {
  it("nets buys and sells per canonical symbol across spellings", () => {
    const cov = fillCoverage([
      buy("ISF.L", 100, 8, "2026-07-01T10:00:00Z"),
      buy("ISF:xlon", 50, 8.2, "2026-07-03T10:00:00Z"),
      sell("ISF", 30, 8.5, "2026-07-05T10:00:00Z"),
    ]);
    expect(cov.size).toBe(1);
    const entry = cov.get("ISF")!;
    expect(entry.bought).toBe(150);
    expect(entry.sold).toBe(30);
    expect(entry.buys).toBe(2);
    expect(entry.firstAt).toBe("2026-07-01");
  });

  it("ignores zero and non-numeric quantities", () => {
    expect(fillCoverage([buy("V", 0, 300, "2026-07-01T00:00:00Z")]).size).toBe(0);
  });
});

describe("analysePositions", () => {
  it("marks a fully backed position as coming from the fills ledger", () => {
    const holdings: DqHolding[] = [
      { symbol: "AAPL", quantity: 10, avg_cost: 200, instrument_ccy: "USD", opened_at: "2026-07-01" },
    ];
    const [p] = analysePositions(holdings, [buy("AAPL", 10, 200, "2026-07-01T10:00:00Z")], "GBP", fx);
    expect(p!.costBasisSource).toBe("fills_ledger");
    expect(p!.coverage).toBe(1);
    expect(p!.unbackedQuantity).toBe(0);
    expect(p!.unbackedCostBase).toBe(0);
    expect(p!.severity).toBe("ok");
    expect(p!.explanation).toContain("replay from 1 buy fill");
  });

  it("flags a broker-imported position with no fills and prices its cost basis in base ccy", () => {
    const [p] = analysePositions(
      [{ symbol: "JNJ:xnys", quantity: 100, avg_cost: 150, instrument_ccy: "USD", opened_at: "2026-07-27T09:00:00Z" }],
      [],
      "GBP",
      fx,
    );
    expect(p!.costBasisSource).toBe("broker_avg_cost");
    expect(p!.backedQuantity).toBe(0);
    expect(p!.unbackedQuantity).toBe(100);
    // 100 × 150 USD × 0.8 = 12,000 GBP
    expect(p!.unbackedCostBase).toBe(12000);
    expect(p!.severity).toBe("info");
    expect(p!.explanation).toContain("broker's average cost");
    expect(p!.explanation).toContain("2026-07-27");
  });

  it("reports a mixed basis when only part of the position is backed by fills", () => {
    const [p] = analysePositions(
      [{ symbol: "V", quantity: 100, avg_cost: 300, instrument_ccy: "USD", opened_at: "2026-07-20" }],
      [buy("V", 40, 300, "2026-07-20T10:00:00Z")],
      "GBP",
      fx,
    );
    expect(p!.costBasisSource).toBe("mixed");
    expect(p!.backedQuantity).toBe(40);
    expect(p!.unbackedQuantity).toBe(60);
    expect(p!.coverage).toBeCloseTo(0.4, 6);
    expect(p!.unbackedCostBase).toBe(60 * 300 * 0.8);
  });

  it("treats sold shares as consuming ledger backing first", () => {
    const [p] = analysePositions(
      [{ symbol: "AAPL", quantity: 10, avg_cost: 200, instrument_ccy: "USD" }],
      [buy("AAPL", 30, 200, "2026-07-01T10:00:00Z"), sell("AAPL", 25, 210, "2026-07-10T10:00:00Z")],
      "GBP",
      fx,
    );
    expect(p!.backedQuantity).toBe(5);
    expect(p!.unbackedQuantity).toBe(5);
    expect(p!.costBasisSource).toBe("mixed");
  });

  it("warns when there is neither a fill nor a usable average cost", () => {
    const [p] = analysePositions(
      [{ symbol: "SGLN:xlon", quantity: 40, avg_cost: 0, instrument_ccy: "GBP" }],
      [],
      "GBP",
      fx,
    );
    expect(p!.costBasisSource).toBe("unknown");
    expect(p!.severity).toBe("warn");
    expect(p!.unbackedCostBase).toBe(0);
    expect(p!.explanation).toContain("excluded from historical cash rollback");
  });

  it("skips dust and non-positive quantities", () => {
    expect(
      analysePositions([{ symbol: "X", quantity: 0 }, { symbol: "Y", quantity: 1e-9 }], [], "GBP", fx),
    ).toEqual([]);
  });

  it("orders positions by the size of the unexplained cost", () => {
    const rows = analysePositions(
      [
        { symbol: "SMALL", quantity: 1, avg_cost: 10, instrument_ccy: "GBP" },
        { symbol: "BIG", quantity: 1000, avg_cost: 10, instrument_ccy: "GBP" },
      ],
      [],
      "GBP",
      fx,
    );
    expect(rows.map((r) => r.symbol)).toEqual(["BIG", "SMALL"]);
  });
});

describe("describeCashReconstruction", () => {
  const positions = analysePositions(
    [{ symbol: "JNJ", quantity: 10, avg_cost: 100, instrument_ccy: "USD", opened_at: "2026-07-27" }],
    [],
    "GBP",
    fx,
  );

  it("anchors on the newest snapshot and lists every rollback leg", () => {
    const c = describeCashReconstruction({
      snapshots: [
        { snapshot_date: "2026-08-01", cash: 100 },
        { snapshot_date: "2026-08-04", cash: 250 },
      ],
      portfolioCash: 999,
      fills: [buy("AAPL", 10, 200, "2026-07-30T10:00:00Z"), sell("AAPL", 5, 210, "2026-08-02T10:00:00Z")],
      fundEvents: [{ at: "2026-07-28T00:00:00Z", amount: 1000 }],
      positions,
      baseCcy: "GBP",
      fx,
    });
    expect(c.anchorSource).toBe("latest_snapshot");
    expect(c.anchorDate).toBe("2026-08-04");
    expect(c.anchorCash).toBe(250);
    expect(c.reconstructible).toBe(true);
    const kinds = c.legs.map((l) => l.kind);
    expect(kinds).toEqual(["buy_fill", "sell_fill", "fund_event", "unbacked_opening"]);
    expect(c.legs.find((l) => l.kind === "buy_fill")!.amountBase).toBe(1600);
    expect(c.legs.find((l) => l.kind === "sell_fill")!.amountBase).toBe(-840);
    expect(c.legs.find((l) => l.kind === "fund_event")!.amountBase).toBe(-1000);
    expect(c.legs.find((l) => l.kind === "unbacked_opening")!.amountBase).toBe(800);
    expect(c.explanation).toContain("rolled backwards");
  });

  it("falls back to the portfolio balance when snapshots carry no cash", () => {
    const c = describeCashReconstruction({
      snapshots: [{ snapshot_date: "2026-08-04", cash: null }],
      portfolioCash: 4200,
      fills: [],
      fundEvents: [],
      positions: [],
      baseCcy: "GBP",
      fx,
    });
    expect(c.anchorSource).toBe("portfolio_cash");
    expect(c.anchorCash).toBe(4200);
  });

  it("reports that history cannot be rebuilt with no anchor at all", () => {
    const c = describeCashReconstruction({
      snapshots: [],
      portfolioCash: null,
      fills: [],
      fundEvents: [],
      positions: [],
      baseCcy: "GBP",
      fx,
    });
    expect(c.anchorSource).toBe("none");
    expect(c.reconstructible).toBe(false);
    expect(c.explanation).toContain("cannot be rebuilt");
  });

  it("blocks reconstruction when a fill has no usable price", () => {
    const c = describeCashReconstruction({
      snapshots: [{ snapshot_date: "2026-08-04", cash: 100 }],
      portfolioCash: 100,
      fills: [{ symbol: "V", side: "buy", quantity: 3, fill_price: 0, filled_at: "2026-08-01T00:00:00Z" }],
      fundEvents: [],
      positions: [],
      baseCcy: "GBP",
      fx,
    });
    expect(c.reconstructible).toBe(false);
    expect(c.blockers[0]).toContain("no usable price");
    expect(c.explanation).toContain("keep their stored balance");
  });
});

describe("buildPortfolioDataQuality / summariseDataQuality", () => {
  const clean = buildPortfolioDataQuality({
    portfolioId: "p-clean",
    portfolioName: "Clean",
    mode: "paper",
    baseCcy: "GBP",
    holdings: [{ symbol: "AAPL", quantity: 10, avg_cost: 200, instrument_ccy: "USD" }],
    fills: [buy("AAPL", 10, 200, "2026-07-01T10:00:00Z")],
    snapshots: [{ snapshot_date: "2026-08-04", cash: 500 }],
    fx,
  });

  const imported = buildPortfolioDataQuality({
    portfolioId: "p-import",
    portfolioName: "Broker imported",
    mode: "live_sim",
    baseCcy: "GBP",
    holdings: [
      { symbol: "JNJ:xnys", quantity: 100, avg_cost: 150, instrument_ccy: "USD", opened_at: "2026-07-27" },
      { symbol: "AAPL", quantity: 10, avg_cost: 200, instrument_ccy: "USD" },
    ],
    fills: [buy("AAPL", 10, 200, "2026-07-01T10:00:00Z")],
    snapshots: [{ snapshot_date: "2026-08-04", cash: 500 }],
    fx,
  });

  it("reports a clean portfolio as ok with no unexplained cost", () => {
    expect(clean.severity).toBe("ok");
    expect(clean.summary).toMatchObject({ positions: 1, fullyBacked: 1, unbacked: 0, unbackedCostBase: 0 });
  });

  it("counts broker-imported positions and their cost", () => {
    expect(imported.severity).toBe("info");
    expect(imported.summary.unbacked).toBe(1);
    expect(imported.summary.fullyBacked).toBe(1);
    expect(imported.summary.unbackedCostBase).toBe(12000);
    expect(imported.cash.legs.some((l) => l.kind === "unbacked_opening")).toBe(true);
  });

  it("sorts problem portfolios first and totals the gaps", () => {
    const report = summariseDataQuality([clean, imported], "2026-08-04T00:00:00Z");
    expect(report.portfolios.map((p) => p.portfolioId)).toEqual(["p-import", "p-clean"]);
    expect(report.totals).toEqual({
      portfolios: 2,
      positions: 3,
      unbackedPositions: 1,
      partiallyBackedPositions: 0,
      portfoliosWithGaps: 1,
    });
    expect(report.generatedAt).toBe("2026-08-04T00:00:00Z");
  });

  it("is deterministic for identical inputs", () => {
    const again = buildPortfolioDataQuality({
      portfolioId: "p-import",
      portfolioName: "Broker imported",
      mode: "live_sim",
      baseCcy: "GBP",
      holdings: [
        { symbol: "JNJ:xnys", quantity: 100, avg_cost: 150, instrument_ccy: "USD", opened_at: "2026-07-27" },
        { symbol: "AAPL", quantity: 10, avg_cost: 200, instrument_ccy: "USD" },
      ],
      fills: [buy("AAPL", 10, 200, "2026-07-01T10:00:00Z")],
      snapshots: [{ snapshot_date: "2026-08-04", cash: 500 }],
      fx,
    });
    expect(again).toEqual(imported);
  });
});
