import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { OrderReconcileSummary } from "@/lib/order-reconciliation.server";

import { Input } from "./order-reconciliation-backfill.helpers";
import type { BackfillPortfolioResult, BackfillResult } from "./order-reconciliation-backfill.helpers";
export type { BackfillPortfolioResult, BackfillResult };

export const backfillOrderReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => Input.parse(v ?? {}))
  .handler(async ({ data, context }): Promise<BackfillResult> => {
    const { userId, supabase } = context;

    let q = supabase
      .from("portfolios")
      .select("id, name, mode, broker, broker_account_id")
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
          accountKey: (p.broker_account_id as string | null) ?? undefined,
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
