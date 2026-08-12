// Visual regression: holdings cards + equity sparklines must render
// percentage-change values that are consistent with the *units* of the
// underlying data on LSE tickers.
//
// Two 100x failure modes are locked out here:
//   1. GBX feed close treated as GBP against a GBP cost basis  → "-99%"
//   2. GBP cost basis divided a second time on the read path   → "+9900%"
//
// The test builds the series exactly as the server does (`buildHoldingSeries`
// over raw feed closes: pence for MKS/HSBA/TSCO, pounds for VUKE, USD for
// AAPL), renders <LiveHoldingsCard/> and <Sparkline/> from that payload, and
// snapshots the extracted per-row labels plus the sparkline geometry. Any
// drift in unit handling, formatter config, or row markup fails the snapshot.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderWithQuery } from "@/components/__tests__/render-with-query";
import { LiveHoldingsCard } from "@/components/live-holdings-card";
import { Sparkline } from "@/components/sparkline";
import { buildHoldingSeries, type PricePoint } from "@/lib/build-holding-series";

type Row = {
  id: string;
  symbol: string;
  quantity: number;
  /** Persisted cost basis — ALWAYS base currency (GBP here). */
  avg_cost: number;
  instrument_ccy: string;
  /** Raw feed closes, in whatever unit the provider quotes. */
  feed: PricePoint[];
};

const OPENED = "2026-07-29";

// Each row is priced so the true move is a clean, small percentage:
// MKS  £4.0000 → 420p  = £4.20  → +5%
// HSBA £15.0000 → 1425p = £14.25 → -5%
// TSCO £4.0000 → 440p  = £4.40  → +10%
// VUKE £46.0000 → 48.30 (already GBP) → +5%
// AAPL £200.00 → 210.00 → +5%
const ROWS: Row[] = [
  {
    id: "1",
    symbol: "MKS:xlon",
    quantity: 879,
    avg_cost: 4,
    instrument_ccy: "GBX",
    feed: [
      { date: "2026-07-29", close: 400 },
      { date: "2026-07-31", close: 410 },
      { date: "2026-08-01", close: 420 },
    ],
  },
  {
    id: "2",
    symbol: "HSBA.L",
    quantity: 120,
    avg_cost: 15,
    instrument_ccy: "GBX",
    feed: [
      { date: "2026-07-29", close: 1500 },
      { date: "2026-07-31", close: 1470 },
      { date: "2026-08-01", close: 1425 },
    ],
  },
  {
    id: "3",
    symbol: "TSCO.L",
    quantity: 300,
    avg_cost: 4,
    instrument_ccy: "GBX",
    feed: [
      { date: "2026-07-29", close: 400 },
      { date: "2026-08-01", close: 440 },
    ],
  },
  {
    id: "4",
    symbol: "VUKE.L",
    quantity: 50,
    avg_cost: 46,
    instrument_ccy: "GBP",
    feed: [
      { date: "2026-07-29", close: 46 },
      { date: "2026-08-01", close: 48.3 },
    ],
  },
  {
    id: "5",
    symbol: "AAPL",
    quantity: 10,
    avg_cost: 200,
    instrument_ccy: "USD",
    feed: [
      { date: "2026-07-29", close: 200 },
      { date: "2026-08-01", close: 210 },
    ],
  },
];

const EXPECTED_PCT: Record<string, number> = {
  "MKS:xlon": 0.05,
  "HSBA.L": -0.05,
  "TSCO.L": 0.1,
  "VUKE.L": 0.05,
  AAPL: 0.05,
};

function buildSeries() {
  const series: Record<string, ReturnType<typeof buildHoldingSeries>> = {};
  for (const r of ROWS) {
    series[r.symbol] = buildHoldingSeries(
      { symbol: r.symbol, quantity: r.quantity, avg_cost: r.avg_cost, opened_at: OPENED },
      r.feed,
    );
  }
  return series;
}

