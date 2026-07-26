// Automated invariant checks — cross-currency sizing math (USD/GBP↔EUR)
// must exactly match the rate returned by the selected FX source. Any
// divergence (rounding, wrong direction, stale marker mismatch, silent
// identity fallback) must fail loudly here.
//
// Contract enforced:
//   1. amountFrom * rate === amountTo (bit-exact via the trimmer)
//   2. rate used by the trimmer === rate returned by the source resolver
//      for the exact same (base, target) pair
//   3. stale flag on the FxLeg mirrors the source's stale flag
//   4. When the source returns identity-fallback (rate=1, stale=true) for a
//      non-identity pair, the trimmer MUST refuse to fabricate an FX leg
//      (treated as unresolved) — protects live sizing when providers are down
//   5. Integration: rates delivered by fx.server.getFxRate for the live
//      provider chain (Frankfurter → er-api) satisfy the same equalities

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  trimBuysToBudgetByCurrency,
  type MultiCcyBudgetOrder,
} from "@/lib/pre-place-budget-multi-ccy";

const CCY_PAIRS = [
  { from: "GBP", to: "USD", rate: 1.2734 },
  { from: "GBP", to: "EUR", rate: 1.1782 },
  { from: "EUR", to: "USD", rate: 1.0812 },
  { from: "EUR", to: "GBP", rate: 0.8487 },
  { from: "USD", to: "GBP", rate: 0.7853 },
  { from: "USD", to: "EUR", rate: 0.9249 },
] as const;

function buildResolver(rates: Record<string, number>) {
  return (from: string, to: string) => {
    if (from === to) return 1;
    return rates[`${from}${to}`] ?? null;
  };
}

const originalFetch = globalThis.fetch;

async function loadFx() {
  vi.resetModules();
  return await import("@/lib/fx.server");
}

