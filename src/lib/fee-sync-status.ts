/**
 * Per-fill fee sync state.
 *
 * `fee_source` says where a number came from; it cannot say *why* a trade is
 * still on modelled costs. That distinction matters because the three reasons
 * a fill is missing broker pricing are not equally actionable: a trade the
 * broker hasn't published yet fixes itself, a trade whose charge never matched
 * needs investigating, and a venue with no cost report will never be priced at
 * all. Collapsing them into "not invoiced" hides which of those you're looking
 * at, so the status and its reason are stored on the fill itself.
 */

export const FEE_SYNC_STATUSES = ["invoiced", "pending", "unmatched", "unsupported"] as const;
export type FeeSyncStatus = (typeof FEE_SYNC_STATUSES)[number];

export function isFeeSyncStatus(v: unknown): v is FeeSyncStatus {
  return typeof v === "string" && (FEE_SYNC_STATUSES as readonly string[]).includes(v);
}

/** Falls back to the old `fee_source` marker so legacy rows still classify. */
export function coerceFeeSyncStatus(row: {
  feeSyncStatus?: unknown;
  feeSource?: unknown;
  fee?: unknown;
}): FeeSyncStatus {
  if (isFeeSyncStatus(row.feeSyncStatus)) return row.feeSyncStatus;
  if (row.feeSource === "broker") return "invoiced";
  if (typeof row.fee === "number" && row.fee > 0 && row.feeSource == null) return "invoiced";
  return "pending";
}

export const FEE_SYNC_LABELS: Record<FeeSyncStatus, string> = {
  invoiced: "Broker-priced",
  pending: "Awaiting broker",
  unmatched: "No matching charge",
  unsupported: "No cost report",
};

export const FEE_SYNC_EXPLANATIONS: Record<FeeSyncStatus, string> = {
  invoiced: "The broker has billed these trades and the exact cost is on the tape.",
  pending: "Placed recently — the broker usually publishes charges the next business day.",
  unmatched: "A charge for these trades never appeared in the report; costs stay modelled.",
  unsupported: "This account's broker publishes no cost report, so costs stay modelled.",
};

export type FeeSyncRow = {
  feeSyncStatus?: unknown;
  feeSource?: unknown;
  fee?: unknown;
  feeSyncReason?: string | null;
  feeSyncedAt?: string | null;
  feeSyncAttemptedAt?: string | null;
};

export type FeeSyncBucket = {
  status: FeeSyncStatus;
  label: string;
  count: number;
  /** Most common stored reason for this bucket, when the broker gave one. */
  reason: string | null;
};

export type FeeSyncSummary = {
  total: number;
  invoiced: number;
  /** Share of the tape carrying broker-booked costs, 0..1. */
  coverage: number;
  buckets: FeeSyncBucket[];
  /** Most recent successful sync across the tape, ISO, or null if never. */
  lastSyncedAt: string | null;
  /** Most recent attempt, successful or not. */
  lastAttemptAt: string | null;
};

function latest(a: string | null, b: unknown): string | null {
  const cand = typeof b === "string" && b ? b : null;
  if (!cand) return a;
  if (!a) return cand;
  return Date.parse(cand) > Date.parse(a) ? cand : a;
}

export function summariseFeeSync(rows: readonly FeeSyncRow[]): FeeSyncSummary {
  const counts = new Map<FeeSyncStatus, number>();
  const reasons = new Map<FeeSyncStatus, Map<string, number>>();
  let lastSyncedAt: string | null = null;
  let lastAttemptAt: string | null = null;

  for (const r of rows) {
    const status = coerceFeeSyncStatus(r);
    counts.set(status, (counts.get(status) ?? 0) + 1);
    const reason = (r.feeSyncReason ?? "").trim();
    if (reason) {
      const bag = reasons.get(status) ?? new Map<string, number>();
      bag.set(reason, (bag.get(reason) ?? 0) + 1);
      reasons.set(status, bag);
    }
    if (status === "invoiced") lastSyncedAt = latest(lastSyncedAt, r.feeSyncedAt);
    lastAttemptAt = latest(lastAttemptAt, r.feeSyncAttemptedAt ?? r.feeSyncedAt);
  }

  const total = rows.length;
  const invoiced = counts.get("invoiced") ?? 0;
  const buckets: FeeSyncBucket[] = FEE_SYNC_STATUSES.filter((s) => (counts.get(s) ?? 0) > 0).map(
    (status) => {
      const bag = reasons.get(status);
      let reason: string | null = null;
      let best = 0;
      for (const [text, n] of bag ?? []) if (n > best) ((best = n), (reason = text));
      return { status, label: FEE_SYNC_LABELS[status], count: counts.get(status) ?? 0, reason };
    },
  );

  return {
    total,
    invoiced,
    coverage: total > 0 ? invoiced / total : 0,
    buckets,
    lastSyncedAt,
    lastAttemptAt,
  };
}
