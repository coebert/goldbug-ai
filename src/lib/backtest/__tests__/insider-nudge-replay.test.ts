import { describe, it, expect } from "vitest";
import {
  runNudgeReplay,
  activeNudge,
  eventNudge,
  normaliseRole,
  trendScore,
  DEFAULT_REPLAY_PARAMS,
  type Candlelike,
  type ReplayEvent,
} from "../insider-nudge-replay";

function tape(seed: number, n = 400, drift = 0.0006): Candlelike[] {
  const out: Candlelike[] = [];
  let px = 100;
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    px *= 1 + drift + rnd() * 0.02;
    out.push({ date: new Date(start + i * 86_400_000).toISOString().slice(0, 10), close: Number(px.toFixed(4)) });
  }
  return out;
}

describe("normaliseRole", () => {
  it("maps free-form filing roles onto scorer tokens", () => {
    expect(normaliseRole("Chief Executive Officer")).toBe("CEO");
    expect(normaliseRole("Chief Financial Officer")).toBe("CFO");
    expect(normaliseRole("Chairman of the Board")).toBe("Chair");
    expect(normaliseRole("Operations Director")).toBe("COO");
    expect(normaliseRole("Officer")).toBeNull();
    expect(normaliseRole(null)).toBeNull();
  });
});

describe("eventNudge", () => {
  it("is negative for a discretionary CEO sale and near zero for a tax disposal", () => {
    const sell = eventNudge({ symbol: "X", date: "2025-01-02", direction: "sell", flavour: "discretionary", role: "CEO", value: 3_000_000 });
    const tax = eventNudge({ symbol: "X", date: "2025-01-02", direction: "sell", flavour: "tax", role: "CEO", value: 3_000_000 });
    expect(sell).toBeLessThan(-0.1);
    expect(sell).toBeGreaterThanOrEqual(-0.15);
    expect(Math.abs(tax)).toBeLessThan(Math.abs(sell) / 3);
  });

  it("is positive but smaller for a director purchase", () => {
    const buy = eventNudge({ symbol: "X", date: "2025-01-02", direction: "buy", flavour: "discretionary", role: "CEO", value: 3_000_000 });
    expect(buy).toBeGreaterThan(0);
    expect(buy).toBeLessThanOrEqual(0.1);
  });
});

describe("activeNudge", () => {
  const ev = (date: string): ReplayEvent => ({
    symbol: "X",
    date,
    direction: "sell",
    flavour: "discretionary",
    role: "CEO",
    value: 5_000_000,
  });
  const age = (today: string) => (d: string) => Math.round((Date.parse(today) - Date.parse(d)) / 86_400_000);

  it("decays with age and drops out of the active window", () => {
    const p = { activeDays: 14, halfLifeDays: 7 };
    const fresh = activeNudge([ev("2025-01-01")], age("2025-01-01"), p);
    const week = activeNudge([ev("2025-01-01")], age("2025-01-08"), p);
    const gone = activeNudge([ev("2025-01-01")], age("2025-02-01"), p);
    expect(fresh).toBeLessThan(0);
    expect(week).toBeGreaterThan(fresh);
    expect(week).toBeLessThan(0);
    expect(gone).toBe(0);
  });

  it("clamps a cluster of filings to the production floor", () => {
    const many = ["2025-01-01", "2025-01-01", "2025-01-01", "2025-01-01"].map(ev);
    expect(activeNudge(many, age("2025-01-01"), { activeDays: 14, halfLifeDays: 7 })).toBe(-0.15);
  });

  it("ignores future-dated filings", () => {
    expect(activeNudge([ev("2025-06-01")], age("2025-01-01"), { activeDays: 14, halfLifeDays: 7 })).toBe(0);
  });
});

