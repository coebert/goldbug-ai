import { describe, expect, it } from "vitest";
import { stressFxLeg } from "@/lib/fx-stress-test";

// Synthetic GBPUSD history: 20y of calm tape with three injected crises so the
// "historical worst" scenarios have something to find.
function makeBars(): Array<{ date: string; rate: number }> {
  const bars: Array<{ date: string; rate: number }> = [];
  let rate = 1.30;
  const start = new Date("2006-01-02");
  let i = 0;
  for (let d = 0; d < 5000; d++) {
    const day = new Date(start.getTime() + d * 86_400_000);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue; // skip weekends
    // tiny deterministic wiggle
    rate *= 1 + 0.001 * Math.sin(i / 7);
    // injected crises
    if (i === 200) rate *= 1.04; // sharp adverse 1-day for a short
    if (i === 1500) rate *= 1.015; // start of a 1-week adverse run
    if (i >= 1500 && i < 1505) rate *= 1.012;
    bars.push({ date: day.toISOString().slice(0, 10), rate });
    i++;
  }
  return bars;
}

const SHORT_LEG = { quantity: -10_000, avgCost: 1.25, rate: 1.27, quoteToBase: 1 / 1.27 };

describe("stressFxLeg", () => {
  it("produces fixed shocks in both directions, adverse flagged correctly for a short", () => {
    const r = stressFxLeg(SHORT_LEG, makeBars());
    const fixed = r.scenarios.filter((s) => s.basis === "fixed-shock");
    expect(fixed).toHaveLength(8);
    const up10 = fixed.find((s) => s.key === "shock-up-0.1")!;
    expect(up10.adverse).toBe(true);
    expect(up10.shockedRate).toBeCloseTo(1.27 * 1.1, 10);
    expect(up10.pnlBaseNet).toBeLessThan(0);
    const dn10 = fixed.find((s) => s.key === "shock-dn-0.1")!;
    expect(dn10.adverse).toBe(false);
    expect(dn10.pnlBaseNet).toBeGreaterThan(0);
  });

  it("sizes P&L from entry, not from the current rate", () => {
    const r = stressFxLeg(SHORT_LEG, makeBars());
    const up5 = r.scenarios.find((s) => s.key === "shock-up-0.05")!;
    // qty -10000 × (1.27×1.05 − 1.25) = −835 USD gross, minus exit fee, ÷1.27 → GBP
    const gross = -10_000 * (1.27 * 1.05 - 1.25);
    const fee = Math.abs(-10_000) * 1.27 * 1.05 * 0.0003 + 0; // 3bps default, min £1-quote
    expect(up5.pnlQuoteNet).toBeCloseTo(gross - fee, 0);
    expect(up5.pnlBaseNet).toBeCloseTo((gross - fee) / 1.27, 0);
  });

  it("adds sigma gap and vol-spike scenarios when history is long enough", () => {
    const r = stressFxLeg(SHORT_LEG, makeBars());
    expect(r.sigmaDaily).not.toBeNull();
    const gaps = r.scenarios.filter((s) => s.basis === "gap-sigma");
    expect(gaps.map((g) => g.key)).toEqual(["gap-3sigma", "gap-6sigma"]);
    // short base → adverse gaps are UP moves
    for (const g of gaps) {
      expect(g.movePct).toBeGreaterThan(0);
      expect(g.pnlBaseNet).toBeLessThan(0);
    }
    const spikes = r.scenarios.filter((s) => s.basis === "vol-spike");
    expect(spikes.length).toBe(2);
    // 20-day drift is larger than 5-day drift
    expect(Math.abs(spikes[1].movePct)).toBeGreaterThan(Math.abs(spikes[0].movePct));
  });

  it("finds the injected crises as historical-worst scenarios", () => {
    const r = stressFxLeg(SHORT_LEG, makeBars());
    const worst1d = r.scenarios.find((s) => s.key === "hist-worst-1d")!;
    expect(worst1d.movePct).toBeGreaterThan(0.035); // the +4% injected crisis dominates
    const worst5d = r.scenarios.find((s) => s.key === "hist-worst-5d")!;
    expect(worst5d.movePct).toBeGreaterThan(0.05);
    expect(worst5d.label).toMatch(/→/);
  });

  it("flips adverse direction for a long-base leg", () => {
    const r = stressFxLeg({ ...SHORT_LEG, quantity: 10_000 }, makeBars());
    expect(r.side).toBe("long");
    const up = r.scenarios.find((s) => s.key === "shock-up-0.05")!;
    expect(up.adverse).toBe(false);
    expect(up.pnlBaseNet).toBeGreaterThan(0);
    const gap = r.scenarios.find((s) => s.key === "gap-3sigma")!;
    expect(gap.movePct).toBeLessThan(0); // adverse for a long is a gap down
  });

  it("reports worst case and NAV percentage", () => {
    const r = stressFxLeg(SHORT_LEG, makeBars(), { navBase: 10_000 });
    expect(r.worstCaseBase).toBeLessThan(0);
    expect(r.worstCaseLabel.length).toBeGreaterThan(0);
    const worst = r.scenarios.find((s) => s.pnlBaseNet === r.worstCaseBase)!;
    expect(worst.pnlPctOfNav).toBeCloseTo((worst.pnlBaseNet / 10_000) * 100, 1);
  });

  it("degrades gracefully with too little history", () => {
    const r = stressFxLeg(SHORT_LEG, [
      { date: "2026-01-01", rate: 1.26 },
      { date: "2026-01-02", rate: 1.27 },
    ]);
    expect(r.sigmaDaily).toBeNull();
    expect(r.scenarios.every((s) => s.basis === "fixed-shock")).toBe(true);
  });
});
