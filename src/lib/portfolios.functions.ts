// Portfolios CRUD + aggregated equity — extracted from trading.functions.ts (Phase 3).
// Kept as a thin server-function module; helpers live in ./all-portfolios-equity and
// ./snapshot-timing-mismatch. Schemas are declared inline inside .inputValidator to
// keep this file safe under the tss-serverfn-split transform.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAal2 } from "@/lib/_server/require-aal2";
import { z } from "zod";
import { buildAllPortfoliosEquity } from "./all-portfolios-equity";
import { backfillMissingEquitySnapshots } from "./equity-snapshot-backfill.server";
import {
  clipToInception,
  firstHoldingsDate,
  portfolioInceptionDate,
  seriesStartDate,
} from "./portfolio-inception";
import { deletePortfolioWithCleanup } from "./portfolio-delete-cleanup";
import { reanchorInferredInflow, trustedPreviousStarting } from "./infer-cash-flow";

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
      .select("id,name,currency,starting_cash,current_cash,mode,created_at,live_activated_at")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const list = portfolios ?? [];
    if (list.length === 0) {
      return {
        portfolios: [],
        series: [],
        perPortfolioSeries: {},
        currency: "GBP" as string,
        mixedCurrency: false,
        currencies: [] as string[],
        mismatches: [] as SnapshotMismatch[],
        deposits: [] as Array<{ portfolio_id: string; date: string; amount: number }>,
        brokerCurrencyByPortfolio: {} as Record<string, string>,
        holdingsByPortfolio: {} as Record<
          string,
          Array<{ symbol: string; quantity: number; avg_cost: number; asset_class: string | null }>
        >,
      };
    }

    const ids = list.map((p) => p.id);

    // Self-healing step: write any missing snapshot rows (today's
    // mark-to-market plus carry-forward gap fill) before reading, so cards
    // never render an empty state or fall back to raw cash. Idempotent upsert;
    // failures are swallowed and simply leave the existing data untouched.
    await backfillMissingEquitySnapshots(context.supabase as never, list);

    const { data: allEq } = await context.supabase
      .from("equity_snapshots")
      .select("portfolio_id,snapshot_date,total_value,cash")
      .in("portfolio_id", ids)
      .order("snapshot_date", { ascending: true });

    // Snapshots dated before a portfolio existed (seeded/backtest rows, or a
    // broker account's pre-existing history pulled in on first sync) are not
    // that portfolio's performance — clip them off every series. Clipping is
    // per portfolio and non-destructive: a portfolio whose whole history
    // predates its row keeps its rows (see clipToInception).
    const inceptionById = new Map(list.map((p) => [p.id, portfolioInceptionDate(p)]));
    const byPid = new Map<string, typeof allEq>();
    for (const s of allEq ?? []) {
      const pid = String(s.portfolio_id);
      const arr = byPid.get(pid) ?? [];
      arr!.push(s);
      byPid.set(pid, arr);
    }
    const clippedEq = [...byPid.entries()].flatMap(([pid, rows]) =>
      clipToInception(rows ?? [], inceptionById.get(pid) ?? null, (r) =>
        String(r.snapshot_date).slice(0, 10),
      ),
    );

    const today = new Date().toISOString().slice(0, 10);
    const built = buildAllPortfoliosEquity({
      portfolios: list,
      snapshots: clippedEq,
      today,
    });

    // Include live_sim portfolios: they are funded via sim_fund_events
    // (Saxo demo top-ups), not real broker deposits, so their deposits
    // must be netted out of range % change just like pure sim modes.
    const simIds = list
      .filter((p) => p.mode !== "live_prod")
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
          newStarting?: number | string;
          previousStarting?: number | string;
        };
        if (!seenCcy.has(row.portfolio_id) && typeof resp.currency === "string" && resp.currency) {
          brokerCurrencyByPortfolio[row.portfolio_id] = resp.currency.toUpperCase();
          seenCcy.add(row.portfolio_id);
        }
        if (!resp.startingCashAdjusted) continue;
        // Defensive: older log rows set startingCashAdjusted=true even when
        // the monotonic clamp left starting_cash unchanged (negative drift).
        // Trust the row only if the baseline actually moved.
        const prevStart = trustedPreviousStarting(resp.previousStarting) ?? Number.NaN;
        const newStart = Number(resp.newStarting);
        if (
          Number.isFinite(prevStart) &&
          Number.isFinite(newStart) &&
          prevStart === newStart
        ) {
          continue;
        }
        const amt = Number(resp.delta);
        if (!Number.isFinite(amt) || amt === 0) continue;
        const raw = {
          date: String(row.created_at).slice(0, 10),
          amount: amt,
        };
        // No known prior baseline → the delta is a starting_cash repair,
        // not measured cash movement. Re-anchor it onto the equity step
        // the portfolio actually shows so the card doesn't net out money
        // that never arrived (see src/lib/infer-cash-flow.ts).
        const trusted = Number.isFinite(prevStart);
        const flow = trusted
          ? raw
          : reanchorInferredInflow(
              raw,
              (built.perPortfolioSeries?.[row.portfolio_id] ?? []) as Array<{
                date: string;
                value: number;
              }>,
            );
        if (!flow) continue;
        deposits.push({
          portfolio_id: row.portfolio_id,
          date: flow.date,
          amount: flow.amount,
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
        .in("method", ["CASH_SYNC", "HOLDINGS_SYNC"])
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

    const { data: allHoldings } = await context.supabase
      .from("holdings")
      .select("portfolio_id,symbol,quantity,avg_cost,asset_class")
      .in("portfolio_id", ids);
    const holdingsByPortfolio: Record<
      string,
      Array<{ symbol: string; quantity: number; avg_cost: number; asset_class: string | null }>
    > = {};
    for (const h of allHoldings ?? []) {
      if (!h.portfolio_id || !h.symbol) continue;
      const qty = Number(h.quantity);
      const avg = Number(h.avg_cost);
      if (!Number.isFinite(qty) || qty === 0) continue;
      (holdingsByPortfolio[h.portfolio_id] ??= []).push({
        symbol: h.symbol,
        quantity: qty,
        avg_cost: Number.isFinite(avg) ? avg : 0,
        asset_class: (h as { asset_class?: string | null }).asset_class ?? null,
      });
    }

    return { ...built, mismatches, deposits, brokerCurrencyByPortfolio, holdingsByPortfolio };
  });

