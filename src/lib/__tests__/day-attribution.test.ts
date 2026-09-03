import { describe, expect, it } from "vitest";
import { buildDayAttribution, type MoverInput } from "../day-attribution";

const line = (o: Partial<MoverInput> & { symbol: string }): MoverInput => ({
  assetClass: "stock",
  quantity: 1,
  prevPrice: 100,
  currPrice: 101,
  currency: "GBP",
  fxRate: 1,
  openedToday: false,
  ...o,
});

describe("buildDayAttribution", () => {
  it("reconciles the 3 Sep live-account day: gains on every stock, loss overall", () => {
    const r = buildDayAttribution({
      inputs: [
        line({ symbol: "VUSA:xlon", quantity: 13, prevPrice: 107.865, currPrice: 108.5725 }),
        line({ symbol: "VWRL:xlon", quantity: 5, prevPrice: 138.77, currPrice: 139.82 }),
        line({
          symbol: "TSLA:xnas",
          quantity: 2,
          prevPrice: 379.89,
          currPrice: 381.795,
          currency: "USD",
          fxRate: 1 / 1.354536,
          openedToday: true,
        }),
        line({
          symbol: "GBPUSD",
          assetClass: "fx",
          quantity: -3455.55,
          prevPrice: 1.348327,
          currPrice: 1.354536,
          currency: "USD",
          fxRate: 1 / 1.354536,
        }),
      ],
      fees: 0.74,
      netFlow: 0,
      totalChange: -7.38,
    });

    const stocks = r.lines.filter((l) => l.kind === "position");
    expect(stocks.every((l) => l.changeBase > 0)).toBe(true);
    const fx = r.lines.find((l) => l.kind === "fx")!;
    expect(fx.changeBase).toBeLessThan(-10);
    expect(r.positionsTotal).toBeLessThan(0);
    // The identity always holds.
    expect(r.totalChange).toBeCloseTo(r.positionsTotal - r.fees + r.netFlow + r.residual, 6);
  });

  it("measures a position opened today from its entry price", () => {
    const r = buildDayAttribution({
      inputs: [line({ symbol: "NEW", prevPrice: 50, currPrice: 55, openedToday: true })],
      fees: 0,
      netFlow: 0,
      totalChange: 5,
    });
    expect(r.lines[0].changeBase).toBe(5);
    expect(r.residual).toBe(0);
  });

  it("keeps unpriced holdings out of the attributed total", () => {
    const r = buildDayAttribution({
      inputs: [line({ symbol: "GOOD" }), line({ symbol: "BAD", currPrice: null })],
      fees: 0,
      netFlow: 0,
      totalChange: 4,
    });
    expect(r.unpricedCount).toBe(1);
    expect(r.positionsTotal).toBe(1);
    expect(r.residual).toBe(3);
  });

  it("nets deposits out of the residual", () => {
    const r = buildDayAttribution({
      inputs: [line({ symbol: "A" })],
      fees: 2,
      netFlow: 500,
      totalChange: 499,
    });
    expect(r.residual).toBe(0);
  });
});
