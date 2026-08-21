import { describe, expect, it } from "vitest";
import {
  ALL_LEG_SHAPES,
  generateScenario,
  makeRng,
  reissueScenario,
  splitExecutions,
  type LegShape,
} from "../testing/partial-fill-scenarios";
import {
  discrepancyAlertKey,
  reconcileTradeLegs,
  type LegDiscrepancy,
} from "../trade-leg-reconciliation";
import { strandedQuantity } from "../recon-metrics";

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

function run(scenario: ReturnType<typeof generateScenario>) {
  return reconcileTradeLegs({
    intended: scenario.intended,
    orders: scenario.orders,
    nowMs: scenario.nowMs,
  });
}

function forSymbol(ds: LegDiscrepancy[], symbol: string): LegDiscrepancy[] {
  return ds.filter((d) => d.symbol === symbol.toUpperCase());
}

describe("generator sanity", () => {
  it("splits executions into positive parts summing to the intent", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 200; i += 1) {
      const qty = 1 + Math.floor(rng() * 900);
      const parts = splitExecutions(rng, qty, 1 + Math.floor(rng() * 4));
      expect(parts.every((p) => p > 0)).toBe(true);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(qty);
    }
  });

  it("is reproducible from a seed", () => {
    expect(generateScenario(42)).toEqual(generateScenario(42));
  });
});

describe("generated partial-fill scenarios: universal invariants", () => {
  it.each(SEEDS)("seed %i holds every reconciliation invariant", (seed) => {
    const scenario = generateScenario(seed);
    const result = run(scenario);
    const { discrepancies: ds, summary } = result;

    // Deterministic for identical input.
    expect(run(scenario)).toEqual(result);

    // Discrepancy identities are unique within a tick.
    expect(new Set(ds.map((d) => d.key)).size).toBe(ds.length);

    // Summary arithmetic stays coherent.
    expect(summary.intendedLegs).toBe(scenario.intended.length);
    expect(summary.matchedLegs + summary.mismatchedLegs).toBe(scenario.intended.length);
    expect(summary.droppedLegs).toBeLessThanOrEqual(scenario.intended.length);
    expect(summary.unexecutedValue).toBeGreaterThanOrEqual(0);

    // An order is never both a phantom and a matched leg's counterpart.
    const phantomIds = new Set(
      ds.filter((d) => d.code === "phantom_leg").map((d) => d.orderId),
    );
    const matchedIds = new Set(
      ds.filter((d) => d.code !== "phantom_leg" && d.orderId).map((d) => d.orderId),
    );
    for (const id of phantomIds) expect(matchedIds.has(id)).toBe(false);

    for (const d of ds) {
      // No contradictory pairs on one order.
      if (d.code === "dropped_leg" && d.orderId) {
        expect(
          ds.some((o) => o.orderId === d.orderId && o.code === "quantity_over"),
        ).toBe(false);
      }
      // Numbers are always usable downstream.
      expect(Number.isFinite(d.executedQuantity ?? 0)).toBe(true);
      expect(d.executedQuantity ?? 0).toBeGreaterThanOrEqual(0);
      // Stranded inventory can never exceed what was intended.
      const stranded = strandedQuantity({
        at: new Date(scenario.nowMs).toISOString(),
        code: d.code,
        severity: d.severity,
        symbol: d.symbol,
        side: d.side,
        intendedQuantity: d.intendedQuantity,
        executedQuantity: d.executedQuantity,
        priceDeviationBps: d.priceDeviationBps,
      });
      expect(stranded).toBeLessThanOrEqual(Math.max(0, d.intendedQuantity ?? 0));
    }
  });

  it.each(SEEDS.slice(0, 120))(
    "seed %i produces stable alert keys when the same reality is re-ticked",
    (seed) => {
      const scenario = generateScenario(seed);
      const again = reissueScenario(scenario, "t2");
      const a = run(scenario).discrepancies.map(discrepancyAlertKey).sort();
      const b = run(again).discrepancies.map(discrepancyAlertKey).sort();
      // New decision/order ids must not manufacture new alerts.
      expect(b).toEqual(a);
      // ...while the raw per-order keys legitimately differ.
      const rawA = run(scenario).discrepancies.map((d) => d.key);
      const rawB = run(again).discrepancies.map((d) => d.key);
      if (rawA.some((k) => k.includes("ord-") || k.includes("dec-"))) {
        expect(rawB).not.toEqual(rawA);
      }
    },
  );
});

describe("generated scenarios: per-shape expectations", () => {
  const shapeSeeds = (shape: LegShape) =>
    Array.from({ length: 25 }, (_, i) => i + 1).map((seed) =>
      generateScenario(seed * 31 + ALL_LEG_SHAPES.indexOf(shape), {
        shapes: [shape],
        sharedSymbols: false,
      }),
    );

  it("clean fills raise nothing", () => {
    for (const s of [...shapeSeeds("full_fill"), ...shapeSeeds("multi_execution")]) {
      expect(run(s).discrepancies).toEqual([]);
    }
  });

  it("engine vetoes are never reported as dropped legs", () => {
    for (const s of shapeSeeds("engine_veto")) {
      expect(run(s).discrepancies).toEqual([]);
    }
  });

  it("legs that never reached the broker are dropped legs", () => {
    for (const s of shapeSeeds("no_order")) {
      for (const g of s.legs) {
        const ds = forSymbol(run(s).discrepancies, g.leg.symbol);
        expect(ds.map((d) => d.code)).toContain("dropped_leg");
      }
    }
  });

  it("silent cancels surface, explained rejections do not", () => {
    for (const s of shapeSeeds("silent_cancel")) {
      expect(run(s).discrepancies.map((d) => d.code)).toContain("dropped_leg");
    }
    for (const s of shapeSeeds("rejected_with_reason")) {
      expect(run(s).discrepancies).toEqual([]);
    }
  });

  it("short fills, over-fills, stale orders and adverse prints each classify", () => {
    for (const s of shapeSeeds("partial_short")) {
      expect(run(s).discrepancies.map((d) => d.code)).toContain("quantity_short");
    }
    for (const s of shapeSeeds("over_fill")) {
      expect(run(s).discrepancies.map((d) => d.code)).toContain("quantity_over");
    }
    for (const s of shapeSeeds("pending_stale")) {
      expect(run(s).discrepancies.map((d) => d.code)).toContain("stale_pending");
    }
    for (const s of shapeSeeds("adverse_print")) {
      const ds = run(s).discrepancies.filter((d) => d.code === "price_deviation");
      expect(ds.length).toBeGreaterThan(0);
      for (const d of ds) {
        const adverse = d.side === "buy" ? d.priceDeviationBps! : -d.priceDeviationBps!;
        expect(adverse).toBeGreaterThan(0);
      }
    }
  });

  it("cancel/replace chains never report an over-fill or lose the remainder", () => {
    for (const s of shapeSeeds("replace_chain")) {
      const ds = run(s).discrepancies;
      expect(ds.map((d) => d.code)).not.toContain("quantity_over");
      for (const g of s.legs) {
        const executed = g.executions.reduce((a, b) => a + b, 0);
        expect(executed).toBe(g.leg.quantity);
      }
    }
  });
});
