import { describe, expect, it } from "vitest";
import { planViableSizeUp } from "../viable-size-up";

describe("planViableSizeUp", () => {
  it("leaves an already-viable ticket alone", () => {
    const r = planViableSizeUp({
      quantity: 10,
      price: 40,
      minViableNotional: 400,
      spendable: 5000,
    });
    expect(r.applied).toBe(false);
    expect(r.quantity).toBe(10);
  });

  it("raises a sub-floor ticket to the viable size", () => {
    const r = planViableSizeUp({
      quantity: 5,
      price: 39,
      minViableNotional: 400,
      spendable: 5000,
    });
    expect(r.applied).toBe(true);
    expect(r.quantity).toBe(11); // ceil(400/39)
    expect(r.note).toContain("fee-viable floor");
  });

  it("refuses to exceed spendable cash", () => {
    const r = planViableSizeUp({
      quantity: 5,
      price: 39,
      minViableNotional: 400,
      spendable: 300,
    });
    expect(r.applied).toBe(false);
    expect(r.note).toContain("blocked by limit");
  });

  it("refuses to exceed the position cap", () => {
    const r = planViableSizeUp({
      quantity: 5,
      price: 39,
      minViableNotional: 400,
      spendable: 5000,
      maxNotional: 350,
    });
    expect(r.applied).toBe(false);
  });

  it("never inflates a tiny ticket without bound", () => {
    const r = planViableSizeUp({
      quantity: 1,
      price: 10,
      minViableNotional: 400,
      spendable: 5000,
    });
    expect(r.applied).toBe(false); // 40x uplift exceeds the 4x guard
  });
});
