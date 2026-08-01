// Idempotent live → paper deactivation.
//
// The endpoint contract this file implements:
//   - Calling it once flips the portfolio to paper and releases its broker
//     account in a single atomic statement.
//   - Calling it again (retry, double-tap, two tabs, a replayed request) is a
//     no-op that returns HTTP-success with `changed: false`.
//   - Either way the caller gets the SAME shape describing the portfolio's
//     current live/paper status, read back from the database — never inferred
//     from what the caller hoped happened.
//
// That last point is what makes the endpoint safe to poll: a client that lost
// the response to its first call can simply call again and learn the truth,
// rather than having to guess whether its earlier request landed.

import {
  LIVE_MODES,
  releaseBrokerAccountAtomically,
  type AtomicReleaseClient,
} from "./broker-account-claim";

/** Canonical live/paper status returned by every deactivate call. */
export type LiveStatus = {
  portfolio_id: string;
  /** Current mode as stored: "paper" | "live_sim" | "live_prod". */
  mode: string;
  /** True while the portfolio is in either live mode. */
  is_live: boolean;
  /** Broker key, kept after deactivation so the account can be re-linked. */
  broker: string | null;
  /** Null whenever the portfolio is not live — the claim is released. */
  broker_account_id: string | null;
  /** Live trading paused flag; always false once paper. */
  live_paused: boolean;
};

export type DeactivateResult = {
  ok: true;
  /** True only when THIS call performed the transition. */
  changed: boolean;
  /** Why nothing changed, when `changed` is false. */
  reason: "released" | "already_paper";
  status: LiveStatus;
  /** The account released by this call; null on a repeat call. */
  released_broker_account_id: string | null;
  /** Mode the portfolio was in before this call. */
  previous_mode: string;
};

/** Minimal read surface: one row by id, scoped to the owner. */
export type StatusReadClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        c: string,
        v: string,
      ) => {
        eq: (
          c: string,
          v: string,
        ) => {
          maybeSingle: () => PromiseLike<{
            data: Record<string, unknown> | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
};

export type DeactivateClient = AtomicReleaseClient & StatusReadClient;

export class PortfolioNotFoundError extends Error {
  constructor() {
    super("Portfolio not found");
    this.name = "PortfolioNotFoundError";
  }
}

const STATUS_COLUMNS = "id, mode, broker, broker_account_id, live_paused";

export function isLiveMode(mode: string | null | undefined): boolean {
  return (LIVE_MODES as readonly string[]).includes(String(mode ?? ""));
}

/** Normalise a portfolios row into the wire-stable status shape. */
export function toLiveStatus(row: Record<string, unknown>): LiveStatus {
  const mode = typeof row["mode"] === "string" ? (row["mode"] as string) : "paper";
  return {
    portfolio_id: String(row["id"] ?? ""),
    mode,
    is_live: isLiveMode(mode),
    broker: (row["broker"] as string | null) ?? null,
    broker_account_id: (row["broker_account_id"] as string | null) ?? null,
    live_paused: row["live_paused"] === true,
  };
}

/** Read the caller's own portfolio, or throw if it isn't theirs / doesn't exist. */
export async function readOwnedStatus(
  supabase: StatusReadClient,
  args: { portfolioId: string; userId: string },
): Promise<LiveStatus> {
  const res = await supabase
    .from("portfolios")
    .select(STATUS_COLUMNS)
    .eq("id", args.portfolioId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (res.error) throw new Error(res.error.message);
  // Ownership is enforced by the query itself, so "not mine" and "not there"
  // are deliberately indistinguishable — no portfolio-existence oracle.
  if (!res.data) throw new PortfolioNotFoundError();
  return toLiveStatus(res.data);
}

/**
 * Deactivate live trading, idempotently.
 *
 * Ordering note: the pre-read is only used to report `previous_mode` and to
 * reject unknown portfolios early. The transition itself is decided by the
 * atomic UPDATE's WHERE clause, so two concurrent callers cannot both report
 * `changed: true` even though both saw a live row in their pre-read.
 */
export async function deactivateLivePortfolio(
  supabase: DeactivateClient,
  args: { portfolioId: string; userId: string },
): Promise<DeactivateResult> {
  const before = await readOwnedStatus(supabase, args);

  const released = await releaseBrokerAccountAtomically(supabase, {
    portfolioId: args.portfolioId,
    userId: args.userId,
  });

  if (!released.changed) {
    // Zero rows matched: the portfolio was already paper, or another caller
    // won the race a moment ago. Re-read so the response reflects committed
    // state rather than our now-stale pre-read.
    const current = await readOwnedStatus(supabase, args);
    return {
      ok: true,
      changed: false,
      reason: "already_paper",
      status: current,
      released_broker_account_id: null,
      previous_mode: before.mode,
    };
  }

  const row = released.row;
  return {
    ok: true,
    changed: true,
    reason: "released",
    status: row
      ? toLiveStatus({ ...row, broker: before.broker })
      : { ...before, mode: "paper", is_live: false, broker_account_id: null, live_paused: false },
    released_broker_account_id: before.broker_account_id,
    previous_mode: before.mode,
  };
}
