// The equity-snapshot write gate.
//
// EVERY write to `equity_snapshots` goes through this module. Nothing else in
// the app is allowed to call `.from("equity_snapshots").insert/upsert(...)` —
// there is a guard test (`valuation-write-gate.guard.test.ts`) that fails the
// suite if a new writer appears.
//
// The gate enforces, in order:
//   1. arithmetic invariants (finite, non-negative, total == cash + holdings)
//   2. a plausibility band vs the previous snapshot, unless the move is
//      explained by a recorded fund event or the figures are broker-authoritative
//   3. provenance capture, so any suspect number can be explained later
//      without re-deriving it
//
// Rejections are logged to `valuation_write_rejections` and returned to the
// caller. They are never silently swallowed, and they never throw: a bad
// valuation must not take down a trading tick, it must just fail to persist.

import {
  checkEquityInvariants,
  summariseInvariantResult,
  type EquityInvariantViolation,
} from "../equity-invariants";
import { compactProvenance, type ValuationProvenance } from "./kernel";

/** Where the numbers came from. Drives which checks apply. */
export type SnapshotSource =
  | "trading_engine"
  | "broker_sync"
  | "backfill"
  | "revalue"
  | "fund_event"
  | "manual";

/** Broker-reported totals are authoritative: we never second-guess the size
 *  of the move, only the internal arithmetic. */
const AUTHORITATIVE_SOURCES: ReadonlySet<SnapshotSource> = new Set<SnapshotSource>([
  "broker_sync",
  "fund_event",
]);

/** Default plausibility band vs the prior snapshot. */
export const DEFAULT_JUMP_FACTOR = 3;

/** Ignore the band below this equity level — small pots move by large ratios. */
export const JUMP_FLOOR = 100;

export type SnapshotWriteInput = {
  portfolioId: string;
  snapshotDate: string;
  cash: number;
  holdingsValue: number;
  /** Defaults to cash + holdingsValue. */
  totalValue?: number;
  currency?: string | null;
  source: SnapshotSource;
  provenance?: ValuationProvenance | null;
  /** Override the plausibility band (e.g. a stress test). */
  jumpFactor?: number;
  /** Net external funding on this date, in base currency; explains a jump. */
  fundFlow?: number | null;
  /**
   * True when the portfolio is bound to a broker account. Combined with
   * `positionCount === 0`, an empty book means "positions have not been
   * imported yet", not "the account is flat" — persisting that writes a
   * cash-only snapshot that later shows up as an implausible jump the day
   * the real positions land.
   */
  brokerLinked?: boolean;
  /** Number of holdings rows the valuation was built from. */
  positionCount?: number;
  /**
   * Prior snapshot total, when the caller already has the series in memory
   * (backfill/revalue). Supplying it avoids a per-row database round-trip.
   * `null` means "explicitly no prior snapshot"; omit to have the gate look
   * it up itself.
   */
  priorTotal?: number | null;
};

export type SnapshotWriteResult = {
  written: boolean;
  reason?: "invariants" | "implausible_jump" | "unsynced_positions" | "db_error";
  message?: string;
  violations?: EquityInvariantViolation[];
};


type MinimalClient = {
  from: (table: string) => any;
};

type PriorSnapshot = { total_value: number } | null;

async function priorSnapshot(
  client: MinimalClient,
  portfolioId: string,
  snapshotDate: string,
): Promise<PriorSnapshot> {
  try {
    const { data } = await client
      .from("equity_snapshots")
      .select("total_value")
      .eq("portfolio_id", portfolioId)
      .lt("snapshot_date", snapshotDate)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    const t = Number(data.total_value);
    return Number.isFinite(t) ? { total_value: t } : null;
  } catch {
    return null;
  }
}

