// Portfolio diagnostics server function.
// Extracted from trading.functions.ts (Phase 3 module decoupling).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { GLOBAL_EVENTS } from "./global-events";
import {
  addBusinessDays,
  mean,
  SIGNAL_KEYS,
  type AiOrder,
  type ExecutedOrder,
} from "./diagnostics.server";

export const getDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        horizon_days: z.number().int().min(1).max(20).default(5),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    // Ownership check via RLS
    const { data: owned } = await context.supabase
      .from("portfolios")
      .select("id, starting_cash")
      .eq("id", data.portfolio_id)
      .single();
    if (!owned) throw new Error("Portfolio not found");

    const [{ data: decisions }, { data: equity }] = await Promise.all([
      context.supabase
        .from("decisions")
        .select("id, run_date, raw, portfolio_value")
        .eq("portfolio_id", data.portfolio_id)
        .order("run_date", { ascending: true }),
      context.supabase
        .from("equity_snapshots")
        .select("snapshot_date, total_value")
        .eq("portfolio_id", data.portfolio_id)
        .order("snapshot_date", { ascending: true }),
    ]);

    const decRows = (decisions ?? []) as Array<{
      id: string;
      run_date: string;
      portfolio_value: number | null;
      raw: {
        orders?: AiOrder[];
        executed?: ExecutedOrder[];
      } | null;
    }>;

    // Collect all forward-price lookups we need
    const needed = new Map<string, Set<string>>();
    for (const d of decRows) {
      const target = addBusinessDays(d.run_date, data.horizon_days);
      for (const ex of d.raw?.executed ?? []) {
        if (ex.rejected || !ex.symbol || !ex.price || !ex.side) continue;
        if (!needed.has(ex.symbol)) needed.set(ex.symbol, new Set());
        needed.get(ex.symbol)!.add(target);
      }
    }
    const symbols = [...needed.keys()];
    const priceLookup = new Map<string, Map<string, number>>();
    if (symbols.length > 0) {
      const { data: prices } = await context.supabase
        .from("price_cache")
        .select("symbol, price_date, close")
        .in("symbol", symbols)
        .order("price_date", { ascending: true });
      for (const row of prices ?? []) {
        if (!priceLookup.has(row.symbol)) priceLookup.set(row.symbol, new Map());
        priceLookup.get(row.symbol)!.set(row.price_date as string, Number(row.close));
      }
    }
    function findClose(symbol: string, targetDate: string): number | null {
      const m = priceLookup.get(symbol);
      if (!m) return null;
      if (m.has(targetDate)) return m.get(targetDate)!;
      const dates = [...m.keys()].sort();
      for (const d of dates) {
        if (d >= targetDate) return m.get(d)!;
      }
      return dates.length ? m.get(dates[dates.length - 1])! : null;
    }

    type Outcome = {
      run_date: string;
      symbol: string;
      side: "buy" | "sell";
      entryPrice: number;
      exitPrice: number;
      forwardReturn: number;
      conviction: number;
      topSignal: string;
      weights: Record<string, number>;
      win: boolean;
    };
    const outcomes: Outcome[] = [];
    let totalOrders = 0;
    let executedOrders = 0;
    let rejectedCount = 0;
    const buySellCounts = { buy: 0, sell: 0 };

    for (const d of decRows) {
      const orders = d.raw?.orders ?? [];
      const executed = d.raw?.executed ?? [];
      totalOrders += orders.length;

      const weightsByKey = new Map<string, AiOrder>();
      for (const o of orders) {
        if (o.symbol && o.side) weightsByKey.set(`${o.symbol}:${o.side}`, o);
      }

      for (const ex of executed) {
        if (!ex.symbol || !ex.side) continue;
        if (ex.rejected) {
          rejectedCount++;
          continue;
        }
        executedOrders++;
        if (ex.side === "buy") buySellCounts.buy++;
        else if (ex.side === "sell") buySellCounts.sell++;

        const target = addBusinessDays(d.run_date, data.horizon_days);
        const entry = Number(ex.price);
        const exit = findClose(ex.symbol, target);
        if (!entry || !exit) continue;
        const rawRet = (exit - entry) / entry;
        const directional = ex.side === "buy" ? rawRet : -rawRet;
        const linked = weightsByKey.get(`${ex.symbol}:${ex.side}`);
        const w = linked?.signal_weights ?? {};
        const weightVals = SIGNAL_KEYS.map((k) => Number(w[k] ?? 0));
        const topIdx = weightVals.indexOf(Math.max(...weightVals));
        const topSignal = SIGNAL_KEYS[topIdx] ?? "unknown";
        const conviction = Math.min(1, Math.max(0, (linked?.percent ?? 0) / 100));
        outcomes.push({
          run_date: d.run_date,
          symbol: ex.symbol,
          side: ex.side as "buy" | "sell",
          entryPrice: entry,
          exitPrice: exit,
          forwardReturn: directional,
          conviction,
          topSignal,
          weights: Object.fromEntries(SIGNAL_KEYS.map((k, i) => [k, weightVals[i]])),
          win: directional > 0,
        });
      }
    }

    const wins = outcomes.filter((o) => o.win).length;
    const winRate = outcomes.length ? wins / outcomes.length : 0;
    const avgForwardReturn = mean(outcomes.map((o) => o.forwardReturn));

    const buckets = [
      { label: "0-10%", min: 0, max: 0.1 },
      { label: "10-25%", min: 0.1, max: 0.25 },
      { label: "25-50%", min: 0.25, max: 0.5 },
      { label: "50-100%", min: 0.5, max: 1.01 },
    ];
    const calibration = buckets.map((b) => {
      const items = outcomes.filter((o) => o.conviction >= b.min && o.conviction < b.max);
      return {
        bucket: b.label,
        n: items.length,
        winRate: items.length ? items.filter((i) => i.win).length / items.length : 0,
        avgReturn: mean(items.map((i) => i.forwardReturn)),
      };
    });

    const perSignal = SIGNAL_KEYS.map((k) => {
      const items = outcomes.filter((o) => o.topSignal === k);
      return {
        signal: k,
        n: items.length,
        winRate: items.length ? items.filter((i) => i.win).length / items.length : 0,
        avgReturn: mean(items.map((i) => i.forwardReturn)),
      };
    });

    const equityRows = (equity ?? []).map((e) => Number(e.total_value));
    let peak = equityRows[0] ?? Number(owned.starting_cash);
    let maxDD = 0;
    for (const v of equityRows) {
      if (v > peak) peak = v;
      const dd = (v - peak) / peak;
      if (dd < maxDD) maxDD = dd;
    }
    const currentValue = equityRows[equityRows.length - 1] ?? Number(owned.starting_cash);
    const currentDD = peak > 0 ? (currentValue - peak) / peak : 0;

    const half = Math.floor(decRows.length / 2);
    const prior = decRows.slice(0, half);
    const recent = decRows.slice(half);
    function avgWeights(rows: typeof decRows) {
      const acc: Record<string, number[]> = {};
      SIGNAL_KEYS.forEach((k) => (acc[k] = []));
      for (const r of rows) {
        for (const o of r.raw?.orders ?? []) {
          const w = o.signal_weights;
          if (!w) continue;
          SIGNAL_KEYS.forEach((k) => acc[k].push(Number(w[k] ?? 0)));
        }
      }
      return Object.fromEntries(SIGNAL_KEYS.map((k) => [k, mean(acc[k])]));
    }
    const priorWeights = avgWeights(prior);
    const recentWeights = avgWeights(recent);
    const weightDrift = SIGNAL_KEYS.map((k) => ({
      signal: k,
      prior: priorWeights[k],
      recent: recentWeights[k],
      delta: recentWeights[k] - priorWeights[k],
    }));

    const priorOrdersPerDay = prior.length ? mean(prior.map((r) => (r.raw?.orders ?? []).length)) : 0;
    const recentOrdersPerDay = recent.length ? mean(recent.map((r) => (r.raw?.orders ?? []).length)) : 0;

    function buySellRatio(rows: typeof decRows) {
      let b = 0, s = 0;
      for (const r of rows)
        for (const o of r.raw?.orders ?? []) {
          if (o.side === "buy") b++;
          else if (o.side === "sell") s++;
        }
      return b + s === 0 ? 0.5 : b / (b + s);
    }
    const priorBuyRatio = buySellRatio(prior);
    const recentBuyRatio = buySellRatio(recent);

    const flags: Array<{ severity: "info" | "warn"; message: string }> = [];
    if (decRows.length < 4) {
      flags.push({
        severity: "info",
        message: `Only ${decRows.length} decision${decRows.length === 1 ? "" : "s"} recorded — run more days for reliable diagnostics.`,
      });
    }
    for (const d of weightDrift) {
      if (Math.abs(d.delta) >= 15) {
        flags.push({
          severity: "warn",
          message: `${d.signal.replace("_", " ")} weighting shifted ${d.delta > 0 ? "up" : "down"} by ${Math.abs(d.delta).toFixed(0)}pp (${d.prior.toFixed(0)}% → ${d.recent.toFixed(0)}%).`,
        });
      }
    }
    if (prior.length >= 2 && recent.length >= 2) {
      if (priorOrdersPerDay > 0 && Math.abs(recentOrdersPerDay - priorOrdersPerDay) / Math.max(priorOrdersPerDay, 0.5) >= 0.5) {
        flags.push({
          severity: "warn",
          message: `Order frequency ${recentOrdersPerDay > priorOrdersPerDay ? "up" : "down"}: ${priorOrdersPerDay.toFixed(1)} → ${recentOrdersPerDay.toFixed(1)} orders/day.`,
        });
      }
      if (Math.abs(recentBuyRatio - priorBuyRatio) >= 0.25) {
        flags.push({
          severity: "warn",
          message: `Buy/sell mix shifted: ${(priorBuyRatio * 100).toFixed(0)}% buys → ${(recentBuyRatio * 100).toFixed(0)}% buys.`,
        });
      }
    }
    if (currentDD <= -0.1) {
      flags.push({
        severity: "warn",
        message: `Currently ${(currentDD * 100).toFixed(1)}% below peak equity.`,
      });
    }
    if (outcomes.length >= 5 && winRate < 0.4) {
      flags.push({
        severity: "warn",
        message: `Win rate ${(winRate * 100).toFixed(0)}% over ${outcomes.length} trades — below the 40% floor.`,
      });
    }

    const rolling: Array<{ index: number; run_date: string; winRate: number }> = [];
    const windowSize = 5;
    for (let i = 0; i < outcomes.length; i++) {
      const from = Math.max(0, i - windowSize + 1);
      const slice = outcomes.slice(from, i + 1);
      rolling.push({
        index: i + 1,
        run_date: outcomes[i].run_date,
        winRate: slice.filter((s) => s.win).length / slice.length,
      });
    }

    type EventBucket = {
      id: string;
      label: string;
      category: string;
      severity: number;
      start: string;
      end: string;
      n: number;
      wins: number;
      avgReturn: number;
      avgConviction: number;
      weights: Record<string, number>;
      topSignal: string;
    };
    const bucketMap = new Map<string, EventBucket & { retSum: number; convSum: number; weightSums: Record<string, number> }>();
    function getBucket(key: string, meta: Omit<EventBucket, "n" | "wins" | "avgReturn" | "avgConviction" | "weights" | "topSignal">) {
      let b = bucketMap.get(key);
      if (!b) {
        b = {
          ...meta,
          n: 0,
          wins: 0,
          avgReturn: 0,
          avgConviction: 0,
          weights: {},
          topSignal: "",
          retSum: 0,
          convSum: 0,
          weightSums: {},
        };
        bucketMap.set(key, b);
      }
      return b;
    }
    for (const o of outcomes) {
      const hits = GLOBAL_EVENTS.filter((e) => o.run_date >= e.start && o.run_date <= e.end);
      const targets = hits.length
        ? hits.map((e) => ({
            key: e.id,
            meta: { id: e.id, label: e.label, category: e.category, severity: e.severity, start: e.start, end: e.end },
          }))
        : [{ key: "__calm", meta: { id: "__calm", label: "Calm periods (no major event)", category: "shock", severity: 0, start: "", end: "" } }];
      for (const t of targets) {
        const b = getBucket(t.key, t.meta);
        b.n++;
        if (o.win) b.wins++;
        b.retSum += o.forwardReturn;
        b.convSum += o.conviction;
        for (const [k, v] of Object.entries(o.weights)) {
          b.weightSums[k] = (b.weightSums[k] ?? 0) + Number(v);
        }
      }
    }
    const eventImpact = [...bucketMap.values()]
      .filter((b) => b.n >= 1)
      .map((b) => {
        const weights: Record<string, number> = {};
        let topSignal = "";
        let topVal = -1;
        for (const [k, v] of Object.entries(b.weightSums)) {
          const avg = v / b.n;
          weights[k] = avg;
          if (avg > topVal) {
            topVal = avg;
            topSignal = k;
          }
        }
        return {
          id: b.id,
          label: b.label,
          category: b.category,
          severity: b.severity,
          start: b.start,
          end: b.end,
          n: b.n,
          winRate: b.n ? b.wins / b.n : 0,
          avgReturn: b.n ? b.retSum / b.n : 0,
          avgConviction: b.n ? b.convSum / b.n : 0,
          weights,
          topSignal,
        };
      })
      .sort((a, b) => (a.id === "__calm" ? 1 : b.id === "__calm" ? -1 : b.n - a.n));

    return {
      summary: {
        decisions: decRows.length,
        totalOrders,
        executedOrders,
        rejectedCount,
        evaluatedOutcomes: outcomes.length,
        horizonDays: data.horizon_days,
        winRate,
        avgForwardReturnPct: avgForwardReturn * 100,
        maxDrawdownPct: maxDD * 100,
        currentDrawdownPct: currentDD * 100,
      },
      calibration,
      perSignal,
      weightDrift,
      behavior: {
        priorOrdersPerDay,
        recentOrdersPerDay,
        priorBuyRatio,
        recentBuyRatio,
        priorDecisions: prior.length,
        recentDecisions: recent.length,
      },
      flags,
      rolling,
      eventImpact,
    };
  });
