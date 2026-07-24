// Portfolio optimizer: equal-weight, inverse-vol (risk parity), and
// max-Sharpe target allocations. Extracted from trading.functions.ts (Phase 3).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  invertMatrix,
  dailyReturnsFromCloses,
  meanOf,
  normaliseWeights,
} from "./optimizer.server";

export const runPortfolioOptimizer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        extra_symbols: z.array(z.string().min(1).max(12)).max(20).default([]),
        lookback_days: z.number().int().min(30).max(504).default(126),
        max_weight_pct: z.number().min(5).max(100).default(35),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: portfolio, error: pErr } = await context.supabase
      .from("portfolios")
      .select("id,name,currency,starting_cash,risk_level,current_cash")
      .eq("id", data.portfolio_id)
      .single();
    if (pErr || !portfolio) throw new Error(pErr?.message ?? "Portfolio not found");

    const { data: holdings } = await context.supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost")
      .eq("portfolio_id", data.portfolio_id);

    const heldSymbols = (holdings ?? []).map((h) => String(h.symbol).toUpperCase());
    const universe = Array.from(
      new Set([...heldSymbols, ...data.extra_symbols.map((s) => s.toUpperCase())]),
    );

    if (universe.length < 2) {
      return {
        portfolio: { id: portfolio.id, name: portfolio.name, currency: portfolio.currency },
        universe: [],
        stats: [] as Array<{ symbol: string; mean_ann_pct: number; vol_ann_pct: number; sharpe: number; last_close: number }>,
        current: [] as Array<{ symbol: string; weight_pct: number; value: number }>,
        weights: {
          equal: [] as Array<{ symbol: string; weight_pct: number }>,
          risk_parity: [] as Array<{ symbol: string; weight_pct: number }>,
          max_sharpe: [] as Array<{ symbol: string; weight_pct: number }>,
        },
        rebalance: {
          risk_parity: [] as Array<{ symbol: string; delta_pct: number; delta_value: number }>,
          max_sharpe: [] as Array<{ symbol: string; delta_pct: number; delta_value: number }>,
        },
        total_value: Number(portfolio.current_cash ?? portfolio.starting_cash ?? 0),
        cash: Number(portfolio.current_cash ?? 0),
        empty: true,
        message: "Need at least 2 symbols (current holdings + extras) to optimise.",
      };
    }

    const { getDailyCandles } = await import("./market-data.server");
    const seriesBySym = new Map<string, number[]>();
    const lastCloseBySym = new Map<string, number>();
    await Promise.all(
      universe.map(async (s) => {
        try {
          const candles = await getDailyCandles(s, data.lookback_days + 5);
          if (candles.length >= 30) {
            seriesBySym.set(s, candles.map((c) => Number(c.close)));
            lastCloseBySym.set(s, Number(candles[candles.length - 1].close));
          }
        } catch {
          /* skip */
        }
      }),
    );

    const validSymbols = universe.filter((s) => seriesBySym.has(s));
    if (validSymbols.length < 2) {
      throw new Error("Not enough price data to optimise — need ≥ 30 trading days for at least 2 symbols.");
    }

    const returnsBySym = new Map<string, number[]>();
    let minLen = Infinity;
    for (const s of validSymbols) {
      const r = dailyReturnsFromCloses(seriesBySym.get(s)!);
      returnsBySym.set(s, r);
      minLen = Math.min(minLen, r.length);
    }
    for (const s of validSymbols) {
      const r = returnsBySym.get(s)!;
      returnsBySym.set(s, r.slice(r.length - minLen));
    }

    const n = validSymbols.length;
    const means = validSymbols.map((s) => meanOf(returnsBySym.get(s)!));
    const cov: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const ri = returnsBySym.get(validSymbols[i])!;
        const rj = returnsBySym.get(validSymbols[j])!;
        let s = 0;
        for (let k = 0; k < minLen; k++) s += (ri[k] - means[i]) * (rj[k] - means[j]);
        const v = s / Math.max(1, minLen - 1);
        cov[i][j] = v;
        cov[j][i] = v;
      }
    }
    for (let i = 0; i < n; i++) cov[i][i] += 1e-6;

    const vols = cov.map((row, i) => Math.sqrt(row[i]));

    const stats = validSymbols.map((s, i) => ({
      symbol: s,
      mean_ann_pct: Number((means[i] * 252 * 100).toFixed(2)),
      vol_ann_pct: Number((vols[i] * Math.sqrt(252) * 100).toFixed(2)),
      sharpe: vols[i] > 0 ? Number(((means[i] / vols[i]) * Math.sqrt(252)).toFixed(2)) : 0,
      last_close: lastCloseBySym.get(s) ?? 0,
    }));

    const heldByS = new Map<string, { qty: number; last: number }>();
    for (const h of holdings ?? []) {
      const sym = String(h.symbol).toUpperCase();
      const last = lastCloseBySym.get(sym) ?? 0;
      heldByS.set(sym, { qty: Number(h.quantity), last });
    }
    const heldValue = Array.from(heldByS.values()).reduce((a, b) => a + b.qty * b.last, 0);
    const cash = Number(portfolio.current_cash ?? 0);
    const totalValue = heldValue + cash;
    const investable = totalValue;
    const current = validSymbols.map((s) => {
      const h = heldByS.get(s);
      const value = h ? h.qty * h.last : 0;
      return {
        symbol: s,
        value: Number(value.toFixed(2)),
        weight_pct: totalValue > 0 ? Number(((value / totalValue) * 100).toFixed(2)) : 0,
      };
    });

    const cap = data.max_weight_pct / 100;
    const applyCap = (w: number[]): number[] => {
      let weights = [...w];
      for (let iter = 0; iter < 10; iter++) {
        let over = 0;
        const under: number[] = [];
        for (let i = 0; i < weights.length; i++) {
          if (weights[i] > cap) {
            over += weights[i] - cap;
            weights[i] = cap;
          } else {
            under.push(i);
          }
        }
        if (over < 1e-9 || under.length === 0) break;
        const underSum = under.reduce((a, i) => a + weights[i], 0);
        if (underSum <= 0) break;
        for (const i of under) weights[i] += over * (weights[i] / underSum);
      }
      return normaliseWeights(weights);
    };

    const equalW = validSymbols.map(() => 1 / n);

    const invVol = vols.map((v) => (v > 0 ? 1 / v : 0));
    const rpW = normaliseWeights(invVol);
    const rpCapped = applyCap(rpW);

    let msRaw: number[] | null = null;
    const inv = invertMatrix(cov);
    if (inv) {
      msRaw = inv.map((row) => row.reduce((sum, v, j) => sum + v * means[j], 0));
    }
    let msW: number[];
    if (msRaw && msRaw.some((x) => x > 0)) {
      msW = normaliseWeights(msRaw);
    } else {
      const fb = means.map((m, i) => (m > 0 ? m / Math.max(1e-6, cov[i][i]) : 0));
      msW = normaliseWeights(fb);
    }
    const msCapped = applyCap(msW);

    const toPct = (arr: number[]) =>
      validSymbols.map((s, i) => ({ symbol: s, weight_pct: Number((arr[i] * 100).toFixed(2)) }));

    const rebalanceFor = (targetW: number[]) =>
      validSymbols.map((s, i) => {
        const targetValue = investable * targetW[i];
        const currentValue = heldByS.get(s) ? heldByS.get(s)!.qty * heldByS.get(s)!.last : 0;
        const deltaVal = targetValue - currentValue;
        return {
          symbol: s,
          delta_pct: Number(((targetW[i] * 100) - (current.find((c) => c.symbol === s)?.weight_pct ?? 0)).toFixed(2)),
          delta_value: Number(deltaVal.toFixed(2)),
        };
      });

    return {
      portfolio: { id: portfolio.id, name: portfolio.name, currency: portfolio.currency },
      universe: validSymbols,
      stats,
      current,
      weights: {
        equal: toPct(equalW),
        risk_parity: toPct(rpCapped),
        max_sharpe: toPct(msCapped),
      },
      rebalance: {
        risk_parity: rebalanceFor(rpCapped),
        max_sharpe: rebalanceFor(msCapped),
      },
      total_value: Number(totalValue.toFixed(2)),
      cash: Number(cash.toFixed(2)),
      lookback_days: data.lookback_days,
      max_weight_pct: data.max_weight_pct,
      empty: false,
    };
  });
