import { describe, it, expect } from "vitest";
import { guardFxMatrix, type FxMatrixEntry } from "@/lib/fx-matrix-guard";

const mk = (
  entries: Record<string, FxMatrixEntry>,
): Map<string, FxMatrixEntry> => new Map(Object.entries(entries));

describe("guardFxMatrix", () => {
  it("returns no block when every required pair is live and fresh", () => {
    const g = guardFxMatrix("GBP", ["USD", "EUR"], mk({
      GBPUSD: { rate: 1.25, stale: false, source: "yahoo" },
      GBPEUR: { rate: 1.15, stale: false, source: "frankfurter" },
    }));
    expect(g.hasBlock).toBe(false);
    expect(g.blocked).toEqual([]);
    expect(g.blockedCcys.size).toBe(0);
  });

  it("blocks a missing pair with reason=missing", () => {
    const g = guardFxMatrix("GBP", ["USD"], mk({}));
    expect(g.hasBlock).toBe(true);
    expect(g.blocked[0].reason).toBe("missing");
    expect(g.blocked[0].detail).toMatch(/GBP->USD missing/);
    expect(g.blockedCcys.has("USD")).toBe(true);
  });

  it("blocks identity-fallback pairs even when stale=false", () => {
    const g = guardFxMatrix("GBP", ["USD"], mk({
      GBPUSD: { rate: 1, stale: true, source: "fallback:yahoo(x)+frankfurter(y)" },
    }));
    expect(g.blocked[0].reason).toBe("identity_fallback");
    expect(g.blocked[0].source).toMatch(/^fallback:/);
  });

  it("blocks stale non-fallback pairs (cache-stale)", () => {
    const g = guardFxMatrix("GBP", ["USD"], mk({
      GBPUSD: { rate: 1.24, stale: true, source: "cache-stale" },
    }));
    expect(g.blocked[0].reason).toBe("stale");
    expect(g.blocked[0].source).toBe("cache-stale");
  });

  it("ignores base==to pairs and de-duplicates repeated ccys", () => {
    const g = guardFxMatrix("GBP", ["GBP", "USD", "USD"], mk({
      GBPUSD: { rate: 1.25, stale: false, source: "yahoo" },
    }));
    expect(g.hasBlock).toBe(false);
    expect(g.blocked).toHaveLength(0);
  });

  it("returns one row per blocked pair in input order and mixes reasons", () => {
    const g = guardFxMatrix("GBP", ["USD", "EUR", "JPY"], mk({
      GBPUSD: { rate: 1.25, stale: false, source: "yahoo" },
      GBPEUR: { rate: 1, stale: true, source: "fallback:yahoo(x)+frankfurter(y)" },
      // JPY missing entirely.
    }));
    expect(g.blocked.map((b) => [b.to, b.reason])).toEqual([
      ["EUR", "identity_fallback"],
      ["JPY", "missing"],
    ]);
    expect(g.blockedCcys).toEqual(new Set(["EUR", "JPY"]));
  });

  it("upper-cases inputs (base and required ccys)", () => {
    const g = guardFxMatrix("gbp", ["usd"], mk({
      GBPUSD: { rate: 1.25, stale: false, source: "yahoo" },
    }));
    expect(g.hasBlock).toBe(false);
  });
});
