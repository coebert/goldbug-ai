import { describe, expect, it } from "vitest";
import { checkPnlSanity } from "../pnl-sanity";

describe("checkPnlSanity", () => {
  it("passes when no prior anchor exists", () => {
    const r = checkPnlSanity({ prevEquity: null, currEquity: 1000 });
    expect(r.ok).toBe(true);
    expect(r.flags[0].code).toBe("no_prior_anchor");
  });

  it("passes on plausible mark-to-market drift", () => {
    const r = checkPnlSanity({
      prevEquity: 1000,
      currEquity: 1015, // +1.5%
      netCashFlow: 0,
      hadHoldings: true,
    });
    expect(r.ok).toBe(true);
  });

  it("passes when equity move matches a deposit", () => {
    const r = checkPnlSanity({
      prevEquity: 1000,
      currEquity: 2000,
      netCashFlow: 1000, // deposit fully explains the jump
      expectedTradingPnl: 0,
      hadHoldings: true,
    });
    expect(r.ok).toBe(true);
  });

  it("flags a flat portfolio whose equity moved without cash flow", () => {
    const r = checkPnlSanity({
      prevEquity: 1000,
      currEquity: 1200,
      netCashFlow: 0,
      hadHoldings: false,
    });
    expect(r.ok).toBe(false);
    expect(r.flags.some((f) => f.code === "flat_portfolio_moved")).toBe(true);
  });

  it("flags a >20% single-step jump", () => {
    const r = checkPnlSanity({
      prevEquity: 1000,
      currEquity: 1500, // +50%
      netCashFlow: 0,
      hadHoldings: true,
    });
    expect(r.ok).toBe(false);
    const jump = r.flags.find((f) => f.code === "unexplained_jump");
    expect(jump).toBeDefined();
    expect(jump!.severity).toBe("critical"); // > 2x threshold
  });

  it("flags negative equity as critical", () => {
    const r = checkPnlSanity({
      prevEquity: 100,
      currEquity: -50,
      netCashFlow: 0,
    });
    expect(r.flags.some((f) => f.code === "negative_equity" && f.severity === "critical")).toBe(
      true,
    );
  });

  it("flags cash-flow vs equity mismatch when trading P&L is supplied", () => {
    // Deposited 100, trading P&L was +10, but equity jumped by 500.
    const r = checkPnlSanity({
      prevEquity: 1000,
      currEquity: 1500,
      netCashFlow: 100,
      expectedTradingPnl: 10,
      hadHoldings: true,
    });
    expect(r.ok).toBe(false);
    expect(r.flags.some((f) => f.code === "cash_flow_vs_equity_mismatch")).toBe(true);
  });

  it("flags direction disagreement between trading P&L and residual", () => {
    // Trading P&L says +200 but equity residual after cash flow is -180.
    const r = checkPnlSanity({
      prevEquity: 1000,
      currEquity: 820,
      netCashFlow: 0,
      expectedTradingPnl: 200,
      hadHoldings: true,
    });
    expect(r.flags.some((f) => f.code === "sign_mismatch")).toBe(true);
  });

  it("ignores tiny residuals below the noise floor", () => {
    const r = checkPnlSanity({
      prevEquity: 1000,
      currEquity: 1000.5,
      netCashFlow: 0,
      hadHoldings: false,
    });
    expect(r.ok).toBe(true);
  });

  it("reconciles the exact starting_cash-inflation scenario from the SIM bug", () => {
    // Reproduces the earlier `syncLiveCashFromBroker` bug: local equity ~1M GBP
    // stayed flat but starting_cash silently inflated, producing a -47% jump
    // on the tile. Modelled here as an equity drop with no cash flow and
    // no expected trading P&L to explain it.
    const r = checkPnlSanity({
      prevEquity: 1_000_000,
      currEquity: 530_000, // -47%
      netCashFlow: 0,
      expectedTradingPnl: 0,
      hadHoldings: true,
    });
    expect(r.ok).toBe(false);
    expect(r.flags.some((f) => f.code === "unexplained_jump" && f.severity === "critical")).toBe(
      true,
    );
  });
});
