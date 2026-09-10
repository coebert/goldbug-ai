import { describe, expect, it, vi, beforeEach } from "vitest";

type Query = { symbols: string[]; limit: number };
const queries: Query[] = [];
const rowsFor = (symbol: string) =>
  Array.from({ length: 30 }, (_, i) => ({
    symbol,
    price_date: `2026-09-${String(30 - i).padStart(2, "0")}`,
    open: 10,
    high: 10,
    low: 10,
    close: 10,
    volume: 1,
  }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Query = { symbols: [], limit: 0 };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        eq: (_c: string, v: string) => {
          q.symbols = [v];
          return builder;
        },
        in: (_c: string, v: string[]) => {
          q.symbols = v;
          return builder;
        },
        lte: chain,
        order: chain,
        limit: async (n: number) => {
          q.limit = n;
          queries.push(q);
          return { data: q.symbols.flatMap(rowsFor), error: null };
        },
        upsert: async () => ({ error: null }),
      });
      return builder;
    },
  },
}));

vi.mock("@/lib/brokers/saxo-prices.server", () => ({
  fetchBrokerDailyBars: async () => null,
}));

describe("price_cache read batching", () => {
  beforeEach(() => {
    queries.length = 0;
  });

  it("serves many symbols asked in one tick from a single query", async () => {
    const { getDailyCandles, clearCandleMemo } = await import("../market-data.server");
    clearCandleMemo();
    const symbols = ["AAA", "BBB", "CCC", "DDD"];
    const out = await Promise.all(
      symbols.map((s) => getDailyCandles(s, 30, "2026-09-30")),
    );
    expect(out.every((c) => c.length === 30)).toBe(true);
    expect(queries.length).toBe(1);
    expect(queries[0].symbols.sort()).toEqual(symbols);
    expect(queries[0].limit).toBe(120);
  });
});
