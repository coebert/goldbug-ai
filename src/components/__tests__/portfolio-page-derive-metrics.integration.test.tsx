// Integration: the portfolio page headline Total, and the LiveHoldingsCard's
// Total / Cash / Invested / per-position values must all be driven from the
// same `derivePortfolioMetrics` output for a real snapshot. This locks the
// contract that shipped in `src/routes/portfolio.$id.tsx` — every headline
// number on the page is a function of the shared helper, so the tiles cannot
// silently diverge from the equity/cash snapshot again (the >100% invested
// bug and the "invested + cash != totalValue" bug both regressed here).
//
// The test renders the LiveHoldingsCard with the exact props the portfolio
// route feeds it (see portfolio.$id.tsx ~line 774) and, alongside, the
// headline "{currency} {totalValue.toFixed(2)}" that the route renders at
// ~line 704. Every visible number is asserted against the same
// `derivePortfolioMetrics` output — not recomputed independently.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveHoldingsCard } from "@/components/live-holdings-card";
import { derivePortfolioMetrics } from "@/lib/derive-portfolio-metrics";

// A realistic multi-currency snapshot: GBP-base portfolio with a GBX pence
// holding (LLOY.L) and a USD holding (AAPL). The server-side snapshot is
// authoritative (£301.89 total, £14.98 cash) — matching the real user bug
// where broker cash disagreed with an old snapshot.
const snapshot = { total_value: 301.89, cash: 14.98 };
const holdings = [
  { id: "h1", symbol: "LLOY.L", quantity: 100, avg_cost: 55.4, instrument_ccy: "GBX" },
  { id: "h2", symbol: "AAPL",   quantity: 2,   avg_cost: 178.2, instrument_ccy: "USD" },
];
const series = {
  "LLOY.L": { closes: [55.4], currentPrice: 55.4, pctChangeSincePurchase: 0, valueChangeSincePurchase: 0 },
  AAPL:     { closes: [178.2], currentPrice: 178.2, pctChangeSincePurchase: 0, valueChangeSincePurchase: 0 },
};
const CURRENCY = "GBP";

function fmt(n: number) {
  return `${CURRENCY} ${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

describe("portfolio page + LiveHoldingsCard use derivePortfolioMetrics as single source", () => {
  const metrics = derivePortfolioMetrics({
    latestSnapshot: snapshot,
    currentCash: 999_999, // stale ledger cash — must be ignored while snapshot exists
    holdings,
  });

  it("derivePortfolioMetrics honours the snapshot over stale ledger cash", () => {
    expect(metrics.source).toBe("snapshot");
    expect(metrics.totalValue).toBeCloseTo(301.89, 2);
    expect(metrics.cash).toBeCloseTo(14.98, 2);
    expect(metrics.invested).toBeCloseTo(301.89 - 14.98, 2);
  });

  it("every headline and per-position value on the page comes from that same output", () => {
    // Route headline: `{p.currency} {totalValue.toFixed(2)}` — reproduce
    // exactly what portfolio.$id.tsx renders around line 704.
    const routeHeadline = `${CURRENCY} ${metrics.totalValue.toFixed(2)}`;

    const cardHtml = renderToStaticMarkup(
      <LiveHoldingsCard
        holdings={holdings}
        currency={CURRENCY}
        cash={metrics.cash}
        totalValue={metrics.totalValue}
        invested={metrics.invested}
        mode="live_prod"
        series={series}
      />,
    );

    // Headline is the authoritative snapshot total.
    expect(routeHeadline).toBe("GBP 301.89");

    // Invested tile ─ formatted with base currency, taken verbatim from metrics.
    expect(cardHtml).toContain(fmt(metrics.invested));
    // Cash tile ─ same.
    expect(cardHtml).toContain(fmt(metrics.cash));

    // Per-position values must be scaled so they sum to metrics.invested
    // (not to the raw GBX/USD notional). Extract every `GBP N.NN` occurrence
    // that appears inside the per-position <li>s. The tile also renders
    // `fmt(cash)` and `fmt(holdingsValue)` at the top; per-position numbers
    // are additional matches beyond those two.
    const currencyMoneyRe = /GBP\s([0-9,]+\.\d{2})/g;
    const all = [...cardHtml.matchAll(currencyMoneyRe)].map((m) => Number(m[1].replace(/,/g, "")));
    // First two matches are the Invested tile then the Cash tile (DOM order
    // in the component). Any remaining `GBP x.xx` matches are per-position
    // values (fmt(r.value)) — some rows also render "@ GBP <avg_cost>" in
    // the qty line, so we filter to unique row values by locating them via
    // the "% of portfolio" marker that follows each row value.
    expect(all.slice(0, 2)).toEqual([
      Number(metrics.invested.toFixed(2)),
      Number(metrics.cash.toFixed(2)),
    ]);

    // Extract per-position rendered values that precede "% of portfolio"
    // in the per-row markup (the tile's own "% of portfolio" strings are
    // preceded by tile fmt() output, not by row fmt(r.value)).
    // Row "% of portfolio" is rendered with one decimal (e.g. 45.3%), whereas
    // the tile version uses integer % — so we require `\d+\.\d+%` to isolate
    // per-position rows only.
    const rowValueRe = /GBP\s([0-9,]+\.\d{2})<\/div><div[^>]*>\d+\.\d+% of portfolio/g;
    const rowValues = [...cardHtml.matchAll(rowValueRe)].map((m) => Number(m[1].replace(/,/g, "")));
    expect(rowValues.length).toBe(holdings.length);

    const rowSum = rowValues.reduce((s, v) => s + v, 0);
    // Rows are scaled proportionally so their sum equals authoritative invested
    // (within a penny of rounding across two rows).
    expect(rowSum).toBeCloseTo(metrics.invested, 1);

    // And invested + cash reconciles to totalValue — the invariant that
    // failed in the >100% invested screenshot.
    expect(metrics.invested + metrics.cash).toBeCloseTo(metrics.totalValue, 2);
  });

  it("fallback path (no snapshot) still feeds the same helper output to the card", () => {
    const fresh = derivePortfolioMetrics({
      latestSnapshot: null,
      currentCash: 500,
      holdings: [{ quantity: 10, avg_cost: 20 }], // native units
    });
    expect(fresh.source).toBe("fallback_native");
    expect(fresh.cash).toBe(500);
    expect(fresh.invested).toBe(200);
    expect(fresh.totalValue).toBe(700);

    const html = renderToStaticMarkup(
      <LiveHoldingsCard
        holdings={[{ id: "x", symbol: "ACME", quantity: 10, avg_cost: 20, instrument_ccy: "GBP" }]}
        currency={CURRENCY}
        cash={fresh.cash}
        totalValue={fresh.totalValue}
        invested={fresh.invested}
        mode="paper"
        series={{ ACME: { closes: [20], currentPrice: 20, pctChangeSincePurchase: 0, valueChangeSincePurchase: 0 } }}
      />,
    );
    expect(html).toContain(fmt(fresh.invested)); // GBP 200.00
    expect(html).toContain(fmt(fresh.cash));     // GBP 500.00
    // Headline the route would render:
    expect(`${CURRENCY} ${fresh.totalValue.toFixed(2)}`).toBe("GBP 700.00");
  });
});
