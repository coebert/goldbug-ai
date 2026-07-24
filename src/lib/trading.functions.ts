// Server functions exposed to the UI. All authenticated via requireSupabaseAuth.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// Re-exports for backwards compatibility after Phase 3 split.
// New code should import directly from the target files.
export { getCurrentRegime } from "./regime.functions";
export { getRegimeHistory } from "./regime.functions";
export { refreshRegimeNow } from "./regime.functions";
export { getPortfolioLearning } from "./lessons.functions";
export { listLessonOverrides } from "./lessons.functions";
export { setLessonOverride } from "./lessons.functions";
export { clearLessonOverride } from "./lessons.functions";
export { rateLessonFeedback } from "./lessons.functions";
export { getBenchmarkSeries } from "./benchmark.functions";
export { getGlobalNewsReel } from "./news.functions";
export { getDecisionNewsBreakdown } from "./news.functions";
export { triggerHourlyRunNow } from "./hourly-run.functions";
export { getPerformanceReport } from "./reports.functions";
export { getComparison } from "./reports.functions";
export { getTradeComparison } from "./reports.functions";
export { getDiagnostics } from "./diagnostics.functions";
export { runBacktest } from "./backtest.functions";
export { runBacktestMany } from "./backtest.functions";
export { runLongHorizonBacktest } from "./backtest.functions";
export { addSimFunds } from "./sim-funds.functions";
export { listSimFundEvents } from "./sim-funds.functions";
export { addSimFundsHandler } from "./sim-funds.server";
export { createPortfolio } from "./portfolios.functions";
export { listPortfolios } from "./portfolios.functions";
export { getAllPortfoliosEquity } from "./portfolios.functions";
export { getPortfolio } from "./portfolios.functions";
export { deletePortfolio } from "./portfolios.functions";
export { renamePortfolio } from "./portfolios.functions";






const RiskConfigSchema = z.object({
  asset_class_limits: z
    .object({
      stock: z.number().min(0).max(1).optional(),
      etf: z.number().min(0).max(1).optional(),
      crypto: z.number().min(0).max(1).optional(),
      commodity: z.number().min(0).max(1).optional(),
      fx: z.number().min(0).max(1).optional(),
    })
    .partial()
    .default({}),
  per_symbol_limit_pct: z.number().min(0).max(1).nullable().default(null),
  stop_loss_pct: z.number().min(0).max(0.9).default(0.1),
  take_profit_pct: z.number().min(0).max(5).default(0.25),
  atr_trailing_mult: z.number().min(0).max(10).default(3),
  max_hold_days: z.number().int().min(0).max(3650).default(0),
  volatility_sizing: z.boolean().default(true),
  vol_target_pct: z.number().min(0.001).max(0.1).default(0.015),
  risk_level: z.number().int().min(1).max(5).optional(),
});

export const updateRiskConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        risk_config: RiskConfigSchema,
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("portfolios")
      .update({ risk_config: data.risk_config })
      .eq("id", data.portfolio_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// -----------------------------------------------------------------------
// Execution calibration — estimates spread / slippage / commission from
// recent OHLCV and updates portfolios.risk_config.execution_params.
// -----------------------------------------------------------------------
export const calibrateExecution = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        window_days: z.number().int().min(20).max(365).default(90),
        apply: z.boolean().default(true),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: p, error } = await context.supabase
      .from("portfolios")
      .select("id, universe, risk_config")
      .eq("id", data.portfolio_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!p) throw new Error("Portfolio not found");

    const { filterUniverse, parseRiskConfig } = await import("./universe.server");
    const { calibrateExecution: run } = await import("./execution-calibration.server");
    const classes = Array.isArray(p.universe) ? (p.universe as string[]) : [];
    const symbols = filterUniverse(classes as Parameters<typeof filterUniverse>[0]).map((u) => u.symbol);
    if (!symbols.length) throw new Error("Portfolio universe is empty");

    const summary = await run(symbols, { lookbackDays: data.window_days });

    if (data.apply) {
      const cfg = parseRiskConfig(p.risk_config);
      const nextCfg = {
        ...cfg,
        execution_params: {
          slippage_bps: summary.recommended.slippage_bps,
          commission_bps: summary.recommended.commission_bps,
          spread_atr_frac: summary.recommended.spread_atr_frac,
          adv_participation: summary.recommended.adv_participation,
          min_trade_value: summary.recommended.min_trade_value,
        },
        execution_calibration: {
          as_of: summary.as_of,
          window_days: summary.window_days,
          n_symbols: summary.n_symbols,
          notes: summary.notes,
        },
      };
      const { error: upErr } = await context.supabase
        .from("portfolios")
        .update({ risk_config: nextCfg })
        .eq("id", data.portfolio_id);
      if (upErr) throw new Error(upErr.message);
    }

    return summary;
  });




