// Phase E — end-to-end wiring smoke test for the algo-regime helper.
//
// Verifies that `buildAlgoRegimeSnapshot` glues the DB reader to the pure
// detectors correctly: a synthetic price_cache response with an extreme
// vol burst + liquidity vacuum must surface as tier="extreme" and
// blockNewBuys=true, and the correlation-spike detector must engage only
// when ≥2 holdings have enough return history.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = { close: number; volume: number | null; price_date: string };

const state: { rowsBySymbol: Record<string, Row[]> } = { rowsBySymbol: {} };

vi.mock("@/integrations/supabase/client.server", () => {
  const makeChain = (symbol: string) => {
    const rows = state.rowsBySymbol[symbol] ?? [];
    const chain = {
      select: () => chain,
      eq: (_c: string, s: string) => makeChain(s),
      lte: () => chain,
      order: () => chain,
      limit: (n: number) =>
        Promise.resolve({
          // supabase returns newest → oldest with descending order; server
          // helper reverses it back to oldest → newest.
          data: [...rows].sort((a, b) => (a.price_date < b.price_date ? 1 : -1)).slice(0, n),
          error: null,
        }),
    };
    return chain;
  };
  return {
    supabaseAdmin: {
      from: () => makeChain(""),
    },
  };
});

import { buildAlgoRegimeSnapshot } from "../algo-regime.server";

function synth(base: number, days: number, shockDay: number | null): Row[] {
  const rows: Row[] = [];
  let px = base;
  for (let i = 0; i < days; i++) {
    // gentle drift for the baseline window, extreme shock at shockDay
    const isShock = shockDay != null && i >= shockDay;
    const step = isShock ? (Math.sin(i) * 0.08) : (Math.sin(i) * 0.002);
    px = Math.max(1, px * (1 + step));
    const d = new Date(2026, 0, 1 + i).toISOString().slice(0, 10);
    rows.push({
      close: px,
      volume: isShock ? 100 : 10_000, // liquidity vacuum on shock days
      price_date: d,
    });
  }
  return rows;
}

beforeEach(() => {
  state.rowsBySymbol = {};
});

describe("buildAlgoRegimeSnapshot (Phase E wiring)", () => {
  it("returns null when bench has too little history", async () => {
    state.rowsBySymbol["SPY"] = synth(400, 10, null);
    const snap = await buildAlgoRegimeSnapshot({ asOf: "2026-01-15" });
    expect(snap).toBeNull();
  });

  it("promotes to extreme tier and blocks new buys on synthetic shock", async () => {
    state.rowsBySymbol["SPY"] = synth(400, 60, 50);
    const snap = await buildAlgoRegimeSnapshot({ asOf: "2026-03-01" });
    expect(snap).not.toBeNull();
    expect(snap!.tier).toBe("extreme");
    expect(snap!.multipliers.blockNewBuys).toBe(true);
    expect(snap!.volBurst).toBe(true);
    expect(snap!.liquidityVacuum).toBe(true);
  });

  it("stays normal without shock", async () => {
    state.rowsBySymbol["SPY"] = synth(400, 60, null);
    const snap = await buildAlgoRegimeSnapshot({ asOf: "2026-03-01" });
    expect(snap).not.toBeNull();
    expect(snap!.tier).toBe("normal");
    expect(snap!.multipliers.blockNewBuys).toBe(false);
  });

  it("skips correlation-spike detector when fewer than 2 holdings have history", async () => {
    state.rowsBySymbol["SPY"] = synth(400, 60, null);
    state.rowsBySymbol["AAPL"] = synth(200, 60, null);
    const snap = await buildAlgoRegimeSnapshot({
      asOf: "2026-03-01",
      holdingSymbols: ["AAPL", "MSFT"], // MSFT has no rows
    });
    expect(snap!.correlationSpike).toBe(false);
  });
});
