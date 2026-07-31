import { describe, expect, it } from "vitest";
import { auditPriceUnits, resolveQuote } from "../price-unit-audit";
import type { RevalueHolding } from "../equity-snapshot-revalue";

const DATE = "2026-07-31";

function prices(entries: Record<string, Record<string, number>>) {
  return new Map(
    Object.entries(entries).map(([symbol, series]) => [
      symbol.toUpperCase(),
      new Map(Object.entries(series)),
    ]),
  );
}

const holding = (h: Partial<RevalueHolding> & { symbol: string }): RevalueHolding => ({
  quantity: 10,
  avg_cost: 1,
  ...h,
});

describe("resolveQuote", () => {
  it("prefers the exact day and reports its key", () => {
    const q = resolveQuote(prices({ "ISF.L": { "2026-07-30": 700, [DATE]: 800 } }), "ISF:xlon", DATE);
    expect(q).toEqual({ key: "ISF.L", close: 800, date: DATE });
  });

  it("carries forward the most recent earlier close", () => {
    const q = resolveQuote(prices({ AAPL: { "2026-07-28": 200 } }), "AAPL", DATE);
    expect(q).toEqual({ key: "AAPL", close: 200, date: "2026-07-28" });
  });

  it("ignores future closes", () => {
    expect(resolveQuote(prices({ AAPL: { "2026-08-05": 210 } }), "AAPL", DATE)).toBeNull();
  });
});

describe("auditPriceUnits", () => {
  it("folds pence quotes exactly once and records the divisor", () => {
    const audit = auditPriceUnits({
      portfolioId: "p1",
      date: DATE,
      baseCcy: "GBP",
      holdings: [holding({ symbol: "ISF:xlon", quantity: 100 })],
      prices: prices({ "ISF.L": { [DATE]: 800 } }),
    });
    const row = audit.rows[0]!;
    expect(row.quote_currency).toBe("GBX");
    expect(row.pence_folded).toBe(true);
    expect(row.divisor).toBe(100);
    expect(row.raw_quote).toBe(800);
    expect(row.price_in_instrument_ccy).toBe(8);
    expect(row.value_base).toBe(800);
    expect(audit.holdings_value).toBe(800);
  });

  it("leaves GBP-quoted LSE ETFs unfolded", () => {
    const audit = auditPriceUnits({
      portfolioId: "p1",
      date: DATE,
      baseCcy: "GBP",
      holdings: [holding({ symbol: "VUKE.L", quantity: 10 })],
      prices: prices({ "VUKE.L": { [DATE]: 35 } }),
    });
    const row = audit.rows[0]!;
    expect(row.pence_folded).toBe(false);
    expect(row.divisor).toBe(1);
    expect(row.value_base).toBe(350);
  });

  it("applies FX after the pence fold and names the pair", () => {
    const audit = auditPriceUnits({
      portfolioId: "p1",
      date: DATE,
      baseCcy: "EUR",
      holdings: [holding({ symbol: "ISF:xlon", quantity: 100 })],
      prices: prices({ "ISF.L": { [DATE]: 800 } }),
      fx: new Map([["GBP", 1.2]]),
    });
    const row = audit.rows[0]!;
    expect(row.fx_pair).toBe("GBP/EUR");
    expect(row.fx_source).toBe("rate");
    expect(row.value_instrument_ccy).toBe(800);
    expect(row.value_base).toBe(960);
    expect(row.steps.at(-1)).toMatchObject({ unit: "EUR", value: 960 });
  });

  it("flags a missing FX rate instead of zeroing the leg", () => {
    const audit = auditPriceUnits({
      portfolioId: "p1",
      date: DATE,
      baseCcy: "EUR",
      holdings: [holding({ symbol: "AAPL", quantity: 2, instrument_ccy: "USD" })],
      prices: prices({ AAPL: { [DATE]: 100 } }),
    });
    const row = audit.rows[0]!;
    expect(row.fx_source).toBe("assumed_identity");
    expect(row.fx_rate).toBe(1);
    expect(row.value_base).toBe(200);
    expect(audit.warnings.join(" ")).toContain("USD/EUR");
  });

  it("labels carried-forward and avg_cost fallbacks", () => {
    const audit = auditPriceUnits({
      portfolioId: "p1",
      date: DATE,
      baseCcy: "USD",
      holdings: [
        holding({ symbol: "AAPL", quantity: 1, avg_cost: 150, instrument_ccy: "USD" }),
        holding({ symbol: "MSFT", quantity: 1, avg_cost: 400, instrument_ccy: "USD" }),
      ],
      prices: prices({ AAPL: { "2026-07-24": 190 } }),
    });
    const byId = Object.fromEntries(audit.rows.map((r) => [r.symbol, r]));
    expect(byId["AAPL"]!.price_source).toBe("carried_close");
    expect(byId["AAPL"]!.quote_date).toBe("2026-07-24");
    expect(byId["MSFT"]!.price_source).toBe("avg_cost");
    expect(byId["MSFT"]!.value_base).toBe(400);
    expect(audit.warnings.join(" ")).toContain("MSFT");
  });

  it("summarises per-currency contributions and weights", () => {
    const audit = auditPriceUnits({
      portfolioId: "p1",
      date: DATE,
      baseCcy: "GBP",
      holdings: [
        holding({ symbol: "ISF:xlon", quantity: 100 }),
        holding({ symbol: "AAPL", quantity: 4, instrument_ccy: "USD" }),
      ],
      prices: prices({ "ISF.L": { [DATE]: 800 }, AAPL: { [DATE]: 100 } }),
      fx: new Map([
        ["GBP", 1],
        ["USD", 0.8],
      ]),
      cash: 200,
    });
    expect(audit.holdings_value).toBe(1120);
    expect(audit.total_value).toBe(1320);
    expect(audit.by_currency).toEqual([
      { currency: "GBP", value_base: 800, fx_rate: 1, positions: 1 },
      { currency: "USD", value_base: 320, fx_rate: 0.8, positions: 1 },
    ]);
    expect(audit.rows.map((r) => r.weight)).toEqual([
      Math.round((800 / 1120) * 1e6) / 1e6,
      Math.round((320 / 1120) * 1e6) / 1e6,
    ]);
  });

  it("calls out a 100x mismatch against the stored snapshot", () => {
    const audit = auditPriceUnits({
      portfolioId: "p1",
      date: DATE,
      baseCcy: "GBP",
      holdings: [holding({ symbol: "ISF:xlon", quantity: 100 })],
      prices: prices({ "ISF.L": { [DATE]: 800 } }),
      stored: { holdings_value: 8, total_value: 8 },
    });
    expect(audit.stored_ratio).toBe(100);
    expect(audit.warnings.join(" ")).toContain("unit (pence vs pounds) mismatch");
  });

  it("is deterministic and independent of holdings order", () => {
    const args = {
      portfolioId: "p1",
      date: DATE,
      baseCcy: "GBP",
      prices: prices({ "ISF.L": { [DATE]: 800 }, "SGLN.L": { [DATE]: 5000 } }),
    };
    const a = auditPriceUnits({
      ...args,
      holdings: [holding({ symbol: "ISF:xlon", quantity: 100 }), holding({ symbol: "SGLN.L", quantity: 3 })],
    });
    const b = auditPriceUnits({
      ...args,
      holdings: [holding({ symbol: "SGLN.L", quantity: 3 }), holding({ symbol: "ISF:xlon", quantity: 100 })],
    });
    expect(a.rows).toEqual(b.rows);
    expect(a.holdings_value).toBe(b.holdings_value);
  });
});
