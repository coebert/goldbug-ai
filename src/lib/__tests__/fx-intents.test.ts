import { describe, it, expect } from "vitest";
import {
  compileFxIntents,
  DEFAULT_GUARDRAILS,
  FxIntentSchema,
  type CompileFxContext,
  type FxIntent,
} from "@/lib/fx-intents";

const baseCtx = (overrides: Partial<CompileFxContext> = {}): CompileFxContext => ({
  baseCcy: "GBP",
  wallet: { GBP: 10_000, USD: 5_000, EUR: 200 },
  exposureBase: { GBP: 20_000, USD: 3_000 },
  ratesToBase: { USD: 0.8, EUR: 0.85, GBP: 1 },
  guardrails: {
    ...DEFAULT_GUARDRAILS,
    navBase: 25_000,
  },
  ...overrides,
});

describe("FxIntentSchema", () => {
  it("accepts each intent kind and rejects unknown ones", () => {
    const ok: FxIntent[] = [
      { kind: "pre_fund", ccy: "USD", notional_base: 500, reason: "buy AAPL" },
      { kind: "hedge", ccy: "USD", reduce_pct: 30, reason: "risk-off" },
      { kind: "sweep_idle", ccy: "EUR", reason: "no upcoming EUR buys" },
      { kind: "carry_tilt", ccy: "USD", tilt_pct_of_base: 5, reason: "rate diff" },
      { kind: "close_hedge", ccy: "USD", amount_base: 200, reason: "vol cleared" },
    ];
    for (const i of ok) expect(FxIntentSchema.parse(i)).toEqual(i);
    expect(() => FxIntentSchema.parse({ kind: "nonsense", ccy: "USD" })).toThrow();
    expect(() => FxIntentSchema.parse({ kind: "hedge", ccy: "US", reduce_pct: 30, reason: "x" }))
      .toThrow(); // ccy length !== 3
  });
});

describe("compileFxIntents — pre_fund", () => {
  it("funds notional_base × 1.02 from GBP into USD", () => {
    const [r] = compileFxIntents(
      [{ kind: "pre_fund", ccy: "USD", notional_base: 800, reason: "buy MSFT" }],
      baseCtx(),
    );
    expect(r.order?.from_ccy).toBe("GBP");
    expect(r.order?.to_ccy).toBe("USD");
    // 800 × 1.02 = 816 GBP; wallet GBP = 10_000 → ~8.16% → rounds to 8
    expect(r.order?.amount_percent).toBe(8);
    expect(r.notionalBase).toBeCloseTo(816, 2);
  });

  it("no-ops when funding base into base", () => {
    const [r] = compileFxIntents(
      [{ kind: "pre_fund", ccy: "GBP", notional_base: 100, reason: "x" }],
      baseCtx(),
    );
    expect(r.order).toBeUndefined();
    expect(r.skipped).toMatch(/no-op/i);
  });
});

describe("compileFxIntents — guardrails", () => {
  it("skips conversions below min notional", () => {
    const [r] = compileFxIntents(
      [{ kind: "sweep_idle", ccy: "EUR", reason: "idle" }],
      baseCtx({
        wallet: { GBP: 10_000, EUR: 20 }, // 20 EUR × 0.85 = 17 GBP < 25
      }),
    );
    expect(r.order).toBeUndefined();
    expect(r.skipped).toMatch(/min notional/i);
  });

  it("enforces per-tick turnover cap by trimming (not skipping) when possible", () => {
    // navBase 25_000 × 25% = 6_250 GBP budget
    // pre_fund 5_000 (×1.02 = 5_100), then pre_fund 3_000 (×1.02 = 3_060)
    // First fits; second gets trimmed to 6250-5100=1150.
    const res = compileFxIntents(
      [
        { kind: "pre_fund", ccy: "USD", notional_base: 5_000, reason: "buy 1" },
        { kind: "pre_fund", ccy: "EUR", notional_base: 3_000, reason: "buy 2" },
      ],
      baseCtx(),
    );
    expect(res[0].notionalBase).toBeCloseTo(5_100, 2);
    expect(res[1].order).toBeDefined();
    expect(res[1].notionalBase).toBeCloseTo(1_150, 2);
  });

  it("caps carry_tilt so tilt exposure never exceeds maxTiltExposurePctOfNav", () => {
    // navBase 25_000, tilt cap 20% = 5_000. Initial non-base exposure = 3_000
    // (USD). Room = 2_000. Tilt asks for 20% of 10_000 GBP = 2_000 → fits.
    // A second tilt should be skipped (room now 0).
    const res = compileFxIntents(
      [
        { kind: "carry_tilt", ccy: "USD", tilt_pct_of_base: 20, reason: "carry 1" },
        { kind: "carry_tilt", ccy: "EUR", tilt_pct_of_base: 5, reason: "carry 2" },
      ],
      baseCtx(),
    );
    expect(res[0].order).toBeDefined();
    expect(res[0].notionalBase).toBeCloseTo(2_000, 2);
    expect(res[1].order).toBeUndefined();
    expect(res[1].skipped).toMatch(/tilt exposure cap/i);
  });

  it("clamps hedge amount to the per-currency 40% cap", () => {
    const [r] = compileFxIntents(
      [{ kind: "hedge", ccy: "USD", reduce_pct: 90, reason: "risk-off" }],
      baseCtx(),
    );
    // USD wallet 5_000, 90% asked → clamped to 40% = 2_000 USD
    // 2_000 × 0.8 = 1_600 GBP notional
    expect(r.notionalBase).toBeCloseTo(1_600, 2);
    // 2_000 / 5_000 = 40%
    expect(r.order?.amount_percent).toBe(40);
  });

  it("runs pre_fund before carry_tilt regardless of input order", () => {
    // If turnover budget just barely fits one, pre_fund should win.
    const res = compileFxIntents(
      [
        { kind: "carry_tilt", ccy: "USD", tilt_pct_of_base: 20, reason: "carry" },
        { kind: "pre_fund", ccy: "EUR", notional_base: 6_000, reason: "buy" },
      ],
      baseCtx({
        guardrails: { ...DEFAULT_GUARDRAILS, navBase: 25_000, maxTurnoverPctOfNav: 25 },
        // 25% × 25_000 = 6_250 budget
      }),
    );
    const kinds = res.map((r) => r.intent.kind);
    expect(kinds).toEqual(["pre_fund", "carry_tilt"]);
    expect(res[0].order).toBeDefined();
    // pre_fund used 6_000 × 1.02 = 6_120 → carry_tilt gets 130 remaining → below min? 130 > 25, so trims
    // but tilt also caps at NAV 20% = 5_000, exposure already 3_000, room 2_000
    // final should be min(130, 2_000) = 130
    if (res[1].order) {
      expect(res[1].notionalBase).toBeLessThanOrEqual(130 + 1);
    }
  });

  it("skips when the base wallet has less than min notional to spend", () => {
    const [r] = compileFxIntents(
      [{ kind: "pre_fund", ccy: "USD", notional_base: 5_000, reason: "buy" }],
      baseCtx({ wallet: { GBP: 20, USD: 0, EUR: 0 }, guardrails: { ...DEFAULT_GUARDRAILS, navBase: 25_000 } }),
    );
    // Base bal 20 GBP < min notional 25 → skip
    expect(r.order).toBeUndefined();
    expect(r.skipped).toMatch(/base gbp wallet too low/i);
  });
});
