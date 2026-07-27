// Regression: the portfolio card's HoldingsStrip (Invested/Cash tiles,
// total line, per-position chips) must satisfy:
//   1. investedPct + cashPct == 100% (within rounding)
//   2. Invested amount == totalEquity − cash (never cost-basis sum)
//   3. "Total" line == totalEquity (never cost-basis sum + cash)
//   4. Chip weights sum to invested%, not to a raw cost-basis %
//
// Guards the bug that showed Invested 94.4% + Cash 41.3% = 135.7% on a
// real-money card because Invested was computed from Σ(qty × avg_cost)
// while Cash and totalEquity came from the broker snapshot.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PortfolioRow } from "@/components/home/portfolio-row";

function renderRow(overrides: {
  totalEquity: number;
  cash: number;
  startingCash?: number;
  holdings: Array<{ symbol: string; quantity: number; avg_cost: number }>;
}): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <PortfolioRow
        portfolio={{
          id: "p1",
          name: "My Portfolio",
          starting_cash: overrides.startingCash ?? 300,
          current_cash: overrides.cash,
          currency: "GBP",
          risk_level: "balanced",
          mode: "live_prod",
          live_paused: false,
          last_run_date: "2026-07-27",
        }}
        sparkSeries={[
          { date: "2026-07-01", value: overrides.totalEquity - 5 },
          { date: "2026-07-27", value: overrides.totalEquity },
        ]}
        deposits={[]}
        holdings={overrides.holdings}
      />
    </QueryClientProvider>,
  );
}

// Match the two allocation-summary tile percentages: they render as
// `<span ...>NN.N%</span>` inside the allocation-summary block, in
// Invested-then-Cash DOM order.
function summaryPcts(html: string): { invested: number; cash: number } {
  const block = html.match(
    /data-testid="allocation-summary"[\s\S]*?<\/div><\/div><\/div>/,
  );
  const src = block?.[0] ?? html;
  const pcts = [...src.matchAll(/>(-?\d+\.\d)%</g)].map((m) => Number(m[1]));
  return { invested: pcts[0], cash: pcts[1] };
}

function totalLineAmount(html: string): number {
  // "Total GBP 302" or "Total GBP 1,000"
  const m = html.match(/Total\s+GBP[\s\u00a0]*([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
}

describe("HoldingsStrip — allocation percentages sum to 100 and are anchored to totalEquity", () => {
  it("cost-basis > equity (drawdown): invested% + cash% == 100%, total == totalEquity", () => {
    // Repro of the screenshot: broker equity £301.83, cash £124.60,
    // cost-basis of two holdings sums to £285 (94.4% of 301.83 vs
    // 41.3% cash = 135.7% total under the old bug).
    const html = renderRow({
      totalEquity: 301.83,
      cash: 124.6,
      holdings: [
        { symbol: "VMID:xlon", quantity: 1, avg_cost: 146 },
        { symbol: "VUKE:xlon", quantity: 1, avg_cost: 139 },
      ],
    });

    const { invested, cash } = summaryPcts(html);
    expect(invested + cash).toBeCloseTo(100, 1);
    // Authoritative invested = 301.83 − 124.60 = £177.23 → "GBP 177".
    expect(html).toMatch(/GBP[\s\u00a0]*177/);
    // "Total GBP 302" — never 285 + 125 = 410.
    expect(totalLineAmount(html)).toBe(302);
  });

  it("cost-basis < equity (unrealised gain): invested% + cash% still == 100%", () => {
    // £1,000 equity, £200 cash → invested must be £800 (80%/20%),
    // even though holdings cost only £600.
    const html = renderRow({
      totalEquity: 1_000,
      cash: 200,
      holdings: [
        { symbol: "AAA", quantity: 10, avg_cost: 40 }, // £400 cost
        { symbol: "BBB", quantity: 10, avg_cost: 20 }, // £200 cost
      ],
    });

    const { invested, cash } = summaryPcts(html);
    expect(invested).toBeCloseTo(80, 1);
    expect(cash).toBeCloseTo(20, 1);
    expect(html).toMatch(/GBP[\s\u00a0]*800/);
    expect(totalLineAmount(html)).toBe(1_000);
  });

  it("chip weights sum to investedPct (not to raw cost-basis %)", () => {
    const html = renderRow({
      totalEquity: 301.83,
      cash: 124.6,
      holdings: [
        { symbol: "VMID:xlon", quantity: 1, avg_cost: 146 },
        { symbol: "VUKE:xlon", quantity: 1, avg_cost: 139 },
      ],
    });
    // Chip weights render as `>N.N%<` inside the chip list, appearing
    // AFTER the two allocation-summary tile percentages. Take the tail.
    const all = [...html.matchAll(/>(-?\d+\.\d)%</g)].map((m) => Number(m[1]));
    // Two summary pcts + two chip pcts (top 6 chips, only 2 holdings).
    expect(all.length).toBeGreaterThanOrEqual(4);
    const chipWeights = all.slice(-2);
    const sumWeights = chipWeights.reduce((a, b) => a + b, 0);
    // Sum equals authoritative invested% (~58.7%), NOT ~135% (raw).
    expect(sumWeights).toBeCloseTo((177.23 / 301.83) * 100, 0);
    expect(sumWeights).toBeLessThan(100);
  });

  it("100% cash, no holdings: strip renders the empty-state pill", () => {
    const html = renderRow({ totalEquity: 500, cash: 500, holdings: [] });
    expect(html).toMatch(/Fully in cash/i);
  });
});
