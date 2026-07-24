// Shared portfolio ownership assertions + structured security audit logging.
//
// Extracted from `execution-slicer.server.ts` (see PendingSliceAccessError +
// assertPortfolioOwnership). This is the single place every server-side
// code path proves "does the authenticated caller own this portfolio row?"
// before touching admin-scoped data. Do NOT re-implement the check inline.
//
// Every rejected access is:
//   1. Logged with a stable `SECURITY:` prefix so ops greps stay useful.
//   2. Persisted (fire-and-forget) to `security_audit_log` for the UI.
//   3. Reported to `maybeNotifySecurityEvent` for push alerts.
//
// This module is server-only and imports `supabaseAdmin` at module scope,
// so its filename ends in `.ts` inside `_server/` — the eslint rule blocks
// any route/component from reaching this file transitively.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export class PortfolioAccessError extends Error {
  constructor(message: string, public readonly context: Record<string, unknown>) {
    super(message);
    this.name = "PortfolioAccessError";
  }
}

export type OwnershipEvent =
  | "pending_slices"
  | "trading"
  | "live"
  | "attribution"
  | "holdings"
  | "insights"
  | "backtest"
  | "generic";

export interface OwnershipLogContext {
  op: string;
  event?: OwnershipEvent;
  reason?: string;
  portfolioId?: string | null;
  sliceId?: string | null;
  ownerUserId?: string | null;
  [k: string]: unknown;
}

/**
 * Structured, greppable security log with best-effort persistence to
 * `security_audit_log`. Persistence + push notification are fire-and-forget:
 * a downstream failure never masks the original access-control decision.
 */
export function logUnexpectedAccess(context: OwnershipLogContext): void {
  const event = context.event ?? "generic";
  console.warn(
    `SECURITY:${event} unexpected access attempt`,
    JSON.stringify({ at: new Date().toISOString(), ...context }),
  );
  void (async () => {
    try {
      await supabaseAdmin.from("security_audit_log").insert({
        event,
        op: typeof context.op === "string" ? context.op : null,
        reason: typeof context.reason === "string" ? context.reason : null,
        portfolio_id:
          typeof context.portfolioId === "string" ? context.portfolioId : null,
        slice_id: typeof context.sliceId === "string" ? context.sliceId : null,
        actor_user_id:
          typeof context.ownerUserId === "string" ? context.ownerUserId : null,
        details: JSON.parse(JSON.stringify(context)),
      });
      const { maybeNotifySecurityEvent } = await import(
        "@/lib/security-alerts.server"
      );
      maybeNotifySecurityEvent({
        actorUserId:
          typeof context.ownerUserId === "string" ? context.ownerUserId : null,
        event,
        reason: typeof context.reason === "string" ? context.reason : null,
        portfolioId:
          typeof context.portfolioId === "string" ? context.portfolioId : null,
      });
    } catch (e) {
      console.warn(
        `SECURITY:${event} audit persist failed`,
        e instanceof Error ? e.message : String(e),
      );
    }
  })();
}

/**
 * Throws `PortfolioAccessError` and audit-logs if the caller does not own
 * `portfolioId`. Uses `supabaseAdmin` to bypass RLS so the check itself
 * cannot be circumvented by a caller with a valid session but wrong scope.
 */
export async function assertPortfolioOwnership(params: {
  op: string;
  portfolioId: string;
  ownerUserId: string;
  event?: OwnershipEvent;
}): Promise<void> {
  const { op, portfolioId, ownerUserId, event } = params;
  if (!portfolioId || !ownerUserId) {
    logUnexpectedAccess({ op, event, reason: "missing_ids", portfolioId, ownerUserId });
    throw new PortfolioAccessError("portfolio: missing portfolioId or ownerUserId", {
      op, portfolioId, ownerUserId,
    });
  }
  const { data, error } = await supabaseAdmin
    .from("portfolios")
    .select("id, user_id")
    .eq("id", portfolioId)
    .maybeSingle();
  if (error) {
    logUnexpectedAccess({
      op, event, reason: "portfolio_lookup_failed", portfolioId,
      error: error.message,
    });
    throw new PortfolioAccessError("portfolio: lookup failed", {
      op, portfolioId, error: error.message,
    });
  }
  if (!data) {
    logUnexpectedAccess({ op, event, reason: "portfolio_not_found", portfolioId, ownerUserId });
    throw new PortfolioAccessError("portfolio: not found", { op, portfolioId });
  }
  const actualOwner = (data as { user_id: string }).user_id;
  if (actualOwner !== ownerUserId) {
    logUnexpectedAccess({
      op, event, reason: "ownership_mismatch",
      portfolioId, expectedOwner: ownerUserId, actualOwner,
    });
    throw new PortfolioAccessError("portfolio: ownership mismatch", {
      op, portfolioId, expectedOwner: ownerUserId,
    });
  }
}
