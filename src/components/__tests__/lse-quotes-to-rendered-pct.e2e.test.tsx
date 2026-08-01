// End-to-end: sample LSE quote data -> valuation kernel -> equity snapshots
// -> rendered holdings cards and equity charts.
//
// This test starts where real data starts: rows as they land in the price
// cache, in the units the provider actually quotes (pence for LSE ordinaries,
// pounds for the GBP-allowlisted ETFs, USD for US names). It then walks the
// production path in order —
//
//   price rows -> computeValuation() (kernel)      -> daily equity snapshots
//               -> buildHoldingSeries()            -> <LiveHoldingsCard/>
//               -> snapshots + baseline            -> <EquityPctChart/>
//
// — and asserts the percentage-change values a user actually reads on screen
// match an independent, hand-written unit-correct calculation. Any regression
// that re-introduces pence/GBP mixing (±9900%, −99%) or double-normalisation
// fails here at the rendered-output level, not just in a helper's unit test.

import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/components/__tests__/render-with-query";
import { LiveHoldingsCard } from "@/components/live-holdings-card";
import { EquityPctChart } from "@/components/equity-pct-chart";
import { buildHoldingSeries, type PricePoint } from "@/lib/build-holding-series";
import { computeValuation } from "@/lib/valuation/kernel";

const OPENED = "2026-07-29";
const DAYS = ["2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01"] as const;

const STARTING_CASH = 10_300;
const CASH_GBP = 1_300.27;
const USDGBP = 0.8;

type Holding = {
  id: string;
  /** Broker-native / cache spelling, deliberately mixed across venues. */
  symbol: string;
  quantity: number;
  /**
   * Persisted cost basis as the sync stores it: base GBP for LSE listings
   * (never pence), native USD for US listings.
   */
  avg_cost: number;
  /** Unit-correct "since purchase" percentage the UI must render. */
  expectedPct: number;
  instrument_ccy: string;
  /** True GBP unit price on each day, used to derive the sample feed. */
  gbp: Record<string, number>;
  /** Raw provider quote unit for this listing. */
  quotedIn: "GBX" | "GBP" | "USD";
};

const HOLDINGS: Holding[] = [
  {
    id: "1",
    symbol: "MKS:xlon",
    quantity: 500,
    avg_cost: 4,
    expectedPct: 5,
    instrument_ccy: "GBX",
    quotedIn: "GBX",
    gbp: { "2026-07-29": 4, "2026-07-30": 4.04, "2026-07-31": 4.1, "2026-08-01": 4.2 },
  },
  {
    id: "2",
    symbol: "HSBA.L",
    quantity: 120,
    avg_cost: 15,
    expectedPct: -5,
    instrument_ccy: "GBX",
    quotedIn: "GBX",
    gbp: { "2026-07-29": 15, "2026-07-30": 14.7, "2026-07-31": 14.4, "2026-08-01": 14.25 },
  },
  {
    id: "3",
    symbol: "VUKE.L", // GBP-allowlisted LSE ETF: quoted in pounds, never /100
    quantity: 50,
    avg_cost: 46,
    expectedPct: 5,
    instrument_ccy: "GBP",
    quotedIn: "GBP",
    gbp: { "2026-07-29": 46, "2026-07-30": 46.92, "2026-07-31": 47.61, "2026-08-01": 48.3 },
  },
  {
    id: "4",
    symbol: "AAPL:xnas", // USD, exercises the FX leg alongside the LSE rows
    quantity: 10,
    avg_cost: 200, // native USD basis: 200 -> 210 is +5%
    expectedPct: 5,
    instrument_ccy: "USD",
    quotedIn: "USD",
    gbp: { "2026-07-29": 160, "2026-07-30": 164, "2026-07-31": 166.4, "2026-08-01": 168 },
  },
];

/** Turn a true GBP price into the raw quote the provider would publish. */
function rawQuote(h: Holding, day: string): number {
  const gbp = h.gbp[day];
  if (h.quotedIn === "GBX") return Math.round(gbp * 100 * 1e6) / 1e6; // pence
  if (h.quotedIn === "USD") return Math.round((gbp / USDGBP) * 1e6) / 1e6;
  return gbp;
}

