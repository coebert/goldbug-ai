import { describe, it, expect } from "vitest";
import { decideAutoCloses, type AutoCloseLeg } from "../fx-auto-close";

const leg = (over: Partial<AutoCloseLeg> = {}): AutoCloseLeg => ({
  symbol: "GBPUSD",
  verdict: "unused",
  coverRatio: 0,
  notionalBase: 4000,
  pnlBaseNet: -80, // -2%
  ...over,
});

describe("decideAutoCloses", () => {
  it("closes a spare leg losing more than the trigger", () => {
    const [d] = decideAutoCloses([leg()]);
    expect(d.close).toBe(true);
    expect(d.lossPctOfLeg).toBeCloseTo(2, 5);
    expect(d.reason).toMatch(/Spare currency/);
  });

  it("never closes a leg still funding holdings, however big the loss", () => {
    const [d] = decideAutoCloses([leg({ verdict: "matched", coverRatio: 0.95, pnlBaseNet: -900 })]);
    expect(d.close).toBe(false);
    expect(d.reason).toMatch(/still paying|Still paying/i);
  });

  it("closes a partly-used (oversized) leg", () => {
    const [d] = decideAutoCloses([leg({ verdict: "oversized", coverRatio: 0.4 })]);
    expect(d.close).toBe(true);
    expect(d.reason).toContain("40%");
  });

  it("holds a leg under the loss trigger", () => {
    const [d] = decideAutoCloses([leg({ pnlBaseNet: -20 })]); // 0.5%
    expect(d.close).toBe(false);
    expect(d.reason).toMatch(/under the 1% trigger/);
  });

  it("holds a leg in profit", () => {
    const [d] = decideAutoCloses([leg({ pnlBaseNet: 50 })]);
    expect(d.close).toBe(false);
    expect(d.reason).toMatch(/not losing money/);
  });

  it("respects the exact 1% boundary", () => {
    expect(decideAutoCloses([leg({ pnlBaseNet: -40 })])[0].close).toBe(true);
    expect(decideAutoCloses([leg({ pnlBaseNet: -39.9 })])[0].close).toBe(false);
  });

  it("skips legs too small to be worth the charge", () => {
    const [d] = decideAutoCloses([leg({ notionalBase: 100, pnlBaseNet: -10 })]);
    expect(d.close).toBe(false);
    expect(d.reason).toMatch(/Too small/);
  });

  it("never acts on a stale or unvaluable rate", () => {
    expect(decideAutoCloses([leg({ stale: true })])[0].close).toBe(false);
    expect(decideAutoCloses([leg({ pnlBaseNet: Number.NaN })])[0].close).toBe(false);
  });

  it("does nothing when switched off", () => {
    const [d] = decideAutoCloses([leg()], { enabled: false });
    expect(d.close).toBe(false);
  });

  it("honours a custom loss trigger", () => {
    expect(decideAutoCloses([leg()], { lossPct: 5 })[0].close).toBe(false);
    expect(decideAutoCloses([leg()], { lossPct: 0.5 })[0].close).toBe(true);
  });
});
