import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * Latest broker charge-sync alert for a portfolio, for the dashboard banner.
 * Reads through the RLS-scoped client so a caller only ever sees their own
 * notifications.
 */
export const getCostSyncAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        sinceHours: z.number().int().min(1).max(168).default(24),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const sinceIso = new Date(Date.now() - data.sinceHours * 3600_000).toISOString();
    const q = await context.supabase
      .from("notifications")
      .select("id, created_at, severity, title, body, details, read_at")
      .eq("portfolio_id", data.portfolioId)
      .eq("category", "broker_cost_sync")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1);
    if (q.error) throw new Error(q.error.message);

    const row = q.data?.[0];
    if (!row) return { alert: null as null };

    const details = (row.details ?? {}) as {
      status?: string;
      coverage_pct?: number;
      fills_considered?: number;
      unmatched_fills?: number;
      error?: string | null;
    };
    return {
      alert: {
        id: row.id as string,
        at: row.created_at as string,
        severity: String(row.severity ?? "warning"),
        title: String(row.title ?? "Broker charge sync issue"),
        body: String(row.body ?? ""),
        status: details.status === "failed" ? "failed" : "partial",
        coveragePct: Number(details.coverage_pct ?? 0),
        fillsConsidered: Number(details.fills_considered ?? 0),
        unmatchedFills: Number(details.unmatched_fills ?? 0),
        readAt: (row.read_at as string | null) ?? null,
      },
    };
  });

/** Dismiss the banner by marking the alert read. */
export const dismissCostSyncAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
