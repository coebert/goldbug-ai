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

/**
 * Throws when `brokerAccountId` is already linked to a portfolio other than
 * `portfolioId`. No-ops when the account id is empty (paper/unlinked).
 */
export async function assertBrokerAccountUnclaimed(
  supabase: ClaimQueryClient,
  args: { portfolioId: string; broker: string; brokerAccountId: string | null | undefined },
): Promise<void> {
  const accountId = (args.brokerAccountId ?? "").trim();
  if (!accountId) return;

  const claimed = await supabase
    .from("portfolios")
    .select("id, name")
    .eq("broker", args.broker)
    .eq("broker_account_id", accountId)
    .neq("id", args.portfolioId);

  if (claimed.error) throw new Error(claimed.error.message);
  const other = claimed.data?.[0];
  if (other) throw new Error(brokerAccountClaimedMessage(accountId, other.name ?? other.id));
}
