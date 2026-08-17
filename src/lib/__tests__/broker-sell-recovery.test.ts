import { describe, expect, it } from "vitest";
import { shouldRetrySellAsMarket } from "@/lib/broker-sell-recovery";

describe("sell price rejection recovery", () => {
  it("retries the exact MKS tick and tolerance failures", () => {
    expect(shouldRetrySellAsMarket({
      side: "sell",
      status: "rejected",
      reason: "The order price is not in tick size increments.",
    })).toBe(true);
    expect(shouldRetrySellAsMarket({
      side: "sell",
      status: "rejected",
      reason: "Price exceeds aggressive tolerance",
    })).toBe(true);
  });

  it("never retries buys or unrelated business rejections", () => {
    expect(shouldRetrySellAsMarket({
      side: "buy",
      status: "rejected",
      reason: "Price exceeds aggressive tolerance",
    })).toBe(false);
    expect(shouldRetrySellAsMarket({
      side: "sell",
      status: "rejected",
      reason: "Market is closed",
    })).toBe(false);
  });
});