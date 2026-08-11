import { describe, expect, it } from "vitest";
import {
  LINK_WINDOW_DAYS,
  linkDecisionsToAnnotations,
  scoreInfluence,
  type DecisionRecord,
} from "../annotation-decision-link";
import type { ChartAnnotation } from "../chart-annotations";

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: over.id ?? "d1",
    symbol: over.symbol ?? "SPY",
    action: over.action ?? "buy",
    outcome: over.outcome ?? "filled",
    decidedAt: over.decidedAt ?? "2026-08-10T15:00:00Z",
    runDate: over.runDate ?? "2026-08-10",
    notional: over.notional ?? 1000,
    instrumentCcy: over.instrumentCcy ?? "GBP",
    rationale: over.rationale ?? "momentum",
  };
}

function annotation(date: string): ChartAnnotation {
  return {
    id: `spike_up:${date}`,
    kind: "spike_up",
    index: 3,
    date,
    close: 100,
    magnitudePct: 3.2,
    label: "Jump",
    fallbackNote: "Big move",
    note: "Big move",
    model: null,
    sources: [],
  };
}

describe("annotation ↔ decision linking", () => {
  it("ignores decisions outside the link window", () => {
    expect(
      scoreInfluence("2026-08-10", "SPY", decision({ decidedAt: "2026-08-01T10:00:00Z" })),
    ).toBeNull();
    expect(
      scoreInfluence(
        "2026-08-10",
        "SPY",
        decision({ decidedAt: `2026-08-${String(10 + LINK_WINDOW_DAYS).padStart(2, "0")}T10:00:00Z` }),
      ),
    ).not.toBeNull();
  });

  it("ranks same-instrument decisions above unrelated ones", () => {
    const same = scoreInfluence("2026-08-10", "SPY", decision())!;
    const other = scoreInfluence("2026-08-10", "SPY", decision({ symbol: "VTI" }))!;
    expect(same.sameInstrument).toBe(true);
    expect(other.sameInstrument).toBe(false);
    expect(same.influence).toBeGreaterThan(other.influence);
  });

  it("matches broker-native symbols to the charted instrument", () => {
    const scored = scoreInfluence("2026-08-10", "SPY", decision({ symbol: "SPY:xnas" }))!;
    expect(scored.sameInstrument).toBe(true);
  });

  it("ranks executed buys above routine holds and skipped orders", () => {
    const filled = scoreInfluence("2026-08-10", "SPY", decision({ symbol: "VTI" }))!;
    const hold = scoreInfluence(
      "2026-08-10",
      "SPY",
      decision({ symbol: "VTI", action: "hold", outcome: "hold" }),
    )!;
    const skipped = scoreInfluence(
      "2026-08-10",
      "SPY",
      decision({ symbol: "VTI", outcome: "skipped" }),
    )!;
    expect(filled.influence).toBeGreaterThan(skipped.influence);
    expect(skipped.influence).toBeGreaterThan(hold.influence);
  });

  it("attaches at most four decisions, best first", () => {
    const decisions = Array.from({ length: 8 }, (_, i) =>
      decision({ id: `d${i}`, symbol: `SYM${i}`, action: "hold", outcome: "hold" }),
    ).concat(decision({ id: "top", symbol: "SPY" }));

    const [linked] = linkDecisionsToAnnotations([annotation("2026-08-10")], "SPY", decisions);
    expect(linked.decisions).toHaveLength(4);
    expect(linked.decisions[0].id).toBe("top");
    expect(linked.decisions[0].dayGap).toBe(0);
  });

  it("returns an empty list when nothing happened near the move", () => {
    const [linked] = linkDecisionsToAnnotations(
      [annotation("2026-01-02")],
      "SPY",
      [decision()],
    );
    expect(linked.decisions).toEqual([]);
    expect(linked.note).toBe("Big move");
  });
});
