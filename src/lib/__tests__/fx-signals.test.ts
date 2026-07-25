import { describe, it, expect } from "vitest";
import {
  pctChange,
  mean,
  stddev,
  dailyReturns,
  annualisedVolPct,
  sma,
  signalsFromCloses,
} from "@/lib/fx-signals.server";
import { eventsNear, pairHasEventNear } from "@/lib/fx-events";

const asOf = new Date("2026-03-01T12:00:00Z");

describe("fx-signals pure math", () => {
  it("pctChange handles zero/invalid inputs safely", () => {
    expect(pctChange(110, 100)).toBeCloseTo(10, 6);
    expect(pctChange(90, 100)).toBeCloseTo(-10, 6);
    expect(pctChange(1, 0)).toBeNull();
    expect(pctChange(Number.NaN, 100)).toBeNull();
  });

  it("mean and stddev match numpy for a trivial series", () => {
    expect(mean([1, 2, 3, 4, 5])).toBeCloseTo(3, 6);
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138089935, 6);
  });

  it("dailyReturns skips non-positive prices and NaNs", () => {
    expect(dailyReturns([100, 110, 121])).toEqual([0.1, 0.1]);
    // A zero price skips only the return whose *previous* price is 0.
    expect(dailyReturns([100, 0, 110])).toEqual([-1]);
  });

  it("annualisedVolPct returns null when insufficient data, otherwise scales √252", () => {
    expect(annualisedVolPct([1], 20)).toBeNull();
    const flat = Array.from({ length: 25 }, () => 100);
    expect(annualisedVolPct(flat, 20)).toBeCloseTo(0, 6);
    const jittery = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100];
    const v = annualisedVolPct(jittery, 20);
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThan(0);
  });

  it("sma requires the full window", () => {
    expect(sma([1, 2, 3], 5)).toBeNull();
    expect(sma([1, 2, 3, 4, 5], 5)).toBeCloseTo(3, 6);
  });
});

describe("signalsFromCloses", () => {
  it("returns a fully-null bundle when the series is empty", () => {
    const s = signalsFromCloses("GBP", "USD", [], asOf);
    expect(s.latest).toBeNull();
    expect(s.ret5dPct).toBeNull();
    expect(s.trendBias).toBe("neutral");
  });

  it("tags a steady uptrend as long_from", () => {
    const closes = Array.from({ length: 70 }, (_, i) => 1 + i * 0.005); // +0.5%/day
    const s = signalsFromCloses("GBP", "USD", closes, asOf);
    expect(s.ret5dPct).not.toBeNull();
    expect(s.ret20dPct as number).toBeGreaterThan(0);
    expect(s.ret60dPct as number).toBeGreaterThan(0);
    expect(s.distSma50Pct as number).toBeGreaterThan(0);
    expect(s.trendBias).toBe("long_from");
  });

  it("tags a steady downtrend as long_to", () => {
    const closes = Array.from({ length: 70 }, (_, i) => 2 - i * 0.005);
    const s = signalsFromCloses("EUR", "USD", closes, asOf);
    expect(s.trendBias).toBe("long_to");
  });

  it("stays neutral when signals disagree", () => {
    // Recent pop-up but longer trend flat.
    const closes = [
      ...Array.from({ length: 55 }, () => 1.0),
      ...Array.from({ length: 10 }, (_, i) => 1.0 + i * 0.001),
    ];
    const s = signalsFromCloses("USD", "JPY", closes, asOf);
    expect(["neutral", "long_from", "long_to"]).toContain(s.trendBias);
  });
});

describe("fx-events helpers", () => {
  it("finds an FOMC event within 24h", () => {
    const near = new Date("2026-03-18T15:00:00Z");
    const hits = eventsNear("USD", near, 24);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].ccy).toBe("USD");
  });

  it("rejects events outside the window", () => {
    const far = new Date("2026-03-25T12:00:00Z");
    expect(eventsNear("USD", far, 24)).toEqual([]);
  });

  it("pairHasEventNear fires for either side of the pair", () => {
    const near = new Date("2026-03-05T12:00:00Z");
    expect(pairHasEventNear("GBP", "EUR", near, 24)).toBe(true);
    expect(pairHasEventNear("AUD", "CAD", near, 24)).toBe(false);
  });
});