/** Sample price-cache rows: one raw quote per symbol per day. */
const QUOTES: Array<{ symbol: string; date: string; close: number }> = HOLDINGS.flatMap((h) =>
  DAYS.map((date) => ({ symbol: h.symbol, date, close: rawQuote(h, date) })),
);

function priceLookupFor(day: string) {
  const byKey = new Map(
    QUOTES.filter((q) => q.date === day).map((q) => [q.symbol.toUpperCase(), q.close]),
  );
  return (symbol: string) => byKey.get(String(symbol).toUpperCase()) ?? null;
}

const fx = (from: string, to: string) => {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return 1;
  if (f === "USD" && t === "GBP") return USDGBP;
  return null;
};

/** Independent expectation: quantity * true GBP price, plus cash. */
function expectedEquity(day: string): number {
  const holdings = HOLDINGS.reduce((sum, h) => sum + h.quantity * h.gbp[day], 0);
  return Math.round((holdings + CASH_GBP) * 100) / 100;
}

function valuationFor(day: string) {
  return computeValuation({
    holdings: HOLDINGS.map((h) => ({
      symbol: h.symbol,
      quantity: h.quantity,
      instrument_ccy: h.instrument_ccy,
      // Kernel cost basis is in native quote units; only used as a fallback,
      // which this fixture never needs (every day has a market quote).
      avg_cost: rawQuote(h, OPENED),
    })),
    wallet: { GBP: CASH_GBP },
    baseCcy: "GBP",
    price: priceLookupFor(day),
    fx,
    asOf: `${day}T16:35:00.000Z`,
  });
}

/** Daily equity snapshots as the writer would persist them. */
const SNAPSHOTS = DAYS.map((d) => ({
  snapshot_date: d,
  total_value: valuationFor(d).totalValue,
}));

/** Feed the series builder gets: the SAME raw cache rows, not pre-scaled. */
function feedFor(h: Holding): PricePoint[] {
  return DAYS.map((d) => ({ date: d, close: rawQuote(h, d) }));
}

function seriesBySymbol() {
  const out: Record<string, ReturnType<typeof buildHoldingSeries>> = {};
  for (const h of HOLDINGS) {
    out[h.symbol] = buildHoldingSeries(
      { symbol: h.symbol, quantity: h.quantity, avg_cost: h.avg_cost, opened_at: OPENED },
      feedFor(h),
    );
  }
  return out;
}

function renderHoldingsCard(): string {
  const series = seriesBySymbol();
  return renderWithQuery(
    <LiveHoldingsCard
      holdings={HOLDINGS.map((h) => ({
        id: h.id,
        symbol: h.symbol,
        quantity: h.quantity,
        avg_cost: h.avg_cost,
        instrument_ccy: h.instrument_ccy,
        opened_at: OPENED,
      }))}
      currency="GBP"
      cash={CASH_GBP}
      totalValue={SNAPSHOTS[SNAPSHOTS.length - 1].total_value}
      mode="live_prod"
      series={Object.fromEntries(
        Object.entries(series).map(([k, s]) => [
          k,
          {
            closes: s.closes,
            currentPrice: s.currentPrice,
            pctChangeSincePurchase: s.pctChangeSincePurchase,
            valueChangeSincePurchase: s.valueChangeSincePurchase,
            opened_at: s.opened_at,
          },
        ]),
      )}
    />,
  );
}

function renderEquityChart(): string {
  return renderWithQuery(
    <EquityPctChart
      equity={SNAPSHOTS}
      startingCash={STARTING_CASH}
      inceptionDate={OPENED}
      currency="GBP"
    />,
  );
}

/** Signed "since purchase" percentage rendered for each row. */
function rowPercents(html: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of HOLDINGS) {
    const idx = html.indexOf(`>${h.symbol}<`);
    const slice = idx >= 0 ? html.slice(idx, idx + 4000) : "";
    const raw = slice.match(/([+\-\u2212][\d.,]+%)/)?.[1] ?? "";
    out[h.symbol] = Number(raw.replace(/\u2212/g, "-").replace(/[%+,]/g, ""));
  }
  return out;
}

