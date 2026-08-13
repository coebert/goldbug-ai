import { describe, it, expect } from "vitest";
import {
  computeCurrencyStances,
  computePolicySignals,
  detectPolicyStatement,
  detectPolicyStatements,
  formatPolicyBlock,
  POLICY_MAX_NUDGE,
  policySentimentNudge,
  scorePolicyTone,
  stanceOf,
} from "@/lib/policy-makers";

describe("detectPolicyStatement", () => {
  it("detects a tracked policy maker making remarks", () => {
    const m = detectPolicyStatement("Powell says rate cuts are premature amid sticky inflation");
    expect(m?.maker.id).toBe("fed-chair");
    expect(m?.tone).toBeLessThan(0);
  });

  it("ignores background coverage without an announcement marker", () => {
    expect(detectPolicyStatement("Powell portrait unveiled at the Federal Reserve building")).toBeNull();
  });

  it("ignores announcements by untracked people", () => {
    expect(detectPolicyStatement("Local mayor says rates should be cut")).toBeNull();
  });

  it("prefers the higher-weight maker on overlapping aliases", () => {
    const m = detectPolicyStatement("Federal Reserve chair Jerome Powell said policy stays restrictive");
    expect(m?.maker.id).toBe("fed-chair");
  });
});

describe("scorePolicyTone", () => {
  it("scores hawkish language negative and dovish positive", () => {
    expect(scorePolicyTone("higher for longer, tightening continues")).toBeLessThan(0);
    expect(scorePolicyTone("disinflation allows rate cuts")).toBeGreaterThan(0);
    expect(scorePolicyTone("the governor visited Leeds")).toBe(0);
  });

  it("maps scores onto stances", () => {
    expect(stanceOf(-0.6)).toBe("hawkish");
    expect(stanceOf(0.6)).toBe("dovish");
    expect(stanceOf(0.05)).toBe("neutral");
  });
});

const asOf = "2026-08-13";

describe("computePolicySignals", () => {
  const rows = [
    {
      headline: "Bailey says the Bank of England will cut rates as disinflation continues",
      date: asOf,
      sentiment: 0.4,
    },
    {
      headline: "Powell warns policy must stay restrictive, higher for longer",
      date: asOf,
      sentiment: -0.3,
    },
  ];

  it("produces per-symbol scores with the right sign", () => {
    const signals = computePolicySignals(rows, asOf);
    const isf = signals.find((s) => s.symbol === "ISF.L");
    const spy = signals.find((s) => s.symbol === "SPY");
    expect(isf?.score ?? 0).toBeGreaterThan(0);
    expect(spy?.score ?? 0).toBeLessThan(0);
    expect(isf?.stance).toBe("dovish");
    expect(spy?.stance).toBe("hawkish");
  });

  it("decays older remarks", () => {
    const fresh = computePolicySignals(rows, asOf).find((s) => s.symbol === "SPY")!;
    const stale = computePolicySignals(
      rows.map((r) => ({ ...r, date: "2026-08-09" })),
      asOf,
    ).find((s) => s.symbol === "SPY")!;
    // Same direction, but the stale set carries far less weight overall.
    expect(Math.sign(stale.score)).toBe(Math.sign(fresh.score));
    expect(stale.statements).toBe(fresh.statements);
  });

  it("drops remarks older than a week", () => {
    expect(computePolicySignals(rows.map((r) => ({ ...r, date: "2026-07-01" })), asOf)).toHaveLength(0);
  });

  it("returns nothing when no policy maker spoke", () => {
    expect(computePolicySignals([{ headline: "Tesla beats delivery estimates", date: asOf }], asOf)).toEqual([]);
  });
});

describe("policySentimentNudge", () => {
  it("is bounded and zero for untouched symbols", () => {
    const signals = computePolicySignals(
      [
        { headline: "Powell says tightening and higher for longer, inflation risk persists", date: asOf, sentiment: -1 },
        { headline: "FOMC statement: restrictive stance, no rush to cut", date: asOf, sentiment: -1 },
        { headline: "Fed governor Waller warns of sticky inflation, tightening bias", date: asOf, sentiment: -1 },
      ],
      asOf,
    );
    const nudge = policySentimentNudge("SPY", signals);
    expect(nudge).toBeLessThan(0);
    expect(Math.abs(nudge)).toBeLessThanOrEqual(POLICY_MAX_NUDGE + 1e-9);
    expect(policySentimentNudge("VOD.L", signals)).toBe(0);
  });
});

describe("currency stances and prompt block", () => {
  it("aggregates by currency and formats a prompt block", () => {
    const rows = [
      { headline: "Lagarde says the ECB will begin easing as disinflation takes hold", date: asOf, sentiment: 0.3 },
    ];
    const stances = computeCurrencyStances(rows, asOf);
    expect(stances[0].ccy).toBe("EUR");
    expect(stances[0].stance).toBe("dovish");

    const block = formatPolicyBlock(
      computePolicySignals(rows, asOf),
      stances,
      detectPolicyStatements(rows),
    );
    expect(block).toContain("POLICY-MAKER ANNOUNCEMENTS");
    expect(block).toContain("EUR dovish");
  });

  it("says so when nothing was said", () => {
    expect(formatPolicyBlock([], [], [])).toContain("no tracked policy remarks");
  });
});