export const getPortfolio = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    // Heal missing snapshots for this portfolio before reading it.
    const { data: pfRow } = await context.supabase
      .from("portfolios")
      .select("id,current_cash,currency,created_at,live_activated_at")
      .eq("id", data.id)
      .maybeSingle();
    if (pfRow) await backfillMissingEquitySnapshots(context.supabase as never, [pfRow as never]);

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
    let brokerCurrency: string | null = null;
    // Deposits that were folded into `portfolios.starting_cash` when they were
    // detected (live cash syncs bump the starting pot). Those must be removed
    // from the baseline before re-adding them on their own date, otherwise the
    // contributed capital — and any passive benchmark built from it — is
    // double-counted.
    let startingCashAbsorbed = 0;
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
        .eq("status", 200)
        .order("created_at", { ascending: false });
      const ownSeries = (equity ?? []).map((r) => ({
        date: String((r as { snapshot_date?: unknown }).snapshot_date ?? ""),
        value: Number((r as { total_value?: unknown }).total_value ?? Number.NaN),
      }));
      for (const row of cashSyncs ?? []) {
        if (!row.created_at) continue;
        const resp = (row.response ?? {}) as {
          delta?: number | string;
          startingCashAdjusted?: boolean;
          currency?: string;
          previousStarting?: number | string;
        };
        if (!brokerCurrency && typeof resp.currency === "string" && resp.currency) {
          brokerCurrency = resp.currency.toUpperCase();
        }
        if (!resp.startingCashAdjusted) continue;
        const amt = Number(resp.delta);
        if (!Number.isFinite(amt) || amt === 0) continue;
        const raw = { date: String(row.created_at).slice(0, 10), amount: amt };
        // Same rule as the home-page list: a sync with no known prior
        // baseline is a starting_cash repair, so re-anchor it onto the
        // equity step the portfolio actually shows.
        const flow = trustedPreviousStarting(resp.previousStarting) !== null
          ? raw
          : reanchorInferredInflow(raw, ownSeries);
        if (!flow) continue;
        deposits.push(flow);
        startingCashAbsorbed += flow.amount;
      }
    }


    const startingCash = Number(
      (portfolio as { starting_cash?: number | string }).starting_cash ?? 0,
    );
    const baselineStartingCash = Number.isFinite(startingCash)
      ? startingCash - startingCashAbsorbed
      : startingCash;

    // Clip pre-inception snapshots: history that predates the portfolio (or,
    // for live portfolios, the day it went live) is not its performance.
    const inceptionDate = portfolioInceptionDate(portfolio as never);
    const clippedEquity = clipToInception(equity ?? [], inceptionDate, (r) =>
      String((r as { snapshot_date?: unknown }).snapshot_date ?? ""),
    );

    // The honest start of the series: the first day a position actually
    // existed (backtest/broker-imported accounts can be created earlier).
    const firstHoldings = firstHoldingsDate(
      (holdings ?? []) as never,
      (trades ?? []) as never,
    );
    const seriesStart = seriesStartDate(inceptionDate, firstHoldings);

    return {
      portfolio,
      holdings: holdings ?? [],
      trades: trades ?? [],
      decisions: decisions ?? [],
      equity: clippedEquity,
      inceptionDate,
      firstHoldingsDate: firstHoldings,
      seriesStartDate: seriesStart,
      deposits,
      // starting_cash with any already-absorbed deposits stripped out, so
      // `baselineStartingCash + deposits === starting_cash`.
      baselineStartingCash,
      brokerCurrency,
    };

  });

export const deletePortfolio = createServerFn({ method: "POST" })
  .middleware([requireAal2])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    // Releases the broker-account claim before removing the row, so the account
    // can be linked to another portfolio afterwards.
    return await deletePortfolioWithCleanup(context.supabase as never, data.id);
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
