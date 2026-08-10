/**
 * End-to-end guard on the live daily BUY notional cap.
 *
 * This gate is the last thing between a strategy bug and a runaway broker day,
 * and it has failed twice in production — both times by *over*-counting, which
 * is the dangerous direction because it silently blocks legitimate trades:
 *
 *   1. Sim fills were charged against the live budget. On 10 Aug 2026 two
 *      simulated fills "spent" £671k of a £10k limit, and every real buy that
 *      day — NVDA included — was skipped for a cap that no real order had
 *      touched.
 *   2. LSE fills were counted at their pence quote. A GBX-quoted fill counted
 *      100x its real notional, so a few hundred pounds of GLEN.L exhausted the
 *      day on its own.
 *
 * The test drives `loadTradingGate` against a faked database, so it exercises
 * the real query shape, the real UK-day bucketing and the real unit
 * normalisation. Two properties are asserted end to end: only `live_prod`
 * portfolios may consume the cap, and LSE pence prices are divided by 100
 * (except for the GBP-quoted Vanguard allowlist, which must NOT be).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ukDayKey } from "@/lib/uk-time";

type Portfolio = { id: string; mode: string };
type Fill = {
  portfolio_id: string;
  symbol: string;
  side: string;
  quantity: number;
  fill_price: number;
  filled_at: string;
};

const { state, queries, supabaseAdmin } = vi.hoisted(() => {
  const state: {
    controls: Record<string, unknown> | null;
    portfolios: Array<{ id: string; mode: string }>;
    fills: Array<Record<string, unknown>>;
  } = { controls: null, portfolios: [], fills: [] };

  /** Every filter the gate applies, so the test can assert the query shape. */
  const queries: string[] = [];

  const supabaseAdmin = {
    from(table: string) {
      if (table === "trading_controls") {
        return {
          select: (cols: string) => {
            queries.push(`trading_controls:${cols}`);
            return { eq: () => ({ maybeSingle: async () => ({ data: state.controls }) }) };
          },
        };
      }
      if (table === "portfolios") {
        return {
          select: (cols: string) => {
            queries.push(`portfolios:${cols}`);
            return {
              // The gate MUST scope this read to live_prod.
              eq: async (col: string, val: string) => {
                queries.push(`portfolios.eq:${col}=${val}`);
                return {
                  data: state.portfolios.filter(
                    (p) => (p as Record<string, unknown>)[col] === val,
                  ),
                };
              },
            };
          },
        };
      }
      if (table === "live_fills") {
        return {
          select: (cols: string) => {
            queries.push(`live_fills:${cols}`);
            let rows = [...state.fills];
            const builder = {
              in(col: string, vals: readonly string[]) {
                queries.push(`live_fills.in:${col}=[${vals.join(",")}]`);
                rows = rows.filter((r) => vals.includes(String(r[col])));
                return builder;
              },
              gte(col: string, val: string) {
                queries.push(`live_fills.gte:${col}`);
                rows = rows.filter((r) => String(r[col]) >= val);
                return builder;
              },
              then: (
                resolve: (v: { data: Array<Record<string, unknown>> }) => unknown,
              ) => resolve({ data: rows }),
            };
            return builder;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { state, queries, supabaseAdmin };
});

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin }));

const { loadTradingGate } = await import("@/lib/trading-controls.server");

const LIVE = "pf-live";
const LIVE_2 = "pf-live-2";
const SIM_BALANCED = "pf-sim-balanced";
const SIM_HIGH = "pf-sim-high";

/** A timestamp inside today's UK trading day (and inside the 36h read window). */
const nowIso = () => new Date().toISOString();
/** 30h ago — inside the 36h read window, but a different UK day. */
const yesterdayIso = () => new Date(Date.now() - 30 * 3600_000).toISOString();

function fill(over: Partial<Fill> & Pick<Fill, "portfolio_id" | "symbol" | "quantity" | "fill_price">): Fill {
  return {
    side: "buy",
    filled_at: nowIso(),
    ...over,
  } as Fill;
}

