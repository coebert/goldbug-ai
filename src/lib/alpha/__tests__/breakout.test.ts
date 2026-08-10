import { describe, it, expect } from "vitest";
import {
  detectBreakout,
  scoreBreakout,
  breakoutSizeMultiplier,
  formatBreakoutBlock,
  type BreakoutCandle,
} from "@/lib/alpha/breakout";
import { effectiveWeightsForRegime, weightsForRegime } from "@/lib/alpha/regime-matrix";

function base(n = 80, px = 100, halfWidth = 2, vol = 1_000_000): BreakoutCandle[] {
  const out: BreakoutCandle[] = [];
  for (let i = 0; i < n; i++) {
    const c = px + (i % 4 < 2 ? halfWidth * 0.5 : -halfWidth * 0.5);
    out.push({ high: c + halfWidth * 0.4, low: c - halfWidth * 0.4, close: c, volume: vol });
  }
  return out;
}

function f(breakout: ReturnType<typeof detectBreakout> | null) {
  return { symbol: "TEST", breakout } as never;
}

describe("detectBreakout", () => {
  it("returns 'none' inside a range", () => {
    const b = detectBreakout(base());
    expect(b.state).toBe("none");
    expect(b.direction).toBeNull();
    expect(b.channel_high).toBeGreaterThan(b.channel_low!);
  });

  it("needs enough history", () => {
    expect(detectBreakout([{ high: 1, low: 1, close: 1 }]).state).toBe("none");
    expect(detectBreakout([]).quality).toBe(0);
  });

  it("calls a single close beyond the level 'pending'", () => {
    const c = base();
    const hi = Math.max(...c.map((x) => x.high));
    c.push({ high: hi + 3, low: hi, close: hi + 2.5, volume: 3_000_000 });
    const b = detectBreakout(c);
    expect(b.state).toBe("pending");
    expect(b.direction).toBe("up");
    expect(b.penetration_atr).toBeGreaterThan(0.25);
    expect(b.actionable).toBe(false);
  });

  it("confirms after a second holding close with volume", () => {
    const c = base();
    const hi = Math.max(...c.map((x) => x.high));
    c.push({ high: hi + 3, low: hi, close: hi + 2.5, volume: 3_000_000 });
    c.push({ high: hi + 4, low: hi + 1, close: hi + 3.2, volume: 2_500_000 });
    const b = detectBreakout(c);
    expect(b.state).toBe("confirmed");
    expect(b.bars_since_breakout).toBeGreaterThanOrEqual(2);
    expect(b.volume_ratio).toBeGreaterThan(1.4);
    expect(b.actionable).toBe(true);
    expect(b.quality).toBeGreaterThan(0.45);
  });

  it("marks a pierce that closes back inside as failed", () => {
    const c = base();
    const hi = Math.max(...c.map((x) => x.high));
    c.push({ high: hi + 3, low: hi, close: hi + 2.5, volume: 3_000_000 });
    c.push({ high: hi + 2, low: hi - 4, close: hi - 3, volume: 2_000_000 });
    const b = detectBreakout(c);
    expect(b.state).toBe("failed");
  });

  it("detects downside breakdowns symmetrically", () => {
    const c = base();
    const lo = Math.min(...c.map((x) => x.low));
    c.push({ high: lo, low: lo - 3, close: lo - 2.5, volume: 3_000_000 });
    c.push({ high: lo - 1, low: lo - 4, close: lo - 3.2, volume: 3_000_000 });
    const b = detectBreakout(c);
    expect(b.direction).toBe("down");
    expect(b.state).toBe("confirmed");
  });

  it("is not actionable without volume expansion", () => {
    const c = base();
    const hi = Math.max(...c.map((x) => x.high));
    c.push({ high: hi + 3, low: hi, close: hi + 2.5, volume: 500_000 });
    c.push({ high: hi + 4, low: hi + 1, close: hi + 3.2, volume: 400_000 });
    const b = detectBreakout(c);
    expect(b.state).toBe("confirmed");
    expect(b.actionable).toBe(false);
  });

  it("is not actionable when there is no compressed base", () => {
    // wide, trending base — range far wider than maxBasePct
    const c: BreakoutCandle[] = [];
    for (let i = 0; i < 80; i++) {
      const px = 50 + i * 2;
      c.push({ high: px + 1, low: px - 1, close: px, volume: 1_000_000 });
    }
    const hi = Math.max(...c.map((x) => x.high));
    c.push({ high: hi + 6, low: hi, close: hi + 5, volume: 3_000_000 });
    c.push({ high: hi + 8, low: hi + 2, close: hi + 7, volume: 3_000_000 });
    const b = detectBreakout(c);
    expect(b.actionable).toBe(false);
    expect(b.reasons.join(" ")).toContain("no compressed base");
  });

  it("marks stale breakouts as extended", () => {
    const c = base();
    const hi = Math.max(...c.map((x) => x.high));
    // slow grind that keeps making new closing highs (no upper wicks, so the
    // trailing channel never gets ahead of the close)
    for (let i = 0; i < 14; i++) {
      const px = hi + 3 + i * 0.5;
      c.push({ high: px, low: px - 0.5, close: px, volume: 2_000_000 });
    }
    const b = detectBreakout(c);
    expect(b.state).toBe("extended");
    expect(b.actionable).toBe(false);
  });

  it("tracks historical false-breakout attempts", () => {
    const c = base(200);
    // three prior pierces that all closed back inside
    for (const at of [60, 110, 160]) {
      const hi = Math.max(...c.slice(at - 55, at).map((x) => x.high));
      c[at] = { high: hi + 3, low: hi, close: hi + 2, volume: 2_000_000 };
      c[at + 1] = { high: hi, low: hi - 4, close: hi - 3, volume: 2_000_000 };
    }
    const b = detectBreakout(c);
    expect(b.prior_attempts).toBeGreaterThan(0);
    expect(b.false_breakout_rate).toBeGreaterThan(0);
  });
});

