// HTTP API route: clear (unblock) a learned Saxo instrument block.
//
// Deliberately NOT under /api/public — this route is auth-gated on published
// sites *and* verifies the caller itself, because unblocking an instrument
// puts it back into the live trading universe (a money-affecting action).
//
// Security layers, in order:
//   1. Bearer access token verified against Supabase Auth (getClaims).
//   2. Second factor enforced once the account has a verified TOTP factor.
//   3. Ownership: the block row must belong to the verified caller.
//   4. Zod-validated body; unknown/oversized input rejected.
//   5. Service-role writes happen only after all of the above, and are still
//      re-scoped with `.eq("user_id", ...)` inside the server helper.

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authorizeClearBrokerBlock } from "@/lib/broker-block-clear-authz";

const BodySchema = z.object({
  symbolKey: z.string().min(1).max(32),
  broker: z.string().min(1).max(32).optional(),
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

async function verifyBearer(request: Request): Promise<
  | { ok: true; userId: string; aal: string | null }
  | { ok: false }
> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return { ok: false };
  const token = header.slice("Bearer ".length).trim();
  if (!token || token.split(".").length !== 3) return { ok: false };

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) return { ok: false };

  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error } = await supabase.auth.getClaims(token);
  const sub = data?.claims?.sub;
  if (error || !sub) return { ok: false };
  const aal = typeof data.claims["aal"] === "string" ? (data.claims["aal"] as string) : null;
  return { ok: true, userId: sub, aal };
}

export const Route = createFileRoute("/api/broker-blocks/clear")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await verifyBearer(request);
        if (!auth.ok) {
          return json(
            { error: "unauthenticated", message: "Sign in to unblock instruments." },
            401,
          );
        }

        let body: z.infer<typeof BodySchema>;
        try {
          body = BodySchema.parse(await request.json());
        } catch {
          return json(
            { error: "invalid_request", message: "symbolKey is required." },
            400,
          );
        }
        const broker = body.broker ?? "saxo";

        const [{ findActiveBrokerBlock, clearBrokerBlock }, { hasVerifiedFactor }] =
          await Promise.all([
            import("@/lib/broker-instrument-blocks.server"),
            import("@/lib/_server/require-aal2"),
          ]);

        const block = await findActiveBrokerBlock({
          userId: auth.userId,
          symbolKey: body.symbolKey,
          broker,
        });

        const decision = authorizeClearBrokerBlock({
          authenticated: true,
          userId: auth.userId,
          aal: auth.aal,
          hasVerifiedFactor:
            auth.aal === "aal2" ? true : await hasVerifiedFactor(auth.userId),
          blockExists: Boolean(block),
          blockOwnerId: block?.ownerId ?? null,
        });

        if (!decision.ok) {
          return json({ error: decision.code, message: decision.message }, decision.status);
        }

        const cleared = await clearBrokerBlock({
          userId: auth.userId,
          symbolKey: body.symbolKey,
          broker,
        });

        if (cleared === 0) {
          return json(
            { error: "not_found", message: "No active block found for that instrument." },
            404,
          );
        }

        return json(
          { cleared, symbol: block?.symbol ?? body.symbolKey, broker },
          200,
        );
      },
    },
  },
});
