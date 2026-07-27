import { createFileRoute } from "@tanstack/react-router";
import { backfillPortfolioDailyChanges } from "@/lib/daily-equity-changes-backfill.server";

export const Route = createFileRoute(
  "/api/public/hooks/backfill-daily-equity-changes",
)({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!apiKey || !expected || apiKey !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        let days = 30;
        try {
          const body = (await request.json()) as { days?: number };
          if (body?.days && Number.isFinite(body.days)) {
            days = Math.max(1, Math.min(3650, Math.floor(body.days)));
          }
        } catch {
          /* empty body is fine */
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        const { data: portfolios, error } = await supabaseAdmin
          .from("portfolios")
          .select("id, mode");
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        let totalRows = 0;
        let ok = 0;
        let failed = 0;
        for (const p of portfolios ?? []) {
          try {
            const r = await backfillPortfolioDailyChanges(
              supabaseAdmin,
              { id: p.id as string, mode: (p as { mode?: string }).mode ?? null },
              days,
            );
            totalRows += r.rowsWritten;
            ok += 1;
          } catch {
            failed += 1;
          }
        }
        return new Response(
          JSON.stringify({
            success: true,
            days,
            portfolios: portfolios?.length ?? 0,
            ok,
            failed,
            totalRowsWritten: totalRows,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
