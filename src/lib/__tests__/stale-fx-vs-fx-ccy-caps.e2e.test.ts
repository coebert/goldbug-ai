// End-to-end test: interaction between stale FX-rate handling and
// `fx_currency_limits` per-currency exposure caps for JPY and AUD buys.
//
// Two independent guardrails can block a foreign-ccy buy:
//   1. STALE FX — the base→native rate is older than the freshness window
//      (or explicitly flagged), which inflates cost/uncertainty and must
//      short-circuit the order with a `stale_fx` reason.
//   2. FX_CCY_CAP — the resulting per-currency base-ccy exposure would
//      breach `fx_currency_limits[ccy]` from RiskConfig.
//
// PRIORITY CONTRACT (locked here):
//   • Stale FX is evaluated FIRST. When a rate is stale, the order is
//     rejected with reason `stale_fx` even if it would also breach the
//     currency cap. Rationale: a stale rate makes the cap check itself
//     unreliable (base-ccy notional is a stale estimate), so we surface
//     the more fundamental data-quality failure.
//   • When the rate is fresh, cap enforcement runs; a breach rejects with
//     reason `fx_ccy_cap` naming the offending currency.
//   • Fresh + within-cap → accepted; exposure is credited.
//
// The test drives both guards through a pure decision function and
// asserts the exact rejection reason, order acceptance, and terminal
// exposure ledger for a mixed JPY/AUD schedule.

import { describe, it, expect } from "vitest";

type Ccy = "JPY" | "AUD";

type FxQuote = {
  ccy: Ccy;
  nativeToBase: number; // native → GBP
  asOfMs: number;
  explicitStale?: boolean;
};

type BuyIntent = {
  id: string;
  symbol: string;
  ccy: Ccy;
  quantity: number;
  price: number; // native
};

type RiskCaps = {
  fx_currency_limits: Partial<Record<Ccy, number>>; // base-ccy exposure cap
};

type Decision =
  | { id: string; accepted: true;  ccy: Ccy; notionalBase: number }
  | { id: string; accepted: false; reason: "stale_fx" | "fx_ccy_cap"; ccy: Ccy; detail?: string };

const FRESHNESS_MS = 60_000; // one minute

function isStale(q: FxQuote, nowMs: number): boolean {
  if (q.explicitStale) return true;
  return nowMs - q.asOfMs > FRESHNESS_MS;
}

/**
 * Pure decision function under test. Applies the stale-first / cap-second
 * priority and updates a running exposure ledger for accepted buys.
 */
function decideBuy(
  intent: BuyIntent,
  quote: FxQuote,
  caps: RiskCaps,
  exposure: Record<Ccy, number>,
  nowMs: number,
): Decision {
  // Guard 1: stale FX — evaluated FIRST so a stale rate never silently
  // masquerades as a cap breach (the cap math would use a stale notional).
  if (isStale(quote, nowMs)) {
    return { id: intent.id, accepted: false, reason: "stale_fx", ccy: intent.ccy };
  }

  const notionalNative = intent.quantity * intent.price;
  const notionalBase = notionalNative * quote.nativeToBase;

  // Guard 2: per-currency exposure cap.
  const cap = caps.fx_currency_limits[intent.ccy];
  if (cap !== undefined) {
    const projected = (exposure[intent.ccy] ?? 0) + notionalBase;
    if (projected > cap + 1e-9) {
      return {
        id: intent.id,
        accepted: false,
        reason: "fx_ccy_cap",
        ccy: intent.ccy,
        detail: `projected ${projected.toFixed(2)} > cap ${cap.toFixed(2)}`,
      };
    }
  }

  return { id: intent.id, accepted: true, ccy: intent.ccy, notionalBase };
}

function runSchedule(
  intents: BuyIntent[],
  quotes: Record<Ccy, FxQuote>,
  caps: RiskCaps,
  nowMs: number,
) {
  const exposure: Record<Ccy, number> = { JPY: 0, AUD: 0 };
  const decisions: Decision[] = [];
  for (const it of intents) {
    const d = decideBuy(it, quotes[it.ccy], caps, exposure, nowMs);
    if (d.accepted) exposure[d.ccy] += d.notionalBase;
    decisions.push(d);
  }
  return { exposure, decisions };
}

