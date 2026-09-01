import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { parseFxPair } from "@/lib/fx-leg-quotes";
import {
  evaluateFxLegPlaybook,
  type FxLegPlaybookVerdict,
} from "@/lib/fx-leg-playbook";

export type FxLegHistoryPoint = {
  date: string;
  rate: number;
  /** Unrealised P&L in the pair's quote currency at that day's close. */
  pnlQuote: number;
  /** Same, as a fraction of notional. */
  pnlPct: number;
};

export type FxLegHistory = {
  symbol: string;
  pairBase: string;
  quoteCcy: string;
  quantity: number;
  avgCost: number;
  rate: number | null;
  observedAt: string | null;
  source: string;
  pnlQuote: number;
  notionalQuote: number;
  points: FxLegHistoryPoint[];
  verdict: FxLegPlaybookVerdict;
  /** Most recent AI reasons that touched this currency. */
  aiNotes: Array<{ at: string; kind: string; reason: string }>;
  /** False for synthetic reference pairs the portfolio does not actually hold. */
  actual: boolean;
  error: string | null;
};

export type FxLegHistoryResult = {
  baseCcy: string;
  days: number;
  asOf: string;
  legs: FxLegHistory[];
};

/**
 * Rate history + unrealised P&L path for every open FX funding leg, plus the
 * playbook verdict (keep / unwind / close) with the exact signals behind it.
 */
export const getFxLegHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        days: z.number().int().min(7).max(7300).default(90),
        /**
         * Pairs to include as synthetic reference legs when they are not held,
         * so the currency picker can chart any pair.
         */
        referencePairs: z.array(z.string().length(6)).max(8).default([]),
        /** Notional (quote ccy) used to size a synthetic reference leg. */
        referenceNotional: z.number().positive().default(10_000),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<FxLegHistoryResult> => {
    const { getFxRateAudited } = await import("@/lib/fx.server");
    const { fetchFxHistory, daysAgo } = await import("@/lib/fx-history.server");

    const [{ data: portfolio }, { data: holdings }, { data: decisions }] = await Promise.all([
      context.supabase
        .from("portfolios")
        .select("currency")
        .eq("id", data.portfolioId)
        .maybeSingle(),
      context.supabase
        .from("holdings")
        .select("symbol, quantity, avg_cost, asset_class, instrument_ccy")
        .eq("portfolio_id", data.portfolioId),
      context.supabase
        .from("decisions")
        .select("created_at, raw")
        .eq("portfolio_id", data.portfolioId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    const baseCcy = String(portfolio?.currency ?? "GBP").toUpperCase();
    const all = holdings ?? [];
    const fxRows = all.filter((h) => h.asset_class === "fx" && Number(h.quantity) !== 0);
    const fundedCcys = new Set(
      all
        .filter((h) => h.asset_class !== "fx" && Number(h.quantity) !== 0)
        .map((h) => String(h.instrument_ccy ?? baseCcy).toUpperCase()),
    );

    // AI reasons recorded per tick against a currency.
    type Note = { at: string; kind: string; reason: string; ccy: string };
    const notes: Note[] = [];
    for (const d of decisions ?? []) {
      const raw = (d.raw ?? {}) as Record<string, unknown>;
      const guard = (raw['guardrails'] ?? {}) as Record<string, unknown>;
      const aiFx = (guard['ai_fx'] ?? {}) as Record<string, unknown>;
      const compiled = Array.isArray(aiFx['intents_compiled'])
        ? (aiFx['intents_compiled'] as Array<Record<string, unknown>>)
        : [];
      for (const c of compiled) {
        const intent = (c['intent'] ?? {}) as Record<string, unknown>;
        const reason = String(intent['reason'] ?? "");
        if (!reason) continue;
        notes.push({
          at: String(d.created_at),
          kind: String(intent['kind'] ?? "intent"),
          reason: c['skipped'] ? `${reason} (skipped: ${String(c['skipped'])})` : reason,
          ccy: String(intent['ccy'] ?? "").toUpperCase(),
        });
      }
    }

    const from = daysAgo(data.days);

    const legs = await Promise.all(
      fxRows.map(async (h): Promise<FxLegHistory> => {
        const pair = parseFxPair(String(h.symbol), h.instrument_ccy ?? null);
        const pairBase = (pair?.base ?? baseCcy).toUpperCase();
        const quoteCcy = (pair?.quote ?? String(h.instrument_ccy ?? baseCcy)).toUpperCase();
        const qty = Number(h.quantity);
        const avgCost = Number(h.avg_cost);

        let rate: number | null = null;
        let observedAt: string | null = null;
        let source = "unavailable";
        let stale = true;
        let rateAgeMinutes: number | null = null;
        try {
          const r = await getFxRateAudited(pairBase, quoteCcy);
          rate = r.rate;
          observedAt = new Date(r.observedAtMs).toISOString();
          source = r.source;
          stale = r.stale;
          rateAgeMinutes = (Date.now() - r.observedAtMs) / 60_000;
        } catch (e) {
          source = e instanceof Error ? e.message : "fx-error";
        }

        let points: FxLegHistoryPoint[] = [];
        let error: string | null = null;
        try {
          const bars = await fetchFxHistory(pairBase, quoteCcy, from);
          points = bars.map((b) => {
            const pnlQuote = Number.isFinite(avgCost) && avgCost > 0 ? qty * (b.rate - avgCost) : 0;
            const notional = Math.abs(qty) * b.rate;
            return {
              date: b.date,
              rate: b.rate,
              pnlQuote,
              pnlPct: notional > 0 ? pnlQuote / notional : 0,
            };
          });
        } catch (e) {
          error = e instanceof Error ? e.message : "history unavailable";
        }

        // Append the live mark so the chart ends at "now".
        if (rate != null && rate > 0) {
          const pnlQuote = avgCost > 0 ? qty * (rate - avgCost) : 0;
          const notional = Math.abs(qty) * rate;
          const today = new Date().toISOString().slice(0, 10);
          const point: FxLegHistoryPoint = {
            date: today,
            rate,
            pnlQuote,
            pnlPct: notional > 0 ? pnlQuote / notional : 0,
          };
          if (points.length && points[points.length - 1]!.date === today) {
            points[points.length - 1] = point;
          } else {
            points.push(point);
          }
        }

        const last = points[points.length - 1];
        const pnlQuote = last?.pnlQuote ?? 0;
        const notionalQuote = Math.abs(qty) * (rate ?? avgCost ?? 0);

        const verdict = evaluateFxLegPlaybook({
          symbol: String(h.symbol),
          quantity: qty,
          avgCost,
          rate,
          pnlQuote,
          notionalQuote,
          stale,
          rateAgeMinutes,
          orphaned: !fundedCcys.has(quoteCcy) && !fundedCcys.has(pairBase),
        });

        return {
          symbol: String(h.symbol),
          pairBase,
          quoteCcy,
          quantity: qty,
          avgCost,
          rate,
          observedAt,
          source,
          pnlQuote,
          notionalQuote,
          points,
          verdict,
          aiNotes: notes
            .filter((n) => !n.ccy || n.ccy === quoteCcy || n.ccy === pairBase)
            .slice(0, 5)
            .map(({ at, kind, reason }) => ({ at, kind, reason })),
          actual: h.actual,
          error,
        };
      }),
    );

    return { baseCcy, days: data.days, asOf: new Date().toISOString(), legs };
  });
