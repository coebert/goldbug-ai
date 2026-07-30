import { describe, it, expect } from "vitest";
import {
  resolvePortfolioBrokerLink,
  isBrokerBacked,
} from "@/lib/brokers/portfolio-broker-link.server";

// Regression guard: two live_sim portfolios once showed identical holdings and
// cash because the broker adapter silently fell back to a process-wide default
// account whenever a portfolio had no broker_account_id of its own.
describe("resolvePortfolioBrokerLink", () => {
  it("links a portfolio that names its own Saxo account", () => {
    const link = resolvePortfolioBrokerLink({
      broker: "saxo",
      broker_account_id: "IszXddWLvI--FLMt59JcDA==",
    });
    expect(link).toEqual({ linked: true, accountKey: "IszXddWLvI--FLMt59JcDA==" });
  });

  it("refuses to fall back to a default account when broker_account_id is missing", () => {
    for (const value of [null, undefined, "", "   "]) {
      const link = resolvePortfolioBrokerLink({ broker: "saxo", broker_account_id: value });
      expect(link.linked).toBe(false);
    }
  });

  it("treats a portfolio with no broker as a simulated ledger", () => {
    const link = resolvePortfolioBrokerLink({ broker: null, broker_account_id: null });
    expect(link.linked).toBe(false);
    if (!link.linked) expect(link.reason).toMatch(/simulated ledger/i);
  });

  it("rejects unsupported brokers", () => {
    const link = resolvePortfolioBrokerLink({ broker: "ibkr", broker_account_id: "abc" });
    expect(link.linked).toBe(false);
    if (!link.linked) expect(link.reason).toMatch(/unsupported broker/i);
  });

  it("normalizes casing and whitespace", () => {
    expect(resolvePortfolioBrokerLink({ broker: " SAXO ", broker_account_id: " k1 " })).toEqual({
      linked: true,
      accountKey: "k1",
    });
  });

  it("never links two distinct portfolios to the same account key implicitly", () => {
    const a = resolvePortfolioBrokerLink({ broker: "saxo", broker_account_id: "acct-A" });
    const b = resolvePortfolioBrokerLink({ broker: "saxo", broker_account_id: null });
    expect(a.linked).toBe(true);
    expect(b.linked).toBe(false);
    expect(isBrokerBacked({ broker: "saxo", broker_account_id: "acct-A" })).toBe(true);
    expect(isBrokerBacked({ broker: "saxo", broker_account_id: null })).toBe(false);
  });
});
