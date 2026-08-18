import { describe, expect, it } from "vitest";
import {
  buildSaxoChecklist,
  categoriseBlockedInstrument,
} from "@/lib/saxo-product-categories";

describe("categoriseBlockedInstrument", () => {
  it("maps gold ETCs to the commodity ETC section", () => {
    expect(categoriseBlockedInstrument("SGLN.L", "suitability", "iShares Physical Gold ETC").id)
      .toBe("etc_commodities");
  });

  it("maps inverse UCITS ETFs to the leveraged/inverse section", () => {
    expect(categoriseBlockedInstrument("XUKS.L", "suitability", null).id)
      .toBe("leveraged_inverse_etf");
    expect(categoriseBlockedInstrument("ABC.L", "suitability", "Daily Short FTSE 100 ETF").id)
      .toBe("leveraged_inverse_etf");
  });

  it("maps permission blocks and derivative wording to derivatives", () => {
    expect(categoriseBlockedInstrument("FOO", "not_permitted", null).id).toBe("derivatives");
    expect(categoriseBlockedInstrument("BAR", "suitability", "CFD on index").id)
      .toBe("derivatives");
  });

  it("maps not_tradable to exchange access", () => {
    expect(categoriseBlockedInstrument("SGLN.L", "not_tradable", "gold").id)
      .toBe("exchange_access");
  });

  it("falls back to complex ETFs for unlabelled suitability blocks", () => {
    expect(categoriseBlockedInstrument("ZZZ:xlon", "suitability", null).id).toBe("complex_etf");
  });
});

describe("buildSaxoChecklist", () => {
  it("groups, de-duplicates and orders categories", () => {
    const items = buildSaxoChecklist([
      { symbol: "XUKS.L", reason: "suitability" },
      { symbol: "SGLN.L", reason: "suitability", detail: "Physical Gold ETC" },
      { symbol: "XUKS.L", reason: "suitability" },
      { symbol: "XSPS.L", reason: "suitability" },
    ]);
    expect(items.map((i) => i.id)).toEqual(["etc_commodities", "leveraged_inverse_etf"]);
    expect(items[1]!.symbols).toEqual(["XSPS.L", "XUKS.L"]);
  });

  it("returns nothing when there are no blocks", () => {
    expect(buildSaxoChecklist([])).toEqual([]);
  });
});
