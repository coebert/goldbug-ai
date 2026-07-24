// AI-narrated divergence analysis across paper portfolios.
// Extracted from trading.functions.ts (Phase 3).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

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
