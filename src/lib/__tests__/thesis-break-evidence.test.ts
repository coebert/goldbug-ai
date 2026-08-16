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
