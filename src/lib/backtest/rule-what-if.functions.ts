// Loader for the "what if these rules had run?" panel: pulls a recent window of
// daily bars for one instrument and replays the portfolio's current level rules
// over them.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { priceSymbolVariants } from "@/lib/price-symbol";
import { riskPresetConfig, riskPresetName } from "@/lib/risk-presets";
import type { TradeLevelRiskConfig } from "@/lib/trade-levels";
import { runRuleWhatIf, type WhatIfBar, type WhatIfResult } from "@/lib/backtest/rule-what-if";

export type RuleWhatIfResponse = {
  result: WhatIfResult | null;
  riskLevel: number;
  riskLevelName: string;
  windowDays: number;
  /** Set when there simply is not enough price history to replay. */
  reason?: string;
};

function dialLevelOf(raw: unknown, band: string | null): number {
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const n = Number(cfg["risk_level"]);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return Math.round(n);
  if (band === "conservative") return 2;
  if (band === "aggressive") return 4;
  return 3;
}

export const getRuleWhatIf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        symbol: z.string().min(1).max(32),
        windowDays: z.number().int().min(30).max(730).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<RuleWhatIfResponse> => {
    const { supabase, userId } = context;
    const windowDays = data.windowDays ?? 180;

    const p = await supabase
      .from("portfolios")
      .select("id, user_id, risk_config, risk_level")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (p.error || !p.data || p.data.user_id !== userId) throw new Error("Portfolio not found");

    const level = dialLevelOf(p.data.risk_config, p.data.risk_level ?? null);
    const stored =
      p.data.risk_config && typeof p.data.risk_config === "object" && !Array.isArray(p.data.risk_config)
        ? (p.data.risk_config as Record<string, unknown>)
        : {};
    const config = { ...riskPresetConfig(level), ...stored } as TradeLevelRiskConfig;

    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
    const variants = Array.from(new Set([data.symbol, ...priceSymbolVariants(data.symbol)]));

    const { data: rows } = await supabase
      .from("price_cache")
      .select("symbol, price_date, open, high, low, close")
      .in("symbol", variants)
      .gte("price_date", since)
      .order("price_date", { ascending: true })
      .limit(2000);

    // One symbol variant owns the history; take the best-populated one so we
    // never blend two different quote conventions (e.g. GBX vs GBP feeds).
    const byVariant = new Map<string, WhatIfBar[]>();
    for (const r of rows ?? []) {
      const close = Number((r as { close: number }).close);
      if (!Number.isFinite(close) || close <= 0) continue;
      const key = String((r as { symbol: string }).symbol);
      const list = byVariant.get(key) ?? [];
      list.push({
        date: String((r as { price_date: string }).price_date),
        open: (r as { open: number | null }).open,
        high: (r as { high: number | null }).high,
        low: (r as { low: number | null }).low,
        close,
      });
      byVariant.set(key, list);
    }
    let bars: WhatIfBar[] = [];
    for (const list of byVariant.values()) if (list.length > bars.length) bars = list;

    const base: Omit<RuleWhatIfResponse, "result" | "reason"> = {
      riskLevel: level,
      riskLevelName: riskPresetName(level),
      windowDays,
    };

    if (bars.length < 5) {
      return { ...base, result: null, reason: "Not enough stored price history for this instrument yet." };
    }

    const holding = await supabase
      .from("holdings")
      .select("quantity, avg_cost")
      .eq("portfolio_id", data.portfolioId)
      .in("symbol", variants)
      .maybeSingle();
    const notional =
      holding.data && Number(holding.data.quantity) > 0
        ? Number(holding.data.quantity) * Number(holding.data.avg_cost ?? 0)
        : null;

    const result = runRuleWhatIf({
      symbol: data.symbol,
      bars,
      config,
      ...(notional && Number.isFinite(notional) && notional > 0 ? { notional } : {}),
    });

    return result
      ? { ...base, result }
      : { ...base, result: null, reason: "The stored bars were too sparse to replay the rules." };
  });
