// Integration test for the extracted `snapshotPortfolio` (backtest fill-in
// valuation path). Everything below the module is faked so the test pins the
// orchestration contract: which rows are read, what is handed to the
// valuation kernel, and what reaches the snapshot writer.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Any = Record<string, unknown>;

const { state, selects, supabaseAdmin } = vi.hoisted(() => {
const state: {
  portfolio: Record<string, unknown> | null;
  holdings: Array<Record<string, unknown>> | null;
} = { portfolio: null, holdings: null };

const selects: string[] = [];

const supabaseAdmin = {
  from(table: string) {
    if (table === "portfolios") {
      return {
        select(cols: string) {
          selects.push(`portfolios:${cols}`);
          return { eq: () => ({ single: async () => ({ data: state.portfolio }) }) };
        },
      };
    }
    if (table === "holdings") {
      return {
        select(cols: string) {
          selects.push(`holdings:${cols}`);
          return { eq: async () => ({ data: state.holdings }) };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  },
};

return { state, selects, supabaseAdmin };
});

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin }));

const currentPrices = vi.fn(async (_symbols: string[], _asOf: string) => new Map<string, number>());
vi.mock("../prices.server", () => ({ currentPrices: (s: string[], a: string) => currentPrices(s, a) }));

const valuePortfolioHoldings = vi.fn(async (_args: Any) => ({
  cash: 1000,
  holdingsValue: 2500,
  totalValue: 3500,
  provenance: "live" as const,
}));
vi.mock("../../valuation/value-holdings.server", () => ({
  valuePortfolioHoldings: (a: Any) => valuePortfolioHoldings(a),
}));

const writeEquitySnapshot = vi.fn(async (_c: unknown, _a: Any) => {});
vi.mock("../../valuation/write-snapshot.server", () => ({
  writeEquitySnapshot: (c: unknown, a: Any) => writeEquitySnapshot(c, a),
}));

const recordIntradayEquity = vi.fn(async (_c: unknown, _p: string, _a: Any) => {});
vi.mock("@/lib/equity-intraday.server", () => ({
  recordIntradayEquity: (c: unknown, p: string, a: Any) => recordIntradayEquity(c, p, a),
}));

import { snapshotPortfolio } from "../snapshot.server";

beforeEach(() => {
  selects.length = 0;
  currentPrices.mockClear();
  valuePortfolioHoldings.mockClear();
  writeEquitySnapshot.mockClear();
  recordIntradayEquity.mockClear();
  state.portfolio = { current_cash: "1000", currency: "GBP", broker_account_id: null };
  state.holdings = [
    { symbol: "AAPL:xnas", quantity: "10", avg_cost: "150" },
    { symbol: "MKS:xlon", quantity: "5", avg_cost: "3.2" },
  ];
});

