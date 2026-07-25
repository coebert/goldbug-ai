import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { OrderReconcileSummary } from "@/lib/order-reconciliation.server";

export interface BackfillPortfolioResult {
  portfolioId: string;
  portfolioName: string | null;
  ok: boolean;
  error?: string;
  summary?: {
    scanned: number;
    filled: number;
    partial: number;
    rejected: number;
    cancelled: number;
    stillWorking: number;
    unknown: number;
  };
}

export interface BackfillResult {
  lookbackHours: number;
  totals: {
    scanned: number;
    filled: number;
    partial: number;
    rejected: number;
    cancelled: number;
    stillWorking: number;
    unknown: number;
  };
  portfolios: BackfillPortfolioResult[];
}

const Input = z
  .object({
    // 60 days default — captures anything since live routing began.
    lookbackHours: z.number().int().min(1).max(24 * 365).default(24 * 60),
    // Also include 'error' — orders that failed pre-broker won't reconcile,
    // but historically some in-flight failures were stored as 'error' when
    // the follow-up status update was lost.
    includeError: z.boolean().default(true),
    portfolioId: z.string().uuid().optional(),
  })
  .default({ lookbackHours: 24 * 60, includeError: true });

export const backfillOrderReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => Input.parse(v ?? {}))
  .handler(async ({ data, context }): Promise<BackfillResult> => {
    const { userId, supabase } = context;

    let q = supabase
      .from("portfolios")
      .select("id, name, mode")
      .eq("user_id", userId)
      .in("mode", ["live_sim", "live_prod"]);
    if (data.portfolioId) q = q.eq("id", data.portfolioId);
    const ports = await q;
    if (ports.error) throw new Error(ports.error.message);

    const statuses = ["pending", "submitted", "partial", "working"];
    if (data.includeError) statuses.push("error");

    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const { reconcileOrderStatusesForPortfolio } = await import(
      "@/lib/order-reconciliation.server"
    );

    const totals = {
      scanned: 0, filled: 0, partial: 0, rejected: 0,
      cancelled: 0, stillWorking: 0, unknown: 0,
    };
    const results: BackfillPortfolioResult[] = [];

    for (const p of ports.data ?? []) {
      const env = p.mode === "live_prod" ? "live" : "sim";
      try {
        const adapter = await buildSaxoAdapter({
          userId,
          portfolioId: p.id as string,
          envOverride: env,
        });
        const s: OrderReconcileSummary = await reconcileOrderStatusesForPortfolio({
          portfolioId: p.id as string,
          userId,
          adapter,
          lookbackHours: data.lookbackHours,
          statuses,
          source: "backfill",
        });
        totals.scanned += s.scanned;
        totals.filled += s.filled;
        totals.partial += s.partial;
        totals.rejected += s.rejected;
        totals.cancelled += s.cancelled;
        totals.stillWorking += s.stillWorking;
        totals.unknown += s.unknown;
        results.push({
          portfolioId: p.id as string,
          portfolioName: (p.name as string | null) ?? null,
          ok: true,
          summary: {
            scanned: s.scanned, filled: s.filled, partial: s.partial,
            rejected: s.rejected, cancelled: s.cancelled,
            stillWorking: s.stillWorking, unknown: s.unknown,
          },
        });
      } catch (e) {
        results.push({
          portfolioId: p.id as string,
          portfolioName: (p.name as string | null) ?? null,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { lookbackHours: data.lookbackHours, totals, portfolios: results };
  });