/** Source of the row already stored for this exact date, if any. */
async function existingSnapshotSource(
  client: MinimalClient,
  portfolioId: string,
  snapshotDate: string,
): Promise<SnapshotSource | null> {
  try {
    const { data } = await client
      .from("equity_snapshots")
      .select("source")
      .eq("portfolio_id", portfolioId)
      .eq("snapshot_date", snapshotDate)
      .maybeSingle();
    const src = (data as { source?: string } | null)?.source;
    return (src as SnapshotSource | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Pure part of the band check, exported so it can be unit-tested without a
 * database. Returns null when the move is acceptable.
 */
export function checkPlausibleMove(args: {
  priorTotal: number | null;
  nextTotal: number;
  fundFlow?: number | null;
  jumpFactor?: number;
}): string | null {
  const { priorTotal, nextTotal } = args;
  const factor = args.jumpFactor ?? DEFAULT_JUMP_FACTOR;
  if (priorTotal == null || !Number.isFinite(priorTotal)) return null;
  // Net out any external funding before judging the size of the move.
  const flow = Number(args.fundFlow ?? 0);
  const baseline = priorTotal + (Number.isFinite(flow) ? flow : 0);
  if (baseline <= JUMP_FLOOR) return null;
  const ratio = nextTotal / baseline;
  if (ratio > factor) {
    return `total_value ${nextTotal.toFixed(2)} is ${ratio.toFixed(1)}x the expected baseline ${baseline.toFixed(2)} (limit ${factor}x)`;
  }
  if (ratio < 1 / factor) {
    return `total_value ${nextTotal.toFixed(2)} is ${(1 / ratio).toFixed(1)}x below the expected baseline ${baseline.toFixed(2)} (limit ${factor}x)`;
  }
  return null;
}

async function logRejection(
  client: MinimalClient,
  input: SnapshotWriteInput,
  reason: string,
  message: string,
  violations: EquityInvariantViolation[],
): Promise<void> {
  try {
    await client.from("valuation_write_rejections").insert({
      portfolio_id: input.portfolioId,
      snapshot_date: input.snapshotDate,
      source: input.source,
      reason: `${reason}: ${message}`,
      attempted: {
        cash: input.cash,
        holdings_value: input.holdingsValue,
        total_value: input.totalValue ?? input.cash + input.holdingsValue,
        currency: input.currency ?? null,
      },
      violations: violations.length ? violations : null,
    });
  } catch {
    /* the audit log must never break the caller */
  }
  console.warn(
    `[valuation-gate] rejected ${input.source} snapshot for ${input.portfolioId} on ${input.snapshotDate} — ${reason}: ${message}`,
  );
}

/**
 * Validate and persist one equity snapshot. Returns `{ written: false }` with
 * a reason rather than throwing when the figures fail a check.
 */
export async function writeEquitySnapshot(
  client: MinimalClient,
  input: SnapshotWriteInput,
): Promise<SnapshotWriteResult> {
  const total = input.totalValue ?? input.cash + input.holdingsValue;

  const invariants = checkEquityInvariants({
    portfolioId: input.portfolioId,
    snapshotDate: input.snapshotDate,
    cash: input.cash,
    holdingsValue: input.holdingsValue,
    totalValue: total,
    currency: input.currency ?? undefined,
  });

  if (!invariants.ok && invariants.worstSeverity === "error") {
    const message = summariseInvariantResult(invariants);
    await logRejection(client, input, "invariants", message, invariants.violations);
    return { written: false, reason: "invariants", message, violations: invariants.violations };
  }

  // A broker-linked account with an empty local book has not been synced yet.
  // Writing that as a flat, cash-only day fabricates a valuation floor which
  // the next (correct) snapshot then breaches as an "implausible jump".
  if (
    !AUTHORITATIVE_SOURCES.has(input.source) &&
    input.brokerLinked === true &&
    (input.positionCount ?? 0) === 0 &&
    Math.abs(input.holdingsValue) < 0.005
  ) {
    const message =
      "broker-linked portfolio has no imported holdings yet; refusing to store a cash-only snapshot";
    await logRejection(client, input, "unsynced_positions", message, []);
    return { written: false, reason: "unsynced_positions", message };
  }



  if (!AUTHORITATIVE_SOURCES.has(input.source)) {
    const prior =
      input.priorTotal !== undefined
        ? input.priorTotal
        : (await priorSnapshot(client, input.portfolioId, input.snapshotDate))?.total_value ?? null;
    const problem = checkPlausibleMove({
      priorTotal: prior,
      nextTotal: total,
      fundFlow: input.fundFlow,
      jumpFactor: input.jumpFactor,
    });
    if (problem) {
      await logRejection(client, input, "implausible_jump", problem, []);
      return { written: false, reason: "implausible_jump", message: problem };
    }
  }

  const { error } = await client.from("equity_snapshots").upsert(
    {
      portfolio_id: input.portfolioId,
      snapshot_date: input.snapshotDate,
      cash: input.cash,
      holdings_value: input.holdingsValue,
      total_value: total,
      source: input.source,
      provenance: input.provenance ? compactProvenance(input.provenance) : null,
    },
    { onConflict: "portfolio_id,snapshot_date" },
  );

  if (error) {
    return { written: false, reason: "db_error", message: error.message };
  }
  return { written: true };
}

/**
 * Batch variant for the backfill/revalue paths. Each row is gated
 * independently; the result reports how many survived.
 */
export async function writeEquitySnapshots(
  client: MinimalClient,
  rows: SnapshotWriteInput[],
): Promise<{ written: number; rejected: (SnapshotWriteResult & { portfolioId: string; snapshotDate: string })[] }> {
  let written = 0;
  const rejected: (SnapshotWriteResult & { portfolioId: string; snapshotDate: string })[] = [];
  for (const row of rows) {
    const res = await writeEquitySnapshot(client, row);
    if (res.written) written += 1;
    else rejected.push({ ...res, portfolioId: row.portfolioId, snapshotDate: row.snapshotDate });
  }
  return { written, rejected };
}
