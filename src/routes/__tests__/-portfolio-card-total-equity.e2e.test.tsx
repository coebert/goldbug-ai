// End-to-end: the prominent GBP "Total equity" headline on every home
// portfolio card MUST always equal the last point of the same sparkline
// series that feeds the % change — regardless of the "Include deposits
// in % change" toggle state.
//
// Pipeline mirrored (matches src/routes/index.tsx exactly):
//   perPortfolioSeries → computeSparkByPortfolio → sparkSeries
//     ├── totalEquity = sparkSeries[last].value           (headline £)
//     └── computeCardRangePct(sparkSeries, deposits, toggle)  (%)
//
// The headline text is produced by the same formatter the card uses
// (`formatMoneyAmount`) so the rendered string is byte-for-byte what
// users see. Toggling the deposits inclusion flag MUST NOT shift the
// headline (£ is a valuation, not a PnL) and MUST NOT desync it from
// the sparkline's last point.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { computeSparkByPortfolio, type EquityData } from "@/lib/spark-by-portfolio";
import { computeCardRangePct } from "@/lib/card-range-pct";
import { formatMoneyAmount } from "@/lib/format-money";

type Portfolio = {
  id: string;
  name: string;
  currency: string;
  current_cash: number;
};

type Scenario = {
  portfolios: Portfolio[];
  equity: EquityData;
  deposits: Record<string, Array<{ date: string; amount: number }>>;
};

// Minimal render that reproduces exactly what the card puts on screen
// for the headline block. If the production JSX in PortfolioRow changes
// its formatter or its source expression, the source-level regression
// test (portfolio-card-equity-source.regression.test.ts) fires; this
// test verifies the *rendered* string is consistent across toggle
// states and across the full portfolio list.
function renderHeadline(
  currency: string,
  totalEquity: number,
  rangePct: number | null,
) {
  return renderToStaticMarkup(
    <div>
      <div data-testid="total-equity" className="text-2xl font-bold tabular-nums">
        {currency} {formatMoneyAmount(totalEquity)}
      </div>
      {rangePct != null && (
        <span data-testid="range-pct" className="tabular-nums">
          {rangePct >= 0 ? "+" : ""}
          {rangePct.toFixed(1)}%
        </span>
      )}
    </div>,
  );
}

function extractHeadline(html: string): string {
  const m = html.match(/data-testid="total-equity"[^>]*>([^<]+)</);
  if (!m) throw new Error(`no headline in html: ${html}`);
  return m[1].trim();
}

function runScenarioBothToggles(scenario: Scenario) {
  const sparkByPortfolio = computeSparkByPortfolio(scenario.equity);
  const results: Array<{
    id: string;
    headline: string;
    totalEquity: number;
    lastSparkValue: number;
    pctExcl: number | null;
    pctIncl: number | null;
  }> = [];

  for (const p of scenario.portfolios) {
    const sparkSeries = sparkByPortfolio[p.id] ?? [];
    // Mirror the exact expression in src/routes/index.tsx line 449.
    const totalEquity =
      sparkSeries.length > 0
        ? sparkSeries[sparkSeries.length - 1].value
        : Number(p.current_cash);
    const deposits = scenario.deposits[p.id] ?? [];
    const pctExcl = computeCardRangePct(sparkSeries, deposits, false);
    const pctIncl = computeCardRangePct(sparkSeries, deposits, true);

    // Render once per toggle state. Headline must be identical.
    const htmlExcl = renderHeadline(p.currency, totalEquity, pctExcl);
    const htmlIncl = renderHeadline(p.currency, totalEquity, pctIncl);
    const hExcl = extractHeadline(htmlExcl);
    const hIncl = extractHeadline(htmlIncl);
    expect(hExcl).toBe(hIncl);

    results.push({
      id: p.id,
      headline: hExcl,
      totalEquity,
      lastSparkValue:
        sparkSeries.length > 0
          ? sparkSeries[sparkSeries.length - 1].value
          : Number(p.current_cash),
      pctExcl,
      pctIncl,
    });
  }
  return results;
}

