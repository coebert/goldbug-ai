// The explainability panel is only useful if its arithmetic is *the same*
// arithmetic the engine used. These tests pin the two together.

import { describe, expect, it } from "vitest";
import {
  computePolicySignals,
  describePolicyNudge,
  explainPolicyNudge,
  policySentimentNudge,
  POLICY_MAX_NUDGE,
  type PolicyRow,
} from "@/lib/policy-makers";

const AS_OF = "2026-08-13";

const ROWS: PolicyRow[] = [
  {
    headline: "Andrew Bailey says rate cuts are premature as inflation risk persists",
    summary: "Bank of England governor pushed back on easing bets.",
    source: "Reuters",
    url: "https://example.test/1",
    date: "2026-08-13",
    sentiment: -0.2,
  },
  {
    headline: "Bank of England MPC minutes signal higher for longer",
    source: "FT",
    date: "2026-08-11",
    sentiment: null,
  },
  {
    headline: "Jerome Powell says disinflation is on track and hints at a rate cut",
    source: "Bloomberg",
    date: "2026-08-12",
    sentiment: 0.4,
  },
  { headline: "Vodafone launches new tariff", source: "PR", date: "2026-08-13", sentiment: 0.1 },
];

describe("explainPolicyNudge", () => {
  it("reproduces the engine's score and nudge for a symbol", () => {
    const signals = computePolicySignals(ROWS, AS_OF);
    for (const symbol of ["ISF.L", "SPY", "TLT"]) {
      const x = explainPolicyNudge(symbol, ROWS, AS_OF);
      const engineSignal = signals.find((s) => s.symbol === symbol.toUpperCase());
      expect(x.score).toBe(engineSignal?.score ?? 0);
      expect(x.statements).toBe(engineSignal?.statements ?? 0);
      expect(x.nudge).toBe(policySentimentNudge(symbol, signals));
    }
  });

  it("attributes shares that sum to the symbol score", () => {
    const x = explainPolicyNudge("ISF.L", ROWS, AS_OF);
    expect(x.contributions.length).toBeGreaterThan(1);
    const total = x.contributions.reduce((a, c) => a + c.share, 0);
    expect(total).toBeCloseTo(x.score, 2);
  });

  it("decays older remarks and records the factor", () => {
    const x = explainPolicyNudge("ISF.L", ROWS, AS_OF);
    const fresh = x.contributions.find((c) => c.date === "2026-08-13");
    const older = x.contributions.find((c) => c.date === "2026-08-11");
    expect(fresh!.decay).toBeGreaterThan(older!.decay);
    expect(older!.age_hours).toBeGreaterThan(fresh!.age_hours);
    // 48h half-life: a two-day-old remark keeps roughly half its weight.
    expect(older!.decay).toBeLessThan(0.75);
  });

  it("halves the weight of a secondary proxy symbol", () => {
    const primary = explainPolicyNudge("SPY", ROWS, AS_OF).contributions.find(
      (c) => c.maker_id === "fed-chair",
    );
    const proxy = explainPolicyNudge("GLD", ROWS, AS_OF).contributions.find(
      (c) => c.maker_id === "fed-chair",
    );
    expect(primary?.proximity).toBe(1);
    expect(proxy?.proximity).toBe(0.5);
    expect(proxy!.weight).toBeCloseTo(primary!.weight / 2, 4);
  });

  it("never exceeds the ±10pt cap and stays empty when nothing matches", () => {
    for (const s of ["ISF.L", "SPY", "VOD.L"]) {
      expect(Math.abs(explainPolicyNudge(s, ROWS, AS_OF).nudge)).toBeLessThanOrEqual(
        POLICY_MAX_NUDGE + 1e-9,
      );
    }
    const none = explainPolicyNudge("VOD.L", ROWS, AS_OF);
    expect(none.statements).toBe(0);
    expect(none.nudge).toBe(0);
    expect(describePolicyNudge(none, "buy")).toMatch(/changed nothing/i);
  });

  it("reads hawkish guidance as an argument against a buy", () => {
    const x = explainPolicyNudge("ISF.L", ROWS, AS_OF);
    expect(x.stance).toBe("hawkish");
    expect(x.nudge).toBeLessThan(0);
    expect(describePolicyNudge(x, "buy")).toMatch(/argued against this buy/);
    expect(describePolicyNudge(x, "sell")).toMatch(/supported trimming/);
  });

  it("ignores remarks older than the 7-day window", () => {
    const stale = explainPolicyNudge("ISF.L", ROWS, "2026-08-25");
    expect(stale.statements).toBe(0);
  });
});
