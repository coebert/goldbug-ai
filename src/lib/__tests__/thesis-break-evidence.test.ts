import { describe, expect, it } from "vitest";
import {
  buildEvidenceTape,
  evidenceFor,
  headlineMatchesSymbol,
  nameForms,
  tickerRoot,
} from "@/lib/backtest/thesis-break-evidence";

const dates = ["2026-05-01", "2026-05-15", "2026-06-01"];

describe("symbol matching", () => {
  it("strips exchange suffixes", () => {
    expect(tickerRoot("MKS.L")).toBe("MKS");
    expect(tickerRoot("AAPL:XNAS")).toBe("AAPL");
    expect(tickerRoot("AAPL")).toBe("AAPL");
  });

  it("derives short company-name forms", () => {
    expect(nameForms("Marks & Spencer Group plc")).toContain("marks & spencer group plc");
    expect(nameForms("Marks & Spencer Group plc")).toContain("marks & spencer");
  });

  it("matches on ticker token or company name, not substrings", () => {
    const forms = nameForms("Marks & Spencer Group plc");
    expect(headlineMatchesSymbol("MKS warns on profit", "MKS.L", forms)).toBe(true);
    expect(headlineMatchesSymbol("Marks & Spencer warns", "MKS.L", forms)).toBe(true);
    expect(headlineMatchesSymbol("REMARKS from the chancellor", "MKS.L", forms)).toBe(false);
  });
});

describe("buildEvidenceTape", () => {
  it("scores news with decay and computes momentum from the prior window", () => {
    const tape = buildEvidenceTape({
      symbols: ["AAPL"],
      names: { AAPL: "Apple Inc" },
      news: [
        { headline: "Apple beats", summary: null, sentiment: 0.8, date: "2026-04-20" },
        { headline: "AAPL guidance cut", summary: null, sentiment: -0.6, date: "2026-05-14" },
      ],
      insider: [],
      dates,
    });
    const e = evidenceFor(tape, "AAPL", "2026-05-15");
    expect(e.newsCount).toBe(1);
    expect(e.newsScore).toBeLessThan(0);
    // prior window held the positive story, so momentum is negative
    expect(e.newsMomentum).not.toBeNull();
    expect(e.newsMomentum!).toBeLessThan(0);
  });

  it("coerces string sentiment and skips unscored rows", () => {
    const tape = buildEvidenceTape({
      symbols: ["AAPL"],
      names: { AAPL: "Apple Inc" },
      news: [
        { headline: "AAPL slips", summary: null, sentiment: "-0.4", date: "2026-05-30" },
        { headline: "AAPL unscored", summary: null, sentiment: null, date: "2026-05-30" },
      ],
      insider: [],
      dates,
    });
    const e = evidenceFor(tape, "AAPL", "2026-06-01");
    expect(e.newsCount).toBe(1);
    expect(e.newsScore).toBeCloseTo(-0.4, 5);
  });

  it("signs the insider nudge by direction and decays it out of the window", () => {
    const tape = buildEvidenceTape({
      symbols: ["MKS.L"],
      news: [],
      insider: [
        { symbol: "MKS.L", date: "2026-05-14", direction: "sell", value: 1_000_000 },
      ],
      dates,
    });
    expect(evidenceFor(tape, "MKS.L", "2026-05-15").insiderNudge!).toBeLessThan(0);
    // Before the filing there is no insider evidence at all.
    expect(evidenceFor(tape, "MKS.L", "2026-05-01").insiderNudge).toBeNull();
    const near = evidenceFor(tape, "MKS.L", "2026-05-15").insiderNudge!;
    const far = evidenceFor(tape, "MKS.L", "2026-06-01").insiderNudge!;
    expect(Math.abs(far)).toBeLessThan(Math.abs(near));
  });

  it("down-weights mechanical awards versus discretionary dealings", () => {
    const opts = (mechanical: boolean) =>
      buildEvidenceTape({
        symbols: ["AAPL"],
        news: [],
        insider: [{ symbol: "AAPL", date: "2026-05-14", direction: "sell", value: 500_000, mechanical }],
        dates,
      });
    const disc = evidenceFor(opts(false), "AAPL", "2026-05-15").insiderNudge!;
    const mech = evidenceFor(opts(true), "AAPL", "2026-05-15").insiderNudge!;
    expect(Math.abs(mech)).toBeLessThan(Math.abs(disc));
  });

  it("keeps all streams null where there is no coverage", () => {
    const tape = buildEvidenceTape({ symbols: ["ZZZ"], news: [], insider: [], dates });
    const e = evidenceFor(tape, "ZZZ", "2026-05-15");
    expect(e).toEqual({
      newsScore: null,
      newsMomentum: null,
      insiderNudge: null,
      fundamentalsScore: null,
      newsCount: 0,
    });
  });

  it("clamps every stream into [-1, 1]", () => {
    const tape = buildEvidenceTape({
      symbols: ["AAPL"],
      names: { AAPL: "Apple Inc" },
      news: [{ headline: "AAPL", summary: null, sentiment: 9, date: "2026-05-14" }],
      insider: Array.from({ length: 20 }, () => ({
        symbol: "AAPL",
        date: "2026-05-14",
        direction: "sell" as const,
        value: 50_000_000,
      })),
      fundamentals: { AAPL: 0.4 },
      dates,
    });
    const e = evidenceFor(tape, "AAPL", "2026-05-15");
    expect(e.newsScore!).toBeLessThanOrEqual(1);
    expect(e.insiderNudge!).toBeGreaterThanOrEqual(-1);
    expect(e.fundamentalsScore).toBe(0.4);
  });
});

