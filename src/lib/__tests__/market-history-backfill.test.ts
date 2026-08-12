import { describe, expect, it, vi, beforeEach } from "vitest";

const cacheRows = vi.fn();
const rangeFetch = vi.fn();
const dayFetch = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            order: () => ({
              limit: async () => ({ data: cacheRows(), error: null }),
            }),
          }),
        }),
      }),
    }),
  },
}));

vi.mock("../market-data.server", () => ({
  getDailyCandlesRange: (...a: unknown[]) => rangeFetch(...a),
  getDailyCandles: (...a: unknown[]) => dayFetch(...a),
}));

const { loadHistoryRows, tradingDaysFor } = await import("../market-history-backfill.server");

const NOW = new Date("2026-08-12T12:00:00Z");

function series(endIso: string, n: number, symbol = "AAPL") {
  const out: { symbol: string; price_date: string; close: number }[] = [];
  const d = new Date(endIso);
  for (let i = 0; i < n; i++) {
    out.push({ symbol, price_date: d.toISOString().slice(0, 10), close: 100 + i });
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

beforeEach(() => {
  cacheRows.mockReset();
  rangeFetch.mockReset().mockResolvedValue([]);
  dayFetch.mockReset().mockResolvedValue([]);
});

describe("loadHistoryRows", () => {
  it("backfills the full range when the cache is too short for the window", async () => {
    cacheRows.mockReturnValue(series("2026-08-12", 40));
    rangeFetch.mockResolvedValue(series("2026-08-12", 700).map((r) => ({ date: r.price_date, close: r.close })));

    const rows = await loadHistoryRows("AAPL", 365, NOW);

    expect(rangeFetch).toHaveBeenCalledTimes(1);
    expect(rows.length).toBeGreaterThan(600);
    expect(rows[rows.length - 1].price_date).toBe("2026-08-12");
  });

  it("refreshes recent sessions when a dense cache is stale", async () => {
    cacheRows.mockReturnValue(series("2026-07-01", 400));
    dayFetch.mockResolvedValue(
      series("2026-08-12", 30).map((r) => ({ date: r.price_date, close: r.close })),
    );

    const rows = await loadHistoryRows("AAPL", 180, NOW);

    expect(dayFetch).toHaveBeenCalled();
    expect(rows[rows.length - 1].price_date).toBe("2026-08-12");
  });

  it("skips the feed when the cache is dense and current", async () => {
    cacheRows.mockReturnValue(series("2026-08-12", 400));

    const rows = await loadHistoryRows("AAPL", 180, NOW);

    expect(rangeFetch).not.toHaveBeenCalled();
    expect(dayFetch).not.toHaveBeenCalled();
    expect(rows).toHaveLength(400);
  });

  it("scales the required session count with the window", () => {
    expect(tradingDaysFor(365)).toBeGreaterThan(200);
    expect(tradingDaysFor(30)).toBeLessThan(tradingDaysFor(365));
  });
});
