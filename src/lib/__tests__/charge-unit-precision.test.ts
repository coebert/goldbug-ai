/**
 * Rounding and rescaling precision contract.
 *
 * A pence charge that lands a hundredth of a penny off is invisible per row and
 * material across a year of fills, so the scaling maths is pinned here to the
 * exact pound figure a human would write on the invoice — not merely to
 * "roughly right". FX legs are pinned the same way: rate application must be
 * exact to the penny, and the itemised legs must still sum to the headline
 * total after every conversion.
 */
import { describe, it, expect } from "vitest";
import { convertChargeLegs, normaliseChargeCurrency } from "../broker-cost-ingest";
import { checkChargeUnits, classifyCurrencyUnit } from "../valuation/unit-validation";

/** Money equality to a hundredth of a penny — tighter than any display rounding. */
const expectMoney = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(1e-6);

const identity = async (amount: number) => amount;
const rate = (r: number) => async (amount: number) => amount * r;

describe("minor-unit rescaling precision", () => {
  it("scales pence labels to pounds by exactly one hundredth", () => {
    for (const label of ["GBp", "GBX", "GBPX"]) {
      const unit = classifyCurrencyUnit(label);
      expect(unit.scale).toBe(0.01);
      expect(unit.code).toBe("GBP");
    }
    expect(classifyCurrencyUnit("GBP").scale).toBe(1);
  });

  it.each([
    [540, 5.4],
    [1, 0.01],
    [7, 0.07],
    [29, 0.29],
    [333, 3.33],
    [1_234_567, 12_345.67],
    [0.5, 0.005],
  ])("rescales %d GBp to £%s exactly", async (pence: number, pounds: number) => {
    const legs = await convertChargeLegs(
      { currency: "GBp", commission: pence, exchangeFee: 0, tax: 0, other: 0, total: pence },
      "GBP",
      identity,
    );
    expectMoney(legs.commission, pounds);
    expectMoney(legs.total, pounds);

    const check = checkChargeUnits({
      symbol: "MKS.L",
      chargeCurrency: "GBp",
      chargeTotal: pence,
      fillCurrency: "GBP",
      fillPrice: 1000,
      quantity: 1000,
    });
    expectMoney(check.normalised.fee ?? Number.NaN, pounds);
  });

  it("never double-scales a pence charge against a pence-quoted fill", async () => {
    const legs = await convertChargeLegs(
      { currency: "GBp", commission: 250, exchangeFee: 0, tax: 0, other: 0, total: 250 },
      "GBp",
      identity,
    );
    // src and dst are both pence: scale up then back down, landing on the raw figure.
    expectMoney(legs.total, 250);
    expect(normaliseChargeCurrency("GBp")).toEqual({ code: "GBP", scale: 0.01 });
  });

  it("keeps the sum of rescaled legs equal to the rescaled total", async () => {
    const legs = await convertChargeLegs(
      { currency: "GBp", commission: 333, exchangeFee: 17, tax: 129, other: 1, total: 480 },
      "GBP",
      identity,
    );
    expectMoney(legs.commission, 3.33);
    expectMoney(legs.exchangeFee, 0.17);
    expectMoney(legs.tax, 1.29);
    // Declared 480p exceeds the 480p itemisation by nothing, so `other` stays at 1p.
    expectMoney(legs.other, 0.01);
    expect(legs.total).toBe(legs.commission + legs.exchangeFee + legs.tax + legs.other);
    expectMoney(legs.total, 4.8);
  });

  it("puts an unitemised pence residual in `other` without rounding it away", async () => {
    const legs = await convertChargeLegs(
      { currency: "GBp", commission: 100, exchangeFee: 0, tax: 0, other: 0, total: 137 },
      "GBP",
      identity,
    );
    expectMoney(legs.commission, 1);
    expectMoney(legs.other, 0.37);
    expectMoney(legs.total, 1.37);
  });
});

describe("rate-based conversion precision", () => {
  it.each([
    [100, 0.7912, 79.12],
    [12.34, 1.1735, 14.480_99],
    [3.5, 0.85, 2.975],
    [0.03, 0.7912, 0.023_736],
  ])("converts %s at %s to %s", async (amount: number, r: number, expected: number) => {
    const legs = await convertChargeLegs(
      { currency: "USD", commission: amount, exchangeFee: 0, tax: 0, other: 0, total: amount },
      "GBP",
      rate(r),
    );
    expectMoney(legs.commission, expected);
    expectMoney(legs.total, expected);
  });

  it("applies the rate after the pence rescale, never before", async () => {
    // 250 GBp = £2.50; at 1.28 USD/GBP that is $3.20.
    const legs = await convertChargeLegs(
      { currency: "GBp", commission: 250, exchangeFee: 0, tax: 0, other: 0, total: 250 },
      "USD",
      rate(1.28),
    );
    expectMoney(legs.total, 3.2);
  });

  it("rescales into a minor-unit target exactly once", async () => {
    // $3.20 at 0.78125 GBP/USD = £2.50 = 250 GBp.
    const legs = await convertChargeLegs(
      { currency: "USD", commission: 3.2, exchangeFee: 0, tax: 0, other: 0, total: 3.2 },
      "GBp",
      rate(0.781_25),
    );
    expectMoney(legs.total, 250);
  });

  it("keeps legs summing to the total across a mixed conversion", async () => {
    const legs = await convertChargeLegs(
      { currency: "EUR", commission: 4.99, exchangeFee: 0.33, tax: 1.07, other: 0, total: 7.5 },
      "GBP",
      rate(0.8412),
    );
    expectMoney(legs.commission, 4.197_588);
    expectMoney(legs.exchangeFee, 0.277_596);
    expectMoney(legs.tax, 0.900_084);
    // The declared €7.50 exceeds the €6.39 itemisation; the residual survives conversion.
    expectMoney(legs.other, (7.5 - 6.39) * 0.8412);
    expect(legs.total).toBe(legs.commission + legs.exchangeFee + legs.tax + legs.other);
    expectMoney(legs.total, 7.5 * 0.8412);
  });

  it("falls back to the unconverted amount when the rate is unusable", async () => {
    const legs = await convertChargeLegs(
      { currency: "USD", commission: 5, exchangeFee: 0, tax: 0, other: 0, total: 5 },
      "GBP",
      async () => Number.NaN,
    );
    expectMoney(legs.total, 5);
  });

  it("does not drift when many small pence charges are accumulated", async () => {
    let running = 0;
    for (let i = 0; i < 1000; i += 1) {
      const legs = await convertChargeLegs(
        { currency: "GBp", commission: 7, exchangeFee: 0, tax: 0, other: 0, total: 7 },
        "GBP",
        identity,
      );
      running += legs.total;
    }
    // 1000 x 7p = £70.00 to the penny.
    expect(Number(running.toFixed(2))).toBe(70);
    expectMoney(running, 70);
  });
});