describe("trendScore", () => {
  it("is null before the slow average exists and bounded afterwards", () => {
    const closes = tape(7).map((c) => c.close);
    expect(trendScore(closes, 10)).toBeNull();
    const s = trendScore(closes, 200);
    expect(s).not.toBeNull();
    expect(s as number).toBeGreaterThanOrEqual(0);
    expect(s as number).toBeLessThanOrEqual(1);
  });
});

describe("runNudgeReplay", () => {
  const prices = new Map<string, Candlelike[]>([
    ["AAA.L", tape(11)],
    ["BBB.L", tape(29, 400, 0.0002)],
    ["CCC.L", tape(53, 400, -0.0003)],
  ]);

  it("returns identical arms when no events exist", () => {
    const r = runNudgeReplay({ prices, events: [] });
    expect(r.baseline.totalReturnPct).toBe(r.nudged.totalReturnPct);
    expect(r.delta.returnPct).toBe(0);
    expect(r.verdict).toBe("neutral");
    expect(r.tradingDays).toBeGreaterThan(300);
  });

  it("is deterministic across runs", () => {
    const events: ReplayEvent[] = [
      { symbol: "AAA.L", date: "2024-06-03", direction: "sell", flavour: "discretionary", role: "CEO", value: 4_000_000 },
    ];
    const a = runNudgeReplay({ prices, events });
    const b = runNudgeReplay({ prices, events });
    expect(a.delta).toEqual(b.delta);
    expect(a.confidence).toEqual(b.confidence);
  });

  it("nudgeScale 0 reproduces the baseline exactly", () => {
    const events: ReplayEvent[] = [
      { symbol: "AAA.L", date: "2024-06-03", direction: "sell", flavour: "discretionary", role: "CEO", value: 4_000_000 },
      { symbol: "BBB.L", date: "2024-09-10", direction: "buy", flavour: "discretionary", role: "CFO", value: 1_000_000 },
    ];
    const r = runNudgeReplay({ prices, events, params: { nudgeScale: 0 } });
    expect(r.delta.returnPct).toBe(0);
    expect(r.attribution.suppressedDays).toBe(0);
  });

  it("a large sale can suppress an otherwise-eligible name and the arms diverge", () => {
    const events: ReplayEvent[] = [];
    // A steady drip of big discretionary sales across the whole window.
    for (let m = 2; m < 12; m++) {
      events.push({
        symbol: "AAA.L",
        date: `2024-${String(m).padStart(2, "0")}-05`,
        direction: "sell",
        flavour: "discretionary",
        role: "CEO",
        value: 5_000_000,
      });
    }
    const r = runNudgeReplay({
      prices,
      events,
      params: { nudgeScale: 3, entryThreshold: 0.5, maxPositions: 2 },
    });
    expect(r.attribution.eventsInWindow).toBe(events.length);
    expect(r.attribution.sellEvents).toBe(events.length);
    expect(r.attribution.suppressedDays).toBeGreaterThan(0);
    expect(r.attribution.suppressedSymbols).toBe(1);
    expect(r.delta.returnPct).not.toBe(0);
    expect(["helps", "hurts", "neutral"]).toContain(r.verdict);
  });

  it("reports a bootstrap interval and honours the cost model", () => {
    const r = runNudgeReplay({ prices, events: [], params: { costBps: 50 } });
    expect(r.confidence.iterations).toBeGreaterThan(0);
    expect(r.confidence.returnDeltaLo).toBeLessThanOrEqual(r.confidence.returnDeltaHi);
    expect(r.baseline.totalCost).toBeGreaterThan(0);
    expect(r.params.costBps).toBe(50);
    expect(r.params.activeDays).toBe(DEFAULT_REPLAY_PARAMS.activeDays);
  });

  it("degrades gracefully on a short tape", () => {
    const r = runNudgeReplay({ prices: new Map([["AAA.L", tape(3, 20)]]), events: [] });
    expect(r.tradingDays).toBeLessThan(60);
    expect(r.verdict).toBe("neutral");
    expect(r.summary).toMatch(/Not enough tape/);
  });
});
