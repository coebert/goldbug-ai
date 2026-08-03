import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

import { InputSchema, bucket } from "./commodity-liquidity.helpers";
import type { CommodityLiquiditySymbol, CommodityLiquidityResult } from "./commodity-liquidity.helpers";
export type { CommodityLiquiditySymbol, CommodityLiquidityResult };

export const simulateCommodityLiquidity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { UNIVERSE } = await import("@/lib/universe.server");
    const { applyBuyExecution, DEFAULT_EXECUTION } = await import(
      "@/lib/execution-realism.server"
    );
    const commodities = UNIVERSE.filter((u) => u.asset_class === "commodity");
    const requested = data.symbols
      ? new Set(data.symbols.map((s) => s.toUpperCase()))
      : null;
    const universe = requested
      ? commodities.filter((u) => requested.has(u.symbol.toUpperCase()))
      : commodities;

    const symbols = universe.map((u) => u.symbol);
    const sinceDate = new Date(
      Date.now() - (data.lookbackDays + 5) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);

    const { data: priceRows, error } = await context.supabase
      .from("price_cache")
      .select("symbol, price_date, close, high, low, volume")
      .in("symbol", symbols)
      .gte("price_date", sinceDate)
      .order("price_date", { ascending: false });
    if (error) throw new Error(`price_cache read failed: ${error.message}`);

    const bySymbol = new Map<
      string,
      { price_date: string; close: number; high: number | null; low: number | null; volume: number | null }[]
    >();
    for (const r of priceRows ?? []) {
      const arr = bySymbol.get(r.symbol) ?? [];
      arr.push({
        price_date: r.price_date as string,
        close: Number(r.close),
        high: r.high == null ? null : Number(r.high),
        low: r.low == null ? null : Number(r.low),
        volume: r.volume == null ? null : Number(r.volume),
      });
      bySymbol.set(r.symbol, arr);
    }

    const staleCutoffMs = Date.now() - 7 * 86_400_000;

    const rows: CommodityLiquiditySymbol[] = universe.map((u) => {
      const notes: string[] = [];
      const bars = (bySymbol.get(u.symbol) ?? []).slice(0, data.lookbackDays);
      if (bars.length === 0) {
        return {
          symbol: u.symbol,
          name: u.name,
          ok: false,
          reason: "no price data",
          lastClose: null,
          lastDate: null,
          adv20d: null,
          spreadBpsAvg: null,
          atrPct: null,
          targetSpend: data.targetSpend,
          liquidityCapSpend: null,
          trimmed: false,
          trimFraction: 0,
          estSlippageBps: null,
          estCostPct: null,
          stale: true,
          rejectionScore: 100,
          rejectionBucket: "high",
          notes: ["no cached prices — trade would defer to broker"],
        };
      }

      const last = bars[0];
      const lastClose = last.close;
      const lastDateMs = new Date(last.price_date + "T00:00:00Z").getTime();
      const stale = lastDateMs < staleCutoffMs;
      if (stale) notes.push(`last close ${last.price_date} is stale`);

      // ADV$ = avg(close * volume) over available bars with volume.
      const dollarVols = bars
        .filter((b) => b.volume != null && b.volume > 0)
        .map((b) => b.close * (b.volume as number));
      const adv20d = dollarVols.length
        ? dollarVols.reduce((s, v) => s + v, 0) / dollarVols.length
        : null;

      // Spread proxy: mean (high-low)/close in bps.
      const spreads = bars
        .filter((b) => b.high != null && b.low != null && b.close > 0)
        .map((b) => (((b.high as number) - (b.low as number)) / b.close) * 10_000);
      const spreadBpsAvg = spreads.length
        ? spreads.reduce((s, v) => s + v, 0) / spreads.length
        : null;

      // ATR% proxy: mean daily range / close (as a fraction).
      const atrPct = spreadBpsAvg != null ? spreadBpsAvg / 10_000 : null;

      const exec = applyBuyExecution({
        requestedSpend: data.targetSpend,
        price: lastClose,
        atrPct,
        adv20d,
      });
      const trimFraction = exec.liquidityCappedSpend != null
        ? Math.max(
            0,
            Math.min(1, 1 - exec.liquidityCappedSpend / data.targetSpend),
          )
        : 0;
      const trimmed = trimFraction > 0;

      // Estimated round-trip cost as % of requestedSpend.
      // costPaid is a per-share offset from mid; approximate round-trip by 2x.
      const spend = exec.effectiveSpend || data.targetSpend;
      const oneWayCostPct = spend > 0 ? (exec.costPaid) / spend : 0;
      const estCostPct = oneWayCostPct * 2;

      const halfSpreadBps = atrPct
        ? atrPct * DEFAULT_EXECUTION.spread_atr_frac * 10_000
        : 0;
      const estSlippageBps = halfSpreadBps + DEFAULT_EXECUTION.slippage_bps;

      // Rejection score components (each 0-100, weighted mean).
      const trimScore = Math.min(100, trimFraction * 120); // 100% trim → 100
      const spreadScore = spreadBpsAvg == null
        ? 60
        : Math.min(100, (spreadBpsAvg / 200) * 100); // 200bps daily range = high
      const advScore = adv20d == null
        ? 80
        : adv20d < 250_000
          ? 100
          : adv20d < 1_000_000
            ? 70
            : adv20d < 10_000_000
              ? 30
              : 5;
      const staleScore = stale ? 100 : 0;
      const rejectionScore = Math.round(
        trimScore * 0.35 +
          spreadScore * 0.2 +
          advScore * 0.3 +
          staleScore * 0.15,
      );

      if (trimmed) {
        notes.push(
          `liquidity cap trims ${(trimFraction * 100).toFixed(0)}% of target spend`,
        );
      }
      if (adv20d != null && adv20d < 1_000_000) {
        notes.push(`thin market: ADV \$${Math.round(adv20d).toLocaleString()}`);
      }
      if (spreadBpsAvg != null && spreadBpsAvg > 150) {
        notes.push(`wide daily range ~${spreadBpsAvg.toFixed(0)}bps`);
      }

      return {
        symbol: u.symbol,
        name: u.name,
        ok: !stale && adv20d != null,
        lastClose,
        lastDate: last.price_date,
        adv20d,
        spreadBpsAvg,
        atrPct,
        targetSpend: data.targetSpend,
        liquidityCapSpend: exec.liquidityCappedSpend,
        trimmed,
        trimFraction,
        estSlippageBps,
        estCostPct,
        stale,
        rejectionScore,
        rejectionBucket: bucket(rejectionScore),
        notes,
      };
    });

    rows.sort((a, b) => b.rejectionScore - a.rejectionScore);

    return {
      targetSpend: data.targetSpend,
      lookbackDays: data.lookbackDays,
      runAt: new Date().toISOString(),
      rows,
    } satisfies CommodityLiquidityResult;
  });
