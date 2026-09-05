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
      .select("snapshot_date, total_value, cash")
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
    // Live holdings are broker-native (`VWRL:xlon`) while trades are recorded on
    // universe symbols (`VWRL.L`), so both sides must be keyed the same way or the
    // unwind cancels positions against the wrong ledger.
    const { engineSymbolKey } = await import("./price-symbol");
    const seeds = new Map<string, Seed>();
    const { data: liveHoldings } = await supabase
      .from("holdings")
      .select("symbol, asset_class, quantity, avg_cost, instrument_ccy")
      .eq("portfolio_id", data.portfolio_id);
    for (const h of liveHoldings ?? []) {
      const key = engineSymbolKey(h.symbol as string);
      seeds.set(key, {
        symbol: h.symbol as string,
        asset_class: (h.asset_class ?? "stock") as Seed["asset_class"],
        quantity: Number(h.quantity ?? 0),
        avg_cost: Number(h.avg_cost ?? 0),
        instrument_ccy: (h.instrument_ccy as string | null) ?? null,
      });
    }
    // Walk the ledger BACKWARDS from today, clamping at zero after each step.
    // A plain net-sum goes negative whenever a name was held at the start, sold,
    // and later re-bought bigger — which is most of this book.
    const { data: laterTrades } = await supabase
      .from("trades")
      .select("symbol, side, quantity, price, trade_date")
      .eq("portfolio_id", data.portfolio_id)
      .gte("trade_date", from)
      .order("trade_date", { ascending: false });
    for (const t of laterTrades ?? []) {
      const sym = t.symbol as string;
      const key = engineSymbolKey(sym);
      const prev = seeds.get(key) ?? {
        symbol: sym,
        asset_class: "stock" as const,
        quantity: 0,
        avg_cost: Number(t.price ?? 0),
        instrument_ccy: null,
      };
      const delta = (t.side === "buy" ? -1 : 1) * Number(t.quantity ?? 0);
      seeds.set(key, { ...prev, quantity: Math.max(0, prev.quantity + delta) });
    }
    const candidates = [...seeds.values()].filter((s) => s.quantity > 1e-8);
    const seedNotes: string[] = [
      `reconstructed ${candidates.length} of ${seeds.size} names`,
    ];

    // Only seed what the engine can actually price on the start day; anything it
    // cannot value would silently vanish from equity, so hold it as cash instead.
    const seeded: Seed[] = [];
    let invested = 0;
    for (const s of candidates) {
      let px: number | null = null;
      try {
        px = await getPriceOn(s.symbol, from);
      } catch {
        px = null;
      }
      if (px == null || !Number.isFinite(px) || px <= 0) {
        seedNotes.push(`${s.symbol}: no price on ${from}`);
        continue;
      }
      seeded.push(s);
      invested += s.quantity * px;
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
          instrument_ccy: s.instrument_ccy ?? undefined,
          opened_at: new Date(`${from}T00:00:00Z`).toISOString(),
        })),
      );
    }
    await supabase.from("portfolios").update({ current_cash: seededCash }).eq("id", shadowId);


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
      let ordersProposed = 0;
      let ordersExecuted = 0;
      let candidatesSeen = 0;
      let universeSeen = 0;
      let daysWithCandidates = 0;
      const rejectReasons = new Map<string, number>();
      const budgetNotes = new Map<string, number>();
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
        const orders = Array.isArray(raw["orders"]) ? (raw["orders"] as unknown[]) : [];
        const executed = Array.isArray(raw["executed"]) ? (raw["executed"] as unknown[]) : [];
        ordersProposed += orders.length;
        ordersExecuted += executed.length;
        // Affordability/universe context explains a "no candidates" silence,
        // which looks identical to the AI simply choosing to hold.
        const aff = (raw["affordability"] ?? {}) as Record<string, unknown>;
        const kept = Number(aff["candidates_kept"] ?? 0);
        candidatesSeen += Number.isFinite(kept) ? kept : 0;
        universeSeen = Math.max(universeSeen, Number(aff["universe_total"] ?? 0) || 0);
        if (kept > 0) daysWithCandidates += 1;
        const notes = Array.isArray(aff["notes"]) ? (aff["notes"] as unknown[]) : [];
        for (const n of notes) {
          if (typeof n === "string" && n.trim()) {
            const k = n.slice(0, 120);
            budgetNotes.set(k, (budgetNotes.get(k) ?? 0) + 1);
          }
        }
        for (const e of executed) {
          const rec = e as Record<string, unknown>;
          const why = rec["rejected"] ?? rec["reason"];
          if (typeof why === "string" && why.trim()) {
            const k = why.slice(0, 120);
            rejectReasons.set(k, (rejectReasons.get(k) ?? 0) + 1);
          }
        }
      }
      const topOf = (m: Map<string, number>) =>
        [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([reason, count]) => ({ reason, count }));
      const diagnostics = {
        ai_days: aiDays,
        fallback_days: fallbackDays,
        orders_proposed: ordersProposed,
        orders_executed: ordersExecuted,
        seeded_positions: seeded.length,
        seeded_cash: Math.round(seededCash * 100) / 100,
        seed_notes: seedNotes.slice(0, 12),
        universe_total: universeSeen,
        candidates_total: candidatesSeen,
        days_with_candidates: daysWithCandidates,
        budget_notes: topOf(budgetNotes),
        reject_reasons: topOf(rejectReasons),
        errors: failures.slice(0, 5),
      };

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

      // The clone is deleted below, so the actual sizes the engine dealt in
      // only survive if we store them on the run itself.
      const tradeLog = (trades ?? []).map((t) => ({
        trade_date: String(t.trade_date),
        side: t.side as "buy" | "sell",
        symbol: String(t.symbol),
        quantity: Number(t.quantity ?? 0),
        price: Number(t.price ?? 0),
        value: Number(t.quantity ?? 0) * Number(t.price ?? 0),
      }));

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
            trades: tradeLog.length,
            diagnostics,
            trade_log: tradeLog.slice(0, 300),
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
        trades: tradeLog.length,
        tradeLog,
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