/** Headline percentage rendered by the equity chart. */
function chartHeadlinePct(html: string): number {
  const raw = html.match(/([+\-\u2212]?\d+\.\d{2})%/)?.[1] ?? "";
  return Number(raw.replace(/\u2212/g, "-"));
}

describe("e2e: LSE quotes -> valuation -> holdings cards & equity charts", () => {
  it("kernel values raw quotes into the hand-computed GBP equity for every day", () => {
    for (const day of DAYS) {
      expect(valuationFor(day).totalValue).toBeCloseTo(expectedEquity(day), 2);
    }
  });

  it("applies the pence divisor exactly once, and never to GBP/USD listings", () => {
    const lines = valuationFor("2026-08-01").provenance.lines;
    const by = (s: string) => lines.find((l) => l.symbol === s)!;
    expect(by("MKS:xlon").unitDivisor).toBe(100);
    expect(by("HSBA.L").unitDivisor).toBe(100);
    expect(by("VUKE.L").unitDivisor).toBe(1);
    expect(by("AAPL:xnas").unitDivisor).toBe(1);
    expect(by("MKS:xlon").baseValue).toBeCloseTo(500 * 4.2, 6);
    expect(by("AAPL:xnas").baseValue).toBeCloseTo(10 * 168, 6);
    expect(valuationFor("2026-08-01").provenance.degraded).toBe(false);
  });

  it("holdings card renders the unit-correct percentage for each ticker", () => {
    const shown = rowPercents(renderHoldingsCard());
    for (const h of HOLDINGS) {
      expect(shown[h.symbol]).toBeCloseTo(h.expectedPct, 1);
    }
    // Spot values, so a wholesale sign/format change cannot pass silently.
    expect(shown["MKS:xlon"]).toBeCloseTo(5, 1);
    expect(shown["HSBA.L"]).toBeCloseTo(-5, 1);
    expect(shown["VUKE.L"]).toBeCloseTo(5, 1);
    expect(shown["AAPL:xnas"]).toBeCloseTo(5, 1);
  });

  it("equity chart headline equals equity vs invested capital", () => {
    const last = SNAPSHOTS[SNAPSHOTS.length - 1].total_value;
    const expected = ((last - STARTING_CASH) / STARTING_CASH) * 100;
    expect(chartHeadlinePct(renderEquityChart())).toBeCloseTo(expected, 2);
  });

  it("card invested + cash reconcile to the equity the chart plots", () => {
    const html = renderHoldingsCard();
    const total = SNAPSHOTS[SNAPSHOTS.length - 1].total_value;
    expect(total).toBeCloseTo(expectedEquity("2026-08-01"), 2);
    // Invested is the kernel's holdings value, rendered in pounds.
    expect(html).toContain("GBP 7,905.00");
    expect(html).toContain("GBP 1,300.27");
    expect(7905 + CASH_GBP).toBeCloseTo(total, 2);
  });

  it("charted closes are base-currency and anchored on the GBP cost basis", () => {
    const series = seriesBySymbol();
    expect(series["MKS:xlon"].closes).toEqual([4, 4, 4.04, 4.1, 4.2]);
    expect(series["VUKE.L"].closes).toEqual([46, 46, 46.92, 47.61, 48.3]);
    for (const h of HOLDINGS) {
      const s = series[h.symbol];
      expect(Math.max(...s.closes) / Math.min(...s.closes)).toBeLessThan(2);
    }
  });

  it("no rendered surface shows a 100x unit-mixing signature", () => {
    for (const html of [renderHoldingsCard(), renderEquityChart()]) {
      expect(html).not.toMatch(/[+-]?9\d{3}(\.\d+)?%/);
      expect(html).not.toMatch(/-9[89](\.\d+)?%/);
    }
  });

  it("rendered holdings + equity output snapshot", () => {
    expect({
      snapshots: SNAPSHOTS,
      rowPercents: rowPercents(renderHoldingsCard()),
      chartPct: chartHeadlinePct(renderEquityChart()),
    }).toMatchSnapshot();
  });
});
