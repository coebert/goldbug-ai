import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { SnapshotMismatch } from "@/lib/snapshot-timing-mismatch";

const REASON_LABEL: Record<SnapshotMismatch["reason"], string> = {
  "no-snapshot-for-broker-sync-day":
    "Broker cash was synced but no equity snapshot has been stored yet",
  "snapshot-older-than-broker-sync":
    "Latest stored snapshot is older than the last broker cash sync",
  "snapshot-cash-diverges-from-broker":
    "Broker cash disagrees with the value in today's stored snapshot",
};

export function SnapshotMismatchAlert({
  mismatches,
}: {
  mismatches: SnapshotMismatch[];
}) {
  if (!mismatches || mismatches.length === 0) return null;
  return (
    <Alert
      variant="destructive"
      className="mb-4 border-amber-500/60 bg-amber-500/10 text-amber-100"
      data-testid="snapshot-mismatch-alert"
    >
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertTitle className="text-sm font-semibold">
        Real-money equity may be showing stale data
      </AlertTitle>
      <AlertDescription className="mt-1 space-y-1 text-xs">
        <p>
          The broker cash sync and stored equity snapshots don't line up for{" "}
          {mismatches.length === 1 ? "1 portfolio" : `${mismatches.length} portfolios`}.
          Trigger a manual run or sync to refresh totals.
        </p>
        <ul className="mt-1 list-disc pl-4">
          {mismatches.map((m) => (
            <li key={`${m.portfolioId}:${m.reason}`}>
              <span className="font-medium">{m.portfolioName}</span>:{" "}
              {REASON_LABEL[m.reason]}
              {m.divergence != null
                ? ` (Δ ${m.divergence >= 0 ? "+" : ""}${m.divergence.toFixed(2)})`
                : ""}
              . {m.detail}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
