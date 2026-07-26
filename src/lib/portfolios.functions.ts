// Portfolios CRUD + aggregated equity — extracted from trading.functions.ts (Phase 3).
// Kept as a thin server-function module; helpers live in ./all-portfolios-equity and
// ./snapshot-timing-mismatch. Schemas are declared inline inside .inputValidator to
// keep this file safe under the tss-serverfn-split transform.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { buildAllPortfoliosEquity } from "./all-portfolios-equity";
import {
  detectSnapshotTimingMismatches,
  logSnapshotTimingMismatches,
  type SnapshotMismatch,
  type SnapshotMismatchInput,
} from "./snapshot-timing-mismatch";

export const createPortfolio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const RiskEnum = z.enum(["conservative", "balanced", "aggressive"]);
    const AssetClassEnum = z.enum(["stock", "etf", "crypto", "commodity", "fx"]);
    return z
      .object({
        name: z.string().min(1).max(80).default("My Portfolio"),
        starting_cash: z.number().min(10).max(1_000_000).default(1000),
        currency: z.enum(["GBP", "USD", "EUR"]).default("GBP"),
        risk_level: RiskEnum.default("balanced"),
        universe: z
          .array(AssetClassEnum)
          .min(1)
          .default(["stock", "etf", "crypto", "commodity", "fx"]),
        mode: z.enum(["backtest", "paper"]).default("backtest"),
      })
      .parse(input);
  })
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("portfolios")
      .insert({
        user_id: context.userId,
        name: data.name,
        starting_cash: data.starting_cash,
        current_cash: data.starting_cash,
        currency: data.currency,
        risk_level: data.risk_level,
        universe: data.universe,
        mode: data.mode,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id };
  });

export const listPortfolios = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("portfolios")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  });

// Combined equity across all of the user's portfolios.
// Returns per-portfolio series plus a merged "total" series summing each
// portfolio's latest-known value (forward-filled) at every date on the axis.
export const getAllPortfoliosEquity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: portfolios, error } = await context.supabase
      .from("portfolios")
      .select("id,name,currency,starting_cash,current_cash,mode,created_at")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const list = portfolios ?? [];
    if (list.length === 0) {
      return {
        portfolios: [],
        series: [],
        perPortfolioSeries: {},
        currency: "GBP" as string,
        mismatches: [] as SnapshotMismatch[],
        deposits: [] as Array<{ portfolio_id: string; date: string; amount: number }>,
        brokerCurrencyByPortfolio: {} as Record<string, string>,
      };
    }

    const ids = list.map((p) => p.id);
    const { data: allEq } = await context.supabase
      .from("equity_snapshots")
      .select("portfolio_id,snapshot_date,total_value,cash")
      .in("portfolio_id", ids)
      .order("snapshot_date", { ascending: true });

    const today = new Date().toISOString().slice(0, 10);
    const built = buildAllPortfoliosEquity({
      portfolios: list,
      snapshots: allEq ?? [],
      today,
    });

    const simIds = list
      .filter((p) => p.mode !== "live_prod" && p.mode !== "live_sim")
      .map((p) => p.id);
    const liveIdsAll = list
      .filter((p) => p.mode === "live_prod" || p.mode === "live_sim")
      .map((p) => p.id);
    const deposits: Array<{ portfolio_id: string; date: string; amount: number }> = [];
    if (simIds.length > 0) {
      const { data: simEvents } = await context.supabase
        .from("sim_fund_events")
        .select("portfolio_id, amount, created_at")
        .in("portfolio_id", simIds);
      for (const e of simEvents ?? []) {
        if (!e.portfolio_id || !e.created_at) continue;
        const amt = Number(e.amount);
        if (!Number.isFinite(amt)) continue;
        deposits.push({
          portfolio_id: e.portfolio_id,
          date: String(e.created_at).slice(0, 10),
          amount: amt,
        });
      }
    }
    const brokerCurrencyByPortfolio: Record<string, string> = {};
    if (liveIdsAll.length > 0) {
      const { data: cashSyncs } = await context.supabase
        .from("live_broker_log")
        .select("portfolio_id, created_at, response, status, method")
        .in("portfolio_id", liveIdsAll)
        .eq("method", "CASH_SYNC")
        .eq("status", 200)
        .order("created_at", { ascending: false });
      const seenCcy = new Set<string>();
      for (const row of cashSyncs ?? []) {
        if (!row.portfolio_id || !row.created_at) continue;
        const resp = (row.response ?? {}) as {
          delta?: number | string;
          startingCashAdjusted?: boolean;
          currency?: string;
        };
        if (!seenCcy.has(row.portfolio_id) && typeof resp.currency === "string" && resp.currency) {
          brokerCurrencyByPortfolio[row.portfolio_id] = resp.currency.toUpperCase();
          seenCcy.add(row.portfolio_id);
        }
        if (!resp.startingCashAdjusted) continue;
        const amt = Number(resp.delta);
        if (!Number.isFinite(amt) || amt === 0) continue;
        deposits.push({
          portfolio_id: row.portfolio_id,
          date: String(row.created_at).slice(0, 10),
          amount: amt,
        });
      }
    }

    const liveIds = list.filter((p) => p.mode === "live_prod").map((p) => p.id);
    let mismatches: SnapshotMismatch[] = [];
    if (liveIds.length > 0) {
      const { data: brokerLogs } = await context.supabase
        .from("live_broker_log")
        .select("portfolio_id,created_at,response,status")
        .in("portfolio_id", liveIds)
        .eq("method", "CASH_SYNC")
        .eq("status", 200)
        .order("created_at", { ascending: false })
        .limit(50);
      const lastSyncByPortfolio = new Map<string, { at: string; cash: number }>();
      for (const row of brokerLogs ?? []) {
        if (!row.portfolio_id || !row.created_at) continue;
        if (lastSyncByPortfolio.has(row.portfolio_id)) continue;
        const resp = (row.response ?? {}) as { brokerCash?: number | string };
        const cash = Number(resp.brokerCash);
        if (!Number.isFinite(cash)) continue;
        lastSyncByPortfolio.set(row.portfolio_id, { at: row.created_at, cash });
      }
      const latestSnapByPortfolio = new Map<
        string,
        { date: string; cash: number | null; totalValue: number }
      >();
      for (const s of allEq ?? []) {
        if (!liveIds.includes(s.portfolio_id)) continue;
        const prev = latestSnapByPortfolio.get(s.portfolio_id);
        if (!prev || s.snapshot_date > prev.date) {
          const rawCash = (s as { cash?: number | string | null }).cash;
          const cash = rawCash == null ? null : Number(rawCash);
          latestSnapByPortfolio.set(s.portfolio_id, {
            date: s.snapshot_date,
            cash: cash != null && Number.isFinite(cash) ? cash : null,
            totalValue: Number(s.total_value ?? 0),
          });
        }
      }
      const inputs: SnapshotMismatchInput[] = list
        .filter((p) => p.mode === "live_prod")
        .map((p) => ({
          portfolioId: p.id,
          portfolioName: p.name,
          mode: p.mode,
          today,
          lastBrokerSync: lastSyncByPortfolio.get(p.id) ?? null,
          latestSnapshot: latestSnapByPortfolio.get(p.id) ?? null,
        }));
      mismatches = detectSnapshotTimingMismatches(inputs);
      logSnapshotTimingMismatches(mismatches);
    }

    return { ...built, mismatches, deposits, brokerCurrencyByPortfolio };
  });

