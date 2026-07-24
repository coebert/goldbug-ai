// Dedicated Saxo OAuth keep-alive. Runs every ~30 min via pg_cron so the
// refresh-token window (which can be as short as 60 minutes on Saxo) is
// always rolled forward well before it lapses. Independent of the hourly
// trading tick so a slow tick or transient failure can't kill the broker
// connection.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/saxo-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:saxo-refresh",
          capacity: 20,
          refillPerSec: 20/3600,
        });
        if (!verified.ok) return verified.response;
        const { forceRefreshTokens, getOAuthStatus } = await import(
          "@/lib/brokers/saxo-oauth.server"
        );
        const result: Record<string, unknown> = {};
        for (const env of ["sim", "live"] as const) {
          try {
            const status = await getOAuthStatus(env);
            if (!status.appConfigured) {
              result[env] = { ok: true, skipped: "app not configured" };
              continue;
            }
            if (!status.connected || status.usingLegacyToken) {
              result[env] = { ok: true, skipped: "no oauth row" };
              continue;
            }
            const r = await forceRefreshTokens(env);
            result[env] = r.refreshed
              ? { ok: true, refreshed: true }
              : { ok: true, skipped: r.reason };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`saxo-refresh: ${env} failed`, msg);
            result[env] = { ok: false, error: msg };
          }
        }
        return new Response(
          JSON.stringify({ ok: true, at: new Date().toISOString(), envs: result }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
