import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { TickerMetrics } from "@/lib/ticker-watch";

import { UpsertInput } from "./ticker-watch.helpers";
import type { TickerWatchView, SecondOpinion } from "./ticker-watch.helpers";
export type { TickerWatchView, SecondOpinion };

/** Watches for the caller, each with live metrics and today's fired triggers. */
export const listTickerWatches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ watches: TickerWatchView[] }> => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("ticker_watches")
      .select("id, user_id, symbol, label, thesis, buy_above, oversold_rsi, max_vol_pct, drop_below, active")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);

    const { loadTickerMetrics, toConfig } = await import("@/lib/ticker-watch.server");
    const { describeWatchStatus } = await import("@/lib/ticker-watch");
    const today = new Date().toISOString().slice(0, 10);

    const watches: TickerWatchView[] = [];
    for (const row of data ?? []) {
      const config = toConfig(row as never);
      let metrics: TickerMetrics | null = null;
      try {
        metrics = await loadTickerMetrics(row.symbol as string);
      } catch {
        metrics = null;
      }
      const alerts = await supabase
        .from("ticker_watch_alerts")
        .select("trigger_code, price, created_at")
        .eq("watch_id", row.id as string)
        .eq("alert_date", today);
      watches.push({
        id: row.id as string,
        symbol: row.symbol as string,
        label: (row.label as string | null) ?? null,
        thesis: (row.thesis as string | null) ?? null,
        buyAbove: config.buyAbove,
        oversoldRsi: config.oversoldRsi,
        maxVolPct: config.maxVolPct,
        dropBelow: config.dropBelow,
        active: Boolean(row.active),
        metrics,
        status: metrics ? describeWatchStatus(config, metrics) : "No price data yet.",
        firedToday: (alerts.data ?? []).map((a) => ({
          code: String(a.trigger_code),
          price: a.price == null ? null : Number(a.price),
          at: String(a.created_at),
        })),
      });
    }
    return { watches };
  });

export const upsertTickerWatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => UpsertInput.parse(v))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("ticker_watches").upsert(
      {
        user_id: userId,
        symbol: data.symbol,
        label: data.label ?? null,
        thesis: data.thesis ?? null,
        buy_above: data.buyAbove ?? null,
        oversold_rsi: data.oversoldRsi,
        max_vol_pct: data.maxVolPct,
        drop_below: data.dropBelow ?? null,
        active: data.active,
      },
      { onConflict: "user_id,symbol" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteTickerWatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("ticker_watches")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** On-demand AI read on a watched symbol, grounded in the live metrics. */
export const askTickerSecondOpinion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z.object({ symbol: z.string().trim().min(1).max(16) }).parse(v),
  )
  .handler(async ({ data }): Promise<SecondOpinion> => {
    const symbol = data.symbol.toUpperCase();
    const { loadTickerMetrics } = await import("@/lib/ticker-watch.server");
    const metrics = await loadTickerMetrics(symbol);

    const key = process.env["LOVABLE_API_KEY"];
    if (!key || !metrics) {
      return {
        symbol,
        metrics,
        verdict: metrics
          ? "AI commentary unavailable right now — the numbers above still stand on their own."
          : "No recent price history for this symbol yet.",
        model: null,
      };
    }

    const { createLovableAiGatewayProvider } = await import("@/lib/ai-gateway.server");
    const { generateText } = await import("ai");
    const model = "google/gemini-3.6-flash";
    const prompt = `You are a risk-aware portfolio analyst advising a GBP-based investor whose portfolio already carries US mega-cap and unhedged USD exposure.

Symbol: ${symbol}
Live metrics (JSON): ${JSON.stringify(metrics)}

In under 140 words, plain English, no markdown headings: give a clear WAIT / ACCUMULATE / AVOID verdict, the two strongest reasons from these numbers, the specific price or indicator level that would change your mind, and the level that invalidates the case. Be concrete about levels. Do not invent data that is not in the metrics.`;

    try {
      const gateway = createLovableAiGatewayProvider(key);
      const { text } = await generateText({ model: gateway(model), prompt });
      const cleaned = (text ?? "").trim().slice(0, 1200);
      if (!cleaned) throw new Error("empty response");
      return { symbol, metrics, verdict: cleaned, model };
    } catch (e) {
      console.warn("askTickerSecondOpinion failed", e);
      return {
        symbol,
        metrics,
        verdict: "AI commentary unavailable right now — try again shortly.",
        model: null,
      };
    }
  });
