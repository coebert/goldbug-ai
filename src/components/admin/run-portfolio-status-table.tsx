import { Badge } from "@/components/ui/badge";
import {
  formatRelativeTime,
  summarizeRunStatuses,
  type RunPortfolioStatus,
  type RunPortfolioStatusKind,
} from "@/lib/run-portfolio-status";

const TONE: Record<RunPortfolioStatusKind, "default" | "secondary" | "destructive" | "outline"> = {
  ticked: "default",
  error: "destructive",
  skipped_recent: "secondary",
  skipped_budget: "secondary",
  skipped_closed: "secondary",
  skipped_other: "secondary",
  paused: "outline",
  not_selected: "outline",
};

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Per-portfolio status board for the last manual run: what ticked, what was
 * skipped and why, what was left untouched by the selection, and when each
 * portfolio last ran.
 */
export function RunPortfolioStatusTable({ rows }: { rows: RunPortfolioStatus[] }) {
  if (!rows.length) return null;
  const s = summarizeRunStatuses(rows);

  return (
    <div className="rounded-md border border-border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/30 px-3 py-2 text-xs">
        <span className="font-medium">Per-portfolio status</span>
        <span className="text-muted-foreground">
          {s.ticked} ticked · {s.skipped} skipped
          {s.failed > 0 ? ` · ${s.failed} failed` : ""}
          {s.untouched > 0 ? ` · ${s.untouched} untouched` : ""}
          {s.paused > 0 ? ` · ${s.paused} paused` : ""}
        </span>
      </div>

      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li
            key={r.id}
            className={`px-3 py-2 text-xs ${r.status === "not_selected" ? "opacity-60" : ""}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                {r.mode.replace("_", " ")}
              </Badge>
              <Badge variant={TONE[r.status]} className="shrink-0 text-[10px]">
                {r.label}
              </Badge>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
              <span className="tabular-nums">
                Last run {fmtTime(r.lastRunAt)} ({formatRelativeTime(r.lastRunAt)})
              </span>
              {r.ticked && r.previousRunAt && (
                <span className="tabular-nums">Previous {fmtTime(r.previousRunAt)}</span>
              )}
              {r.durationMs !== null && (
                <span className="tabular-nums">{(r.durationMs / 1000).toFixed(1)}s</span>
              )}
              {r.value !== null && (
                <span className="tabular-nums">value {Math.round(r.value).toLocaleString()}</span>
              )}
            </div>

            {r.detail && r.status !== "ticked" && (
              <p className="mt-0.5 break-words text-muted-foreground">{r.detail}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
