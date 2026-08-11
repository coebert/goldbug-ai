// Thin server-function wrapper for AI chart annotations.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getChartAnnotations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        symbol: z.string().min(1).max(24),
        days: z.number().int().min(7).max(1825).default(90),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { buildSymbolHistory, isKnownSymbol, symbolMeta } = await import(
      "./market-symbol-history"
    );
    const { detectChartEvents } = await import("./chart-annotations");
    const { explainChartEvents } = await import("./chart-annotations.server");

    if (!isKnownSymbol(data.symbol)) throw new Error(`Unknown market symbol: ${data.symbol}`);

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - (data.days + 320));
    const sinceIso = since.toISOString().slice(0, 10);
    const windowStart = new Date();
    windowStart.setUTCDate(windowStart.getUTCDate() - data.days);
    const windowStartIso = windowStart.toISOString().slice(0, 10);

    const [prices, news] = await Promise.all([
      context.supabase
        .from("price_cache")
        .select("symbol, price_date, close")
        .eq("symbol", data.symbol)
        .gte("price_date", sinceIso)
        .order("price_date", { ascending: true })
        .limit(4000),
      context.supabase
        .from("news_cache")
        .select("news_date, headline, source, url, fetched_at, relevance_score")
        .gte("news_date", windowStartIso)
        .order("relevance_score", { ascending: false, nullsFirst: false })
        .limit(300),
    ]);

    if (prices.error) throw new Error(prices.error.message);

    const history = buildSymbolHistory(
      data.symbol,
      (prices.data ?? []).map((r) => ({
        symbol: r.symbol as string,
        price_date: r.price_date as string,
        close: Number(r.close),
      })),
      data.days,
    );

    const meta = symbolMeta(data.symbol);
    const events = detectChartEvents(history.points, meta?.label ?? data.symbol);

    const { linkDecisionsToAnnotations, LINK_WINDOW_DAYS } = await import(
      "./annotation-decision-link"
    );

    const decisionsSince = new Date(`${windowStartIso}T00:00:00Z`);
    decisionsSince.setUTCDate(decisionsSince.getUTCDate() - LINK_WINDOW_DAYS);

    const audit = await context.supabase
      .from("ai_decision_audit")
      .select(
        "id, symbol, action, outcome, decided_at, run_date, notional, instrument_ccy, rationale",
      )
      .gte("run_date", decisionsSince.toISOString().slice(0, 10))
      .order("decided_at", { ascending: false })
      .limit(1500);

    const decisionRecords = (audit.data ?? []).map((d) => ({
      id: d.id as string,
      symbol: (d.symbol as string) ?? "",
      action: (d.action as string) ?? "hold",
      outcome: (d.outcome as string) ?? "pending",
      decidedAt: (d.decided_at as string) ?? `${d.run_date as string}T00:00:00Z`,
      runDate: d.run_date as string,
      notional: d.notional === null || d.notional === undefined ? null : Number(d.notional),
      instrumentCcy: (d.instrument_ccy as string | null) ?? null,
      rationale: (d.rationale as string | null) ?? null,
    }));

    const annotations = await explainChartEvents({
      label: meta?.label ?? data.symbol,
      symbol: data.symbol,
      days: data.days,
      events,
      news: (news.data ?? []).map((n) => ({
        date: n.news_date as string,
        headline: n.headline as string,
        source: (n.source as string | null) ?? null,
        url: (n.url as string | null) ?? null,
        at: (n.fetched_at as string | null) ?? null,
      })),
    });

    return {
      symbol: data.symbol,
      days: data.days,
      annotations: linkDecisionsToAnnotations(annotations, data.symbol, decisionRecords),
    };
  });
