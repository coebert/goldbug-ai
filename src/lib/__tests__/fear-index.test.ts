import { describe, expect, it } from "vitest";
import { computeFearIndex, formatFearIndexBlock, labelFor } from "../fear-index";

describe("fear index", () => {
  it("returns a neutral gauge when nothing is available", () => {
    const f = computeFearIndex({});
    expect(f.score).toBe(50);
    expect(f.label).toBe("neutral");
    expect(f.sizeMultiplier).toBe(1);
    expect(f.blockNewBuys).toBe(false);
  });

  it("scores a panic tape as extreme fear and shrinks sizing", () => {
    const f = computeFearIndex({
      vix: 42,
      vix9d: 55,
      vix3m: 34,
      vvix: 150,
      skew: 150,
      putCallProxy: 0.95,
      drawdownPct: -0.22,
    });
    expect(f.score).toBeGreaterThanOrEqual(85);
    expect(f.label).toBe("extreme_fear");
    expect(f.sizeMultiplier).toBeLessThanOrEqual(0.35);
  });

  it("scores a calm tape as greed and permits normal-to-slightly-larger sizing", () => {
    const f = computeFearIndex({
      vix: 12,
      vix9d: 10.5,
      vix3m: 15,
      vvix: 78,
      skew: 112,
      putCallProxy: 0.2,
      drawdownPct: -0.005,
    });
    expect(f.score).toBeLessThan(20);
    expect(["greed", "extreme_greed"]).toContain(f.label);
  });

  it("treats euphoric complacency as its own risk (multiplier below 1)", () => {
    const f = computeFearIndex({
      vix: 10,
      vix9d: 8,
      vix3m: 14,
      vvix: 70,
      skew: 110,
      putCallProxy: 0,
      drawdownPct: 0,
    });
    expect(f.label).toBe("extreme_greed");
    expect(f.sizeMultiplier).toBeLessThan(1);
  });

  it("re-normalises weights when components are missing", () => {
    const only = computeFearIndex({ vix: 40 });
    expect(only.score).toBeGreaterThan(90);
    expect(only.components.filter((c) => c.score != null)).toHaveLength(1);
  });

  it("ignores non-finite inputs", () => {
    const f = computeFearIndex({ vix: Number.NaN, vvix: Infinity });
    expect(f.score).toBe(50);
  });

  it("labels boundaries consistently", () => {
    expect(labelFor(80)).toBe("extreme_fear");
    expect(labelFor(60)).toBe("fear");
    expect(labelFor(41)).toBe("neutral");
    expect(labelFor(20)).toBe("extreme_greed");
  });

  it("formats a prompt block containing the score and enforced multiplier", () => {
    const f = computeFearIndex({ vix: 30, drawdownPct: -0.1 });
    const block = formatFearIndexBlock(f);
    expect(block).toContain("FEAR INDEX");
    expect(block).toContain(`${f.score.toFixed(0)}/100`);
    expect(block).toContain(`×${f.sizeMultiplier.toFixed(2)}`);
  });
});
