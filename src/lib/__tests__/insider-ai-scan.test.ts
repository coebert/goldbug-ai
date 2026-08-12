import { describe, expect, it } from "vitest";
import {
  applyAiVerdict,
  buildInsiderScanPrompt,
  clusterFactor,
  effectiveInsiderNudge,
  insiderSignalsWithAi,
  parseInsiderScanReply,
  type InsiderSignalRow,
} from "@/lib/insider-ai-scan";
import { INSIDER_NUDGE_CEILING, INSIDER_NUDGE_FLOOR } from "@/lib/insider-dealings";

function row(over: Partial<InsiderSignalRow>): InsiderSignalRow {
  return {
    symbol: "MKS.L",
    company: "Marks & Spencer",
    event_date: "2026-08-10",
    headline: "CEO sells shares",
    summary: null,
    source: "RNS (Investegate)",
    url: null,
    direction: "sell",
    flavour: "discretionary",
    person: "Jane Doe",
    role: "CEO",
    shares: null,
    value: null,
    severity: 0.8,
    sentiment_nudge: -0.12,
    ...over,
  } as InsiderSignalRow;
}

describe("applyAiVerdict", () => {
  it("keeps a confident signal near full strength but inside the bounds", () => {
    const out = applyAiVerdict({ sentiment_nudge: -0.12 }, { verdict: "signal", confidence: 1, rationale: "r" });
    expect(out.ai_nudge).toBeLessThan(-0.12);
    expect(out.ai_nudge).toBeGreaterThanOrEqual(INSIDER_NUDGE_FLOOR);
  });

  it("all but silences mechanical vesting/tax disposals", () => {
    const out = applyAiVerdict({ sentiment_nudge: -0.12 }, { verdict: "mechanical", confidence: 0.9, rationale: "" });
    expect(out.ai_nudge).toBeCloseTo(-0.018, 3);
  });

  it("zeroes anything the model calls noise", () => {
    const out = applyAiVerdict({ sentiment_nudge: -0.15 }, { verdict: "noise", confidence: 0.4, rationale: "buyback" });
    expect(out.ai_nudge).toBe(0);
  });

  it("never escapes the hard bounds", () => {
    const buy = applyAiVerdict({ sentiment_nudge: 0.1 }, { verdict: "signal", confidence: 1, rationale: "" });
    expect(buy.ai_nudge).toBeLessThanOrEqual(INSIDER_NUDGE_CEILING);
    const sell = applyAiVerdict({ sentiment_nudge: -0.15 }, { verdict: "signal", confidence: 1, rationale: "" });
    expect(sell.ai_nudge).toBeGreaterThanOrEqual(INSIDER_NUDGE_FLOOR);
  });
});

describe("parseInsiderScanReply", () => {
  it("reads verdicts wrapped in prose and fences", () => {
    const parsed = parseInsiderScanReply(
      'Sure!\n```json\n{"verdicts":[{"i":0,"verdict":"signal","confidence":0.8,"rationale":"open-market sale"}]}\n```',
    );
    expect(parsed.get(0)?.verdict).toBe("signal");
    expect(parsed.get(0)?.confidence).toBe(0.8);
  });

  it("drops unknown verdict labels and clamps confidence", () => {
    const parsed = parseInsiderScanReply(
      '{"verdicts":[{"i":0,"verdict":"maybe","confidence":0.5},{"i":1,"verdict":"noise","confidence":4}]}',
    );
    expect(parsed.has(0)).toBe(false);
    expect(parsed.get(1)?.confidence).toBe(1);
  });

  it("returns empty on unparseable output instead of throwing", () => {
    expect(parseInsiderScanReply("no json here").size).toBe(0);
    expect(parseInsiderScanReply("").size).toBe(0);
  });
});

describe("buildInsiderScanPrompt", () => {
  it("lists every candidate and asks for strict JSON", () => {
    const prompt = buildInsiderScanPrompt([
      {
        index: 0,
        symbol: "MKS.L",
        company: "Marks & Spencer",
        headline: "CEO sells 400,000 shares",
        direction: "sell",
        flavour: "discretionary",
        role: "CEO",
      },
    ]);
    expect(prompt).toContain("MKS.L");
    expect(prompt).toContain("CEO sells 400,000 shares");
    expect(prompt).toContain('"verdicts"');
  });
});

describe("insiderSignalsWithAi", () => {
  it("prefers the reviewed nudge over the keyword score", () => {
    const [signal] = insiderSignalsWithAi([row({ sentiment_nudge: -0.12, ai_verdict: "mechanical", ai_nudge: -0.02 })]);
    expect(signal.nudge).toBeCloseTo(-0.02, 4);
    expect(effectiveInsiderNudge(row({ ai_nudge: -0.02 }))).toBe(-0.02);
  });

  it("excludes events the model rejected as noise", () => {
    const out = insiderSignalsWithAi([
      row({ headline: "Company launches buyback", ai_verdict: "noise", ai_nudge: 0 }),
      row({ person: "Jane Doe", ai_verdict: "signal", ai_nudge: -0.05 }),
    ]);
    expect(out[0].events).toBe(1);
    expect(out[0].nudge).toBeCloseTo(-0.05, 4);
  });

  it("drops the symbol entirely when every event is noise", () => {
    expect(insiderSignalsWithAi([row({ ai_verdict: "noise", ai_nudge: 0 })])).toHaveLength(0);
  });

  it("applies a bounded cluster premium for multiple distinct insiders", () => {
    const out = insiderSignalsWithAi([
      row({ person: "Jane Doe", ai_verdict: "signal", ai_nudge: -0.04 }),
      row({ person: "John Roe", headline: "CFO sells shares", ai_verdict: "signal", ai_nudge: -0.04 }),
    ]);
    expect(out[0].cluster).toBe(2);
    expect(out[0].clusterDirection).toBe("sell");
    expect(out[0].nudge).toBeCloseTo(-0.088, 3);
    expect(clusterFactor(1)).toBe(1);
    expect(clusterFactor(9)).toBe(1.3);
  });

  it("clamps a large cluster back to the floor", () => {
    const rows = ["a", "b", "c", "d"].map((p) =>
      row({ person: p, ai_verdict: "signal", ai_nudge: -0.1 }),
    );
    expect(insiderSignalsWithAi(rows)[0].nudge).toBe(INSIDER_NUDGE_FLOOR);
  });
});
