// Cron-triggered hourly-equity backfill.
//
// The Hourly chart used to seed itself only when someone opened the Hourly
// view. That means a fresh deploy, or a portfolio created overnight, shows an
// empty hourly line until a human happens to look at it. This endpoint runs
// the same backfill for every portfolio on a schedule so the history is
// already there. It is idempotent — recorded hours are never overwritten —
// so running it hourly is safe.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/backfill-intraday-equity")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:backfill-intraday-equity",
          capacity: 10,
          refillPerSec: 10 / 3600,
        });
        if (!verified.ok) return verified.response;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { backfillPortfolioIntradayEquity, type IntradayBackfillResult } = await import(
          "@/lib/equity-intraday-backfill.server"
        );

        let days = 365;
        try {
          const body = (await request.json()) as { days?: unknown } | null;
          const n = Number(body?.days);
          if (Number.isFinite(n) && n >= 1 && n <= 3650) days = Math.floor(n);
        } catch {
          // Empty or non-JSON body: keep the default window.
        }

        const { data: portfolios, error } = await supabaseAdmin.from("portfolios").select("id");
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const results: IntradayBackfillResult[] = [];
        for (const p of portfolios ?? []) {
          const id = String(p.id);
          try {
            results.push(await backfillPortfolioIntradayEquity(supabaseAdmin, id, days));
          } catch (err) {
            results.push({
              portfolioId: id,
              snapshots: 0,
              rowsWritten: 0,
              fromBucket: null,
              toBucket: null,
              skipped: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return Response.json({
          ok: true,
          days,
          portfoliosProcessed: results.length,
          totalRowsWritten: results.reduce((a, r) => a + r.rowsWritten, 0),
          priceShapedRows: results.reduce((a, r) => a + (r.priceShapedRows ?? 0), 0),
          results,
        });
      },
    },
  },
});
