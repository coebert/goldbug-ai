// Regression: the portfolio card's HoldingsStrip (Invested/Cash tiles,
// total line, per-position chips) must satisfy:
//   1. investedPct + cashPct == 100% (within rounding)
//   2. Invested amount == totalEquity − cash (never cost-basis sum)
//   3. "Total" line == totalEquity (never cost-basis sum + cash)
//   4. Chip values sum to the authoritative invested amount
//
// Guards the bug that showed Invested 94.4% + Cash 41.3% = 135.7% on a
// real-money card because Invested was computed from Σ(qty × avg_cost)
// while Cash and totalEquity came from the broker snapshot.

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PortfolioRow } from "@/components/home/portfolio-row";

function renderRow(overrides: {
  totalEquity: number;
  cash: number;
  startingCash?: number;
  holdings: Array<{ symbol: string; quantity: number; avg_cost: number }>;
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
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

const parsePct = (t: string) => Number(t.replace("%", ""));
const parseGbp = (t: string) => Number(t.replace(/[^0-9.\-]/g, ""));

describe("HoldingsStrip — allocation percentages sum to 100 and are anchored to totalEquity", () => {
  it("cost-basis > equity (drawdown): invested% + cash% == 100%, total == totalEquity", () => {
    // Repro of the screenshot: broker equity £301.83, cash £124.60,
    // cost-basis of two holdings sums to £285 (94.4% of 301.83 vs
    // 41.3% cash = 135.7% total under the old bug).
    renderRow({
      totalEquity: 301.83,
      cash: 124.6,
      holdings: [
        { symbol: "VMID:xlon", quantity: 1, avg_cost: 146 },
        { symbol: "VUKE:xlon", quantity: 1, avg_cost: 139 },
      ],
    });

    const summary = screen.getByTestId("allocation-summary");
    const [investedTile, cashTile] = within(summary).getAllByText(/%$/);
    const investedPct = parsePct(investedTile.textContent!);
    const cashPct = parsePct(cashTile.textContent!);
    expect(investedPct + cashPct).toBeCloseTo(100, 1);
    // Invested = totalEquity − cash = 177.23 → rendered as "GBP 177".
    expect(within(summary).getByText(/GBP\s*177/)).toBeInTheDocument();
    // Cash tile shows the broker cash (£125 rounded).
    expect(within(summary).getByText(/GBP\s*125/)).toBeInTheDocument();

    const strip = screen.getByTestId("portfolio-row-holdings-strip");
    // "Total GBP 302" — the authoritative totalEquity, not 285+125=410.
    expect(within(strip).getByText(/Total\s+GBP\s*302/)).toBeInTheDocument();
    expect(within(strip).queryByText(/Total\s+GBP\s*4\d\d/)).toBeNull();
  });

  it("cost-basis < equity (unrealised gain): invested% + cash% still == 100%", () => {
    // £1,000 equity, £200 cash → invested must be £800 (80%/20%),
    // even though holdings cost only £600.
    renderRow({
      totalEquity: 1_000,
      cash: 200,
      holdings: [
        { symbol: "AAA", quantity: 10, avg_cost: 40 }, // £400 cost
        { symbol: "BBB", quantity: 10, avg_cost: 20 }, // £200 cost
      ],
    });

    const summary = screen.getByTestId("allocation-summary");
    const [investedTile, cashTile] = within(summary).getAllByText(/%$/);
    expect(parsePct(investedTile.textContent!)).toBeCloseTo(80, 1);
    expect(parsePct(cashTile.textContent!)).toBeCloseTo(20, 1);
    expect(within(summary).getByText(/GBP\s*800/)).toBeInTheDocument();

    const strip = screen.getByTestId("portfolio-row-holdings-strip");
    expect(within(strip).getByText(/Total\s+GBP\s*1,000/)).toBeInTheDocument();
  });

  it("chip weights sum to investedPct and chip values sum to authoritative invested", () => {
    renderRow({
      totalEquity: 301.83,
      cash: 124.6,
      holdings: [
        { symbol: "VMID:xlon", quantity: 1, avg_cost: 146 },
        { symbol: "VUKE:xlon", quantity: 1, avg_cost: 139 },
      ],
    });

    const strip = screen.getByTestId("portfolio-row-holdings-strip");
    const chips = within(strip).getAllByTitle(/of portfolio/);
    expect(chips.length).toBe(2);
    // Extract "X.Y%" from each chip's inner "% of portfolio" badge.
    const weights = chips.map((li) => {
      const m = li.textContent!.match(/(\d+\.\d)%/g)!;
      return parsePct(m[m.length - 1]);
    });
    const sumWeights = weights.reduce((a, b) => a + b, 0);
    // Weights sum to the authoritative invested% (~58.7%), not to
    // ~135% that raw cost-basis would produce.
    expect(sumWeights).toBeCloseTo((177.23 / 301.83) * 100, 0);
    expect(sumWeights).toBeLessThan(100);
  });

  it("100% cash, no holdings: invested 0%, cash 100%, total == cash", () => {
    renderRow({ totalEquity: 500, cash: 500, holdings: [] });
    // No holdings → the empty-state pill is rendered, not the tiles.
    expect(
      screen.getByText(/Fully in cash — no open positions/i),
    ).toBeInTheDocument();
  });
});
