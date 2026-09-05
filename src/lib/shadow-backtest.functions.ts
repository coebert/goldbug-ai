// Shadow backtest for LIVE portfolios.
//
// `runBacktest` wipes holdings/trades/decisions and re-runs the engine on the
// portfolio itself. That is fine for a sim book and catastrophic for a live
// broker-linked one. This function instead clones the live portfolio into a
// throwaway `mode: "backtest"` portfolio (no broker => no order routing),
// replays the daily tick there with the REAL AI decision model (`forceAi`),
// stores the resulting equity curve as a `backtest_runs` row attached to the
// LIVE portfolio (so the backtest-vs-real card lines them up), and deletes the
// clone. The live portfolio is never mutated.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const Shape = z.object({
  portfolio_id: z.string().uuid(),
  /** Trading days to replay, ending yesterday. Ignored when full_history. */
  days: z.number().int().min(3).max(400).default(30),
  /**
   * Replay every day the book has existed (from its first equity snapshot or
   * first trade) instead of a fixed trailing window.
   */
  full_history: z.boolean().default(false),
  /** Keep the clone for inspection instead of deleting it. */
  keep_clone: z.boolean().default(false),
});
const Input = Shape.parse.bind(Shape);

function businessDaysEndingYesterday(count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  let guard = 0;
  while (dates.length < count && guard++ < 1200) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.unshift(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates;
}

function businessDaysBetween(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  let guard = 0;
  while (cursor <= end && guard++ < 3000) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}


export const runShadowBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => Input(i))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;

    const { data: live, error: liveErr } = await supabase
      .from("portfolios")
      .select(
        "id, name, currency, risk_level, universe, risk_config, hyperparams, starting_cash, mode, fx_enabled, holding_dd_budget_pct, holding_dd_autoclose, concentration_cap_pct, concentration_autotrim",
      )
      .eq("id", data.portfolio_id)
      .single();
    if (liveErr || !live) throw new Error("Portfolio not found");

    let dates = businessDaysEndingYesterday(data.days);
    if (data.full_history) {
      // Earliest day the book has any recorded life.
      const [{ data: snap0 }, { data: trade0 }] = await Promise.all([
        supabase
          .from("equity_snapshots")
          .select("snapshot_date")
          .eq("portfolio_id", data.portfolio_id)
          .order("snapshot_date", { ascending: true })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("trades")
          .select("trade_date")
          .eq("portfolio_id", data.portfolio_id)
          .order("trade_date", { ascending: true })
          .limit(1)
          .maybeSingle(),
      ]);
      const candidates = [snap0?.snapshot_date, trade0?.trade_date]
        .filter(Boolean)
        .map((d) => String(d).slice(0, 10))
        .sort();
      const start = candidates[0];
      if (start) {
        const yesterday = businessDaysEndingYesterday(1)[0]!;
        const full = businessDaysBetween(start, yesterday);
        if (full.length >= 3) dates = full;
      }
    }
    const from = dates[0]!;


    // Start the shadow book on the live book's own equity at the window start,
    // so the two curves are measured on the same money.
    const { data: firstSnap } = await supabase
      .from("equity_snapshots")
      .select("snapshot_date, total_value")
      .eq("portfolio_id", data.portfolio_id)
      .gte("snapshot_date", from)
      .order("snapshot_date", { ascending: true })
      .limit(1)
      .maybeSingle();
    const startingCash = Number(firstSnap?.total_value ?? live.starting_cash ?? 0);

    const { data: clone, error: cloneErr } = await supabase
      .from("portfolios")
      .insert({
        user_id: context.userId,
        name: `${live.name} — shadow backtest`,
        starting_cash: startingCash,
        current_cash: startingCash,
        currency: live.currency,
        risk_level: live.risk_level,
        universe: live.universe,
        risk_config: live.risk_config,
        hyperparams: live.hyperparams,
        holding_dd_budget_pct: live.holding_dd_budget_pct,
        holding_dd_autoclose: live.holding_dd_autoclose,
        concentration_cap_pct: live.concentration_cap_pct,
        concentration_autotrim: live.concentration_autotrim,
        fx_enabled: false,
        mode: "backtest",
        broker: null,
        status: "active",
      })
      .select("id")
      .single();
    if (cloneErr || !clone) throw new Error(cloneErr?.message ?? "Could not create shadow book");
    const shadowId = clone.id as string;

    const { runDailyTick, snapshotPortfolio } = await import("./trading-engine.server");
    const { getPriceOn } = await import("./market-data.server");

    // Seed the shadow book with the positions the live book actually held on the
    // first replay day, reconstructed by unwinding every trade made since then.
    // Without this the shadow starts 100% cash and the comparison is unfair.
    type Seed = {
      symbol: string;
      asset_class: "stock" | "etf" | "crypto" | "commodity" | "fx";
      quantity: number;
      avg_cost: number;
      instrument_ccy: string | null;
    };
    const seeds = new Map<string, Seed>();
    const { data: liveHoldings } = await supabase
      .from("holdings")
      .select("symbol, asset_class, quantity, avg_cost, instrument_ccy")
      .eq("portfolio_id", data.portfolio_id);
    for (const h of liveHoldings ?? []) {
      seeds.set(h.symbol as string, {
        symbol: h.symbol as string,
        asset_class: (h.asset_class ?? "stock") as Seed["asset_class"],
        quantity: Number(h.quantity ?? 0),
        avg_cost: Number(h.avg_cost ?? 0),
        instrument_ccy: (h.instrument_ccy as string | null) ?? null,
      });
    }
    const { data: laterTrades } = await supabase
      .from("trades")
      .select("symbol, side, quantity, price")
      .eq("portfolio_id", data.portfolio_id)
      .gte("trade_date", from);
    for (const t of laterTrades ?? []) {
      const sym = t.symbol as string;
      const prev = seeds.get(sym) ?? {
        symbol: sym,
        asset_class: "stock" as const,
        quantity: 0,
        avg_cost: Number(t.price ?? 0),
        instrument_ccy: null,
      };
      const delta = (t.side === "buy" ? -1 : 1) * Number(t.quantity ?? 0);
      seeds.set(sym, { ...prev, quantity: prev.quantity + delta });
    }
    const seeded = [...seeds.values()].filter((s) => s.quantity > 1e-8);

    let invested = 0;
    for (const s of seeded) {
      let px: number | null = null;
      try {
        px = await getPriceOn(s.symbol, from);
      } catch {
        px = null;
      }
      invested += s.quantity * (px ?? s.avg_cost);
    }
    const seededCash = Math.max(0, startingCash - invested);

    if (seeded.length > 0) {
      await supabase.from("holdings").insert(
        seeded.map((s) => ({
          portfolio_id: shadowId,
          symbol: s.symbol,
          asset_class: s.asset_class,
          quantity: s.quantity,
          avg_cost: s.avg_cost,
          instrument_ccy: s.instrument_ccy,
          opened_at: new Date(`${from}T00:00:00Z`).toISOString(),
        })),
      );
      await supabase.from("portfolios").update({ current_cash: seededCash }).eq("id", shadowId);
    }


    let aiDays = 0;
    let fallbackDays = 0;
    const failures: Array<{ date: string; error: string }> = [];

    try {
      for (const d of dates) {
        try {
          // forceAi: the real decision model, never the heuristic shortcut.
          await runDailyTick(shadowId, d, { skipNews: true, forceAi: true });
        } catch (err) {
          failures.push({ date: d, error: err instanceof Error ? err.message : String(err) });
          await snapshotPortfolio(shadowId, d).catch(() => {});
        }
      }

      // How often did the real model actually decide?
      const { data: decisions } = await supabase
        .from("decisions")
        .select("run_date, model, raw")
        .eq("portfolio_id", shadowId);
      for (const row of decisions ?? []) {
        const raw = (row.raw ?? {}) as Record<string, unknown>;
        const model = String(row.model ?? "").toLowerCase();
        const usedHeuristic =
          raw["ai_unavailable"] === true ||
          raw["source"] === "heuristic" ||
          raw["engine"] === "heuristic" ||
          model.includes("heuristic") ||
          model === "fallback";
        if (usedHeuristic) fallbackDays += 1;
        else aiDays += 1;
      }

      const { data: eq } = await supabase
        .from("equity_snapshots")
        .select("snapshot_date, total_value")
        .eq("portfolio_id", shadowId)
        .order("snapshot_date", { ascending: true });

      const curve = (eq ?? []).map((r) => ({
        snapshot_date: String(r.snapshot_date),
        total_value: Number(r.total_value ?? 0),
      }));

      const { data: trades } = await supabase
        .from("trades")
        .select("trade_date, side, symbol, quantity, price")
        .eq("portfolio_id", shadowId)
        .order("trade_date", { ascending: true });

      const { computeBacktestMetrics } = await import("./backtest-metrics");
      const metrics = computeBacktestMetrics(
        curve,
        (trades ?? []).map((t) => ({
          trade_date: t.trade_date as string,
          executed_at: null,
          side: t.side as "buy" | "sell",
          symbol: t.symbol as string,
          quantity: Number(t.quantity),
          price: Number(t.price),
        })),
        startingCash,
        [],
      );

      // Attach the run to the LIVE portfolio so the comparison card sees it.
      const { data: saved } = await supabase
        .from("backtest_runs")
        .insert({
          user_id: context.userId,
          portfolio_id: data.portfolio_id,
          risk_level: live.risk_level,
          days: dates.length,
          metrics: {
            ...metrics,
            shadow: true,
            ai_days: aiDays,
            fallback_days: fallbackDays,
            trades: (trades ?? []).length,
          },
          equity: curve,
          ran_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      return {
        ok: true,
        runId: (saved?.id as string | undefined) ?? null,
        shadowPortfolioId: data.keep_clone ? shadowId : null,
        from,
        to: dates[dates.length - 1]!,
        days: dates.length,
        aiDays,
        fallbackDays,
        trades: (trades ?? []).length,
        startingCash,
        finalValue: curve.length ? curve[curve.length - 1]!.total_value : startingCash,
        metrics,
        failures,
      };
    } finally {
      if (!data.keep_clone) {
        await supabase.from("holdings").delete().eq("portfolio_id", shadowId);
        await supabase.from("trades").delete().eq("portfolio_id", shadowId);
        await supabase.from("decisions").delete().eq("portfolio_id", shadowId);
        await supabase.from("equity_snapshots").delete().eq("portfolio_id", shadowId);
        await supabase.from("portfolios").delete().eq("id", shadowId);
      }
    }
  });
