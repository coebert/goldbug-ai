/**
 * Which trades are priced by the broker, which aren't, and why.
 *
 * The headline KPI can only say "38 of 40 invoiced". This says what the other
 * two are waiting on, which is the difference between "check back tomorrow"
 * and "something is wrong with matching".
 */

import { FEE_SYNC_EXPLANATIONS, type FeeSyncSummary } from "@/lib/fee-sync-status";

function when(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

const TONE: Record<string, string> = {
  invoiced: "bg-primary/15 text-primary",
  pending: "bg-muted text-muted-foreground",
  unmatched: "bg-destructive/15 text-destructive",
  unsupported: "bg-muted text-muted-foreground",
};

export function FeeSyncStatusStrip({ summary }: { summary: FeeSyncSummary }) {
  if (summary.total === 0) return null;

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium">Cost data by trade</p>
        <p className="ml-auto text-xs text-muted-foreground">
          Last successful sync: {when(summary.lastSyncedAt)}
          {summary.lastAttemptAt && summary.lastAttemptAt !== summary.lastSyncedAt
            ? ` · last checked ${when(summary.lastAttemptAt)}`
            : ""}
        </p>
      </div>

      <ul className="space-y-1.5">
        {summary.buckets.map((b) => (
          <li key={b.status} className="flex flex-wrap items-baseline gap-2 text-xs">
            <span className={`rounded px-1.5 py-0.5 font-medium ${TONE[b.status] ?? TONE["pending"]}`}>
              {b.label}
            </span>
            <span className="tabular-nums">
              {b.count} of {summary.total} trades
            </span>
            <span className="text-muted-foreground">
              {b.reason ?? FEE_SYNC_EXPLANATIONS[b.status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
