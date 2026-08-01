// One broker account may back at most one portfolio.
//
// Saxo resolves the SAME account key for every activation made with the same
// credentials, so without a guard a second portfolio silently claims an account
// another portfolio already owns. From then on every sync writes one broker
// snapshot into both books — the "portfolios are showing identical data" mirror
// error.
//
// Two layers protect this invariant:
//   1. this pre-check, which produces a readable message, and
//   2. the `portfolios_unique_broker_account` partial unique index, which wins
//      the race when two activations run concurrently.
//
// Pure + client-safe: the Supabase client is injected so this can be unit- and
// integration-tested without a live database.

export type ClaimRow = { id: string; name: string | null };

/** Minimal shape of the query builder used by {@link assertBrokerAccountUnclaimed}. */
export type ClaimQueryClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        eq: (column: string, value: string) => {
          neq: (
            column: string,
            value: string,
          ) => PromiseLike<{ data: ClaimRow[] | null; error: { message: string } | null }>;
        };
      };
    };
  };
};

/** The Postgres error raised by `portfolios_unique_broker_account`. */
export function isBrokerAccountUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string };
  if (e.code === "23505") return true;
  return /portfolios_unique_broker_account/i.test(e.message ?? "");
}

export function brokerAccountClaimedMessage(accountId: string, otherName: string): string {
  return (
    `Broker account ${accountId} is already linked to "${otherName}". ` +
    `Two portfolios cannot share one broker account — they would mirror each other's ` +
    `holdings and equity. Deactivate live trading on "${otherName}" first, or use a ` +
    `different Saxo account for this portfolio.`
  );
}

/** Fallback owner label when the conflicting row can't be read (e.g. RLS hides it). */
export const UNKNOWN_CLAIM_OWNER = "another portfolio";

export type ClaimLookupArgs = {
  portfolioId: string;
  broker: string;
  brokerAccountId: string | null | undefined;
};

/** The portfolio (other than `portfolioId`) currently holding this account, if any. */
export async function findBrokerAccountClaimant(
  supabase: ClaimQueryClient,
  args: ClaimLookupArgs,
): Promise<ClaimRow | null> {
  const accountId = (args.brokerAccountId ?? "").trim();
  if (!accountId) return null;

  const claimed = await supabase
    .from("portfolios")
    .select("id, name")
    .eq("broker", args.broker)
    .eq("broker_account_id", accountId)
    .neq("id", args.portfolioId);

  if (claimed.error) throw new Error(claimed.error.message);
  return claimed.data?.[0] ?? null;
}

/**
 * THE single source of the conflict wording. Both the pre-check and the
 * unique-index violation path go through here, so a user sees byte-identical
 * text whether the clash was caught before the write or by Postgres during a
 * concurrent activation race.
 */
export async function brokerAccountConflictMessage(
  supabase: ClaimQueryClient,
  args: ClaimLookupArgs,
): Promise<string> {
  const accountId = (args.brokerAccountId ?? "").trim();
  let owner = UNKNOWN_CLAIM_OWNER;
  try {
    const other = await findBrokerAccountClaimant(supabase, args);
    if (other) owner = other.name ?? other.id;
  } catch {
    // Lookup failure must never mask the real conflict — fall back to the
    // generic owner label rather than surfacing a different error.
  }
  return brokerAccountClaimedMessage(accountId, owner);
}

/**
 * Throws when `brokerAccountId` is already linked to a portfolio other than
 * `portfolioId`. No-ops when the account id is empty (paper/unlinked).
 */
export async function assertBrokerAccountUnclaimed(
  supabase: ClaimQueryClient,
  args: ClaimLookupArgs,
): Promise<void> {
  const accountId = (args.brokerAccountId ?? "").trim();
  if (!accountId) return;

  const other = await findBrokerAccountClaimant(supabase, args);
  if (other) throw new Error(brokerAccountClaimedMessage(accountId, other.name ?? other.id));
}

/**
 * The patch that RELEASES a broker-account claim when a portfolio goes back to
 * paper. `broker_account_id` must be nulled: the partial unique index only
 * covers non-null ids, and the pre-check matches on (broker, account) with no
 * regard for mode — so leaving the id behind keeps the account locked to a
 * portfolio that no longer trades it.
 */
export function releaseBrokerAccountPatch() {
  return {
    mode: "paper" as const,
    live_paused: false,
    broker_account_id: null,
  };
}

/** Modes that mean "this portfolio is bound to a broker account". */
export const LIVE_MODES = ["live_sim", "live_prod"] as const;
export type LiveMode = (typeof LIVE_MODES)[number];

export type AtomicReleaseRow = {
  id: string;
  mode: string | null;
  broker_account_id: string | null;
  live_paused: boolean | null;
};

/** Query-builder surface for {@link releaseBrokerAccountAtomically}. */
export type AtomicReleaseClient = {
  from: (table: string) => {
    update: (patch: Record<string, unknown>) => {
      eq: (
        c: string,
        v: string,
      ) => {
        eq: (
          c: string,
          v: string,
        ) => {
          in: (
            c: string,
            v: readonly string[],
          ) => {
            select: (
              columns: string,
            ) => PromiseLike<{
              data: AtomicReleaseRow[] | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
};

export type AtomicReleaseResult = {
  changed: boolean;
  row: AtomicReleaseRow | null;
};

/**
 * Goes live → paper AND drops the broker-account claim in ONE statement.
 *
 * Why one statement: `mode` and `broker_account_id` are two halves of the same
 * invariant — "a live portfolio owns exactly one account". Writing them in
 * separate round-trips (or checking the mode in JS and then updating) leaves a
 * window where the row is paper but still holds the account, which the claim
 * pre-check reads as "account taken" by a portfolio that no longer trades it.
 * A single UPDATE ... WHERE is atomic in Postgres, so no reader ever observes
 * the half-updated pair, and a concurrent duplicate deactivate simply matches
 * zero rows instead of clobbering a re-activation.
 *
 * Guards are part of the same WHERE, so ownership and the live-mode
 * precondition are enforced by the write itself rather than by a prior read:
 *   - `user_id` — RLS-equivalent ownership, re-checked at write time,
 *   - `mode IN (live_sim, live_prod)` — makes repeat calls a no-op (0 rows).
 */
export async function releaseBrokerAccountAtomically(
  supabase: AtomicReleaseClient,
  args: { portfolioId: string; userId: string },
): Promise<AtomicReleaseResult> {
  const res = await supabase
    .from("portfolios")
    .update(releaseBrokerAccountPatch())
    .eq("id", args.portfolioId)
    .eq("user_id", args.userId)
    .in("mode", LIVE_MODES)
    .select("id, mode, broker_account_id, live_paused");

  if (res.error) throw new Error(res.error.message);

  const row = res.data?.[0] ?? null;
  if (!row) return { changed: false, row: null };

  // The returned row is the POST-update state: if either half is missing the
  // write didn't land as one unit and the caller must not report success.
  if (row.broker_account_id !== null || row.mode !== "paper") {
    throw new Error(
      "Deactivation did not fully release the broker account — refusing to report success. Please retry.",
    );
  }
  return { changed: true, row };
}
