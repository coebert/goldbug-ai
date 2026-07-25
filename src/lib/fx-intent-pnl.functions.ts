// Realized/mark-to-market PnL attribution grouped by FX intent kind.
// For each applied FX conversion linked to an intent, PnL is computed in
// portfolio base currency as:
//   pnl_base = amount_to * spot(to->base) - amount_from * spot(from->base)
// Positive = the conversion is currently in the money vs the rate we struck.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type IntentPnlBucket = {
  kind: string;
  count: number;
  notionalBase: number;
  pnlBase: number;
  winRate: number;
};

export type IntentPnlRollup = {
  baseCcy: string;
  since: string;
  totalPnlBase: number;
  totalNotionalBase: number;
  buckets: IntentPnlBucket[];
  stale: boolean;
};

const KINDS = ["pre_fund", "hedge", "sweep_idle", "carry_tilt", "close_hedge"] as const;

export const getFxIntentPnl = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      portfolioId: z.string().uuid(),
      sinceDays: z.number().int().min(1).max(365).default(30),
    }).parse(i),
  )
  .handler(async ({ data, context }): Promise<IntentPnlRollup> => {
    const { supabase } = context;

    const { data: portfolio, error: pErr } = await supabase
      .from("portfolios")
      .select("id, currency")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (pErr) throw new Error(pErr.message);
    const baseCcy = (portfolio?.currency ?? "GBP").toUpperCase();

    const since = new Date(Date.now() - data.sinceDays * 86400_000).toISOString();

    const { data: rows, error } = await supabase
      .from("decisions")
      .select("id, created_at, raw")
      .eq("portfolio_id", data.portfolioId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    type Applied = {
      kind: string;
      from_ccy: string;
      to_ccy: string;
      amount_from: number;
      amount_to: number;
      rate: number;
    };
    const applied: Applied[] = [];
    for (const r of rows ?? []) {
      const raw = r.raw as Record<string, unknown> | null;
      const g = (raw?.guardrails ?? {}) as Record<string, unknown>;
      const aiFx = (g.ai_fx ?? null) as {
        intents_compiled?: Array<{
          intent: { kind: string };
          order: { from_ccy: string; to_ccy: string } | null;
        }>;
        applied?: Array<{
          from_ccy: string;
          to_ccy: string;
          amount_from: number;
          amount_to: number;
          rate: number;
          rejected?: string;
        }>;
      } | null;
      const compiled = aiFx?.intents_compiled ?? [];
      const app = aiFx?.applied ?? [];
      for (const c of compiled) {
        if (!c.order) continue;
        const match = app.find(
          (a) => a.from_ccy === c.order!.from_ccy && a.to_ccy === c.order!.to_ccy && !a.rejected,
        );
        if (!match) continue;
        applied.push({
          kind: c.intent.kind,
          from_ccy: match.from_ccy,
          to_ccy: match.to_ccy,
          amount_from: match.amount_from,
          amount_to: match.amount_to,
          rate: match.rate,
        });
      }
    }

    // Collect unique currencies and pull spot rates to base.
    const ccys = new Set<string>();
    for (const a of applied) {
      ccys.add(a.from_ccy);
      ccys.add(a.to_ccy);
    }
    const { getFxRate } = await import("./fx.server");
    const spot: Record<string, number> = { [baseCcy]: 1 };
    let stale = false;
    await Promise.all(
      Array.from(ccys).map(async (c) => {
        if (c === baseCcy) return;
        const q = await getFxRate(c, baseCcy);
        spot[c] = q.rate;
        if (q.stale) stale = true;
      }),
    );

    const buckets = new Map<string, IntentPnlBucket>();
    for (const k of KINDS) {
      buckets.set(k, { kind: k, count: 0, notionalBase: 0, pnlBase: 0, winRate: 0 });
    }
    const wins = new Map<string, number>();

    for (const a of applied) {
      const rFrom = spot[a.from_ccy];
      const rTo = spot[a.to_ccy];
      if (!rFrom || !rTo) continue;
      const notionalBase = a.amount_from * rFrom;
      const pnlBase = a.amount_to * rTo - a.amount_from * rFrom;
      const b = buckets.get(a.kind) ?? {
        kind: a.kind,
        count: 0,
        notionalBase: 0,
        pnlBase: 0,
        winRate: 0,
      };
      b.count += 1;
      b.notionalBase += notionalBase;
      b.pnlBase += pnlBase;
      buckets.set(a.kind, b);
      if (pnlBase > 0) wins.set(a.kind, (wins.get(a.kind) ?? 0) + 1);
    }

    let totalPnl = 0;
    let totalNotional = 0;
    for (const b of buckets.values()) {
      b.winRate = b.count > 0 ? (wins.get(b.kind) ?? 0) / b.count : 0;
      totalPnl += b.pnlBase;
      totalNotional += b.notionalBase;
    }

    return {
      baseCcy,
      since,
      totalPnlBase: totalPnl,
      totalNotionalBase: totalNotional,
      buckets: Array.from(buckets.values()).sort((a, b) => b.notionalBase - a.notionalBase),
      stale,
    };
  });
