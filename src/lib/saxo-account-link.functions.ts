// Thin server-function wrappers for the guided Saxo account-key setup flow.
// All runtime logic lives in saxo-account-link.server.ts (server-fn modules
// get split at build time, so module-scope helpers here would vanish).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAal2 } from "@/lib/_server/require-aal2";
import type { AccountDiscovery, AccountKeyAuditEntry } from "@/lib/saxo-account-link.server";

export type { AccountDiscovery, AccountKeyAuditEntry, DiscoveredAccount } from "@/lib/saxo-account-link.server";

export const discoverSaxoAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AccountDiscovery[]> => {
    const { discoverAccountsForPortfolios } = await import("@/lib/saxo-account-link.server");
    const { data: portfolios } = await context.supabase
      .from("portfolios")
      .select("id, name, user_id, mode, broker, broker_account_id")
      .eq("user_id", context.userId)
      .in("mode", ["live_sim", "live_prod"])
      .order("name", { ascending: true });
    return discoverAccountsForPortfolios({
      userId: context.userId,
      portfolios: (portfolios ?? []) as never,
    });
  });

export const saveSaxoAccountKey = createServerFn({ method: "POST" })
  // Rebinding which real Saxo account live orders route to is risk-increasing,
  // so it needs the same step-up MFA as activateLive/deletePortfolio.
  .middleware([requireAal2])
  .inputValidator((input: { portfolioId: string; accountKey: string }) => {
    if (!input?.portfolioId) throw new Error("portfolioId is required");
    if (!input?.accountKey) throw new Error("accountKey is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { linkPortfolioAccountKey } = await import("@/lib/saxo-account-link.server");
    return linkPortfolioAccountKey({
      userId: context.userId,
      supabase: context.supabase as never,
      portfolioId: data.portfolioId,
      accountKey: data.accountKey,
    });
  });

export const listSaxoAccountKeyAudits = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AccountKeyAuditEntry[]> => {
    const { readAccountKeyAudits } = await import("@/lib/saxo-account-link.server");
    return readAccountKeyAudits(context.supabase as never, 30);
  });