export const getPortfolio = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const [
      { data: portfolio },
      { data: holdings },
      { data: trades },
      { data: decisions },
      { data: equity },
    ] = await Promise.all([
      context.supabase.from("portfolios").select("*").eq("id", data.id).single(),
      context.supabase.from("holdings").select("*").eq("portfolio_id", data.id),
      context.supabase
        .from("trades")
        .select("*")
        .eq("portfolio_id", data.id)
        .order("executed_at", { ascending: false })
        .limit(200),
      context.supabase
        .from("decisions")
        .select("*")
        .eq("portfolio_id", data.id)
        .order("run_date", { ascending: false })
        .limit(60),
      context.supabase
        .from("equity_snapshots")
        .select("*")
        .eq("portfolio_id", data.id)
        .order("snapshot_date", { ascending: true }),
    ]);
    if (!portfolio) throw new Error("Portfolio not found");

    const deposits: Array<{ date: string; amount: number }> = [];
    const mode = (portfolio as { mode?: string }).mode;
    if (mode !== "live_prod" && mode !== "live_sim") {
      const { data: simEvents } = await context.supabase
        .from("sim_fund_events")
        .select("amount, created_at")
        .eq("portfolio_id", data.id);
      for (const e of simEvents ?? []) {
        if (!e.created_at) continue;
        const amt = Number(e.amount);
        if (!Number.isFinite(amt)) continue;
        deposits.push({ date: String(e.created_at).slice(0, 10), amount: amt });
      }
    } else {
      const { data: cashSyncs } = await context.supabase
        .from("live_broker_log")
        .select("created_at, response, status, method")
        .eq("portfolio_id", data.id)
        .eq("method", "CASH_SYNC")
        .eq("status", 200);
      for (const row of cashSyncs ?? []) {
        if (!row.created_at) continue;
        const resp = (row.response ?? {}) as {
          delta?: number | string;
          startingCashAdjusted?: boolean;
        };
        if (!resp.startingCashAdjusted) continue;
        const amt = Number(resp.delta);
        if (!Number.isFinite(amt) || amt === 0) continue;
        deposits.push({ date: String(row.created_at).slice(0, 10), amount: amt });
      }
    }

    return {
      portfolio,
      holdings: holdings ?? [],
      trades: trades ?? [],
      decisions: decisions ?? [],
      equity: equity ?? [],
      deposits,
    };
  });

export const deletePortfolio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("portfolios").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const renamePortfolio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1, "Name required").max(80, "Max 80 characters"),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("portfolios")
      .update({ name: data.name })
      .eq("id", data.id)
      .select("id, name")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true, portfolio: row };
  });
