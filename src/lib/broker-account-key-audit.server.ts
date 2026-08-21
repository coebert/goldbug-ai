// Scheduled revalidation of Saxo account keys against each broker environment.
//
// BUG THIS EXISTS TO PREVENT: an account key is only ever validated lazily, on
// the first broker call of a run. A key that silently stops existing (account
// closed, environment migrated, env var rotated) therefore only surfaces as a
// failed trading tick, at the worst possible moment. This job asks each broker
// environment "is this key still real and active?" on a schedule and appends a
// row to `broker_account_key_audits`, so a status change (valid →
// wrong_environment, for example) is visible as history rather than inferred
// from a broken run.
//
// Every check is best-effort: one portfolio's broker outage must never abort
// the sweep for the others.

import { maskKey, type SaxoAccountKeyStatus } from "@/lib/brokers/saxo-account-key";

export type AccountKeyAuditRow = {
  portfolioId: string | null;
  portfolioName: string | null;
  env: "sim" | "live";
  status: SaxoAccountKeyStatus | "error";
  mismatch: boolean;
  accountCount: number;
  configuredKeyMasked: string;
  resolvedKeyMasked: string;
  message: string;
  changed: boolean;
  previousStatus: string | null;
};

type PortfolioRow = {
  id: string;
  name: string | null;
  user_id: string;
  mode: string | null;
  broker: string | null;
  broker_account_id: string | null;
};

async function checkOne(args: {
  userId: string;
  portfolioId: string | null;
  portfolioName: string | null;
  env: "sim" | "live";
  accountKey: string | null;
}): Promise<Omit<AccountKeyAuditRow, "changed" | "previousStatus">> {
  const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
  try {
    const adapter = await buildSaxoAdapter({
      userId: args.userId,
      portfolioId: args.portfolioId,
      envOverride: args.env,
      accountKey: args.accountKey,
      // Auditing must observe the mismatch, not throw on it.
      strictAccountKey: false,
    });
    const resolution = await adapter.validateAccountKey();
    if (!resolution) {
      return {
        portfolioId: args.portfolioId,
        portfolioName: args.portfolioName,
        env: args.env,
        status: "error",
        mismatch: false,
        accountCount: 0,
        configuredKeyMasked: maskKey(args.accountKey ?? undefined),
        resolvedKeyMasked: maskKey(undefined),
        message: "Broker did not return an account list; validation inconclusive.",
      };
    }
    return {
      portfolioId: args.portfolioId,
      portfolioName: args.portfolioName,
      env: args.env,
      status: resolution.status,
      mismatch: resolution.mismatch,
      accountCount: resolution.accountCount,
      configuredKeyMasked: maskKey(resolution.configured),
      resolvedKeyMasked: maskKey(resolution.accountKey),
      message: resolution.message,
    };
  } catch (e) {
    return {
      portfolioId: args.portfolioId,
      portfolioName: args.portfolioName,
      env: args.env,
      status: "error",
      mismatch: false,
      accountCount: 0,
      configuredKeyMasked: maskKey(args.accountKey ?? undefined),
      resolvedKeyMasked: maskKey(undefined),
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Statuses that mean the configured key is not usable as-is. */
export function isProblemStatus(status: string): boolean {
  return status !== "valid" && status !== "discovered";
}

export async function revalidateBrokerAccountKeys(): Promise<AccountKeyAuditRow[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: portfolios } = await supabaseAdmin
    .from("portfolios")
    .select("id, name, user_id, mode, broker, broker_account_id")
    .eq("broker", "saxo");

  const targets: Array<{
    userId: string;
    portfolioId: string | null;
    portfolioName: string | null;
    env: "sim" | "live";
    accountKey: string | null;
  }> = [];

  for (const p of (portfolios ?? []) as PortfolioRow[]) {
    const key = (p.broker_account_id ?? "").trim();
    if (!key) continue;
    targets.push({
      userId: p.user_id,
      portfolioId: p.id,
      portfolioName: p.name ?? null,
      env: p.mode === "live_prod" ? "live" : "sim",
      accountKey: key,
    });
  }

  // Also audit the process-wide default key (portfolio_id = null) in each
  // environment a portfolio actually uses, since unscoped admin probes fall
  // back to it.
  const defaultKey = (process.env["SAXO_ACCOUNT_KEY"] ?? "").trim();
  const anyUser = (portfolios ?? [])[0]?.user_id;
  if (defaultKey && anyUser) {
    for (const env of Array.from(new Set(targets.map((t) => t.env)))) {
      targets.push({
        userId: anyUser,
        portfolioId: null,
        portfolioName: "SAXO_ACCOUNT_KEY (default)",
        env,
        accountKey: defaultKey,
      });
    }
  }

  const rows: AccountKeyAuditRow[] = [];
  for (const target of targets) {
    const result = await checkOne(target);

    // Compare with the previous audit for the same (portfolio, env) pair.
    let previousQuery = supabaseAdmin
      .from("broker_account_key_audits")
      .select("status")
      .eq("env", target.env)
      .order("checked_at", { ascending: false })
      .limit(1);
    previousQuery = target.portfolioId
      ? previousQuery.eq("portfolio_id", target.portfolioId)
      : previousQuery.is("portfolio_id", null);
    const { data: prev } = await previousQuery.maybeSingle();
    const previousStatus = (prev?.status as string | undefined) ?? null;
    const changed = previousStatus !== null && previousStatus !== result.status;

    const row: AccountKeyAuditRow = { ...result, changed, previousStatus };
    rows.push(row);

    await supabaseAdmin.from("broker_account_key_audits").insert({
      portfolio_id: row.portfolioId,
      portfolio_name: row.portfolioName,
      env: row.env,
      configured_key_masked: row.configuredKeyMasked,
      resolved_key_masked: row.resolvedKeyMasked,
      status: row.status,
      mismatch: row.mismatch,
      account_count: row.accountCount,
      message: row.message,
      changed: row.changed,
      previous_status: row.previousStatus,
    });
  }

  return rows;
}
