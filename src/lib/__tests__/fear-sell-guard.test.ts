import { describe, it, expect } from "vitest";
import { classifyPanicSell } from "@/lib/fear-sell-guard";

describe("classifyPanicSell", () => {
  it("blocks a sell justified purely by elevated fear", () => {
    const v = classifyPanicSell({ reason: "Fear index at panic levels, raising cash", fearScore: 92 });
    expect(v.block).toBe(true);
    expect(v.reason).toContain("panic-sell guard");
  });

  it("blocks VIX-spike-driven de-risking", () => {
    expect(classifyPanicSell({ reason: "VIX spiking, de-risking the book", fearScore: 75 }).block).toBe(true);
  });

  it("allows a stop-loss exit even during panic", () => {
    const v = classifyPanicSell({ reason: "Stop-loss hit amid panic selling", fearScore: 95 });
    expect(v.block).toBe(false);
    expect(v.override).toBeTruthy();
  });

  it("allows ATR-stop and rebalance exits", () => {
    expect(classifyPanicSell({ reason: "ATR stop triggered; fear elevated", fearScore: 88 }).block).toBe(false);
    expect(classifyPanicSell({ reason: "Rebalance to target weight, VIX high", fearScore: 88 }).block).toBe(false);
  });

  it("allows broken-thesis and take-profit exits", () => {
    expect(classifyPanicSell({ reason: "Thesis broken after downgrade, market fear rising", fearScore: 80 }).block).toBe(false);
    expect(classifyPanicSell({ reason: "Take-profit at target despite panic", fearScore: 91 }).block).toBe(false);
  });

  it("ignores incidental fear wording in a calm tape", () => {
    expect(classifyPanicSell({ reason: "Trimming winner; VIX unremarkable", fearScore: 30 }).block).toBe(false);
  });

  it("allows ordinary sells with no fear language", () => {
    expect(classifyPanicSell({ reason: "Funding a higher-conviction position", fearScore: 95 }).block).toBe(false);
    expect(classifyPanicSell({ reason: "", fearScore: 99 }).block).toBe(false);
  });
});
