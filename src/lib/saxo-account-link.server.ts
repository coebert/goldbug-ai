// Guided account-key linking: discover the accounts a broker environment
// actually exposes, and bind a portfolio to one of them.
//
// WHY THIS EXISTS: `SAXO_ACCOUNT_KEY` is a single process-wide value while
// account keys are environment-specific and per-account. Typing/pasting a key
// is how portfolios ended up pointing at accounts that do not exist in their
// environment. This module never accepts a free-text key: the user may only
// choose from the list the broker itself returned for that environment, and
// every change appends a row to `broker_account_key_audits`.

import { maskKey } from "@/lib/brokers/saxo-account-key";

export type DiscoveredAccount = {
  accountKey: string;
  masked: string;
  active: boolean;
  currency: string | null;
  assetTypes: string[];
  /** True when this is the key the portfolio is currently bound to. */
  current: boolean;
  /** True when this key is what the broker would auto-discover. */
  recommended: boolean;
};

export type AccountDiscovery = {
  portfolioId: string;
  portfolioName: string;
  env: "sim" | "live";
  currentKey: string | null;
  currentKeyMasked: string;
  currentKeyStatus: "valid" | "inactive" | "wrong_environment" | "unset";
  accounts: DiscoveredAccount[];
  error: string | null;
};

export type AccountKeyAuditEntry = {
  id: string;
  portfolioId: string | null;
  portfolioName: string | null;
  env: string;
  status: string;
  previousStatus: string | null;
  changed: boolean;
  mismatch: boolean;
  configuredKeyMasked: string | null;
  resolvedKeyMasked: string | null;
  message: string | null;
  checkedAt: string;
};

type PortfolioRow = {
  id: string;
  name: string | null;
  user_id: string;
  mode: string | null;
  broker: string | null;
  broker_account_id: string | null;
};

export function envForMode(mode: string | null): "sim" | "live" {
  return mode === "live_prod" ? "live" : "sim";
}

function pickRecommended(accounts: DiscoveredAccount[]): string | undefined {
  return (
    accounts.find((a) => a.active && a.assetTypes.some((t) => t === "Stock" || t === "Etf"))?.accountKey ??
    accounts.find((a) => a.active)?.accountKey ??
    accounts[0]?.accountKey
  );
}

/** Discover the accounts visible in each broker-capable portfolio's environment. */
export async function discoverAccountsForPortfolios(args: {
  userId: string;
  portfolios: PortfolioRow[];
}): Promise<AccountDiscovery[]> {
  const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
  const out: AccountDiscovery[] = [];

  // One broker call per distinct environment, shared across its portfolios.
  const byEnv = new Map<"sim" | "live", { accounts: DiscoveredAccount[]; error: string | null }>();

  for (const p of args.portfolios) {
    const env = envForMode(p.mode);
    if (!byEnv.has(env)) {
      try {
        const adapter = await buildSaxoAdapter({
          userId: args.userId,
          envOverride: env,
          // Account-agnostic probe: we are listing accounts, not trading.
          accountKey: null,
          strictAccountKey: false,
        });
        const raw = await adapter.listAccounts();
        byEnv.set(env, {
          error: null,
          accounts: raw.map((a) => ({
            accountKey: a.AccountKey!,
            masked: maskKey(a.AccountKey),
            active: a.Active !== false,
            currency: a.Currency ?? null,
            assetTypes: a.LegalAssetTypes ?? [],
            current: false,
            recommended: false,
          })),
        });
      } catch (e) {
        byEnv.set(env, { accounts: [], error: e instanceof Error ? e.message : String(e) });
      }
    }

    const found = byEnv.get(env)!;
    const currentKey = (p.broker_account_id ?? "").trim() || null;
    const recommended = pickRecommended(found.accounts);
    const accounts = found.accounts.map((a) => ({
      ...a,
      current: !!currentKey && a.accountKey === currentKey,
      recommended: a.accountKey === recommended,
    }));

    const match = accounts.find((a) => a.accountKey === currentKey);
    const currentKeyStatus: AccountDiscovery["currentKeyStatus"] = !currentKey
      ? "unset"
      : !match
        ? "wrong_environment"
        : match.active
          ? "valid"
          : "inactive";

    out.push({
      portfolioId: p.id,
      portfolioName: p.name ?? "Portfolio",
      env,
      currentKey,
      currentKeyMasked: maskKey(currentKey ?? undefined),
      currentKeyStatus,
      accounts,
      error: found.error,
    });
  }

  return out;
}

