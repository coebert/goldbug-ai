import { describe, expect, it } from "vitest";
import { runPolicyNudgeSweep } from "../policy-nudge-sweep";
import { runPolicyNudgeReplay, type Candlelike } from "../policy-nudge-replay";
import type { PolicyRow } from "@/lib/policy-makers";

function tape(seed: number, n = 300): Candlelike[] {
  let px = 100;
  let a = seed;
  const out: Candlelike[] = [];
  for (let i = 0; i < n; i++) {
    a = (a * 1664525 + 1013904223) >>> 0;
    px *= 1 + ((a / 4294967296) - 0.48) * 0.03;
    out.push({ date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10), close: Number(px.toFixed(2)) });
  }
  return out;
}

const prices = new Map<string, Candlelike[]>([
  ["AAPL", tape(1)],
  ["MSFT", tape(7)],
  ["SPY", tape(13)],
]);

const news: PolicyRow[] = Array.from({ length: 40 }, (_, i) => ({
  headline:
    i % 2 === 0
      ? "Fed Chair Powell says rates must stay higher for longer to fight inflation"
      : "Powell signals the Fed is ready to cut rates as inflation cools",
  summary: null,
  source: "Reuters",
  url: null,
  date: new Date(Date.UTC(2024, 0, 40 + i * 5)).toISOString().slice(0, 10),
  sentiment: null,
}));

describe("policy nudge sensitivity sweep", () => {
  const result = runPolicyNudgeSweep({
    prices,
    news,
    nudgeScales: [0.5, 1],
    regimeGains: [0, 1],
    iterations: 200,
  });

  it("covers the full grid", () => {
    expect(result.cells).toHaveLength(4);
    expect(result.nudgeScales).toEqual([0.5, 1]);
    expect(result.regimeGains).toEqual([0, 1]);
  });

  it("collapses the regime arm onto the fixed nudge at gain 0", () => {
    for (const c of result.cells.filter((x) => x.regimeGain === 0)) {
      expect(c.vsFixed.returnPct).toBe(0);
      expect(c.regimeReturnPct).toBe(c.fixedReturnPct);
    }
  });

  it("matches a single replay at the same dials", () => {
    const single = runPolicyNudgeReplay({
      prices,
      news,
      iterations: 200,
      params: { nudgeScale: 1, regimeGain: 1 },
    });
    const cell = result.cells.find((c) => c.nudgeScale === 1 && c.regimeGain === 1)!;
    expect(cell.regimeReturnPct).toBe(single.regime.totalReturnPct);
    expect(cell.vsFixed.returnPct).toBe(single.regimeVsFixed.delta.returnPct);
  });

  it("is deterministic", () => {
    const again = runPolicyNudgeSweep({
      prices,
      news,
      nudgeScales: [0.5, 1],
      regimeGains: [0, 1],
      iterations: 200,
    });
    expect(again.cells).toEqual(result.cells);
    expect(again.summary).toBe(result.summary);
  });

  it("summarises the surface", () => {
    expect(result.summary.length).toBeGreaterThan(20);
    expect(result.winCount).toBeLessThanOrEqual(result.cells.length);
  });
});
