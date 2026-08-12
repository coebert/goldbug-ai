import { describe, it, expect } from "vitest";
import { buildHoldingSeries } from "@/lib/build-holding-series";

/**
 * Regression: Saxo kept serving the same position `marketPrice` (407.8p) for
 * MKS across two sessions while the real close fell to 386.7p. Because the
 * hourly stream is timestamped "now", it beat today's close and the card
 * published a wrong price, a wrong "+0.64% since purchase" and a flat-lining
 * sparkline — while the row's money value was rescaled to the (correct)
 * broker total, so quantity x price no longer matched the value shown.
 */
describe("stale broker hourly quotes", () => {
  const holding = {
    symbol: "MKS:xlon",
    quantity: 775,
    avg_cost: 4.0528,
    opened_at: "2026-08-01",
    asset_class: "stock",
  };
  const closes = [
    { date: "2026-08-10", close: 403.5 },
    { date: "2026-08-11", close: 401.8 },
    { date: "2026-08-12", close: 386.7 },
  ];

  it("ignores a stale hourly stream that disagrees with the latest close", () => {
    const s = buildHoldingSeries(holding, closes, [
      { at: "2026-08-11T12:00:00Z", close: 407.88 },
      { at: "2026-08-12T12:00:00Z", close: 407.74 },
    ]);
    expect(s.hourlyStale).toBe(true);
    expect(s.currentPrice).toBeCloseTo(3.867, 4);
    expect(s.pctChangeSincePurchase!).toBeLessThan(0);
  });

  it("keeps hourly detail when it agrees with the latest close", () => {
    const s = buildHoldingSeries(holding, closes, [
      { at: "2026-08-12T12:00:00Z", close: 388.0 },
    ]);
    expect(s.hourlyStale).toBe(false);
    expect(s.currentPrice).toBeCloseTo(3.88, 4);
  });

  it("keeps hourly when it is genuinely newer than the last daily bar", () => {
    const s = buildHoldingSeries(holding, closes.slice(0, 2), [
      { at: "2026-08-12T12:00:00Z", close: 407.74 },
    ]);
    expect(s.hourlyStale).toBe(false);
    expect(s.currentPrice).toBeCloseTo(4.0774, 4);
  });
});