describe("thesis-break action logging", () => {
  // Long slow rise (so SMA20 crosses SMA50 and a position opens), then a
  // grinding fall that arms the layer without hitting the 8% stop at once.
  const bars: Array<{ date: string; close: number }> = [];
  const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  // Fall first so SMA20 sits below SMA50, then rise (entry cross), then grind down.
  for (let i = 0; i < 60; i++) bars.push({ date: day(i), close: 130 - i * 0.4 });
  for (let i = 0; i < 60; i++) bars.push({ date: day(60 + i), close: 106 + i * 0.6 });
  for (let i = 0; i < 40; i++) bars.push({ date: day(120 + i), close: 142 - i * 0.3 });

  it("records trim and close actions with the agreeing signals", async () => {
    const { replayArm } = await import("@/lib/backtest/thesis-break-replay");
    const { buildEvidenceTape } = await import("@/lib/backtest/thesis-break-evidence");
    const dates = bars.map((b) => b.date);
    const evidence = buildEvidenceTape({
      symbols: ["ACME"],
      news: [],
      insider: dates
        .filter((_, i) => i % 10 === 0)
        .map((d) => ({ symbol: "ACME", date: d, direction: "sell" as const, value: 800_000 })),
      fundamentals: { ACME: -0.5 },
      dates,
    });

    const arm = replayArm({ ACME: bars }, { thesisBreak: true, evidence });
    expect(arm.thesisEvents.length).toBeGreaterThan(0);
    expect(arm.actionMix.trim + arm.actionMix.close).toBe(arm.thesisEvents.length);
    for (const e of arm.thesisEvents) {
      expect(e.signals.length).toBeGreaterThanOrEqual(2);
      expect(e.action === "trim" ? e.sellFraction < 1 : e.sellFraction === 1).toBe(true);
      expect(e.unrealisedPct).toBeLessThan(0);
    }
    expect(Object.keys(arm.signalCounts).length).toBeGreaterThan(0);
  });

  it("trims at most once per position and reports the trimmed fraction", async () => {
    const { replayArm } = await import("@/lib/backtest/thesis-break-replay");
    const { buildEvidenceTape } = await import("@/lib/backtest/thesis-break-evidence");
    const dates = bars.map((b) => b.date);
    const evidence = buildEvidenceTape({
      symbols: ["ACME"],
      news: [],
      insider: dates.map((d) => ({ symbol: "ACME", date: d, direction: "sell" as const, value: 800_000 })),
      fundamentals: { ACME: -0.5 },
      dates,
    });
    const arm = replayArm({ ACME: bars }, { thesisBreak: true, evidence });
    for (const t of arm.trades) {
      expect(t.thesisActions.filter((a) => a.action === "trim").length).toBeLessThanOrEqual(1);
      expect(t.trimmedFraction).toBeGreaterThanOrEqual(0);
      expect(t.trimmedFraction).toBeLessThanOrEqual(1);
    }
  });

  it("logs nothing on the stop-only arm", async () => {
    const { replayArm } = await import("@/lib/backtest/thesis-break-replay");
    const arm = replayArm({ ACME: bars }, { thesisBreak: false });
    expect(arm.thesisEvents).toEqual([]);
    expect(arm.actionMix).toEqual({ trim: 0, close: 0 });
    expect(arm.trades.every((t) => t.thesisActions.length === 0)).toBe(true);
  });
});
