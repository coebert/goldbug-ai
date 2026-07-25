import { describe, it, expect } from "vitest";
import {
  getMarketStatusForVenue,
  getMarketStatusForSymbol,
  inferVenue,
  marketHadOpenPeriod,
} from "../market-hours";

// Anchors chosen so DST behaviour matches known state:
// - 2025-01-06 Mon: winter, LSE UTC = local
// - 2025-06-04 Wed: summer, both LSE (BST) and US (EDT)

describe("inferVenue", () => {
  it("maps common ticker shapes to venues", () => {
    expect(inferVenue("VOD.L")).toBe("LSE");
    expect(inferVenue("AAPL")).toBe("NYSE");
    expect(inferVenue("BTC-USD")).toBe("CRYPTO");
    expect(inferVenue("GBPUSD=X")).toBe("FX");
    expect(inferVenue("XYZ123!!")).toBe("OTHER");
  });
});

describe("getMarketStatusForVenue", () => {
  it("reports LSE open at 12:00 UK on a weekday (winter)", () => {
    // 2025-01-06 12:00 UTC == 12:00 London (GMT)
    const s = getMarketStatusForVenue("LSE", new Date("2025-01-06T12:00:00Z"));
    expect(s.isOpen).toBe(true);
    expect(s.phase).toBe("open");
    expect(s.localTime).toBe("12:00");
  });

  it("reports LSE weekend on Sunday", () => {
    const s = getMarketStatusForVenue("LSE", new Date("2025-01-05T12:00:00Z"));
    expect(s.isOpen).toBe(false);
    expect(s.phase).toBe("weekend");
    // Next open must be Monday 08:00 local
    expect(s.nextOpenIso).toBe("2025-01-06T08:00:00.000Z");
  });

  it("reports LSE post-close after 16:30 UK", () => {
    const s = getMarketStatusForVenue("LSE", new Date("2025-01-06T17:00:00Z"));
    expect(s.isOpen).toBe(false);
    expect(s.phase).toBe("post_close");
    expect(s.nextOpenIso).toBe("2025-01-07T08:00:00.000Z");
  });

  it("reports NYSE open at 15:00 UTC in summer (11:00 ET during EDT)", () => {
    // 2025-06-04 15:00 UTC == 11:00 EDT — inside 09:30–16:00
    const s = getMarketStatusForVenue("NYSE", new Date("2025-06-04T15:00:00Z"));
    expect(s.isOpen).toBe(true);
    expect(s.phase).toBe("open");
  });

  it("crypto is always open", () => {
    const s = getMarketStatusForVenue("CRYPTO", new Date("2025-01-05T04:00:00Z"));
    expect(s.isOpen).toBe(true);
    expect(s.phase).toBe("always_open");
    expect(s.nextOpenIso).toBeNull();
  });
});

describe("marketHadOpenPeriod", () => {
  it("returns true for CRYPTO regardless of interval", () => {
    expect(marketHadOpenPeriod("CRYPTO", 0, 1000)).toBe(true);
  });

  it("returns false when the whole interval falls on a weekend for LSE", () => {
    const from = Date.parse("2025-01-04T09:00:00Z"); // Sat
    const to = Date.parse("2025-01-05T20:00:00Z");   // Sun
    expect(marketHadOpenPeriod("LSE", from, to)).toBe(false);
  });

  it("returns true when the interval straddles a Monday morning open", () => {
    const from = Date.parse("2025-01-05T20:00:00Z"); // Sun eve
    const to = Date.parse("2025-01-06T10:00:00Z");   // Mon 10:00 UTC
    expect(marketHadOpenPeriod("LSE", from, to)).toBe(true);
  });
});

describe("getMarketStatusForSymbol", () => {
  it("infers LSE from a .L ticker and reports weekend correctly", () => {
    const s = getMarketStatusForSymbol("VOD.L", new Date("2025-01-05T12:00:00Z"));
    expect(s.venue).toBe("LSE");
    expect(s.phase).toBe("weekend");
  });
});