function seed(fills: Fill[], limit = 10_000) {
  state.controls = { trading_enabled: true, daily_notional_limit: limit, halt_reason: null };
  state.portfolios = [
    { id: LIVE, mode: "live_prod" },
    { id: LIVE_2, mode: "live_prod" },
    { id: SIM_BALANCED, mode: "sim_balanced" },
    { id: SIM_HIGH, mode: "sim_high" },
  ] satisfies Portfolio[];
  state.fills = fills as unknown as Array<Record<string, unknown>>;
}

beforeEach(() => {
  queries.length = 0;
  state.controls = null;
  state.portfolios = [];
  state.fills = [];
});

describe("daily BUY cap: sim fills are never charged to the live budget", () => {
  it("a sim-only day leaves the entire live budget available", async () => {
    // The exact 10 Aug 2026 shape: two enormous sim fills, no live activity.
    seed([
      fill({ portfolio_id: SIM_BALANCED, symbol: "NVDA", quantity: 1_000, fill_price: 421 }),
      fill({ portfolio_id: SIM_HIGH, symbol: "MSFT", quantity: 500, fill_price: 500 }),
    ]);

    const gate = await loadTradingGate();

    expect(gate.spentToday, "sim fills consumed the live cap").toBe(0);
    expect(gate.remaining).toBe(10_000);
    expect(gate.enabled).toBe(true);
  });

  it("only live_prod fills count when sim and live trade the same day", async () => {
    seed([
      fill({ portfolio_id: LIVE, symbol: "AAPL", quantity: 10, fill_price: 200 }), // 2,000
      fill({ portfolio_id: LIVE_2, symbol: "MSFT", quantity: 2, fill_price: 500 }), //  1,000
      fill({ portfolio_id: SIM_BALANCED, symbol: "AAPL", quantity: 900, fill_price: 200 }),
      fill({ portfolio_id: SIM_HIGH, symbol: "NVDA", quantity: 900, fill_price: 421 }),
    ]);

    const gate = await loadTradingGate();

    expect(gate.spentToday).toBeCloseTo(3_000, 9);
    expect(gate.remaining).toBeCloseTo(7_000, 9);
  });

  it("scopes the portfolio read to live_prod rather than filtering afterwards", async () => {
    seed([fill({ portfolio_id: LIVE, symbol: "AAPL", quantity: 1, fill_price: 100 })]);
    await loadTradingGate();

    expect(queries, "portfolio read was not scoped to live_prod").toContain(
      "portfolios.eq:mode=live_prod",
    );
    // The fills read must be restricted to those live ids, not the whole table.
    const inFilter = queries.find((q) => q.startsWith("live_fills.in:"));
    expect(inFilter, "fills were read without a portfolio filter").toBeDefined();
    expect(inFilter).not.toContain(SIM_BALANCED);
    expect(inFilter).not.toContain(SIM_HIGH);
  });

  it("a fill on an unknown portfolio id cannot consume the cap", async () => {
    // Belt and braces: even if the ids filter is bypassed by a stale read,
    // the in-loop membership check must reject the row.
    seed([fill({ portfolio_id: "pf-deleted", symbol: "AAPL", quantity: 100, fill_price: 200 })]);
    state.fills.push(
      fill({ portfolio_id: LIVE, symbol: "AAPL", quantity: 1, fill_price: 200 }) as unknown as Record<
        string,
        unknown
      >,
    );

    const gate = await loadTradingGate();
    expect(gate.spentToday).toBeCloseTo(200, 9);
  });

  it("sells and prior-day live fills do not consume today's cap", async () => {
    seed([
      fill({ portfolio_id: LIVE, symbol: "AAPL", quantity: 10, fill_price: 200 }), // counts: 2,000
      fill({ portfolio_id: LIVE, symbol: "AAPL", quantity: 50, fill_price: 200, side: "sell" }),
      fill({ portfolio_id: LIVE, symbol: "AAPL", quantity: 50, fill_price: 200, side: "SELL" }),
      fill({
        portfolio_id: LIVE,
        symbol: "AAPL",
        quantity: 50,
        fill_price: 200,
        filled_at: yesterdayIso(),
      }),
    ]);

    const gate = await loadTradingGate();

    expect(gate.spentToday).toBeCloseTo(2_000, 9);
    expect(ukDayKey(new Date(yesterdayIso())), "fixture is not on a prior UK day").not.toBe(
      ukDayKey(new Date()),
    );
  });
});

