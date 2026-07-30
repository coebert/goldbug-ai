// Integration: per-position rows in <LiveHoldingsCard/> sum bit-exactly to
// the Invested tile, and Invested + Cash sum bit-exactly to the headline
// Total after the FX/GBX rounding standardisation. Locks the invariant
// that shipped in `src/lib/format-money.ts` (largest-remainder allocation
// + shared 2dp halfExpand grid).

import { describe, expect, it } from "vitest";
import { renderWithQuery as renderToStaticMarkup } from "@/components/__tests__/render-with-query";
import { LiveHoldingsCard } from "@/components/live-holdings-card";
import { derivePortfolioMetrics } from "@/lib/derive-portfolio-metrics";
import { formatMoney, roundMoney } from "@/lib/format-money";

function moneyMatches(html: string, currency: string): number[] {
  const re = new RegExp(`${currency}\\s([0-9,]+\\.\\d{2})`, "g");
  return [...html.matchAll(re)].map((m) => Number(m[1].replace(/,/g, "")));
}

describe("LiveHoldingsCard — displayed rows sum to displayed Invested (no ±0.01 drift)", () => {
  it("multi-currency snapshot with GBX + USD holdings", () => {
    const snapshot = { total_value: 301.89, cash: 14.98 };
    const holdings = [
      { id: "h1", symbol: "LLOY.L", quantity: 100, avg_cost: 55.4, instrument_ccy: "GBX" },
      { id: "h2", symbol: "AAPL", quantity: 2, avg_cost: 178.2, instrument_ccy: "USD" },
      { id: "h3", symbol: "VOD.L", quantity: 33, avg_cost: 71.15, instrument_ccy: "GBX" },
    ];
    const metrics = derivePortfolioMetrics({
      latestSnapshot: snapshot,
      currentCash: 999,
      holdings,
    });
    const html = renderToStaticMarkup(
      <LiveHoldingsCard
        holdings={holdings}
        currency="GBP"
        cash={metrics.cash}
        totalValue={metrics.totalValue}
        invested={metrics.invested}
        mode="live_prod"
        series={{
          "LLOY.L": { closes: [55.4], currentPrice: 55.4, pctChangeSincePurchase: 0, valueChangeSincePurchase: 0 },
          AAPL: { closes: [178.2], currentPrice: 178.2, pctChangeSincePurchase: 0, valueChangeSincePurchase: 0 },
          "VOD.L": { closes: [71.15], currentPrice: 71.15, pctChangeSincePurchase: 0, valueChangeSincePurchase: 0 },
        }}
      />,
    );

    // Tile numbers appear first (Invested then Cash) using the same
    // formatMoney helper as the headline.
    const nums = moneyMatches(html, "GBP");
    const investedTile = nums[0];
    const cashTile = nums[1];
    expect(investedTile).toBe(roundMoney(metrics.invested));
    expect(cashTile).toBe(roundMoney(metrics.cash));
    expect(roundMoney(investedTile + cashTile)).toBe(roundMoney(metrics.totalValue));

    // Per-position values are rendered inside <li> blocks; extract only
    // those (row `% of portfolio` uses one decimal, tile uses integer).
    const rowRe = /GBP\s([0-9,]+\.\d{2})<\/div><div[^>]*>\d+\.\d+% of portfolio/g;
    const rowValues = [...html.matchAll(rowRe)].map((m) => Number(m[1].replace(/,/g, "")));
    expect(rowValues.length).toBe(holdings.length);
    const sum = rowValues.reduce((s, v) => s + v, 0);
    // Bit-exact: rounded row sum equals the displayed Invested tile.
    expect(roundMoney(sum)).toBe(investedTile);
  });

  it("headline formatter matches the tile formatter (single grid)", () => {
    // If any surface bypassed formatMoney (e.g. toFixed) a value like
    // 301.895 would render 301.89 in one place and 301.90 in another.
    expect(formatMoney(301.895, "GBP")).toBe("GBP 301.90");
    expect(formatMoney(roundMoney(301.895), "GBP")).toBe("GBP 301.90");
  });
});
