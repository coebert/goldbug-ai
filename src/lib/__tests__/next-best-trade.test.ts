import { describe, expect, it } from "vitest";
import {
  rankNextBuys,
  scoreConviction,
  type NextBuyCandidate,
  type NextBuyInput,
} from "../next-best-trade";

const base: NextBuyCandidate = {
  symbol: "MSFT:xnas",
  name: "Microsoft",
  assetClass: "stock",
  price: 400,
  currency: "USD",
  fxToBase: 0.75,
  atrPct: 0.02,
  rsi14: 55,
  change5d: 0.01,
  change30d: 0.04,
  macdHist: 0.4,
  sma20: 390,
  sma50: 380,
  sma200: 350,
  weeklyTrendUp: true,
  heldQuantity: 2,
  heldValueBase: 600,
};

const input: NextBuyInput = {
  candidates: [base],
  navBase: 10_000,
  cashBase: 8_000,
  minTicketBase: 250,
  safetyMultiple: 1.25,
  measuredRoundTripBps: 90,
};

describe("scoreConviction", () => {
  it("rewards a clean uptrend", () => {
    const { conviction, signals } = scoreConviction(base);
    expect(conviction).toBeGreaterThan(0.7);
    expect(signals.join(" ")).toContain("20-day");
  });

  it("penalises an overbought run", () => {
    const hot = scoreConviction({ ...base, rsi14: 82 });
    const calm = scoreConviction(base);
    expect(hot.conviction).toBeLessThan(calm.conviction);
    expect(hot.signals.join(" ")).toContain("stretched");
  });

  it("floors at zero for a broken chart", () => {
    const weak = scoreConviction({
      ...base,
      price: 300,
      sma20: 390,
      sma50: 400,
      sma200: 420,
      weeklyTrendUp: false,
      macdHist: -1,
      change5d: -0.05,
      change30d: -0.2,
      rsi14: 78,
    });
    expect(weak.conviction).toBe(0);
  });
});

describe("rankNextBuys", () => {
  it("suggests a fee-viable ticket in portfolio currency", () => {
    const [row] = rankNextBuys(input);
    expect(row).toBeDefined();
    expect(row!.symbol).toBe("MSFT:xnas");
    expect(row!.quantity).toBeGreaterThan(0);
    // 12% of a 10k book at a 300 GBP share price -> 4 shares.
    expect(row!.ticketBase).toBeCloseTo(row!.quantity * 300, 6);
    expect(row!.costBase).toBeGreaterThan(0);
    expect(row!.recommended).toBe(true);
    expect(row!.expectedProfitBase).toBeGreaterThan(0);
  });

  it("never suggests more than the position cap allows", () => {
    const [row] = rankNextBuys({
      ...input,
      candidates: [{ ...base, heldValueBase: 1_400 }],
      maxPositionPctOfNav: 0.15,
    });
    // Cap room is 100 GBP, below one 300 GBP share, so nothing is suggested.
    expect(row).toBeUndefined();
  });

  it("gives broad trackers the wider cap", () => {
    const tracker: NextBuyCandidate = {
      ...base,
      symbol: "VWRL.L",
      name: "Vanguard FTSE All-World",
      assetClass: "etf",
      currency: "GBP",
      fxToBase: 1,
      price: 100,
      heldValueBase: 1_600,
      diversified: true,
    };
    const tight = rankNextBuys({ ...input, candidates: [{ ...tracker, diversified: false }] });
    const wide = rankNextBuys({ ...input, candidates: [tracker] });
    expect(wide[0]!.ticketBase).toBeGreaterThan(tight[0]?.ticketBase ?? 0);
  });

  it("keeps blocked ideas behind recommended ones and explains them", () => {
    const weak: NextBuyCandidate = {
      ...base,
      symbol: "TSCO.L",
      currency: "GBP",
      fxToBase: 1,
      price: 3,
      atrPct: 0.002,
      rsi14: 80,
      change5d: -0.03,
      change30d: -0.08,
      macdHist: -0.2,
      sma20: 3.4,
      sma50: 3.6,
      sma200: 3.8,
      weeklyTrendUp: false,
      heldQuantity: 100,
      heldValueBase: 300,
    };
    const rows = rankNextBuys({ ...input, candidates: [weak, base] });
    expect(rows[0]!.symbol).toBe("MSFT:xnas");
    expect(rows[1]!.recommended).toBe(false);
    expect(rows[1]!.blockedReason).toBeTruthy();
  });

  it("ignores names the book does not hold", () => {
    expect(rankNextBuys({ ...input, candidates: [{ ...base, heldQuantity: 0 }] })).toEqual([]);
  });

  it("recommends nothing when there is no cash, but explains why", () => {
    const rows = rankNextBuys({ ...input, cashBase: 10 });
    expect(rows.every((r) => !r.recommended)).toBe(true);
    for (const r of rows) expect(r.blockedReason).toMatch(/not enough spare cash/);
  });
});

describe("cash reserve sizing", () => {
  const candidate = {
    symbol: "AAA",
    price: 100,
    currency: "GBP",
    fxToBase: 1,
    heldQuantity: 10,
    heldValueBase: 1000,
    sma20: 90,
    sma50: 85,
    sma200: 80,
    atrPct: 3,
  };

  it("sizes out of cash above the reserve only", () => {
    const rows = rankNextBuys({
      candidates: [candidate as never],
      navBase: 10_000,
      cashBase: 3000,
      cashReserveBase: 450,
      minTicketBase: 250,
      maxCashSharePct: 0.6,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ticketBase).toBeLessThanOrEqual((3000 - 450) * 0.6 + 1);
  });

  it("blocks when spare cash cannot fund a viable ticket", () => {
    const rows = rankNextBuys({
      candidates: [candidate as never],
      navBase: 10_000,
      cashBase: 500,
      cashReserveBase: 450,
      minTicketBase: 250,
    });
    expect(rows[0]!.recommended).toBe(false);
    expect(rows[0]!.blockedReason).toMatch(/not enough spare cash/);
  });
});