describe("Stale FX × fx_currency_limits caps — priority and rejection reasons", () => {
  const nowMs = 1_700_000_000_000;
  const fresh = (ccy: Ccy, rate: number): FxQuote => ({
    ccy, nativeToBase: rate, asOfMs: nowMs - 5_000, // 5s old → fresh
  });
  const stale = (ccy: Ccy, rate: number): FxQuote => ({
    ccy, nativeToBase: rate, asOfMs: nowMs - 10 * 60_000, // 10min old
  });
  const flaggedStale = (ccy: Ccy, rate: number): FxQuote => ({
    ccy, nativeToBase: rate, asOfMs: nowMs - 1_000, explicitStale: true,
  });

  const JPY_RATE = 1 / 190;
  const AUD_RATE = 1 / 1.9;

  const caps: RiskCaps = {
    fx_currency_limits: {
      JPY: 2_000, // £2,000 exposure cap
      AUD: 1_500, // £1,500 exposure cap
    },
  };

  it("stale FX rejects the buy with reason `stale_fx` and skips cap math", () => {
    const { exposure, decisions } = runSchedule(
      [{ id: "j1", symbol: "7203.T", ccy: "JPY", quantity: 100, price: 3_000 }],
      { JPY: stale("JPY", JPY_RATE), AUD: fresh("AUD", AUD_RATE) },
      caps,
      nowMs,
    );
    expect(decisions[0]).toMatchObject({ accepted: false, reason: "stale_fx", ccy: "JPY" });
    expect(exposure.JPY).toBe(0);
  });

  it("explicit stale flag also rejects with `stale_fx`, even if fresh by timestamp", () => {
    const { decisions } = runSchedule(
      [{ id: "a1", symbol: "BHP.AX", ccy: "AUD", quantity: 10, price: 40 }],
      { JPY: fresh("JPY", JPY_RATE), AUD: flaggedStale("AUD", AUD_RATE) },
      caps,
      nowMs,
    );
    expect(decisions[0]).toMatchObject({ accepted: false, reason: "stale_fx", ccy: "AUD" });
  });

  it("stale FX takes PRIORITY over an obvious cap breach (would-also-fail-cap)", () => {
    // 1,000,000 JPY notional → ~£5,263 in base → would breach the £2,000 JPY cap.
    // Rate is stale, so the reason must be `stale_fx`, not `fx_ccy_cap`.
    const { decisions } = runSchedule(
      [{ id: "j-huge", symbol: "7203.T", ccy: "JPY", quantity: 1_000, price: 1_000 }],
      { JPY: stale("JPY", JPY_RATE), AUD: fresh("AUD", AUD_RATE) },
      caps,
      nowMs,
    );
    expect(decisions[0]).toMatchObject({ accepted: false, reason: "stale_fx" });
  });

  it("fresh rate but cap breach rejects with `fx_ccy_cap` and names the currency", () => {
    // 500 × 40 A$ = 20,000 A$ → £10,526 base → breaches the £1,500 AUD cap.
    const { exposure, decisions } = runSchedule(
      [{ id: "a-big", symbol: "BHP.AX", ccy: "AUD", quantity: 500, price: 40 }],
      { JPY: fresh("JPY", JPY_RATE), AUD: fresh("AUD", AUD_RATE) },
      caps,
      nowMs,
    );
    expect(decisions[0].accepted).toBe(false);
    expect((decisions[0] as { reason: string }).reason).toBe("fx_ccy_cap");
    expect((decisions[0] as { ccy: Ccy }).ccy).toBe("AUD");
    expect(exposure.AUD).toBe(0);
  });

  it("fresh + within cap is accepted and credits exposure at the fresh rate", () => {
    // 50 × 3,000 JPY = 150,000 JPY → ~£789 base → well under the £2,000 cap.
    const { exposure, decisions } = runSchedule(
      [{ id: "j-ok", symbol: "7203.T", ccy: "JPY", quantity: 50, price: 3_000 }],
      { JPY: fresh("JPY", JPY_RATE), AUD: fresh("AUD", AUD_RATE) },
      caps,
      nowMs,
    );
    expect(decisions[0].accepted).toBe(true);
    expect(exposure.JPY).toBeCloseTo((50 * 3_000) * JPY_RATE, 9);
  });

  it("mixed schedule: staleness on one ccy does not block orders in the other", () => {
    // JPY quote is stale — JPY orders rejected. AUD is fresh, and the
    // small AUD buy fits under its £1,500 cap — should be accepted.
    const intents: BuyIntent[] = [
      { id: "j1", symbol: "7203.T", ccy: "JPY", quantity: 100, price: 3_000 }, // stale_fx
      { id: "a1", symbol: "BHP.AX", ccy: "AUD", quantity: 20,  price: 40 },    // ok
      { id: "j2", symbol: "7203.T", ccy: "JPY", quantity: 10,  price: 100 },   // stale_fx
    ];
    const { exposure, decisions } = runSchedule(
      intents,
      { JPY: stale("JPY", JPY_RATE), AUD: fresh("AUD", AUD_RATE) },
      caps,
      nowMs,
    );
    expect(decisions.map((d) => (d.accepted ? "ok" : d.reason))).toEqual([
      "stale_fx", "ok", "stale_fx",
    ]);
    expect(exposure.JPY).toBe(0);
    expect(exposure.AUD).toBeCloseTo((20 * 40) * AUD_RATE, 9);
  });

  it("running cap enforcement: earlier fills consume headroom for later intents", () => {
    // £1,500 AUD cap. First fill uses ~£1,052; second (~£1,052) would
    // push exposure to ~£2,104 → must reject with `fx_ccy_cap`.
    const intents: BuyIntent[] = [
      { id: "a1", symbol: "BHP.AX", ccy: "AUD", quantity: 50, price: 40 }, // ok, ~£1,052
      { id: "a2", symbol: "BHP.AX", ccy: "AUD", quantity: 50, price: 40 }, // cap breach
    ];
    const { exposure, decisions } = runSchedule(
      intents,
      { JPY: fresh("JPY", JPY_RATE), AUD: fresh("AUD", AUD_RATE) },
      caps,
      nowMs,
    );
    expect(decisions[0].accepted).toBe(true);
    expect(decisions[1]).toMatchObject({ accepted: false, reason: "fx_ccy_cap", ccy: "AUD" });
    expect(exposure.AUD).toBeCloseTo((50 * 40) * AUD_RATE, 9);
  });

  it("cap breach on stale ccy still surfaces `stale_fx` — priority is invariant", () => {
    // Even if we've already filled part of the AUD cap earlier (fresh),
    // a later AUD intent whose quote turns stale must be rejected as
    // `stale_fx`, not `fx_ccy_cap`, regardless of prior exposure.
    const intents: BuyIntent[] = [
      { id: "a1", symbol: "BHP.AX", ccy: "AUD", quantity: 50, price: 40 },
    ];
    const first = runSchedule(intents, { JPY: fresh("JPY", JPY_RATE), AUD: fresh("AUD", AUD_RATE) }, caps, nowMs);
    expect(first.decisions[0].accepted).toBe(true);

    // Now attempt another AUD buy with a stale quote — should be stale_fx.
    const staleQuotes = { JPY: fresh("JPY", JPY_RATE), AUD: stale("AUD", AUD_RATE) };
    const followUp = decideBuy(
      { id: "a2", symbol: "BHP.AX", ccy: "AUD", quantity: 50, price: 40 },
      staleQuotes.AUD,
      caps,
      first.exposure,
      nowMs,
    );
    expect(followUp).toMatchObject({ accepted: false, reason: "stale_fx", ccy: "AUD" });
  });

  it("a missing cap for a currency permits any within-liquidity buy at fresh rates", () => {
    const noCaps: RiskCaps = { fx_currency_limits: {} };
    const { decisions, exposure } = runSchedule(
      [{ id: "j", symbol: "7203.T", ccy: "JPY", quantity: 10_000, price: 3_000 }],
      { JPY: fresh("JPY", JPY_RATE), AUD: fresh("AUD", AUD_RATE) },
      noCaps,
      nowMs,
    );
    expect(decisions[0].accepted).toBe(true);
    expect(exposure.JPY).toBeCloseTo((10_000 * 3_000) * JPY_RATE, 6);
  });
});
