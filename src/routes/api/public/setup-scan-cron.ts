// Scheduled market scan. pg_cron POSTs here on a fixed cadence; the handler
// refreshes the post-reclaim setup scan and stores the result so the UI can
// read cached matches instantly without triggering a scan itself.
//
// Security: requires the project's publishable (anon) key in the `apikey`
// header. The endpoint only writes to a table it owns end-to-end and returns
// counts, never user data.

import { createFileRoute } from "@tanstack/react-router";

function unauthorized(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/public/setup-scan-cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected =
          process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
        const provided =
          request.headers.get("apikey") ??
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
          "";
        if (!expected) return new Response("Scan cron not configured", { status: 503 });
        if (provided !== expected) return unauthorized("Missing or invalid apikey");

        const { getOrRefreshScan } = await import("@/lib/setup-scan-schedule.server");
        try {
          const { run, refreshed, note } = await getOrRefreshScan({
            source: "cron",
            force: true,
          });
          return new Response(
            JSON.stringify({
              success: true,
              refreshed,
              note,
              scanned: run?.scanned ?? 0,
              matches: run?.matches.length ?? 0,
              rateLimited: run?.rateLimited ?? false,
              ranAt: run?.ranAt ?? null,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (err) {
          return new Response(
            JSON.stringify({
              success: false,
              error: err instanceof Error ? err.message : "Scan failed",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
