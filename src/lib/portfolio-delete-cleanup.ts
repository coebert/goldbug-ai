// Deleting a portfolio must also release the broker-account claim it holds.
//
// The claim lives on `portfolios.broker_account_id` and is enforced by the
// `portfolios_unique_broker_account` partial unique index plus the pre-check in
// ./broker-account-claim. Row deletion normally drops the claim with the row,
// but a delete can match ZERO rows without raising an error (RLS hides the row,
// or the id is already gone). In that case the account stays locked to a
// portfolio the user believes is deleted, and the next activation fails with
// "already linked to …" naming a portfolio that isn't in their list.
//
// So: release the claim first, verify the delete actually removed a row, and
// restore the claim if the delete fails — never leave a half-cleaned state.
//
// Pure + client-safe: the Supabase client is injected so this is unit-testable.

import { releaseBrokerAccountPatch } from "./broker-account-claim";

export type DeletableRow = {
  id: string;
  name: string | null;
  broker: string | null;
  broker_account_id: string | null;
  mode: string | null;
};

type Result<T> = { data: T; error: { message: string } | null };

/** Minimal query-builder surface used by {@link deletePortfolioWithCleanup}. */
export type DeleteQueryClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        maybeSingle: () => PromiseLike<Result<DeletableRow | null>>;
      };
    };
    update: (patch: Record<string, unknown>) => {
      eq: (column: string, value: string) => PromiseLike<Result<unknown>>;
    };
    delete: () => {
      eq: (
        column: string,
        value: string,
      ) => {
        select: (columns: string) => PromiseLike<Result<{ id: string }[] | null>>;
      };
    };
  };
};

export type DeleteCleanupOutcome = {
  ok: true;
  /** The broker account freed by this delete, if the portfolio held one. */
  releasedBrokerAccountId: string | null;
};

export const PORTFOLIO_NOT_FOUND_MESSAGE =
  "That portfolio no longer exists, or you don't have access to it.";

/**
 * Deletes a portfolio and guarantees its broker-account claim is released.
 *
 * Order matters:
 *   1. read the row (so we know what claim, if any, is being given up),
 *   2. null `broker_account_id` — frees the unique index slot immediately,
 *   3. delete the row and require it to have matched,
 *   4. on delete failure, put the claim back so the still-live portfolio keeps
 *      trading its account.
 */
export async function deletePortfolioWithCleanup(
  supabase: DeleteQueryClient,
  portfolioId: string,
): Promise<DeleteCleanupOutcome> {
  const existing = await supabase
    .from("portfolios")
    .select("id, name, broker, broker_account_id, mode")
    .eq("id", portfolioId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  const row = existing.data;
  if (!row) throw new Error(PORTFOLIO_NOT_FOUND_MESSAGE);

  const heldAccount = (row.broker_account_id ?? "").trim() || null;

  if (heldAccount) {
    const released = await supabase
      .from("portfolios")
      .update(releaseBrokerAccountPatch())
      .eq("id", portfolioId);
    if (released.error) throw new Error(released.error.message);
  }

  const removed = await supabase
    .from("portfolios")
    .delete()
    .eq("id", portfolioId)
    .select("id");

  if (removed.error || !(removed.data?.length ?? 0)) {
    // Roll the claim back: the portfolio is still there and still live.
    if (heldAccount) {
      await supabase
        .from("portfolios")
        .update({ broker_account_id: heldAccount, mode: row.mode ?? "paper" })
        .eq("id", portfolioId);
    }
    throw new Error(removed.error?.message ?? PORTFOLIO_NOT_FOUND_MESSAGE);
  }

  return { ok: true, releasedBrokerAccountId: heldAccount };
}
