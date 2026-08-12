import { describe, expect, it } from "vitest";
import type { InsiderDealingEvent } from "@/lib/insider-dealings";
import { disposalType, explainInsiderEvent, filingFields, impliedPrice } from "@/lib/insider-dealing-explain";

function ev(over: Partial<InsiderDealingEvent> = {}): InsiderDealingEvent {
  return {
    symbol: "MKS.L",
    company: "Marks & Spencer",
    event_date: "2026-07-22",
    headline: "RNS: S Berendji sold 300,000 shares at £3.976 in Marks & Spencer",
    summary: "PDMR (Operations Director). Sale of ordinary shares",
    source: "RNS (Investegate)",
    url: "https://investegate.co.uk/x",
    direction: "sell",
    flavour: "discretionary",
    person: "S Berendji",
    role: "Director",
    shares: 300000,
    value: 1192800,
    severity: 0.5,
    sentiment_nudge: -0.075,
    ...over,
  };
}

describe("impliedPrice", () => {
  it("derives price per share from value and volume", () => {
    expect(impliedPrice(ev())).toBeCloseTo(3.976, 3);
    expect(impliedPrice(ev({ shares: 0 }))).toBeNull();
    expect(impliedPrice(ev({ value: null }))).toBeNull();
  });
});

describe("disposalType", () => {
  it("labels discretionary sales as open market and non-mechanical", () => {
    const d = disposalType(ev());
    expect(d.label).toContain("open market");
    expect(d.mechanical).toBe(false);
  });

  it("flags tax and award filings as mechanical", () => {
    expect(disposalType(ev({ flavour: "tax" })).mechanical).toBe(true);
    expect(disposalType(ev({ flavour: "award", direction: "buy" })).mechanical).toBe(true);
  });

  it("takes no directional read when the wording is unclear", () => {
    const d = disposalType(ev({ direction: "unknown", flavour: "unknown" }));
    expect(d.label).toBe("Unclassified dealing");
    expect(d.mechanical).toBe(true);
  });
});

describe("filingFields", () => {
  it("exposes every underlying field, with placeholders when absent", () => {
    const labels = filingFields(ev()).map((f) => f.label);
    expect(labels).toEqual([
      "Filed / dated",
      "Issuer",
      "Person",
      "Position",
      "Transaction",
      "Volume",
      "Price",
      "Consideration",
      "Nature",
      "Source",
    ]);
    const sparse = filingFields(ev({ person: null, shares: null, value: null, summary: null }));
    expect(sparse.find((f) => f.label === "Person")?.value).toBe("not named in filing");
    expect(sparse.find((f) => f.label === "Consideration")?.value).toBe("not stated");
  });
});

describe("explainInsiderEvent", () => {
  it("rebuilds the severity terms behind the score", () => {
    const ex = explainInsiderEvent(ev({ role: "CEO" }));
    expect(ex.nudge.breakdown.flavourWeight).toBe(1);
    expect(ex.nudge.breakdown.roleWeight).toBe(1);
    expect(ex.nudge.breakdown.sizeWeight).toBeGreaterThan(0.4);
    expect(ex.nudge.breakdown.sentiment_nudge).toBeLessThan(0);
  });

  it("sums peer filings for the ticker and reports the applied value", () => {
    const a = ev({ sentiment_nudge: -0.06 });
    const b = ev({ headline: "second filing", sentiment_nudge: -0.05 });
    const ex = explainInsiderEvent(a, [a, b]);
    expect(ex.nudge.symbolEvents).toBe(2);
    expect(ex.nudge.symbolRaw).toBeCloseTo(-0.11, 4);
    expect(ex.nudge.symbolApplied).toBeCloseTo(-0.11, 4);
    expect(ex.nudge.capped).toBe(false);
  });

  it("clamps the symbol total at the hard floor", () => {
    const a = ev({ sentiment_nudge: -0.12 });
    const b = ev({ headline: "b", sentiment_nudge: -0.12 });
    const ex = explainInsiderEvent(a, [a, b]);
    expect(ex.nudge.symbolRaw).toBeCloseTo(-0.24, 4);
    expect(ex.nudge.symbolApplied).toBe(-0.15);
    expect(ex.nudge.capped).toBe(true);
  });

  it("marks RNS-sourced events as the primary filing", () => {
    expect(explainInsiderEvent(ev()).match.primary).toBe(true);
    expect(explainInsiderEvent(ev({ source: "Reuters" })).match.primary).toBe(false);
  });

  it("says plainly when nothing is applied", () => {
    const flat = ev({ sentiment_nudge: 0, direction: "unknown", flavour: "unknown" });
    expect(explainInsiderEvent(flat).effect).toContain("No adjustment");
  });
});
