// Regression: the Invested tile and Cash tile in <LiveHoldingsCard/>
// must NEVER exceed 100% of the portfolio, and their sum must be
// <= 100% (equal only when there are no negative artifacts). This
// specifically guards against the bug where GBX pence / USD / EUR
// native holdings were summed as if they were the base currency,
// producing screenshots showing "Invested 144% + Cash 99%".
//
// The card takes an authoritative `totalValue` (server-side, FX/GBX
// normalised) and `cash` in base currency; per-position `value` is
// scaled proportionally so that Σvalue === totalValue − cash. This
// test locks that invariant across several pathological inputs.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveHoldingsCard } from "@/components/live-holdings-card";

function pctsFromMarkup(html: string) {
  // The tile renders "<N>% of portfolio" (rounded to whole numbers)
  // for both Invested and Cash. Extract each in DOM order.
  const matches = [...html.matchAll(/(-?\d+)% of portfolio/g)].map((m) => Number(m[1]));
  return { invested: matches[0], cash: matches[1] };
}

describe("LiveHoldingsCard — Invested/Cash % never exceed 100%", () => {
  it("USD holdings in a GBP portfolio: raw sum inflates but tile stays bounded", () => {
    // Portfolio base = GBP. One position quoted in USD with a huge
    // native price (would be ~£790 if summed as GBP), but the
    // authoritative server snapshot says totalValue=£300, cash=£100
    // → invested = £200 (67%), cash = 33%.
    const html = renderToStaticMarkup(
      <LiveHoldingsCard
        holdings={[{ id: "1", symbol: "AAPL", quantity: 5, avg_cost: 158, instrument_ccy: "USD" }]}
        currency="GBP"
        cash={100}
        totalValue={300}
        mode="live_prod"
        series={{ AAPL: { closes: [], currentPrice: 158, pctChangeSincePurchase: 0, valueChangeSincePurchase: 0 } }}
      />,
    );
    const { invested, cash } = pctsFromMarkup(html);
    expect(invested).toBeLessThanOrEqual(100);
    expect(cash).toBeLessThanOrEqual(100);
    expect(invested + cash).toBeLessThanOrEqual(100);
    expect(invested).toBe(67);
    expect(cash).toBe(33);
  });

  it("GBX (pence) holdings in a GBP portfolio don't inflate past 100%", () => {
    // 100 shares × 2500p naive = £250,000 raw sum. Authoritative
    // totalValue=£3,000, cash=£500 → invested=£2,500 (83%), cash=17%.
    const html = renderToStaticMarkup(
      <LiveHoldingsCard
        holdings={[{ id: "1", symbol: "LLOY.L", quantity: 100, avg_cost: 2500, instrument_ccy: "GBX" }]}
        currency="GBP"
        cash={500}
        totalValue={3000}
        mode="live_prod"
        series={{ "LLOY.L": { closes: [], currentPrice: 2500, pctChangeSincePurchase: 0, valueChangeSincePurchase: 0 } }}
      />,
    );
    const { invested, cash } = pctsFromMarkup(html);
    expect(invested).toBeLessThanOrEqual(100);
    expect(cash).toBeLessThanOrEqual(100);
    expect(invested + cash).toBeLessThanOrEqual(100);
  });

  it("mixed USD + EUR positions in an EUR base portfolio stay bounded", () => {
    const html = renderToStaticMarkup(
      <LiveHoldingsCard
        holdings={[
          { id: "1", symbol: "MSFT", quantity: 10, avg_cost: 420, instrument_ccy: "USD" },
          { id: "2", symbol: "SAP.DE", quantity: 5, avg_cost: 190, instrument_ccy: "EUR" },
        ]}
        currency="EUR"
        cash={200}
        totalValue={1000}
        mode="live_sim"
        series={{
          MSFT: { closes: [], currentPrice: 420, pctChangeSincePurchase: 0, valueChangeSincePurchase: 0 },
          "SAP.DE": { closes: [], currentPrice: 190, pctChangeSincePurchase: 0, valueChangeSincePurchase: 0 },
        }}
      />,
    );
    const { invested, cash } = pctsFromMarkup(html);
    expect(invested + cash).toBeLessThanOrEqual(100);
    expect(invested).toBe(80);
    expect(cash).toBe(20);
  });

  it("100% cash, no holdings → invested 0%, cash 100%", () => {
    const html = renderToStaticMarkup(
      <LiveHoldingsCard holdings={[]} currency="GBP" cash={500} totalValue={500} mode="live_prod" />,
    );
    const { invested, cash } = pctsFromMarkup(html);
    expect(invested).toBe(0);
    expect(cash).toBe(100);
  });

  it("100% invested, zero cash → invested 100%, cash 0%", () => {
    const html = renderToStaticMarkup(
      <LiveHoldingsCard
        holdings={[{ id: "1", symbol: "VOD.L", quantity: 100, avg_cost: 7, instrument_ccy: "GBP" }]}
        currency="GBP"
        cash={0}
        totalValue={700}
        mode="live_prod"
        series={{ "VOD.L": { closes: [], currentPrice: 7, pctChangeSincePurchase: 0, valueChangeSincePurchase: 0 } }}
      />,
    );
    const { invested, cash } = pctsFromMarkup(html);
    expect(invested).toBe(100);
    expect(cash).toBe(0);
    expect(invested + cash).toBeLessThanOrEqual(100);
  });

  it("randomised fuzz: for any (cash, totalValue, native prices), tile pcts stay in [0,100] and sum ≤ 100", () => {
    // Deterministic pseudo-random inputs.
    let seed = 20260727;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let i = 0; i < 40; i++) {
      const totalValue = 100 + rand() * 100_000;
      const cash = rand() * totalValue; // 0..totalValue → invested is the rest
      const nativePrice = 0.01 + rand() * 10_000; // GBX/USD/etc. wildly off
      const qty = 1 + Math.floor(rand() * 500);
      const html = renderToStaticMarkup(
        <LiveHoldingsCard
          holdings={[{ id: "1", symbol: "X", quantity: qty, avg_cost: nativePrice, instrument_ccy: "GBX" }]}
          currency="GBP"
          cash={cash}
          totalValue={totalValue}
          mode="live_prod"
          series={{ X: { closes: [], currentPrice: nativePrice, pctChangeSincePurchase: 0, valueChangeSincePurchase: 0 } }}
        />,
      );
      const { invested, cash: cashPct } = pctsFromMarkup(html);
      expect(invested, `iter ${i}`).toBeGreaterThanOrEqual(0);
      expect(invested, `iter ${i}`).toBeLessThanOrEqual(100);
      expect(cashPct, `iter ${i}`).toBeGreaterThanOrEqual(0);
      expect(cashPct, `iter ${i}`).toBeLessThanOrEqual(100);
      expect(invested + cashPct, `iter ${i}`).toBeLessThanOrEqual(100);
    }
  });
});