describe("scoreBreakout", () => {
  it("scores confirmed upside breakouts positive and breakdowns negative", () => {
    const c = base();
    const hi = Math.max(...c.map((x) => x.high));
    c.push({ high: hi + 3, low: hi, close: hi + 2.5, volume: 3_000_000 });
    c.push({ high: hi + 4, low: hi + 1, close: hi + 3.2, volume: 3_000_000 });
    expect(scoreBreakout(f(detectBreakout(c))).score).toBeGreaterThan(0.3);

    const d = base();
    const lo = Math.min(...d.map((x) => x.low));
    d.push({ high: lo, low: lo - 3, close: lo - 2.5, volume: 3_000_000 });
    d.push({ high: lo - 1, low: lo - 4, close: lo - 3.2, volume: 3_000_000 });
    expect(scoreBreakout(f(detectBreakout(d))).score).toBeLessThan(0);
  });

  it("treats a failed upside breakout as a bearish tell", () => {
    const c = base();
    const hi = Math.max(...c.map((x) => x.high));
    c.push({ high: hi + 3, low: hi, close: hi + 2.5, volume: 3_000_000 });
    c.push({ high: hi + 2, low: hi - 4, close: hi - 3, volume: 2_000_000 });
    expect(scoreBreakout(f(detectBreakout(c))).score).toBeLessThan(0);
  });

  it("scores 0 with no evidence and stays bounded", () => {
    expect(scoreBreakout(f(null)).score).toBe(0);
    expect(Math.abs(scoreBreakout(f(detectBreakout(base()))).score)).toBeLessThanOrEqual(1);
  });
});

describe("breakoutSizeMultiplier", () => {
  const mk = (over: Partial<ReturnType<typeof detectBreakout>>) =>
    ({ state: "confirmed", direction: "up", quality: 0.8, actionable: true, ...over }) as never;

  it("boosts buys on actionable breakouts and cuts unconfirmed ones", () => {
    expect(breakoutSizeMultiplier(mk({}), "buy").mult).toBeCloseTo(1.2);
    expect(breakoutSizeMultiplier(mk({ state: "pending", actionable: false }), "buy").mult).toBeCloseTo(0.8);
    expect(breakoutSizeMultiplier(mk({ state: "extended", actionable: false }), "buy").mult).toBeCloseTo(0.7);
    expect(breakoutSizeMultiplier(mk({ state: "failed", actionable: false }), "buy").mult).toBeCloseTo(0.5);
  });

  it("accelerates exits on breakdowns and failed breakouts", () => {
    expect(breakoutSizeMultiplier(mk({ direction: "down" }), "sell").mult).toBeCloseTo(1.2);
    expect(breakoutSizeMultiplier(mk({ state: "failed" }), "sell").mult).toBeCloseTo(1.15);
  });

  it("is neutral with no evidence", () => {
    expect(breakoutSizeMultiplier(null, "buy").mult).toBe(1);
    expect(breakoutSizeMultiplier(mk({ state: "none", direction: null }), "buy").mult).toBe(1);
  });
});

describe("regime matrix with breakout", () => {
  it("keeps every regime's weights summing to 1", () => {
    for (const r of ["risk_on", "risk_off", "high_vol", "low_vol", "trending", "range_bound", "unknown"]) {
      const w = weightsForRegime(r);
      expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      expect(Object.values(effectiveWeightsForRegime(r)).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    }
  });

  it("disables breakout in risk_off / high_vol and leans on it when trending", () => {
    expect(effectiveWeightsForRegime("risk_off").breakout).toBe(0);
    expect(effectiveWeightsForRegime("high_vol").breakout).toBe(0);
    expect(effectiveWeightsForRegime("trending").breakout).toBeGreaterThan(0.15);
  });
});

describe("formatBreakoutBlock", () => {
  it("reports none when everything is in range", () => {
    expect(formatBreakoutBlock([{ symbol: "A", breakout: detectBreakout(base()) }])).toContain("none");
  });

  it("lists live breakouts with their level and quality", () => {
    const c = base();
    const hi = Math.max(...c.map((x) => x.high));
    c.push({ high: hi + 3, low: hi, close: hi + 2.5, volume: 3_000_000 });
    c.push({ high: hi + 4, low: hi + 1, close: hi + 3.2, volume: 3_000_000 });
    const block = formatBreakoutBlock([{ symbol: "AAPL", breakout: detectBreakout(c) }]);
    expect(block).toContain("AAPL");
    expect(block).toContain("ACTIONABLE");
  });
});