function renderCard() {
  const series = buildSeries();
  return renderWithQuery(
    <LiveHoldingsCard
      holdings={ROWS.map((r) => ({
        id: r.id,
        symbol: r.symbol,
        quantity: r.quantity,
        avg_cost: r.avg_cost,
        instrument_ccy: r.instrument_ccy,
        opened_at: OPENED,
      }))}
      currency="GBP"
      cash={1300.27}
      totalValue={12000}
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

/** Pull "SYMBOL … qty @ GBP avg … ±x.xx%" triples out of the rendered card. */
function extractRowLabels(html: string) {
  const out: Array<{ symbol: string; unitCost: string; pct: string }> = [];
  for (const r of ROWS) {
    const idx = html.indexOf(`>${r.symbol}<`);
    const slice = idx >= 0 ? html.slice(idx, idx + 4000) : "";
    const unitCost = slice.match(/@ GBP\s*(?:<!-- -->)?\s*([\d.,]+)/)?.[1] ?? "";
    // Signed value = the "since purchase" change; "% of portfolio" is unsigned.
    const pct = slice.match(/([+\-\u2212][\d.,]+%)/)?.[1] ?? "";
    out.push({ symbol: r.symbol, unitCost, pct });
  }
  return out;
}

describe("holdings card + equity charts — LSE unit/percentage visual parity", () => {
  // The card renders "today" into axis labels/captions, so the markup snapshot
  // would otherwise drift every calendar day. Pin the clock.
  beforeAll(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("per-row cost basis and percentage labels snapshot", () => {
    expect(extractRowLabels(renderCard())).toMatchSnapshot();
  });

  it("full holdings card markup snapshot", () => {
    expect(renderCard()).toMatchSnapshot();
  });

  it("rendered percentages equal the unit-correct computation", () => {
    const labels = extractRowLabels(renderCard());
    for (const { symbol, pct } of labels) {
      const expected = EXPECTED_PCT[symbol] * 100;
      const shown = Number(pct.replace(/\u2212/g, "-").replace(/[%+,]/g, ""));
      expect(Math.abs(shown - expected)).toBeLessThan(0.05);
    }
  });

  it("cost basis is displayed in pounds, never pence or pence/100", () => {
    for (const { symbol, unitCost } of extractRowLabels(renderCard())) {
      const shown = Number(unitCost.replace(/,/g, ""));
      const expected = ROWS.find((r) => r.symbol === symbol)!.avg_cost;
      expect(shown).toBeCloseTo(expected, 2);
    }
  });

  it("no row renders a 100x unit-mixing signature", () => {
    const html = renderCard();
    expect(html).not.toMatch(/[+-]?9\d{3}(\.\d+)?%/);
    expect(html).not.toMatch(/-9[89](\.\d+)?%/);
    expect(html).not.toMatch(/@ GBP\s*(?:<!-- -->)?\s*0\.0[0-4]\b/);
  });

  it("equity sparkline geometry snapshot per ticker", () => {
    const series = buildSeries();
    const geometry: Record<string, string> = {};
    for (const r of ROWS) {
      const html = renderToStaticMarkup(
        <Sparkline values={series[r.symbol].closes} width={120} height={36} />,
      );
      geometry[r.symbol] = html.match(/<path d="M([^"]+)" fill="none"/)?.[1] ?? "";
    }
    expect(geometry).toMatchSnapshot();
  });

  it("sparkline direction matches the sign of the percentage change", () => {
    const series = buildSeries();
    for (const r of ROWS) {
      const s = series[r.symbol];
      const html = renderToStaticMarkup(<Sparkline values={s.closes} width={120} height={36} />);
      const up = html.includes("#4ade80");
      expect(up).toBe((s.pctChangeSincePurchase ?? 0) >= 0);
      // The series is anchored on the GBP cost basis, so the plotted span
      // can never be a 100x cliff.
      const lo = Math.min(...s.closes);
      const hi = Math.max(...s.closes);
      expect(hi / lo).toBeLessThan(2);
    }
  });

  it("charted closes are in base currency for both pence and GBP feeds", () => {
    const series = buildSeries();
    expect(series["MKS:xlon"].closes).toEqual([4, 4, 4.1, 4.2]);
    expect(series["VUKE.L"].closes).toEqual([46, 46, 48.3]);
    expect(series["HSBA.L"].currentPrice).toBeCloseTo(14.25, 10);
  });
});
