import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  insiderSignalBySymbol,
  type InsiderDealingEvent,
} from "@/lib/insider-dealings";

export type InsiderDealingsFeed = {
  as_of: string;
  events: InsiderDealingEvent[];
  signals: Array<{ symbol: string; nudge: number; events: number }>;
  refreshed: boolean;
  targets: number;
};

function rowToEvent(r: Record<string, unknown>): InsiderDealingEvent {
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
        const { ingestInsiderDealings } = await import("@/lib/insider-dealings.server");
        const res = await ingestInsiderDealings(supabaseAdmin as never, { windowDays: 3 });
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
    return {
      as_of: new Date().toISOString(),
      events,
      signals: insiderSignalBySymbol(events).map((s) => ({
        symbol: s.symbol,
        nudge: s.nudge,
        events: s.events,
      })),
      refreshed,
      targets,
    };
  });
