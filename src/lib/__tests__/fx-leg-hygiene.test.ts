import { describe, it, expect } from "vitest";
import { assessFxLegs, type HygieneLegInput } from "@/lib/fx-leg-hygiene";

const NOW = new Date("2026-09-10T12:00:00Z");

function leg(over: Partial<HygieneLegInput> = {}): HygieneLegInput {
  return {
    symbol: "GBPUSD",
    quantity: -5000,
    quoteCcy: "USD",
    openedAt: "2026-08-01T00:00:00Z",
    notionalQuote: 6750,
    notionalBase: 5000,
    ...over,
  };
}

describe("assessFxLegs", () => {
  it("leaves a fully used leg alone", () => {
    const [a] = assessFxLegs([leg()], { USD: 7000 }, NOW);
    expect(a.verdict).toBe("matched");
    expect(a.recommendClose).toBe(false);
  });

  it("flags a leg whose holdings have been sold", () => {
    const [a] = assessFxLegs([leg()], { USD: 0 }, NOW);
    expect(a.verdict).toBe("unused");
    expect(a.recommendClose).toBe(true);
    expect(a.reason).toMatch(/Close it/);
  });

  it("flags an oversized leg", () => {
    const [a] = assessFxLegs([leg()], { USD: 3000 }, NOW);
    expect(a.verdict).toBe("oversized");
    expect(a.recommendClose).toBe(true);
  });

  it("does not nag about a brand new leg", () => {
    const [a] = assessFxLegs([leg({ openedAt: "2026-09-09T00:00:00Z" })], { USD: 0 }, NOW);
    expect(a.verdict).toBe("unused");
    expect(a.recommendClose).toBe(false);
  });

  it("does not recommend paying a fee to close a tiny leg", () => {
    const [a] = assessFxLegs(
      [leg({ quantity: -100, notionalQuote: 135, notionalBase: 100 })],
      { USD: 0 },
      NOW,
    );
    expect(a.recommendClose).toBe(false);
    expect(a.reason).toMatch(/too small/);
  });

  it("shares one currency's exposure across several legs, largest first", () => {
    const out = assessFxLegs(
      [
        leg({ symbol: "GBPUSD-A", notionalQuote: 6000, quantity: -4400 }),
        leg({ symbol: "GBPUSD-B", notionalQuote: 2000, quantity: -1480, notionalBase: 1480 }),
      ],
      { USD: 6000 },
      NOW,
    );
    const a = out.find((l) => l.symbol === "GBPUSD-A")!;
    const b = out.find((l) => l.symbol === "GBPUSD-B")!;
    expect(a.verdict).toBe("matched");
    expect(b.verdict).toBe("unused");
    expect(b.recommendClose).toBe(true);
  });
});
