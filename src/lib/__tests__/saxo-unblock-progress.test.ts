import { describe, expect, it } from "vitest";
import { buildSaxoChecklist } from "@/lib/saxo-product-categories";
import { computeUnblockProgress } from "@/lib/saxo-unblock-progress";

const items = buildSaxoChecklist([
  { symbol: "SGLN.L", reason: "suitability", detail: "Physical Gold ETC" },
  { symbol: "XUKS.L", reason: "suitability" },
  { symbol: "XSPS.L", reason: "suitability" },
]);

describe("computeUnblockProgress", () => {
  it("counts nothing as done when no category is ticked", () => {
    const p = computeUnblockProgress(items, {});
    expect(p.totalCategories).toBe(2);
    expect(p.completedCategories).toBe(0);
    expect(p.percent).toBe(0);
    expect(p.symbolsWaiting.sort()).toEqual(["SGLN.L", "XSPS.L", "XUKS.L"]);
    expect(p.symbolsReady).toEqual([]);
  });

  it("moves a ticked category's symbols from waiting to ready", () => {
    const p = computeUnblockProgress(items, { etc_commodities: true });
    expect(p.completedCategories).toBe(1);
    expect(p.percent).toBe(50);
    expect(p.symbolsReady).toEqual(["SGLN.L"]);
    expect(p.symbolsWaiting.sort()).toEqual(["XSPS.L", "XUKS.L"]);
    expect(p.categories.find((c) => c.id === "etc_commodities")!.symbolsWaiting).toEqual([]);
  });

  it("reaches 100% when every category is ticked", () => {
    const p = computeUnblockProgress(items, {
      etc_commodities: true,
      leveraged_inverse_etf: true,
    });
    expect(p.percent).toBe(100);
    expect(p.symbolsWaiting).toEqual([]);
  });

  it("treats an empty checklist as complete", () => {
    const p = computeUnblockProgress([], {});
    expect(p.percent).toBe(100);
    expect(p.totalCategories).toBe(0);
  });

  it("ignores stale ticks for categories that are no longer blocked", () => {
    const p = computeUnblockProgress(items, { derivatives: true });
    expect(p.completedCategories).toBe(0);
    expect(p.symbolsWaiting).toHaveLength(3);
  });
});
