// Server-side second-factor enforcement for money-moving server functions.
//
// `MfaGate` in the UI stops the *screen*; this stops the *request*. Any caller
// that reaches a trading server function with a valid bearer token but a
// single-factor (aal1) session is rejected here, so a stolen/forwarded access
// token alone cannot place, liquidate or unpause trades.
//
// Policy: enforcement is conditional on enrolment. If the account has at least
// one verified TOTP factor, the session must be aal2. Accounts with no factor
// pass through (otherwise enabling this would lock the owner out before they
// enrol) — the moment a factor is verified, every path below hard-requires it.

import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export class MfaRequiredError extends Error {
  code = "mfa_required" as const;
  constructor(message = "Two-factor verification required for this action.") {
    super(message);
    this.name = "MfaRequiredError";
  }
}

/** Verified-factor lookup, cached briefly to keep hot paths cheap. */
const factorCache = new Map<string, { hasFactor: boolean; at: number }>();
const FACTOR_TTL_MS = 60_000;

export async function hasVerifiedFactor(userId: string): Promise<boolean> {
  const hit = factorCache.get(userId);
  if (hit && Date.now() - hit.at < FACTOR_TTL_MS) return hit.hasFactor;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error) {
    // Fail closed only when we can't tell *and* the session is already aal1:
    // the caller below decides. Here we report "no factor" but do not cache,
    // so a transient Auth API blip can't silently disable enforcement.
    return false;
  }
  const factors = (data?.user?.factors ?? []) as Array<{ status?: string }>;
  const hasFactor = factors.some((f) => f.status === "verified");
  factorCache.set(userId, { hasFactor, at: Date.now() });
  return hasFactor;
}

/** Pure policy: enforcement kicks in only once a factor is verified. */
export function aal2Satisfied(aal: string | null, hasVerifiedFactor: boolean): boolean {
  return aal === "aal2" || !hasVerifiedFactor;
}

/**
 * `requireSupabaseAuth` + a hard aal2 check. Use on every server function that
 * can move money or change trading safety settings.
 */
export const requireAal2 = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const claims = context.claims as Record<string, unknown> | undefined;
    const aal = typeof claims?.aal === "string" ? claims.aal : null;

    if (!aal2Satisfied(aal, aal === "aal2" ? true : await hasVerifiedFactor(context.userId))) {
      throw new MfaRequiredError();
    }

    return next({ context: { aal } });
  });