export const resetPortfolio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { data: p } = await context.supabase
      .from("portfolios")
      .select("starting_cash")
      .eq("id", data.id)
      .single();
    if (!p) throw new Error("Portfolio not found");
    await context.supabase.from("holdings").delete().eq("portfolio_id", data.id);
    await context.supabase.from("trades").delete().eq("portfolio_id", data.id);
    await context.supabase.from("decisions").delete().eq("portfolio_id", data.id);
    await context.supabase.from("equity_snapshots").delete().eq("portfolio_id", data.id);
    await context.supabase
      .from("portfolios")
      .update({ current_cash: p.starting_cash, last_run_date: null })
      .eq("id", data.id);
    return { ok: true };
  });

export const runOneDay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        as_of: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    // Verify user owns portfolio (RLS via context.supabase)
    const { data: owned } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolio_id)
      .single();
    if (!owned) throw new Error("Portfolio not found");
    const { runDailyTick } = await import("./trading-engine.server");
    const asOf = data.as_of ?? new Date().toISOString().slice(0, 10);
    const result = await runDailyTick(data.portfolio_id, asOf);
    return {
      briefing: result.decision.briefing,
      rationale: result.decision.rationale,
      totalValue: result.totalValue,
      executedCount: result.executed.filter((e) => !e.rejected).length,
    };
  });


// ---------------- Regime detection ----------------

// getCurrentRegime, getRegimeHistory, refreshRegimeNow → src/lib/regime.functions.ts
// (re-exported at the top of this file for backwards compatibility)


