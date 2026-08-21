import { describe, expect, it } from "vitest";
import {
  parseFeeSchedule,
  feeScheduleDefaults,
  importFeeSchedule,
} from "@/lib/backtest/fee-schedule-import";
import { deriveAutoAssumptions } from "@/lib/backtest/auto-assumptions";

const JSON_SCHEDULE = JSON.stringify({
  broker: "Saxo",
  tier: "Classic",
  asOf: "2026-08-01",
  baseCurrency: "GBP",
  venues: [
    { currency: "GBP", venue: "LSE", ratePct: 0.08, min: 3 },
    { currency: "USD", venue: "US", rateBps: 8, min: 1 },
  ],
  taxes: { ukStampDutyPct: 0.5, ptmLevy: true, fxSpreadBps: 6 },
});

describe("parseFeeSchedule", () => {
  it("accepts JSON with percentage or bps rate quoting", () => {
    const { schedule, warnings } = parseFeeSchedule(JSON_SCHEDULE);
    expect(warnings).toEqual([]);
    expect(schedule?.venues).toHaveLength(2);
    expect(schedule?.venues[0]!.rate).toBeCloseTo(0.0008, 6);
    expect(schedule?.venues[1]!.rate).toBeCloseTo(0.0008, 6);
    expect(schedule?.taxes?.ukStampDutyPct).toBe(0.5);
  });

  it("accepts a CSV export", () => {
    const { schedule } = parseFeeSchedule(
      "currency,venue,ratePct,min\nGBP,LSE,0.08,3\nUSD,US,0.08,1\n",
    );
    expect(schedule?.venues.map((v) => v.currency)).toEqual(["GBP", "USD"]);
    expect(schedule?.venues[0]!.min).toBe(3);
  });

  it("skips junk rows with a warning instead of poisoning the schedule", () => {
    const { schedule, warnings } = parseFeeSchedule({
      baseCurrency: "GBP",
      venues: [
        { currency: "GBP", ratePct: 0.08, min: 3 },
        { currency: "nonsense", rate: 0.1 },
        { currency: "EUR", rate: 99 },
      ],
    });
    expect(schedule?.venues).toHaveLength(1);
    expect(warnings.length).toBe(2);
  });

  it("returns null for unusable input", () => {
    expect(parseFeeSchedule("").schedule).toBeNull();
    expect(parseFeeSchedule("{oops").schedule).toBeNull();
    expect(parseFeeSchedule({ venues: [] }).schedule).toBeNull();
  });
});

describe("feeScheduleDefaults", () => {
  it("prices a schedule matching our model at ~1x", () => {
    const { schedule } = parseFeeSchedule(JSON_SCHEDULE);
    const d = feeScheduleDefaults(schedule!);
    expect(d.commissionMult).toBeCloseTo(1, 2);
    expect(d.commissionFloorBase).toBe(3);
    expect(d.stampMult).toBe(1);
    expect(d.ptmLevy).toBe(true);
    expect(d.fxSpreadBps).toBe(6);
  });

  it("detects a costlier tariff and a stamp-free jurisdiction", () => {
    const { defaults } = importFeeSchedule({
      broker: "Pricey",
      baseCurrency: "GBP",
      venues: [{ currency: "GBP", ratePct: 0.16, min: 6 }],
      taxes: { ukStampDutyPct: 0, ptmLevy: false },
    });
    expect(defaults!.commissionMult).toBeGreaterThan(1.5);
    expect(defaults!.stampMult).toBe(0);
    expect(defaults!.ptmLevy).toBe(false);
    expect(defaults!.commissionFloorBase).toBe(6);
  });
});

describe("auto assumptions with an imported schedule", () => {
  it("uses the schedule when there are no invoiced tickets", () => {
    const { defaults } = importFeeSchedule({
      broker: "Cheap",
      baseCurrency: "GBP",
      venues: [{ currency: "GBP", ratePct: 0.04, min: 1 }],
      taxes: { ukStampDutyPct: 0, ptmLevy: false },
    });
    const res = deriveAutoAssumptions({ feeSchedule: defaults });
    expect(res.assumptions.stampMult).toBe(0);
    expect(res.assumptions.ptmLevy).toBe(false);
    expect(res.assumptions.commissionFloorBase).toBe(1);
    expect(res.assumptions.commissionMult).toBeLessThan(1);
    expect(res.basis.find((b) => b.field === "commissionMult")?.note).toContain(
      "imported fee schedule",
    );
  });

  it("lets real invoiced fills override the published tariff", () => {
    const { defaults } = importFeeSchedule({
      broker: "Cheap",
      baseCurrency: "GBP",
      venues: [{ currency: "GBP", ratePct: 0.04, min: 1 }],
    });
    const fees = Array.from({ length: 6 }, () => ({
      notional: 1_000,
      invoicedCommission: 4,
      modelledCommission: 3,
    }));
    const res = deriveAutoAssumptions({ feeSchedule: defaults, fees });
    expect(res.assumptions.commissionMult).toBeCloseTo(1.33, 2);
  });
});
