// Cron-triggered endpoint: composes a per-user daily portfolio summary and
// pushes it to each user's registered browser subscriptions.
// Called by pg_cron once per day at 22:00 UTC. Auth via x-cron-secret header.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/daily-summary")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { checkRateLimit, tooManyRequests } = await import("@/lib/rate-limit.server");
        const rl = await checkRateLimit(request, {
          bucket: "hooks:daily-summary",
          capacity: 5,
          refillPerSec: 5 / 3600,
        });
        if (!rl.allowed) return tooManyRequests(rl);

        const provided =
          request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        const expected = process.env.CRON_SECRET;
        if (!expected || provided !== expected) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { sendPushToUser } = await import("@/lib/push.server");

        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
        const dayStartIso = `${today}T00:00:00.000Z`;

        // Users with at least one push subscription
        const { data: subUsers, error: subErr } = await supabaseAdmin
          .from("push_subscriptions")
          .select("user_id");
        if (subErr) {
          return new Response(JSON.stringify({ error: subErr.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        const userIds = Array.from(new Set((subUsers ?? []).map((r) => r.user_id)));
        if (userIds.length === 0) {
          return Response.json({ success: true, users: 0, message: "no subscribers" });
        }

        const results: Array<{ userId: string; sent: number; removed: number; failed: number; skipped?: string }> = [];

        for (const uid of userIds) {
          try {
            const { data: portfolios } = await supabaseAdmin
              .from("portfolios")
              .select("id, name, currency, starting_cash, mode")
              .eq("user_id", uid);
            if (!portfolios || portfolios.length === 0) {
              results.push({ userId: uid, sent: 0, removed: 0, failed: 0, skipped: "no portfolios" });
              continue;
            }
            const ids = portfolios.map((p) => p.id);

            const [latestTotals, prevTotals, trades] = await Promise.all([
              supabaseAdmin
                .from("equity_snapshots")
                .select("portfolio_id, total_value, snapshot_date")
                .in("portfolio_id", ids)
                .order("snapshot_date", { ascending: false })
                .limit(200),
              supabaseAdmin
                .from("equity_snapshots")
                .select("portfolio_id, total_value, snapshot_date")
                .in("portfolio_id", ids)
                .lte("snapshot_date", yesterday)
                .order("snapshot_date", { ascending: false })
                .limit(200),
              supabaseAdmin
                .from("trades")
                .select("portfolio_id, side, symbol, quantity, price, value")
                .in("portfolio_id", ids)
                .gte("executed_at", dayStartIso),
            ]);

            const latestByP = new Map<string, number>();
            for (const r of latestTotals.data ?? []) {
              if (!latestByP.has(r.portfolio_id)) latestByP.set(r.portfolio_id, Number(r.total_value));
            }
            const prevByP = new Map<string, number>();
            for (const r of prevTotals.data ?? []) {
              if (!prevByP.has(r.portfolio_id)) prevByP.set(r.portfolio_id, Number(r.total_value));
            }
            const tradesByP = new Map<string, { buys: number; sells: number }>();
            for (const t of trades.data ?? []) {
              const b = tradesByP.get(t.portfolio_id) ?? { buys: 0, sells: 0 };
              if (t.side === "buy") b.buys++;
              else b.sells++;
              tradesByP.set(t.portfolio_id, b);
            }

            // Compose per-user summary text (portfolio-by-portfolio)
            const lines: string[] = [];
            let totalPnl = 0;
            let totalValue = 0;
            let hasAny = false;
            for (const p of portfolios) {
              const cur = latestByP.get(p.id) ?? Number(p.starting_cash);
              const prev = prevByP.get(p.id) ?? Number(p.starting_cash);
              const pnl = cur - prev;
              const pct = prev > 0 ? (pnl / prev) * 100 : 0;
              const tc = tradesByP.get(p.id) ?? { buys: 0, sells: 0 };
              const sign = pnl >= 0 ? "+" : "";
              const cs = p.currency || "GBP";
              lines.push(
                `${p.name}: ${cs}${cur.toFixed(0)} (${sign}${pnl.toFixed(0)}, ${sign}${pct.toFixed(2)}%) · ${tc.buys}B/${tc.sells}S`,
              );
              totalPnl += pnl;
              totalValue += cur;
              hasAny = true;
            }
            if (!hasAny) {
              results.push({ userId: uid, sent: 0, removed: 0, failed: 0, skipped: "no data" });
              continue;
            }

            const totalSign = totalPnl >= 0 ? "+" : "";
            const totalPct = totalValue - totalPnl > 0 ? (totalPnl / (totalValue - totalPnl)) * 100 : 0;
            const title = `Aegis daily · ${totalSign}${totalPnl.toFixed(0)} (${totalSign}${totalPct.toFixed(2)}%)`;
            const body = lines.slice(0, 4).join("\n");

            const res = await sendPushToUser(uid, {
              title,
              body,
              url: "/",
              tag: `aegis-daily-${today}`,
              requireInteraction: false,
            });
            results.push({ userId: uid, ...res });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`daily-summary: user ${uid} failed`, msg);
            results.push({ userId: uid, sent: 0, removed: 0, failed: 1, skipped: msg });
          }
        }

        return Response.json({ success: true, date: today, users: userIds.length, results });
      },
    },
  },
});