export const getDivergenceNarratives = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_ids: z.array(z.string().uuid()).min(2).max(6),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(10).default(5),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: portfolios, error: pErr } = await context.supabase
      .from("portfolios")
      .select("id, name, risk_level, risk_config")
      .in("id", data.portfolio_ids);
    if (pErr) throw new Error(pErr.message);
    const pById = new Map((portfolios ?? []).map((p) => [p.id, p]));
    const ordered = data.portfolio_ids
      .map((id) => pById.get(id))
      .filter((x): x is NonNullable<typeof x> => !!x);

    type Row = {
      date: string;
      symbol: string;
      side: "buy" | "sell";
      intent_pct: number | null;
      executed_value: number;
      price: number;
      rejected: string | null;
      reason: string;
      signal_weights: Record<string, number> | null;
      signals: Record<string, number | null> | null;
    };
    type PerPortfolio = {
      portfolio_id: string;
      name: string;
      risk_level: string;
      rows: Row[];
      regime?: string | null;
    };

    const perP: PerPortfolio[] = await Promise.all(
      ordered.map(async (p) => {
        let q = context.supabase
          .from("decisions")
          .select("run_date, raw")
          .eq("portfolio_id", p.id)
          .order("run_date", { ascending: true });
        if (data.from) q = q.gte("run_date", data.from);
        if (data.to) q = q.lte("run_date", data.to);
        const { data: decs } = await q;
        const rows: Row[] = [];
        let regime: string | null = null;
        for (const d of decs ?? []) {
          const raw = (d.raw ?? {}) as {
            orders?: Array<{ symbol?: string; side?: string; percent?: number; reason?: string; signal_weights?: Record<string, number> }>;
            executed?: Array<{ symbol?: string; side?: string; value?: number; price?: number; reason?: string; rejected?: string | null }>;
            signals?: Array<{ symbol: string; sma20?: number | null; sma50?: number | null; rsi14?: number | null; change5d?: number | null; change30d?: number | null; vol20d?: number | null }>;
            regime?: { regime?: string };
          };
          if (raw.regime?.regime) regime = raw.regime.regime;
          const sigBy = new Map((raw.signals ?? []).map((s) => [s.symbol.toUpperCase(), s] as const));
          const intentBy = new Map(
            (raw.orders ?? [])
              .filter((o) => o.symbol)
              .map((o) => [`${(o.symbol ?? "").toUpperCase()}|${o.side ?? ""}`, o] as const),
          );
          for (const ex of raw.executed ?? []) {
            const sym = (ex.symbol ?? "").toUpperCase();
            if (!sym) continue;
            const side = (ex.side === "sell" ? "sell" : "buy") as "buy" | "sell";
            const intent = intentBy.get(`${sym}|${side}`);
            const sig = sigBy.get(sym);
            rows.push({
              date: d.run_date as string,
              symbol: sym,
              side,
              intent_pct: intent?.percent ?? null,
              executed_value: Number(ex.value ?? 0),
              price: Number(ex.price ?? 0),
              rejected: ex.rejected ?? null,
              reason: String(ex.reason ?? intent?.reason ?? ""),
              signal_weights: intent?.signal_weights ?? null,
              signals: sig
                ? {
                    sma20: sig.sma20 ?? null,
                    sma50: sig.sma50 ?? null,
                    rsi14: sig.rsi14 ?? null,
                    change5d: sig.change5d ?? null,
                    change30d: sig.change30d ?? null,
                    vol20d: sig.vol20d ?? null,
                  }
                : null,
            });
          }
        }
        return { portfolio_id: p.id, name: p.name, risk_level: p.risk_level, rows, regime };
      }),
    );

    // Build (date, symbol) grid
    type Cell = Row | null;
    const grid = new Map<string, { date: string; symbol: string; cells: Cell[] }>();
    perP.forEach((pp, idx) => {
      for (const r of pp.rows) {
        const key = `${r.date}|${r.symbol}`;
        let entry = grid.get(key);
        if (!entry) {
          entry = { date: r.date, symbol: r.symbol, cells: perP.map(() => null) };
          grid.set(key, entry);
        }
        entry.cells[idx] = r;
      }
    });

    // Score divergence: number of distinct actions × total capital involved
    const scored = [...grid.values()]
      .map((g) => {
        const actions = g.cells.map((c) => (!c ? "none" : c.rejected ? "blocked" : c.side));
        const distinct = new Set(actions).size;
        if (distinct < 2) return null;
        const capital = g.cells.reduce((s, c) => s + (c?.executed_value ?? 0), 0);
        const score = (distinct - 1) * 100 + capital / 100;
        return { ...g, actions, score };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.score - a.score)
      .slice(0, data.limit);

    if (scored.length === 0) return { events: [] };

    // Build compact JSON for the model
    const eventsForAi = scored.map((g) => ({
      date: g.date,
      symbol: g.symbol,
      portfolios: g.cells.map((c, i) => ({
        name: perP[i].name,
        risk_level: perP[i].risk_level,
        regime: perP[i].regime,
        action: !c ? "no action" : c.rejected ? "blocked" : c.side,
        rejected: c?.rejected ?? null,
        reason: c?.reason ?? null,
        intent_pct: c?.intent_pct ?? null,
        executed_value: c?.executed_value ?? 0,
        price: c?.price ?? null,
        signals: c?.signals ?? null,
        top_weights: c?.signal_weights
          ? Object.entries(c.signal_weights)
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .slice(0, 3)
              .map(([k, v]) => ({ signal: k, weight: Number(v) }))
          : [],
      })),
    }));

    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");
    const { createLovableAiGatewayProvider } = await import("./ai-gateway.server");
    const { generateText, Output } = await import("ai");
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-3.6-flash");

    const system = `You are Aegis, explaining trade divergences between paper portfolios in plain English to a non-technical investor.

For each event you are given: the date, symbol, and each portfolio's action (buy/sell/blocked/no action), the reason, risk level, macro regime, technical signals (RSI, SMA20/50, 5d/30d change, 20d volatility) and the top signal-importance weights.

For EACH event, write a short narrative (3-5 sentences) that:
1. States clearly what each portfolio did differently, referencing them by name.
2. Explains WHY they diverged — connect the difference to the priors (risk level, macro regime), the signals, and the signal-importance weights. Name specific numbers where they matter (e.g. "RSI at 24 flagged oversold", "SMA20 crossed below SMA50").
3. If a portfolio was blocked, explain which guardrail rejected it in plain English (e.g. cash floor, per-symbol cap, asset-class limit).
4. Ends with a one-line takeaway about what this divergence reveals about the strategies.

Avoid jargon dumps. Do not repeat the raw JSON. Do not give investment advice.`;

    let narratives: { date: string; symbol: string; narrative: string }[] = [];
    try {
      const { output } = await generateText({
        model,
        system,
        prompt: `Write narratives for these ${eventsForAi.length} divergence events:\n\n${JSON.stringify(eventsForAi, null, 2)}`,
        output: Output.object({
          schema: z.object({
            events: z
              .array(
                z.object({
                  date: z.string(),
                  symbol: z.string(),
                  narrative: z.string(),
                }),
              )
              .min(1),
          }),
        }),
      });
      narratives = output.events;
    } catch (err) {
      throw new Error(
        err instanceof Error
          ? `AI narrative generation failed: ${err.message}`
          : "AI narrative generation failed",
      );
    }

    // Zip narratives back to structured events
    const narrByKey = new Map(narratives.map((n) => [`${n.date}|${n.symbol}`, n.narrative]));
    const events = scored.map((g, idx) => ({
      rank: idx + 1,
      date: g.date,
      symbol: g.symbol,
      score: g.score,
      narrative: narrByKey.get(`${g.date}|${g.symbol}`) ?? "",
      portfolios: eventsForAi[idx].portfolios,
    }));
    return { events };
  });