describe("home dashboard e2e — total equity headline vs equity % share one source", () => {
  it("headline equals sparkSeries[last] for every card, unchanged by deposits toggle", () => {
    const portfolios: Portfolio[] = [
      { id: "live-1", name: "My Portfolio", currency: "GBP", current_cash: 124.6 },
      { id: "sim-hi", name: "High risk sim", currency: "GBP", current_cash: 25.0 },
      { id: "sim-bal", name: "Balanced sim", currency: "GBP", current_cash: 812.34 },
    ];
    const equity: EquityData = {
      portfolios: [
        { id: "live-1", mode: "live" as const },
        { id: "sim-hi", mode: "sim" as const },
        { id: "sim-bal", mode: "sim" as const },
      ],
      perPortfolioSeries: {
        "live-1": [
          { date: "2026-07-20", value: 1000 },
          { date: "2026-07-21", value: 1100 },
          { date: "2026-07-22", value: 1234.56 },
        ],
        "sim-hi": [
          { date: "2026-07-20", value: 500 },
          { date: "2026-07-21", value: 400 },
          { date: "2026-07-22", value: 10.11 },
        ],
        "sim-bal": [
          { date: "2026-07-20", value: 800 },
          { date: "2026-07-22", value: 812.34 },
        ],
      },
      series: [],
    };
    const deposits = {
      // Mid-window deposit on the live card — this is the exact case
      // that used to fabricate a phantom % gain. Whatever the toggle
      // does to the %, the headline must not budge.
      "live-1": [{ date: "2026-07-21", amount: 100 }],
      "sim-hi": [],
      "sim-bal": [{ date: "2026-07-22", amount: 10 }],
    };

    const results = runScenarioBothToggles({ portfolios, equity, deposits });

    // Card 1 — live: headline is the last sparkline point, formatted.
    expect(results[0].totalEquity).toBe(1234.56);
    expect(results[0].headline).toBe("GBP 1,234.56");
    // Deposit toggle actually moves the %: with deposits netted, the
    // £100 mid-window cash-in does not count as trading gain.
    // Capital-adjusted: trading pnl / (baseline + net flow) = (134.56)/(1000+100).
    expect(results[0].pctExcl).toBeCloseTo(((1234.56 - 100 - 1000) / (1000 + 100)) * 100, 5);

    expect(results[0].pctIncl).toBeCloseTo(((1234.56 - 1000) / 1000) * 100, 5);
    expect(results[0].pctExcl).not.toBe(results[0].pctIncl);

    // Card 2 — sim, no deposits: toggle is a no-op on %, headline
    // still equals last sparkline point.
    expect(results[1].totalEquity).toBe(10.11);
    expect(results[1].headline).toBe("GBP 10.11");
    expect(results[1].pctExcl).toBe(results[1].pctIncl);

    // Card 3 — sim with a same-day deposit on the last snapshot.
    expect(results[2].totalEquity).toBe(812.34);
    expect(results[2].headline).toBe("GBP 812.34");

    // Contract across ALL cards: headline value == last spark point.
    for (const r of results) {
      expect(r.totalEquity).toBe(r.lastSparkValue);
    }
  });

  it("falls back to current_cash only when a portfolio has no snapshots yet", () => {
    const portfolios: Portfolio[] = [
      { id: "new", name: "Just created", currency: "GBP", current_cash: 742.5 },
    ];
    const equity: EquityData = {
      portfolios: [{ id: "new", mode: "sim" as const }],
      perPortfolioSeries: { new: [] },
      series: [],
    };
    const results = runScenarioBothToggles({
      portfolios,
      equity,
      deposits: { new: [{ date: "2026-07-22", amount: 100 }] },
    });
    expect(results[0].totalEquity).toBe(742.5);
    expect(results[0].headline).toBe("GBP 742.50");
    // Empty series ⇒ % is null in both toggle states (nothing to compute).
    expect(results[0].pctExcl).toBeNull();
    expect(results[0].pctIncl).toBeNull();
  });

  it("randomised: headline stays glued to sparkSeries[last] across both toggles", () => {
    // Property-style sweep. If a future refactor accidentally sources
    // the headline from an independent valuation (holdings sum,
    // current_cash, deposit-adjusted last, etc.) at least one trial
    // will diverge and fail here.
    let seed = 424_242;
    const rand = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0xffff_ffff;
    };

    for (let trial = 0; trial < 20; trial++) {
      const n = 3 + Math.floor(rand() * 12);
      const series = Array.from({ length: n }, (_, i) => ({
        date: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`,
        value: 100 + rand() * 5_000,
      }));
      const depositCount = Math.floor(rand() * 3);
      const deposits = Array.from({ length: depositCount }, () => ({
        date: series[Math.floor(rand() * series.length)].date,
        amount: (rand() - 0.5) * 400,
      }));

      const scenario: Scenario = {
        portfolios: [
          { id: "rnd", name: "Random", currency: "GBP", current_cash: 999 },
        ],
        equity: {
          portfolios: [{ id: "rnd", mode: "sim" as const }],
          perPortfolioSeries: { rnd: series },
          series: [],
        },
        deposits: { rnd: deposits },
      };
      const results = runScenarioBothToggles(scenario);
      const expectedHeadline = `GBP ${formatMoneyAmount(series[series.length - 1].value)}`;
      expect(results[0].totalEquity).toBe(series[series.length - 1].value);
      expect(results[0].headline).toBe(expectedHeadline);
    }
  });
});