/**
 * Bind a portfolio to one of the discovered accounts.
 * Rejects any key the broker did not just report for that environment, so a
 * stale or cross-environment key can never be saved through this path.
 */
export async function linkPortfolioAccountKey(args: {
  userId: string;
  supabase: { from: (t: string) => any };
  portfolioId: string;
  accountKey: string;
}): Promise<{ ok: true; env: "sim" | "live"; masked: string } | { ok: false; reason: string }> {
  const { data: p } = await args.supabase
    .from("portfolios")
    .select("id, name, user_id, mode, broker, broker_account_id")
    .eq("id", args.portfolioId)
    .maybeSingle();
  if (!p) return { ok: false, reason: "Portfolio not found." };
  if (p.user_id !== args.userId) return { ok: false, reason: "Portfolio not owned by caller." };

  const env = envForMode(p.mode);
  const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
  let accounts: Awaited<ReturnType<Awaited<ReturnType<typeof buildSaxoAdapter>>["listAccounts"]>>;
  try {
    const adapter = await buildSaxoAdapter({
      userId: args.userId,
      envOverride: env,
      accountKey: null,
      strictAccountKey: false,
    });
    accounts = await adapter.listAccounts();
  } catch (e) {
    return { ok: false, reason: `Could not read the ${env} account list: ${e instanceof Error ? e.message : String(e)}` };
  }

  const match = accounts.find((a) => a.AccountKey === args.accountKey);
  if (!match) {
    return { ok: false, reason: `That account does not exist in the ${env} environment. Refresh the list and pick again.` };
  }
  if (match.Active === false) {
    return { ok: false, reason: "That account is marked inactive by the broker." };
  }

  const previousKey = (p.broker_account_id ?? "").trim() || null;
  const { error: updErr } = await args.supabase
    .from("portfolios")
    .update({ broker: "saxo", broker_account_id: args.accountKey })
    .eq("id", args.portfolioId);
  if (updErr) return { ok: false, reason: updErr.message };

  // Audit trail: append, never overwrite, so the key history is reconstructable.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: prev } = await supabaseAdmin
    .from("broker_account_key_audits")
    .select("status")
    .eq("portfolio_id", args.portfolioId)
    .eq("env", env)
    .order("checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const previousStatus = (prev?.status as string | undefined) ?? null;

  await supabaseAdmin.from("broker_account_key_audits").insert({
    portfolio_id: args.portfolioId,
    portfolio_name: p.name ?? null,
    env,
    configured_key_masked: maskKey(previousKey ?? undefined),
    resolved_key_masked: maskKey(args.accountKey),
    status: "valid",
    mismatch: false,
    account_count: accounts.length,
    message:
      previousKey === args.accountKey
        ? `Re-confirmed account ${maskKey(args.accountKey)} for ${p.name ?? "portfolio"} on ${env} (manual).`
        : `Manually linked ${p.name ?? "portfolio"} to account ${maskKey(args.accountKey)} on ${env} (was ${maskKey(previousKey ?? undefined)}).`,
    changed: previousStatus !== null && previousStatus !== "valid",
    previous_status: previousStatus,
  });

  return { ok: true, env, masked: maskKey(args.accountKey) };
}

export async function readAccountKeyAudits(
  supabase: { from: (t: string) => any },
  limit = 30,
): Promise<AccountKeyAuditEntry[]> {
  const { data } = await supabase
    .from("broker_account_key_audits")
    .select(
      "id, portfolio_id, portfolio_name, env, status, previous_status, changed, mismatch, configured_key_masked, resolved_key_masked, message, checked_at",
    )
    .order("checked_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    portfolioId: r.portfolio_id,
    portfolioName: r.portfolio_name,
    env: r.env,
    status: r.status,
    previousStatus: r.previous_status,
    changed: !!r.changed,
    mismatch: !!r.mismatch,
    configuredKeyMasked: r.configured_key_masked,
    resolvedKeyMasked: r.resolved_key_masked,
    message: r.message,
    checkedAt: r.checked_at,
  }));
}