// getPortfolioLearning, listLessonOverrides, setLessonOverride,
// clearLessonOverride, rateLessonFeedback → src/lib/lessons.functions.ts
// getBenchmarkSeries → src/lib/benchmark.functions.ts
// (re-exported at the top of this file for backwards compatibility)


// ============================================================================
// #12 — Portfolio optimizer: equal-weight, inverse-vol (risk parity),
// and max-Sharpe (mean-variance, long-only) target allocations.
// ============================================================================

function invertMatrix(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < n; i++) {
    // pivot
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    if (Math.abs(a[pivot][i]) < 1e-12) return null;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const div = a[i][i];
    for (let c = 0; c < 2 * n; c++) a[i][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = a[r][i];
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c++) a[r][c] -= f * a[i][c];
    }
  }
  return a.map((row) => row.slice(n));
}

function dailyReturnsFromCloses(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return out;
}

function meanOf(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function normaliseWeights(w: number[]): number[] {
  const clipped = w.map((x) => (x > 0 ? x : 0));
  const s = clipped.reduce((a, b) => a + b, 0);
  if (s <= 0) return w.map(() => 1 / w.length);
  return clipped.map((x) => x / s);
}

export const runPortfolioOptimizer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      portfolio_id: z.string().uuid(),
      extra_symbols: z.array(z.string().min(1).max(12)).max(20).default([]),
      lookback_days: z.number().int().min(30).max(504).default(126),
      max_weight_pct: z.number().min(5).max(100).default(35),
    }).parse(i),
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

    // Fetch price series
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

    // Align returns to shortest length
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
    // Covariance matrix (population, using deviations from mean)
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
    // Ridge for numerical stability
    for (let i = 0; i < n; i++) cov[i][i] += 1e-6;

    const vols = cov.map((row, i) => Math.sqrt(row[i]));

    const stats = validSymbols.map((s, i) => ({
      symbol: s,
      mean_ann_pct: Number((means[i] * 252 * 100).toFixed(2)),
      vol_ann_pct: Number((vols[i] * Math.sqrt(252) * 100).toFixed(2)),
      sharpe: vols[i] > 0 ? Number(((means[i] / vols[i]) * Math.sqrt(252)).toFixed(2)) : 0,
      last_close: lastCloseBySym.get(s) ?? 0,
    }));

    // Current weights (need total value)
    const heldByS = new Map<string, { qty: number; last: number }>();
    for (const h of holdings ?? []) {
      const sym = String(h.symbol).toUpperCase();
      const last = lastCloseBySym.get(sym) ?? 0;
      heldByS.set(sym, { qty: Number(h.quantity), last });
    }
    const heldValue = Array.from(heldByS.values()).reduce((a, b) => a + b.qty * b.last, 0);
    const cash = Number(portfolio.current_cash ?? 0);
    const totalValue = heldValue + cash;
    const investable = totalValue; // full rebalance target
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
      // Iterative cap: clip to cap and redistribute residual to uncapped names
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

    // Equal weight
    const equalW = validSymbols.map(() => 1 / n);

    // Inverse-vol (risk parity approximation)
    const invVol = vols.map((v) => (v > 0 ? 1 / v : 0));
    const rpW = normaliseWeights(invVol);
    const rpCapped = applyCap(rpW);

    // Max-Sharpe: unconstrained tangency w ∝ C^-1 μ, then long-only + cap
    let msRaw: number[] | null = null;
    const inv = invertMatrix(cov);
    if (inv) {
      msRaw = inv.map((row) => row.reduce((sum, v, j) => sum + v * means[j], 0));
    }
    let msW: number[];
    if (msRaw && msRaw.some((x) => x > 0)) {
      msW = normaliseWeights(msRaw);
    } else {
      // fallback: mean / variance normalized
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
// getGlobalNewsReel, getDecisionNewsBreakdown → src/lib/news.functions.ts
// triggerHourlyRunNow → src/lib/hourly-run.functions.ts
// (re-exported at the top of this file for backwards compatibility)



