// Risk simulator: shows how each risk-level preset would shape the next
// tick's FX intent compilation — turnover caps, tilt exposure headroom,
// min-notional rejections, and per-currency single-tick limits.
//
// Read-only preview: no DB writes, no broker calls. Uses the same
// compileFxIntents as the live tick, run against the most recent decision's
// raw intents (or an empty set when none are available).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  compileFxIntents,
  GUARDRAIL_PRESETS,
  presetForRiskLevel,
  type FxIntent,
  type RiskLevelKey,
} from "./fx-intents";

type PresetResult = {
  key: RiskLevelKey;
  guardrails: {
    maxTurnoverPctOfNav: number;
    minNotionalBase: number;
    maxTiltExposurePctOfNav: number;
    perCurrencyMaxPct: number;
  };
  caps: {
    turnoverBase: number;
    tiltCapBase: number;
    tiltRemainingBase: number;
  };
  results: {
    total: number;
    allowed: number;
    skipped: number;
    minNotionalRejects: number;
    turnoverTrimmed: number;
    tiltTrimmed: number;
    perCurrencyTrimmed: number;
    totalNotionalBase: number;
    unusedTurnoverBase: number;
  };
};

export type RiskSimulatorResult = {
  baseCcy: string;
  navBase: number;
  currentRiskLevel: string;
  intentsSource: "last-decision" | "synthetic-empty";
  intentSampleCount: number;
  currentNonBaseExposureBase: number;
  presets: PresetResult[];
};

const KEYS: RiskLevelKey[] = ["conservative", "balanced", "aggressive"];

