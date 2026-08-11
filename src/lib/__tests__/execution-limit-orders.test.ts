import { describe, it, expect } from "vitest";
import {
  DEFAULT_LIMIT_ORDER,
  barVolBpsSeries,
  drawExtraBps,
  limitFillOdds,
  makeLimitOrderSampler,
} from "../execution-limit-orders";

describe("limitFillOdds", () => {
  it("falls with a more passive offset and rises with volatility", () => {
    const near = limitFillOdds({ ...DEFAULT_LIMIT_ORDER, limitOffsetBps: 2 }, 100);
    const far = limitFillOdds({ ...DEFAULT_LIMIT_ORDER, limitOffsetBps: 40 }, 100);
    expect(near.pTouch).toBeGreaterThan(far.pTouch);

    const calm = limitFillOdds(DEFAULT_LIMIT_ORDER, 40);
    const wild = limitFillOdds(DEFAULT_LIMIT_ORDER, 400);
    expect(wild.pTouch).toBeGreaterThan(calm.pTouch);
    expect(wild.pTouch).toBeLessThanOrEqual(1);
  });

  it("joining the touch fills with certainty on the touch leg", () => {
    const odds = limitFillOdds({ ...DEFAULT_LIMIT_ORDER, limitOffsetBps: 0 }, 100);
    expect(odds.pTouch).toBe(1);
    expect(odds.pFill).toBeCloseTo(odds.pQueue, 12);
  });

  it("queue odds are turnover / (turnover + depth ahead)", () => {
    const odds = limitFillOdds(
      { ...DEFAULT_LIMIT_ORDER, queueAheadRatio: 3, queueTurnoverRatio: 1 },
      100,
    );
    expect(odds.pQueue).toBeCloseTo(0.25, 12);
  });

  it("stress clears the queue faster (more volume prints)", () => {
    const calm = limitFillOdds(DEFAULT_LIMIT_ORDER, 100, false);
    const stressed = limitFillOdds(DEFAULT_LIMIT_ORDER, 100, true);
    expect(stressed.pQueue).toBeGreaterThan(calm.pQueue);
  });
});

describe("makeLimitOrderSampler", () => {
  const req = { barVolBps: 120, takerSlippageMult: 1, takerFillRatio: 1 };

  it("is deterministic for a given seed", () => {
    const a = makeLimitOrderSampler({}, 42);
    const b = makeLimitOrderSampler({}, 42);
    for (let i = 0; i < 200; i++) expect(a.draw(req)).toEqual(b.draw(req));
  });

  it("passive fills are cheaper on spread but carry adverse selection", () => {
    const s = makeLimitOrderSampler({ crossAfterBars: 3 }, 7);
    const makers = [];
    for (let i = 0; i < 500; i++) {
      const d = s.draw(req);
      if (d.liquidity === "maker") makers.push(d);
    }
    expect(makers.length).toBeGreaterThan(0);
    for (const d of makers) {
      expect(d.slippageMult).toBeLessThan(1);
      expect(d.feeBps).toBeLessThan(0); // rebate
      expect(d.driftBps).toBeGreaterThan(0); // adverse selection
      expect(drawExtraBps(d)).toBeGreaterThan(0); // net still a cost
      expect(d.fillRatio).toBeGreaterThan(0);
      expect(d.fillRatio).toBeLessThanOrEqual(1);
    }
  });

  it("crosses on timeout and pays the taker fee plus waiting drift", () => {
    // Unreachable limit: nothing ever gets touched, so every order crosses.
    const s = makeLimitOrderSampler({ limitOffsetBps: 5000, crossAfterBars: 2 }, 3);
    for (let i = 0; i < 50; i++) {
      const d = s.draw(req);
      expect(d.liquidity).toBe("taker");
      expect(d.touched).toBe(false);
      expect(d.waitedBars).toBe(2);
      expect(d.feeBps).toBeCloseTo(DEFAULT_LIMIT_ORDER.takerFeeBps, 12);
      expect(d.driftBps).toBeGreaterThan(0);
    }
    const stats = s.stats();
    expect(stats.makerShare).toBe(0);
    expect(stats.neverTouched).toBe(50);
    expect(stats.fillRate).toBe(1);
  });

  it("cancels instead of crossing when crossOnTimeout is off", () => {
    const s = makeLimitOrderSampler(
      { limitOffsetBps: 5000, crossAfterBars: 1, crossOnTimeout: false },
      11,
    );
    const d = s.draw(req);
    expect(d.liquidity).toBe("none");
    expect(d.fillRatio).toBe(0);
    expect(s.stats().fillRate).toBe(0);
  });

  it("forceTaker and crossAfterBars=0 skip the book entirely", () => {
    const s = makeLimitOrderSampler({ crossAfterBars: 4 }, 5);
    expect(s.draw({ ...req, forceTaker: true }).liquidity).toBe("taker");
    const immediate = makeLimitOrderSampler({ crossAfterBars: 0 }, 5);
    const d = immediate.draw(req);
    expect(d.liquidity).toBe("taker");
    expect(d.waitedBars).toBe(0);
    expect(d.driftBps).toBe(0);
  });

  it("inherits a no-fill from the underlying market draw when it crosses", () => {
    const s = makeLimitOrderSampler({ limitOffsetBps: 5000 }, 9);
    const d = s.draw({ ...req, takerFillRatio: 0 });
    expect(d.liquidity).toBe("none");
    expect(d.fillRatio).toBe(0);
    expect(s.stats().unfilled).toBe(1);
  });

  it("more patience means more passive fills", () => {
    const share = (crossAfterBars: number) => {
      const s = makeLimitOrderSampler({ crossAfterBars }, 2024);
      for (let i = 0; i < 800; i++) s.draw(req);
      return s.stats().makerShare;
    };
    expect(share(4)).toBeGreaterThan(share(1));
  });

  it("stress makes passive fills more adversely selected", () => {
    const avgDrift = (stressed: boolean) => {
      const s = makeLimitOrderSampler({ crossAfterBars: 3 }, 99);
      const xs: number[] = [];
      for (let i = 0; i < 600; i++) {
        const d = s.draw({ ...req, stressed });
        if (d.liquidity === "maker" && d.waitedBars === 0) xs.push(d.driftBps);
      }
      return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    };
    expect(avgDrift(true)).toBeGreaterThan(avgDrift(false));
  });

  it("stats add up", () => {
    const s = makeLimitOrderSampler({ crossAfterBars: 2 }, 77);
    for (let i = 0; i < 300; i++) s.draw(req);
    const st = s.stats();
    expect(st.orders).toBe(300);
    expect(st.makerFills + st.takerFills + st.unfilled).toBe(300);
    expect(st.avgWaitBars).toBeGreaterThanOrEqual(0);
  });
});

describe("barVolBpsSeries", () => {
  it("returns bps volatility that scales with move size", () => {
    const calm = Array.from({ length: 60 }, (_, i) => 100 * (1 + 0.0005 * (i % 2 ? 1 : -1)));
    const wild = Array.from({ length: 60 }, (_, i) => 100 * (1 + 0.05 * (i % 2 ? 1 : -1)));
    const c = barVolBpsSeries(calm).at(-1)!;
    const w = barVolBpsSeries(wild).at(-1)!;
    expect(w).toBeGreaterThan(c * 10);
    expect(c).toBeGreaterThan(0);
  });

  it("is defined for every bar and non-negative", () => {
    const out = barVolBpsSeries([10, 11, 12, 11, 13, 14]);
    expect(out).toHaveLength(6);
    expect(out.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });
});
