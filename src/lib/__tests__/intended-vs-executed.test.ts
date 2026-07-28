// Locks the intended-vs-executed math: intended = buy/sell rows,
// executed = placed/filled/partial, filled = filled/partial,
// missed = rejected/skipped/cancelled/error. `hold` rows are ignored.
// Per-symbol rows sort lowest-executed-rate first so chronic misses
// surface at the top of the metrics table.

import { describe, it, expect } from "vitest";
import { computeIntendedVsExecuted } from "@/lib/intended-vs-executed.functions";

type Row = { symbol: string; action: string; outcome: string; outcome_detail: string | null };

const now = new Date("2026-06-01T12:00:00Z").toISOString();

function row(symbol: string, action: string, outcome: string, detail: string | null = null): Row {
  return { symbol, action, outcome, outcome_detail: detail };
}

describe("computeIntendedVsExecuted", () => {
  it("aggregates portfolio and per-symbol counts and rates", () => {
    const rows: Row[] = [
      row("AAPL", "buy", "filled"),
      row("AAPL", "buy", "filled"),
      row("AAPL", "buy", "rejected", "InsufficientCash"),
      row("MSFT", "buy", "placed"),
      row("MSFT", "sell", "partial"),
      row("BAD",  "buy", "skipped", "fee-guard"),
      row("BAD",  "buy", "skipped", "fee-guard"),
      row("BAD",  "buy", "skipped", "min-notional"),
      row("BAD",  "buy", "rejected", "fee-guard"),
      row("HELD", "hold", "hold"),
    ];
    const m = computeIntendedVsExecuted(rows, "p1", 72, now);

    // 9 intended (all buy/sell); 5 executed (2 filled + 1 placed + 1 partial + wait — count exactly)
    // filled: AAPL x2 + MSFT partial = 3; placed: MSFT placed = 1 → executed = 4
    expect(m.intended).toBe(9);
    expect(m.executed).toBe(4);
    expect(m.filled).toBe(3);
    expect(m.missed).toBe(5); // 1 AAPL rejected + 3 BAD skipped + 1 BAD rejected
    expect(m.executed_rate).toBeCloseTo(4 / 9, 5);
    expect(m.fill_rate).toBeCloseTo(3 / 9, 5);

    const bySym = new Map(m.symbols.map((s) => [s.symbol, s]));
    expect(bySym.get("AAPL")!.executed_rate).toBeCloseTo(2 / 3, 5);
    expect(bySym.get("MSFT")!.executed_rate).toBe(1);
    expect(bySym.get("BAD")!.executed_rate).toBe(0);
    expect(bySym.get("BAD")!.top_miss_reason).toBe("fee-guard");
    expect(bySym.has("HELD")).toBe(false); // hold rows never counted as intended

    // Sorted worst-first so the alerter and UI show regressions at the top.
    expect(m.symbols[0].symbol).toBe("BAD");
  });

  it("returns zeros safely when nothing was intended", () => {
    const m = computeIntendedVsExecuted([row("X", "hold", "hold")], "p1", 24, now);
    expect(m.intended).toBe(0);
    expect(m.executed_rate).toBe(0);
    expect(m.fill_rate).toBe(0);
    expect(m.symbols).toHaveLength(0);
    expect(m.outcomes.hold).toBe(1);
  });
});
