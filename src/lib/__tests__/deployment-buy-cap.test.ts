import { describe, it, expect } from "vitest";
import { deploymentAdjustedBuyCap, MAX_DEPLOY_BONUS_TICKETS } from "../cost-governor";

describe("deployment-adjusted daily buy cap", () => {
  it("leaves the cap alone when the book is fully deployed", () => {
    const r = deploymentAdjustedBuyCap({ maxBuysPerDay: 3, investedFraction: 0.92 });
    expect(r.cap).toBe(3);
    expect(r.bonus).toBe(0);
    expect(r.reason).toBeNull();
  });

  it("leaves the cap alone when the shortfall is small", () => {
    expect(deploymentAdjustedBuyCap({ maxBuysPerDay: 3, investedFraction: 0.8 }).cap).toBe(3);
  });

  it("adds a ticket for a moderate shortfall", () => {
    const r = deploymentAdjustedBuyCap({ maxBuysPerDay: 3, investedFraction: 0.7 });
    expect(r.cap).toBe(4);
    expect(r.reason).toContain("daily buy cap 3→4");
  });

  it("caps the bonus for an all-cash book", () => {
    const r = deploymentAdjustedBuyCap({ maxBuysPerDay: 3, investedFraction: 0 });
    expect(r.bonus).toBe(MAX_DEPLOY_BONUS_TICKETS);
    expect(r.cap).toBe(3 + MAX_DEPLOY_BONUS_TICKETS);
  });

  it("honours an explicit target", () => {
    expect(
      deploymentAdjustedBuyCap({
        maxBuysPerDay: 3,
        investedFraction: 0.5,
        targetInvestedFraction: 0.5,
      }).cap,
    ).toBe(3);
  });

  it("ignores a missing or nonsense invested share", () => {
    expect(deploymentAdjustedBuyCap({ maxBuysPerDay: 3 }).cap).toBe(3);
    expect(deploymentAdjustedBuyCap({ maxBuysPerDay: 3, investedFraction: NaN }).cap).toBe(3);
  });
});