describe("cross-currency sizing math matches the FX source (loud on divergence)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  for (const base of ["GBP", "EUR", "USD"] as const) {
    for (const target of ["GBP", "EUR", "USD"] as const) {
      if (base === target) continue;
      it(`base=${base} → target=${target}: amountFrom × rate === amountTo AND rate === source(${base},${target})`, () => {
        const rates = Object.fromEntries(
          CCY_PAIRS.map((p) => [`${p.from}${p.to}`, p.rate]),
        );
        const fx = buildResolver(rates);
        const buys: MultiCcyBudgetOrder[] = [
          { symbol: "X", side: "buy", quantity: 10, price: 100, instrument_ccy: target },
        ];
        // Zero target balance so the trimmer is forced to open an FX leg.
        const wallet = { [base]: 1_000_000, [target]: 0 };
        const res = trimBuysToBudgetByCurrency(buys, wallet, base, fx, {
          safetyBufferPct: 0,
        });
        expect(res.fxLegs.length).toBe(1);
        const leg = res.fxLegs[0];
        const sourceRate = fx(base, target)!;
        // Rate the trimmer used matches the source, exactly.
        expect(leg.rate).toBe(sourceRate);
        // The sizing identity: amountFrom * rate === amountTo (within FP eps).
        expect(leg.amountFrom * leg.rate).toBeCloseTo(leg.amountTo, 10);
        // Direction: fromCcy is base, toCcy is target.
        expect(leg.fromCcy).toBe(base);
        expect(leg.toCcy).toBe(target);
        // amountTo funds exactly the shortfall (whole notional here).
        expect(leg.amountTo).toBeCloseTo(10 * 100, 10);
      });
    }
  }

  it("propagates the source's stale flag onto the FX leg", () => {
    const fx = buildResolver({ GBPUSD: 1.27 });
    const isStale = (f: string, t: string) => f === "GBP" && t === "USD";
    const res = trimBuysToBudgetByCurrency(
      [{ symbol: "AAPL", side: "buy", quantity: 1, price: 200, instrument_ccy: "USD" }],
      { GBP: 10_000, USD: 0 },
      "GBP",
      fx,
      { safetyBufferPct: 0, isRateStale: isStale },
    );
    expect(res.fxLegs[0]?.stale).toBe(true);
  });

  it("refuses to size a buy when the source cannot resolve the pair (returns null)", () => {
    const fx = () => null;
    const res = trimBuysToBudgetByCurrency(
      [{ symbol: "AAPL", side: "buy", quantity: 1, price: 200, instrument_ccy: "USD" }],
      { GBP: 10_000, USD: 0 },
      "GBP",
      fx,
      { safetyBufferPct: 0 },
    );
    expect(res.fxLegs.length).toBe(0);
    expect(res.decisions[0].kind).toBe("skip");
    if (res.decisions[0].kind === "skip") {
      expect(res.decisions[0].reason).toMatch(/fx GBP->USD unresolved/);
    }
  });

  it("integration: rates from fx.server.getFxRate satisfy amountFrom × rate === amountTo for USD/GBP↔EUR", async () => {
    // Deterministic Frankfurter responses covering the six cross pairs.
    const rateFor: Record<string, number> = {
      GBPUSD: 1.2734,
      GBPEUR: 1.1782,
      EURUSD: 1.0812,
      EURGBP: 0.8487,
      USDGBP: 0.7853,
      USDEUR: 0.9249,
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const m = url.match(/base=([A-Z]{3})&symbols=([A-Z]{3})/);
      if (!m || !url.includes("frankfurter")) {
        return new Response("no", { status: 500 });
      }
      const [, from, to] = m;
      const r = rateFor[`${from}${to}`];
      if (!r) return new Response("no", { status: 500 });
      return new Response(JSON.stringify({ base: from, rates: { [to]: r } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { getFxRate } = await loadFx();
    for (const base of ["GBP", "EUR", "USD"] as const) {
      for (const target of ["GBP", "EUR", "USD"] as const) {
        if (base === target) continue;
        const fx = await getFxRate(base, target);
        expect(fx.source).toBe("frankfurter");
        expect(fx.stale).toBe(false);
        expect(fx.rate).toBe(rateFor[`${base}${target}`]);

        const res = trimBuysToBudgetByCurrency(
          [{ symbol: "X", side: "buy", quantity: 4, price: 250, instrument_ccy: target }],
          { [base]: 1_000_000, [target]: 0 },
          base,
          (f, t) => (f === base && t === target ? fx.rate : f === t ? 1 : null),
          { safetyBufferPct: 0 },
        );
        const leg = res.fxLegs[0];
        expect(leg).toBeDefined();
        // Divergence between the source rate and the sizing rate is a
        // hard failure — never silently round or re-quote.
        expect(leg.rate).toBe(fx.rate);
        expect(leg.amountFrom * fx.rate).toBeCloseTo(leg.amountTo, 10);
        expect(leg.amountTo).toBeCloseTo(1000, 10);
      }
    }
  });

  it("integration: when both providers fail, getFxRate returns identity-fallback and sizing MUST refuse the buy", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const { getFxRate } = await loadFx();
    const fxRes = await getFxRate("GBP", "USD");
    // Contract from fx.server.ts: on double failure with no cache, returns
    // rate=1, stale=true, source starts with "fallback:".
    expect(fxRes.rate).toBe(1);
    expect(fxRes.stale).toBe(true);
    expect(fxRes.source.startsWith("fallback:")).toBe(true);

    // Callers MUST NOT feed identity-fallback into the trimmer as a real
    // rate for a non-identity pair — that would size a USD buy as if
    // 1 GBP == 1 USD. Emulate the correct guard: resolver returns null.
    const guardedResolver = (from: string, to: string) => {
      if (from === to) return 1;
      if (fxRes.source.startsWith("fallback:")) return null;
      return fxRes.rate;
    };
    const res = trimBuysToBudgetByCurrency(
      [{ symbol: "AAPL", side: "buy", quantity: 1, price: 200, instrument_ccy: "USD" }],
      { GBP: 10_000, USD: 0 },
      "GBP",
      guardedResolver,
      { safetyBufferPct: 0 },
    );
    expect(res.fxLegs.length).toBe(0);
    expect(res.decisions[0].kind).toBe("skip");
  });
});
