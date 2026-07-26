// Per-trade FX drilldown for the Saxo SIM run details view.
//
// For each recent decision tick, returns the exact FX_LEG rows the executor
// used to fund cross-currency buys — i.e. which USD/GBP↔EUR cross-rate was
// applied to size each individual order. Correlates by decision_id so
// operators can see, per trade: symbol, side, from→to, amount converted,
// applied rate, and the FX_CAPTURE snapshot that drove sizing on that tick.
//
// This is the operational counterpart to `fx-audit.functions.ts`, which
// only shows what sizing would use *right now*.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type FxTradeDrilldownLeg = {
  triggeredBySymbol: string | null;
  fromCcy: string | null;
  toCcy: string | null;
  amountFrom: number | null;
  amountTo: number | null;
  rate: number | null;
  stale: boolean | null;
  createdAt: string;
};

export type FxTradeDrilldownDecision = {
  decisionId: string | null;
  asOf: string | null;
  createdAt: string;
  /** Base→broker capture recorded at the start of the tick, if any. */
  capture: {
    pair: string;
    rate: number | null;
    source: string | null;
    stale: boolean | null;
  } | null;
  legs: FxTradeDrilldownLeg[];
};

export type FxTradeDrilldown = {
  requestedAt: string;
  decisions: FxTradeDrilldownDecision[];
};

type LogRow = {
  created_at: string;
  method: string;
  path: string | null;
  request: unknown;
  response: unknown;
};

function getStr(o: unknown, k: string): string | null {
  if (o && typeof o === "object" && k in (o as Record<string, unknown>)) {
    const v = (o as Record<string, unknown>)[k];
    return typeof v === "string" ? v : null;
  }
  return null;
}
function getNum(o: unknown, k: string): number | null {
  if (o && typeof o === "object" && k in (o as Record<string, unknown>)) {
    const v = (o as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return null;
}
function getBool(o: unknown, k: string): boolean | null {
  if (o && typeof o === "object" && k in (o as Record<string, unknown>)) {
    const v = (o as Record<string, unknown>)[k];
    return typeof v === "boolean" ? v : null;
  }
  return null;
}

export const getFxTradeDrilldown = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        limit: z.number().int().min(1).max(50).default(10),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<FxTradeDrilldown> => {
    // Pull the recent FX_LEG + FX_CAPTURE rows for this portfolio. FX_LEG is
    // the per-symbol conversion the executor actually applied; FX_CAPTURE is
    // the tick-level rate snapshot recorded when the tick started.
    const res = await context.supabase
      .from("live_broker_log")
      .select("created_at, method, path, request, response")
      .eq("portfolio_id", data.portfolioId)
      .in("method", ["FX_LEG", "FX_CAPTURE"])
      .order("created_at", { ascending: false })
      .limit(400);

    const rows = ((res.data as LogRow[] | null) ?? []).slice();

    // Group by decision_id (falls back to created_at bucket when absent).
    const byDecision = new Map<
      string,
      {
        decisionId: string | null;
        asOf: string | null;
        createdAt: string;
        capture: FxTradeDrilldownDecision["capture"];
        legs: FxTradeDrilldownLeg[];
      }
    >();

    for (const r of rows) {
      const decisionId = getStr(r.request, "decisionId");
      const asOf = getStr(r.request, "asOf");
      const key = decisionId ?? `t:${r.created_at}`;
      let bucket = byDecision.get(key);
      if (!bucket) {
        bucket = {
          decisionId,
          asOf,
          createdAt: r.created_at,
          capture: null,
          legs: [],
        };
        byDecision.set(key, bucket);
      }
      // Track earliest createdAt within the bucket for stable ordering.
      if (r.created_at < bucket.createdAt) bucket.createdAt = r.created_at;

      if (r.method === "FX_LEG") {
        bucket.legs.push({
          triggeredBySymbol: getStr(r.request, "triggeredBySymbol"),
          fromCcy: getStr(r.response, "fromCcy"),
          toCcy: getStr(r.response, "toCcy"),
          amountFrom: getNum(r.response, "amountFrom"),
          amountTo: getNum(r.response, "amountTo"),
          rate: getNum(r.response, "rate"),
          stale: getBool(r.response, "stale"),
          createdAt: r.created_at,
        });
      } else if (r.method === "FX_CAPTURE") {
        const m = /\/fx\/([A-Z]{3}->[A-Z]{3})/.exec(r.path ?? "");
        bucket.capture = {
          pair: m?.[1] ?? "unknown",
          rate: getNum(r.response, "rate"),
          source: getStr(r.response, "source"),
          stale: getBool(r.response, "stale"),
        };
      }
    }

    const decisions: FxTradeDrilldownDecision[] = [...byDecision.values()]
      // Only keep ticks that actually applied at least one cross-currency leg.
      .filter((b) => b.legs.length > 0)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, data.limit)
      .map((b) => ({
        decisionId: b.decisionId,
        asOf: b.asOf,
        createdAt: b.createdAt,
        capture: b.capture,
        legs: b.legs.sort((x, y) =>
          (x.triggeredBySymbol ?? "").localeCompare(y.triggeredBySymbol ?? ""),
        ),
      }));

    return { requestedAt: new Date().toISOString(), decisions };
  });
