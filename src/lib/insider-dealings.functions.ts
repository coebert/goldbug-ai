import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { type InsiderDealingEvent } from "@/lib/insider-dealings";
import { insiderSignalsWithAi, type InsiderSignalRow } from "@/lib/insider-ai-scan";

export type InsiderDealingsFeed = {
  as_of: string;
  events: InsiderSignalRow[];
  signals: Array<{ symbol: string; nudge: number; events: number; cluster: number; reviewed: number }>;
  refreshed: boolean;
  targets: number;
  /** Summary of the most recent scheduled AI scan, when there has been one. */
  last_scan: {
    at: string;
    trigger: string;
    detected: number;
    ai_scored: number;
    signals: number;
    mechanical: number;
    noise: number;
  } | null;
};

function rowToEvent(r: Record<string, unknown>): InsiderSignalRow {
  return {
    symbol: String(r["symbol"] ?? ""),
    company: String(r["company"] ?? ""),
    event_date: (r["event_date"] as string | null) ?? null,
    headline: String(r["headline"] ?? ""),
    summary: (r["summary"] as string | null) ?? null,
    source: (r["source"] as string | null) ?? null,
    url: (r["url"] as string | null) ?? null,
    direction: (r["direction"] as InsiderDealingEvent["direction"]) ?? "unknown",
    flavour: (r["flavour"] as InsiderDealingEvent["flavour"]) ?? "unknown",
    person: (r["person"] as string | null) ?? null,
    role: (r["role"] as string | null) ?? null,
    shares: r["shares"] == null ? null : Number(r["shares"]),
    value: r["value"] == null ? null : Number(r["value"]),
    severity: Number(r["severity"] ?? 0),
    sentiment_nudge: Number(r["sentiment_nudge"] ?? 0),
    ai_verdict: (r["ai_verdict"] as InsiderSignalRow["ai_verdict"]) ?? null,
    ai_confidence: r["ai_confidence"] == null ? null : Number(r["ai_confidence"]),
    ai_nudge: r["ai_nudge"] == null ? null : Number(r["ai_nudge"]),
    ai_rationale: (r["ai_rationale"] as string | null) ?? null,
  };
}

/** Reads stored dealings, optionally refreshing the feeds first. */
export const getInsiderDealings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sinceDays?: number; refresh?: boolean } | undefined) => ({
    sinceDays: Math.max(1, Math.min(90, Math.round(Number(input?.sinceDays ?? 14)))),
    refresh: Boolean(input?.refresh),
  }))
  .handler(async ({ context, data }): Promise<InsiderDealingsFeed> => {
    const since = new Date(Date.now() - data.sinceDays * 86_400_000).toISOString().slice(0, 10);
    let targets = 0;
    let refreshed = false;

    if (data.refresh) {
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        void supabaseAdmin;
        const { runInsiderAiScan } = await import("@/lib/insider-ai-scan.server");
        const res = await runInsiderAiScan({ trigger: "manual", windowDays: 7 });
        targets = res.targets;
        refreshed = true;
      } catch (err) {
        console.warn("insider-dealings: refresh failed", err instanceof Error ? err.message : String(err));
      }
    }

    const { data: rows } = await context.supabase
      .from("insider_dealing_events")
      .select("*")
      .gte("event_date", since)
      .order("event_date", { ascending: false })
      .limit(200);

    const events = (rows ?? []).map((r) => rowToEvent(r as Record<string, unknown>));

    const { data: lastRun } = await context.supabase
      .from("insider_scan_runs")
      .select("created_at, trigger, detected, ai_scored, signals, mechanical, noise")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      as_of: new Date().toISOString(),
      events,
      signals: insiderSignalsWithAi(events).map((s) => ({
        symbol: s.symbol,
        nudge: s.nudge,
        events: s.events,
        cluster: s.cluster,
        reviewed: s.reviewed,
      })),
      refreshed,
      targets,
      last_scan: lastRun
        ? {
            at: String((lastRun as Record<string, unknown>)["created_at"] ?? ""),
            trigger: String((lastRun as Record<string, unknown>)["trigger"] ?? "cron"),
            detected: Number((lastRun as Record<string, unknown>)["detected"] ?? 0),
            ai_scored: Number((lastRun as Record<string, unknown>)["ai_scored"] ?? 0),
            signals: Number((lastRun as Record<string, unknown>)["signals"] ?? 0),
            mechanical: Number((lastRun as Record<string, unknown>)["mechanical"] ?? 0),
            noise: Number((lastRun as Record<string, unknown>)["noise"] ?? 0),
          }
        : null,
    };
  });