describe("snapshotPortfolio", () => {
  it("prices exactly the held symbols on the requested date", async () => {
    await snapshotPortfolio("p1", "2026-08-03");
    expect(currentPrices).toHaveBeenCalledWith(["AAPL:xnas", "MKS:xlon"], "2026-08-03");
  });

  it("passes numeric-coerced holdings and a base-currency wallet to the valuation kernel", async () => {
    await snapshotPortfolio("p1", "2026-08-03");
    const args = valuePortfolioHoldings.mock.calls[0][0] as Any;
    expect(args.holdings).toEqual([
      { symbol: "AAPL:xnas", quantity: 10, avg_cost: 150 },
      { symbol: "MKS:xlon", quantity: 5, avg_cost: 3.2 },
    ]);
    expect(args.wallet).toEqual({ GBP: 1000 });
    expect(args.baseCcy).toBe("GBP");
    expect(args.asOf).toBe("2026-08-03");
  });

  it("writes the snapshot with the kernel's values, not recomputed ones", async () => {
    await snapshotPortfolio("p1", "2026-08-03");
    expect(writeEquitySnapshot).toHaveBeenCalledTimes(1);
    const [, payload] = writeEquitySnapshot.mock.calls[0] as [unknown, Any];
    expect(payload).toMatchObject({
      portfolioId: "p1",
      snapshotDate: "2026-08-03",
      cash: 1000,
      holdingsValue: 2500,
      totalValue: 3500,
      currency: "GBP",
      source: "trading_engine",
      provenance: "live",
      brokerLinked: false,
      positionCount: 2,
    });
  });

  it("records the same figures to the intraday equity series", async () => {
    await snapshotPortfolio("p1", "2026-08-03");
    expect(recordIntradayEquity).toHaveBeenCalledWith(supabaseAdmin, "p1", {
      cash: 1000,
      holdingsValue: 2500,
      totalValue: 3500,
    });
  });

  it("flags brokerLinked when the portfolio is bound to a broker account", async () => {
    state.portfolio = { current_cash: 1000, currency: "GBP", broker_account_id: "acct-1" };
    await snapshotPortfolio("p1", "2026-08-03");
    const [, payload] = writeEquitySnapshot.mock.calls[0] as [unknown, Any];
    expect(payload.brokerLinked).toBe(true);
  });

  it("upper-cases a lowercase stored currency", async () => {
    state.portfolio = { current_cash: 1000, currency: "eur", broker_account_id: null };
    await snapshotPortfolio("p1", "2026-08-03");
    const args = valuePortfolioHoldings.mock.calls[0][0] as Any;
    expect(args.baseCcy).toBe("EUR");
    expect(args.wallet).toEqual({ EUR: 1000 });
  });

  it("defaults to GBP when the currency column is null or empty", async () => {
    for (const currency of [null, ""]) {
      valuePortfolioHoldings.mockClear();
      state.portfolio = { current_cash: 1000, currency, broker_account_id: null };
      await snapshotPortfolio("p1", "2026-08-03");
      expect((valuePortfolioHoldings.mock.calls[0][0] as Any).baseCcy).toBe("GBP");
    }
  });

  it("still writes a cash-only snapshot when there are no holdings", async () => {
    state.holdings = [];
    valuePortfolioHoldings.mockResolvedValueOnce({
      cash: 1000,
      holdingsValue: 0,
      totalValue: 1000,
      provenance: "cash_only" as never,
    });
    await snapshotPortfolio("p1", "2026-08-03");
    expect(currentPrices).toHaveBeenCalledWith([], "2026-08-03");
    const [, payload] = writeEquitySnapshot.mock.calls[0] as [unknown, Any];
    expect(payload).toMatchObject({ holdingsValue: 0, totalValue: 1000, positionCount: 0 });
  });

  it("treats a null holdings result like an empty list rather than throwing", async () => {
    state.holdings = null;
    await snapshotPortfolio("p1", "2026-08-03");
    expect(currentPrices).toHaveBeenCalledWith([], "2026-08-03");
    const [, payload] = writeEquitySnapshot.mock.calls[0] as [unknown, Any];
    expect(payload.positionCount).toBe(0);
  });

  it("is a no-op when the portfolio does not exist", async () => {
    state.portfolio = null;
    await snapshotPortfolio("missing", "2026-08-03");
    expect(currentPrices).not.toHaveBeenCalled();
    expect(valuePortfolioHoldings).not.toHaveBeenCalled();
    expect(writeEquitySnapshot).not.toHaveBeenCalled();
    expect(recordIntradayEquity).not.toHaveBeenCalled();
  });

  it("reads only the columns it needs (no SELECT *)", async () => {
    await snapshotPortfolio("p1", "2026-08-03");
    expect(selects).toEqual([
      "portfolios:current_cash, currency, broker_account_id",
      "holdings:symbol, quantity, avg_cost",
    ]);
  });

  it("propagates a valuation failure instead of writing a partial snapshot", async () => {
    valuePortfolioHoldings.mockRejectedValueOnce(new Error("kernel down"));
    await expect(snapshotPortfolio("p1", "2026-08-03")).rejects.toThrow("kernel down");
    expect(writeEquitySnapshot).not.toHaveBeenCalled();
    expect(recordIntradayEquity).not.toHaveBeenCalled();
  });

  it("does not record intraday equity when the snapshot write fails", async () => {
    writeEquitySnapshot.mockRejectedValueOnce(new Error("write gate rejected"));
    await expect(snapshotPortfolio("p1", "2026-08-03")).rejects.toThrow("write gate rejected");
    expect(recordIntradayEquity).not.toHaveBeenCalled();
  });
});