describe("daily BUY cap: LSE pence quotes are normalised to base currency", () => {
  it("a GBX-quoted .L fill is counted in pounds, not pence", async () => {
    // GLEN.L at 320.5p x 1,000 shares = £3,205 — not £320,500.
    seed([fill({ portfolio_id: LIVE, symbol: "GLEN.L", quantity: 1_000, fill_price: 320.5 })]);

    const gate = await loadTradingGate();

    expect(gate.spentToday, "GBX fill counted at 100x").toBeCloseTo(3_205, 9);
    expect(gate.remaining).toBeCloseTo(6_795, 9);
  });

  it("normalises the :XLON broker-native form the same way", async () => {
    seed([fill({ portfolio_id: LIVE, symbol: "GLEN:XLON", quantity: 1_000, fill_price: 320.5 })]);
    const gate = await loadTradingGate();
    expect(gate.spentToday).toBeCloseTo(3_205, 9);
  });

  it("leaves GBP-quoted LSE tickers and non-LSE symbols alone", async () => {
    seed(
      [
        // Vanguard allowlist: already in pounds, must NOT be divided by 100.
        fill({ portfolio_id: LIVE, symbol: "VUKE.L", quantity: 100, fill_price: 47.6 }), // 4,760
        // US listing in USD, summed without FX by design.
        fill({ portfolio_id: LIVE, symbol: "AAPL", quantity: 10, fill_price: 200 }), // 2,000
      ],
      100_000,
    );

    const gate = await loadTradingGate();
    expect(gate.spentToday).toBeCloseTo(6_760, 9);
  });

  it("iShares LSE ETFs are pence, not pounds (the 100x regression)", async () => {
    // ISF.L quotes ≈ 1062p. Treating "ETF" as GBP inflated this by 100x and
    // made a sim portfolio read ~9.2M instead of ~92k.
    seed([fill({ portfolio_id: LIVE, symbol: "ISF.L", quantity: 100, fill_price: 1_062 })], 100_000);
    const gate = await loadTradingGate();
    expect(gate.spentToday).toBeCloseTo(1_062, 9);
  });

  it("a mixed live/sim, GBX/USD day nets out exactly", async () => {
    seed(
      [
        fill({ portfolio_id: LIVE, symbol: "GLEN.L", quantity: 1_000, fill_price: 320.5 }), // 3,205
        fill({ portfolio_id: LIVE_2, symbol: "VUKE.L", quantity: 10, fill_price: 47.6 }), //    476
        fill({ portfolio_id: LIVE, symbol: "NVDA", quantity: 2, fill_price: 421 }), //          842
        // Sim noise on the same symbols — none of it may land on the cap.
        fill({ portfolio_id: SIM_HIGH, symbol: "GLEN.L", quantity: 100_000, fill_price: 320.5 }),
        fill({ portfolio_id: SIM_BALANCED, symbol: "NVDA", quantity: 5_000, fill_price: 421 }),
      ],
      10_000,
    );

    const gate = await loadTradingGate();

    expect(gate.spentToday).toBeCloseTo(4_523, 9);
    expect(gate.remaining).toBeCloseTo(5_477, 9);
    // The headroom that the sim fills used to destroy: a real NVDA buy still fits.
    expect(gate.remaining).toBeGreaterThan(2 * 421);
  });

  it("still fails closed when the controls row is unreadable", async () => {
    state.controls = null;
    state.portfolios = [{ id: LIVE, mode: "live_prod" }];
    const gate = await loadTradingGate();
    expect(gate.enabled).toBe(false);
    expect(gate.remaining).toBe(0);
    expect(gate.haltReason).toBe("trading_controls unreadable");
  });

  it("clamps remaining at zero once real fills exhaust the cap", async () => {
    seed([fill({ portfolio_id: LIVE, symbol: "GLEN.L", quantity: 10_000, fill_price: 320.5 })]);
    const gate = await loadTradingGate();
    expect(gate.spentToday).toBeCloseTo(32_050, 9);
    expect(gate.remaining).toBe(0);
  });
});