export const simulateRiskGuardrails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(i),
  )
  .handler(async ({ data, context }): Promise<RiskSimulatorResult> => {
    const { supabase } = context;

    const { data: p, error } = await supabase
      .from("portfolios")
      .select(
        "id, currency, current_cash, cash_by_ccy, fx_enabled, risk_level",
      )
      .eq("id", data.portfolioId)
      .single();
    if (error || !p) throw new Error(error?.message ?? "Portfolio not found");

    const baseCcy = String(p.currency ?? "GBP").toUpperCase();

    // Wallet from portfolio.
    const { readWallet } = await import("./portfolio-wallet");
    const rawCashByCcy =
      p.cash_by_ccy && typeof p.cash_by_ccy === "object" && !Array.isArray(p.cash_by_ccy)
        ? (p.cash_by_ccy as Record<string, number>)
        : null;
    const wallet = readWallet({
      currency: p.currency,
      current_cash: p.current_cash,
      cash_by_ccy: rawCashByCcy,
    });

    // Holdings for exposure by currency (in base).
    const { data: hs } = await supabase
      .from("holdings")
      .select("symbol, quantity")
      .eq("portfolio_id", data.portfolioId);
    const holdings = (hs ?? []).map((h) => ({
      symbol: String(h.symbol),
      quantity: Number(h.quantity ?? 0),
    }));
    const symbols = Array.from(new Set(holdings.map((h) => h.symbol)));
    const priceMap = new Map<string, number>();
    if (symbols.length > 0) {
      const { data: pc } = await supabase
        .from("price_cache")
        .select("symbol, close, price_date")
        .in("symbol", symbols)
        .order("price_date", { ascending: false })
        .limit(symbols.length * 8);
      for (const r of pc ?? []) {
        if (!priceMap.has(r.symbol)) priceMap.set(r.symbol, Number(r.close));
      }
    }

    const { inferSymbolCurrency } = await import("./ai-fx-conversions.server");
    const exposureNative: Record<string, number> = {};
    for (const h of holdings) {
      const ccy = inferSymbolCurrency(h.symbol, baseCcy);
      const price = priceMap.get(h.symbol) ?? 0;
      exposureNative[ccy] = (exposureNative[ccy] ?? 0) + price * h.quantity;
    }

    // FX matrix for exposure→base and ratesToBase.
    const { getFxMatrix } = await import("./fx.server");
    const nonBase = Array.from(
      new Set([
        ...Object.keys(wallet).filter((c) => c !== baseCcy),
        ...Object.keys(exposureNative).filter((c) => c !== baseCcy),
      ]),
    );
    const pairs = nonBase.flatMap((c) => [
      { from: c, to: baseCcy },
      { from: baseCcy, to: c },
    ]);
    let matrix: Awaited<ReturnType<typeof getFxMatrix>> = new Map();
    try {
      matrix = await getFxMatrix(pairs);
    } catch {
      matrix = new Map();
    }
    const ratesToBase: Record<string, number> = { [baseCcy]: 1 };
    for (const c of nonBase) {
      const q = matrix.get(`${c}${baseCcy}`);
      if (q && Number.isFinite(q.rate)) ratesToBase[c] = q.rate;
    }
    const exposureBase: Record<string, number> = {};
    for (const [ccy, native] of Object.entries(exposureNative)) {
      const r = ratesToBase[ccy] ?? (ccy === baseCcy ? 1 : 0);
      exposureBase[ccy] = native * r;
    }
    const walletBase: Record<string, number> = {};
    for (const [ccy, native] of Object.entries(wallet)) {
      const r = ratesToBase[ccy] ?? (ccy === baseCcy ? 1 : 0);
      walletBase[ccy] = native * r;
    }
    const navBase =
      Object.values(walletBase).reduce((a, v) => a + v, 0) +
      Object.values(exposureBase).reduce((a, v) => a + v, 0);
    const currentNonBaseExposureBase = Object.entries(exposureBase)
      .filter(([c]) => c !== baseCcy)
      .reduce((a, [, v]) => a + v, 0);

    // Sample intents: most recent decision.raw.ai_fx.intents_compiled.
    const { data: dr } = await supabase
      .from("decisions")
      .select("raw")
      .eq("portfolio_id", data.portfolioId)
      .order("created_at", { ascending: false })
      .limit(15);
    let intents: FxIntent[] = [];
    for (const row of dr ?? []) {
      const raw = row.raw as Record<string, unknown> | null;
      const g = (raw?.guardrails ?? {}) as Record<string, unknown>;
      const aiFx = g.ai_fx as
        | { intents_compiled?: Array<{ intent: FxIntent }> }
        | null
        | undefined;
      const list = aiFx?.intents_compiled ?? [];
      if (list.length > 0) {
        intents = list.map((c) => c.intent);
        break;
      }
    }
    const intentsSource: RiskSimulatorResult["intentsSource"] =
      intents.length > 0 ? "last-decision" : "synthetic-empty";

    const presets: PresetResult[] = KEYS.map((key) => {
      const g = presetForRiskLevel(key, navBase);
      const compiled = compileFxIntents(intents, {
        baseCcy,
        wallet,
        exposureBase,
        ratesToBase,
        guardrails: g,
      });
      const turnoverBase = (g.maxTurnoverPctOfNav / 100) * navBase;
      const tiltCapBase = (g.maxTiltExposurePctOfNav / 100) * navBase;
      const tiltRemainingBase = Math.max(0, tiltCapBase - currentNonBaseExposureBase);
      let minNotionalRejects = 0;
      let turnoverTrimmed = 0;
      let tiltTrimmed = 0;
      let perCurrencyTrimmed = 0;
      let allowed = 0;
      let totalNotionalBase = 0;
      for (const c of compiled) {
        if (c.order) {
          allowed += 1;
          totalNotionalBase += c.notionalBase;
        }
        const s = c.skipped ?? "";
        if (!s) continue;
        if (/min notional/i.test(s)) minNotionalRejects += 1;
        else if (/turnover/i.test(s)) turnoverTrimmed += 1;
        else if (/tilt/i.test(s)) tiltTrimmed += 1;
        else if (/per[- ]currency/i.test(s)) perCurrencyTrimmed += 1;
      }
      return {
        key,
        guardrails: {
          maxTurnoverPctOfNav: GUARDRAIL_PRESETS[key].maxTurnoverPctOfNav,
          minNotionalBase: GUARDRAIL_PRESETS[key].minNotionalBase,
          maxTiltExposurePctOfNav: GUARDRAIL_PRESETS[key].maxTiltExposurePctOfNav,
          perCurrencyMaxPct: GUARDRAIL_PRESETS[key].perCurrencyMaxPct,
        },
        caps: {
          turnoverBase,
          tiltCapBase,
          tiltRemainingBase,
        },
        results: {
          total: compiled.length,
          allowed,
          skipped: compiled.length - allowed,
          minNotionalRejects,
          turnoverTrimmed,
          tiltTrimmed,
          perCurrencyTrimmed,
          totalNotionalBase,
          unusedTurnoverBase: Math.max(0, turnoverBase - totalNotionalBase),
        },
      };
    });

    return {
      baseCcy,
      navBase,
      currentRiskLevel: String(p.risk_level ?? "balanced"),
      intentsSource,
      intentSampleCount: intents.length,
      currentNonBaseExposureBase,
      presets,
    };
  });
