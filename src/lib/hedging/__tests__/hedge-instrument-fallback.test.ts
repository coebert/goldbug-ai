import { describe, it, expect } from "vitest";
import {
  hedgeCandidatesFor,
  selectHedgeInstrument,
  type HedgeEligibility,
} from "../hedge-instrument-fallback";

const all = (list: string[]) => (s: string) => list.some((x) => x.toUpperCase() === s.toUpperCase());

function eligibility(opts: {
  known?: string[];
  priced?: string[];
  blocked?: string[];
  held?: string[];
}): HedgeEligibility {
  return {
    isKnown: all(opts.known ?? ["SGLN.L", "SGLD.L", "PHAU.L", "GLD", "IAU"]),
    hasPrice: all(opts.priced ?? ["SGLN.L", "SGLD.L", "PHAU.L", "GLD", "IAU"]),
    isBlocked: all(opts.blocked ?? []),
    isHeld: all(opts.held ?? []),
  };
}

describe("hedgeCandidatesFor", () => {
  it("prefers LSE listings for GBP and US listings for USD", () => {
    expect(hedgeCandidatesFor("GBP")[0]).toBe("SGLN.L");
    expect(hedgeCandidatesFor("USD")[0]).toBe("GLD");
  });

  it("promotes an explicit override without duplicating it", () => {
    const list = hedgeCandidatesFor("GBP", "PHAU.L");
    expect(list[0]).toBe("PHAU.L");
    expect(list.filter((s) => s === "PHAU.L")).toHaveLength(1);
  });
});

describe("selectHedgeInstrument — buy", () => {
  it("uses the primary when eligible and reports no fallback", () => {
    const sel = selectHedgeInstrument({
      candidates: hedgeCandidatesFor("GBP"),
      side: "buy",
      eligibility: eligibility({}),
    });
    expect(sel.symbol).toBe("SGLN.L");
    expect(sel.fallbackFrom).toBeNull();
    expect(sel.note).toBe("");
  });

  it("falls back to the next gold wrapper when the primary is broker-blocked", () => {
    const sel = selectHedgeInstrument({
      candidates: hedgeCandidatesFor("GBP"),
      side: "buy",
      eligibility: eligibility({ blocked: ["SGLN.L"] }),
    });
    expect(sel.symbol).toBe("SGLD.L");
    expect(sel.fallbackFrom).toBe("SGLN.L");
    expect(sel.note).toContain("suitability");
  });

  it("skips blocked and unpriced candidates in ladder order", () => {
    const sel = selectHedgeInstrument({
      candidates: hedgeCandidatesFor("GBP"),
      side: "buy",
      eligibility: eligibility({ blocked: ["SGLN.L", "SGLD.L"], priced: ["PHAU.L", "GLD", "IAU"] }),
    });
    expect(sel.symbol).toBe("PHAU.L");
  });

  it("consolidates onto an already-held eligible wrapper", () => {
    const sel = selectHedgeInstrument({
      candidates: hedgeCandidatesFor("GBP"),
      side: "buy",
      eligibility: eligibility({ blocked: ["SGLN.L"], held: ["GLD"] }),
    });
    expect(sel.symbol).toBe("GLD");
    expect(sel.fallbackFrom).toBe("SGLN.L");
  });

  it("returns no symbol when every candidate is blocked", () => {
    const sel = selectHedgeInstrument({
      candidates: hedgeCandidatesFor("GBP"),
      side: "buy",
      eligibility: eligibility({ blocked: ["SGLN.L", "SGLD.L", "PHAU.L", "GLD", "IAU"] }),
    });
    expect(sel.symbol).toBeNull();
    expect(sel.note).toContain("no eligible gold hedge instrument");
  });

  it("ignores symbols outside the universe", () => {
    const sel = selectHedgeInstrument({
      candidates: ["FAKE.X", "SGLN.L"],
      side: "buy",
      eligibility: eligibility({}),
    });
    expect(sel.symbol).toBe("SGLN.L");
    expect(sel.rejected).toContainEqual({ symbol: "FAKE.X", reason: "not in universe" });
  });
});

describe("selectHedgeInstrument — sell", () => {
  it("unwinds a blocked instrument that is still held", () => {
    const sel = selectHedgeInstrument({
      candidates: hedgeCandidatesFor("GBP"),
      side: "sell",
      eligibility: eligibility({ blocked: ["SGLN.L"], held: ["SGLN.L"] }),
    });
    expect(sel.symbol).toBe("SGLN.L");
    expect(sel.fallbackFrom).toBeNull();
  });

  it("unwinds the substitute wrapper when that is what is held", () => {
    const sel = selectHedgeInstrument({
      candidates: hedgeCandidatesFor("GBP"),
      side: "sell",
      eligibility: eligibility({ held: ["SGLD.L"] }),
    });
    expect(sel.symbol).toBe("SGLD.L");
    expect(sel.fallbackFrom).toBe("SGLN.L");
  });

  it("tolerates a missing quote when the position is held", () => {
    const sel = selectHedgeInstrument({
      candidates: hedgeCandidatesFor("GBP"),
      side: "sell",
      eligibility: eligibility({ priced: [], held: ["SGLN.L"] }),
    });
    expect(sel.symbol).toBe("SGLN.L");
  });

  it("returns no symbol when nothing is held", () => {
    const sel = selectHedgeInstrument({
      candidates: hedgeCandidatesFor("GBP"),
      side: "sell",
      eligibility: eligibility({}),
    });
    expect(sel.symbol).toBeNull();
  });
});
