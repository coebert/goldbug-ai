// Pins the net-of-fees "close now" maths: the displayed figure must deduct
// the one-way exit conversion cost (spread + min ticket). FX spot carries no
// stamp/transaction tax, so fees are the only friction.

import { describe, it, expect } from "vitest";
import { valueFxLeg, netClosePnl } from "../fx-leg-quotes";
import { quoteFxCost, feeInFromCcy } from "../fx-cost-model";

describe("netClosePnl", () => {
  it("deducts the proportional spread on a large close", () => {
    const net = netClosePnl({ pnlQuote: 50, notionalQuote: 100_000, exitCostBps: 3, minFeeQuote: 1 });
    expect(net.exitFeeQuote).toBe(30); // 3bps of 100k
    expect(net.pnlQuoteNet).toBe(20);
  });

  it("floors at the minimum ticket fee on small closes", () => {
    const net = netClosePnl({ pnlQuote: 2, notionalQuote: 1_000, exitCostBps: 3, minFeeQuote: 1 });
    expect(net.exitFeeQuote).toBe(1); // 3bps of 1k = 0.30 → min 1.00
    expect(net.pnlQuoteNet).toBe(1);
  });

  it("can flip a marginal gross gain into a net loss", () => {
    const net = netClosePnl({ pnlQuote: 0.5, notionalQuote: 2_000, exitCostBps: 8, minFeeQuote: 1 });
    expect(net.exitFeeQuote).toBe(1.6);
    expect(net.pnlQuoteNet).toBeLessThan(0);
  });

  it("charges nothing on a zero-notional leg", () => {
    const net = netClosePnl({ pnlQuote: 0, notionalQuote: 0, exitCostBps: 3, minFeeQuote: 1 });
    expect(net.exitFeeQuote).toBe(0);
    expect(net.pnlQuoteNet).toBe(0);
  });
});

describe("close-now estimate end-to-end (short GBPUSD funding leg)", () => {
  it("net P&L = gross − spot exit fee, converted to base", () => {
    // Short 1,233.52 GBP vs USD entered at 1.3639, now 1.3600.
    const v = valueFxLeg({ quantity: -1233.52, avgCost: 1.3639, rate: 1.36, quoteToBase: 1 / 1.36 });
    expect(v.pnlQuote).toBeCloseTo(4.81, 2); // gross gain in USD

    const cost = quoteFxCost("USD", "GBP", "spot");
    expect(cost.pairClass).toBe("major");
    const { fee } = feeInFromCcy(v.notionalQuote, "USD", "GBP", "spot");
    const net = netClosePnl({
      pnlQuote: v.pnlQuote,
      notionalQuote: v.notionalQuote,
      exitCostBps: cost.totalBps,
      minFeeQuote: Math.min(fee, cost.minFeeFrom),
    });
    expect(net.exitFeeQuote).toBeCloseTo(Math.max(1, v.notionalQuote * 0.0003), 2);
    expect(net.pnlQuoteNet).toBeCloseTo(v.pnlQuote - net.exitFeeQuote, 2);
    expect(net.pnlQuoteNet).toBeLessThan(v.pnlQuote);
  });
});
