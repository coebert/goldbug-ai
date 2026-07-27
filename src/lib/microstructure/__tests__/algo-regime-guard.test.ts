// Phase B — algo-regime guard unit tests.
import { describe, it, expect } from "vitest";
import type { AlgoRegimeSnapshot } from "@/lib/microstructure/algo-regime";
import {
  partitionByAlgoRegime,
  effectiveMaxParticipation,
} from "@/lib/microstructure/algo-regime-guard";

const snapshot = (over: Partial<AlgoRegimeSnapshot["multipliers"]> & { tier?: AlgoRegimeSnapshot["tier"] } = {}): AlgoRegimeSnapshot => ({
  volBurst: false, liquidityVacuum: false, whipsaw: false, correlationSpike: false, gapFade: false,
  score: over.tier === "extreme" ? 3 : over.tier === "elevated" ? 1 : 0,
  tier: over.tier ?? "normal",
  reason: "test",
  multipliers: {
    maxParticipation: over.maxParticipation ?? 0.15,
    sizeScale: over.sizeScale ?? 1,
    tailHedgeBoostPctNav: over.tailHedgeBoostPctNav ?? 0,
    blockNewBuys: over.blockNewBuys ?? false,
  },
});

describe("partitionByAlgoRegime", () => {
  const items = [
    { id: "a", side: "buy" as const },
    { id: "b", side: "sell" as const },
    { id: "c", side: "BUY" as const },
  ];

  it("passes everything through when snapshot is null or normal", () => {
    for (const snap of [null, snapshot(), snapshot({ tier: "elevated" })]) {
      const r = partitionByAlgoRegime(items, snap, (i) => i.side);
      expect(r.kept).toHaveLength(3);
      expect(r.blocked).toHaveLength(0);
    }
  });

  it("blocks BUYs (both casings) and keeps SELLs when blockNewBuys is set", () => {
    const snap = snapshot({ tier: "extreme", blockNewBuys: true });
    const r = partitionByAlgoRegime(items, snap, (i) => i.side);
    expect(r.kept.map((i) => i.id)).toEqual(["b"]);
    expect(r.blocked.map((b) => b.item.id).sort()).toEqual(["a", "c"]);
    for (const b of r.blocked) expect(b.reason).toContain("algo_regime_extreme");
  });
});

describe("effectiveMaxParticipation", () => {
  it("returns null when neither side supplies a cap", () => {
    expect(effectiveMaxParticipation(undefined, null)).toBeNull();
    expect(effectiveMaxParticipation(0, snapshot({ maxParticipation: 0 }))).toBeNull();
  });

  it("returns the stricter of the two caps and never loosens", () => {
    expect(effectiveMaxParticipation(0.1, snapshot({ maxParticipation: 0.02 }))).toBe(0.02);
    expect(effectiveMaxParticipation(0.01, snapshot({ maxParticipation: 0.5 }))).toBe(0.01);
  });

  it("clamps caps to [0,1]", () => {
    expect(effectiveMaxParticipation(5, snapshot({ maxParticipation: 3 }))).toBe(1);
  });

  it("falls back to whichever side is finite", () => {
    expect(effectiveMaxParticipation(undefined, snapshot({ maxParticipation: 0.05 }))).toBe(0.05);
    expect(effectiveMaxParticipation(0.08, null)).toBe(0.08);
  });
});
