import { describe, it, expect } from "vitest";
import {
  detectMirroredPortfolios,
  holdingsFingerprint,
  hasMirrorError,
  relDiff,
  type MirrorPortfolioInput,
} from "@/lib/portfolio-mirror-detect";

function p(over: Partial<MirrorPortfolioInput> & { id: string; name: string }): MirrorPortfolioInput {
  return {
    current_cash: 1000,
    equity: 10000,
    holdings: [{ symbol: "AAPL", quantity: 10, avg_cost: 100 }],
    ...over,
  };
}

describe("holdingsFingerprint", () => {
  it("is order- and case-independent", () => {
    const a = holdingsFingerprint([
      { symbol: "msft", quantity: 5 },
      { symbol: "AAPL", quantity: 10 },
    ]);
    const b = holdingsFingerprint([
      { symbol: "AAPL", quantity: 10 },
      { symbol: "MSFT", quantity: 5 },
    ]);
    expect(a).toBe(b);
  });

  it("drops zero-quantity rows and merges duplicates", () => {
    expect(holdingsFingerprint([{ symbol: "AAPL", quantity: 0 }])).toBe("");
    expect(
      holdingsFingerprint([
        { symbol: "AAPL", quantity: 4 },
        { symbol: "AAPL", quantity: 6 },
      ]),
    ).toBe("AAPL:10");
  });

  it("distinguishes different quantities", () => {
    expect(holdingsFingerprint([{ symbol: "AAPL", quantity: 10 }])).not.toBe(
      holdingsFingerprint([{ symbol: "AAPL", quantity: 11 }]),
    );
  });
});

describe("relDiff", () => {
  it("returns 0 for two zeros and scales relatively", () => {
    expect(relDiff(0, 0)).toBe(0);
    expect(relDiff(100, 100)).toBe(0);
    expect(relDiff(100, 110)).toBeCloseTo(10 / 110, 10);
  });
});

describe("detectMirroredPortfolios", () => {
  it("flags identical books sharing one broker account as an error", () => {
    const findings = detectMirroredPortfolios([
      p({ id: "1", name: "High risk sim", risk_level: "high", broker_account_id: "ACC-1" }),
      p({ id: "2", name: "Balanced risk sim", risk_level: "balanced", broker_account_id: "ACC-1" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].cause).toBe("shared_broker_account");
    expect(findings[0].portfolioIds).toEqual(["1", "2"]);
    expect(findings[0].symbols).toEqual(["AAPL"]);
    expect(findings[0].message).toContain("High risk sim");
    expect(findings[0].details.join(" ")).toContain("same broker account");
    expect(findings[0].details.join(" ")).toContain("Risk levels differ");
    expect(hasMirrorError(findings)).toBe(true);
  });

  it("flags two unlinked portfolios as a default-account fallback", () => {
    const findings = detectMirroredPortfolios([
      p({ id: "1", name: "A", broker_account_id: null }),
      p({ id: "2", name: "B", broker_account_id: "  " }),
    ]);
    expect(findings[0].cause).toBe("unlinked_default_account_fallback");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].brokerAccountIds).toEqual([null, null]);
  });

  it("flags a linked/unlinked pair separately", () => {
    const findings = detectMirroredPortfolios([
      p({ id: "1", name: "A", broker_account_id: "ACC-1" }),
      p({ id: "2", name: "B", broker_account_id: null }),
    ]);
    expect(findings[0].cause).toBe("linked_and_unlinked_mismatch");
    expect(findings[0].severity).toBe("error");
  });

  it("downgrades to a warning when the accounts genuinely differ", () => {
    const findings = detectMirroredPortfolios([
      p({ id: "1", name: "A", broker_account_id: "ACC-1" }),
      p({ id: "2", name: "B", broker_account_id: "ACC-2" }),
    ]);
    expect(findings[0].cause).toBe("unknown");
    expect(findings[0].severity).toBe("warning");
    expect(hasMirrorError(findings)).toBe(false);
  });

  it("does not flag portfolios whose holdings differ", () => {
    const findings = detectMirroredPortfolios([
      p({ id: "1", name: "A", broker_account_id: "ACC-1" }),
      p({
        id: "2",
        name: "B",
        broker_account_id: "ACC-1",
        holdings: [{ symbol: "AAPL", quantity: 9 }],
      }),
    ]);
    expect(findings).toEqual([]);
  });

  it("does not flag portfolios whose equity or cash differ beyond tolerance", () => {
    expect(
      detectMirroredPortfolios([
        p({ id: "1", name: "A", equity: 10000 }),
        p({ id: "2", name: "B", equity: 10500 }),
      ]),
    ).toEqual([]);
    expect(
      detectMirroredPortfolios([
        p({ id: "1", name: "A", current_cash: 1000 }),
        p({ id: "2", name: "B", current_cash: 1400 }),
      ]),
    ).toEqual([]);
  });

  it("treats sub-tolerance rounding noise as identical", () => {
    const findings = detectMirroredPortfolios([
      p({ id: "1", name: "A", equity: 10000, broker_account_id: "ACC-1" }),
      p({ id: "2", name: "B", equity: 10000.001, broker_account_id: "ACC-1" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].equityDeltaPct).toBeLessThan(0.001);
  });

  it("ignores two empty portfolios by default but reports them when asked", () => {
    const empties: MirrorPortfolioInput[] = [
      p({ id: "1", name: "A", equity: 0, current_cash: 0, holdings: [] }),
      p({ id: "2", name: "B", equity: 0, current_cash: 0, holdings: [] }),
    ];
    expect(detectMirroredPortfolios(empties)).toEqual([]);
    expect(detectMirroredPortfolios(empties, { ignoreEmpty: false })).toHaveLength(1);
  });

  it("reports every offending pair across three mirrored portfolios", () => {
    const findings = detectMirroredPortfolios([
      p({ id: "1", name: "A", broker_account_id: "ACC-1" }),
      p({ id: "2", name: "B", broker_account_id: "ACC-1" }),
      p({ id: "3", name: "C", broker_account_id: "ACC-1" }),
    ]);
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.portfolioIds)).toEqual([
      ["1", "2"],
      ["1", "3"],
      ["2", "3"],
    ]);
  });

  it("sorts errors ahead of warnings", () => {
    const findings = detectMirroredPortfolios([
      p({ id: "1", name: "A", broker_account_id: "ACC-1" }),
      p({ id: "2", name: "B", broker_account_id: "ACC-2" }),
      p({ id: "3", name: "C", broker_account_id: "ACC-1" }),
    ]);
    expect(findings[0].severity).toBe("error");
    expect(findings.at(-1)!.severity).toBe("warning");
  });

  it("is stable regardless of input order", () => {
    const a = p({ id: "1", name: "A", broker_account_id: "ACC-1" });
    const b = p({ id: "2", name: "B", broker_account_id: "ACC-1" });
    const one = detectMirroredPortfolios([a, b])[0];
    const two = detectMirroredPortfolios([b, a])[0];
    expect(one.cause).toBe(two.cause);
    expect(one.holdingsFingerprint).toBe(two.holdingsFingerprint);
    expect(new Set(two.portfolioIds)).toEqual(new Set(one.portfolioIds));
  });

  it("handles fewer than two portfolios", () => {
    expect(detectMirroredPortfolios([])).toEqual([]);
    expect(detectMirroredPortfolios([p({ id: "1", name: "A" })])).toEqual([]);
  });
});
