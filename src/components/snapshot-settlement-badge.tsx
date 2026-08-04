import { Badge } from "@/components/ui/badge";
import {
  classifySnapshot,
  SETTLEMENT_HINT,
  SETTLEMENT_LABEL,
  type SettlementState,
} from "@/lib/snapshot-settlement";
import { formatUkAxisDay } from "@/lib/uk-time";

const TONE: Record<SettlementState, string> = {
  settled: "border-primary/40 text-primary",
  intraday: "border-warning/50 text-warning",
  reconstructed: "border-muted-foreground/40 text-muted-foreground",
};

/**
 * One-glance answer to "is this number final?" for any surface that quotes a
 * snapshot date — the equity curve, reconciliation views, exports.
 */
export function SnapshotSettlementBadge({
  snapshotDate,
  source = null,
  showDate = true,
  className,
}: {
  snapshotDate: string;
  source?: string | null;
  showDate?: boolean;
  className?: string;
}) {
  if (!snapshotDate) return null;
  const date = String(snapshotDate).slice(0, 10);
  const state = classifySnapshot({ snapshot_date: date, source });
  return (
    <Badge
      variant="outline"
      title={SETTLEMENT_HINT[state]}
      className={`w-fit shrink-0 ${TONE[state]} ${className ?? ""}`}
      data-testid="snapshot-settlement-badge"
      data-state={state}
    >
      {showDate ? `${formatUkAxisDay(`${date}T00:00:00Z`)} · ` : ""}
      {SETTLEMENT_LABEL[state]}
    </Badge>
  );
}
