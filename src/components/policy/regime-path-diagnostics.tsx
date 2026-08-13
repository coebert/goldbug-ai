import {
  REGIME_PATH_HINT,
  REGIME_PATH_LABEL,
  type RegimeScaleDiagnostic,
  type RegimeScalePath,
} from "@/lib/policy-regime-path";
import { Badge } from "@/components/ui/badge";

const TONE: Record<RegimeScalePath, string> = {
  exact: "border-primary/40 bg-primary/10 text-primary",
  recomputed: "border-border bg-muted text-foreground",
  clamped: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  fallback: "border-border/60 bg-transparent text-muted-foreground",
};

/** Compact per-case badge: which path resolved this order's regime scale. */
export function RegimePathBadge({
  diagnostic,
  className,
}: {
  diagnostic: RegimeScaleDiagnostic;
  className?: string;
}) {
  return (
    <span
      title={REGIME_PATH_HINT[diagnostic.path]}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] leading-none ${TONE[diagnostic.path]} ${className ?? ""}`}
    >
      {REGIME_PATH_LABEL[diagnostic.path]}
      <span className="tabular-nums opacity-80">×{diagnostic.appliedScale.toFixed(2)}</span>
    </span>
  );
}

/** Full working-out for one case, shown inside the expanded order row. */
export function RegimePathDetail({ diagnostic }: { diagnostic: RegimeScaleDiagnostic }) {
  const d = diagnostic;
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2 text-[11px] text-muted-foreground">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <RegimePathBadge diagnostic={d} />
        <span>
          {d.posture.replace("_", "-")}
          {d.postureDefaulted ? " (defaulted)" : ""} · {d.vol}
          {d.volDefaulted ? " (defaulted)" : ""} volatility
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums sm:grid-cols-4">
        <div>
          <dt className="inline">Stored: </dt>
          <dd className="inline text-foreground">
            {d.storedScale == null ? "none" : `×${d.storedScale.toFixed(3)}`}
          </dd>
        </div>
        <div>
          <dt className="inline">Resolved: </dt>
          <dd className="inline text-foreground">×{d.scale.toFixed(3)}</dd>
        </div>
        <div>
          <dt className="inline">Direction: </dt>
          <dd className="inline text-foreground">
            {d.sign > 0 ? "dovish (+)" : d.sign < 0 ? "hawkish (−)" : "none"}
          </dd>
        </div>
        <div>
          <dt className="inline">Applied: </dt>
          <dd className="inline text-foreground">×{d.appliedScale.toFixed(3)}</dd>
        </div>
      </dl>
      {d.notes.length ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {d.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1">Stored multiplier used verbatim — no repair or clamping needed.</p>
      )}
    </div>
  );
}

/** Run-level strip: how many cases took each path. */
export function RegimePathSummary({
  summary,
  className,
}: {
  summary: Array<{ path: RegimeScalePath; count: number }>;
  className?: string;
}) {
  if (!summary.length) return null;
  const total = summary.reduce((s, r) => s + r.count, 0);
  const degraded = summary.filter((r) => r.path !== "exact").reduce((s, r) => s + r.count, 0);
  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground ${className ?? ""}`}>
      <span>Regime scale path:</span>
      {summary.map((r) => (
        <Badge
          key={r.path}
          variant="outline"
          title={REGIME_PATH_HINT[r.path]}
          className={`gap-1 border px-2 py-0 font-normal ${TONE[r.path]}`}
        >
          {REGIME_PATH_LABEL[r.path]}
          <span className="tabular-nums">{r.count}</span>
        </Badge>
      ))}
      <span>
        {degraded === 0
          ? `all ${total} case${total === 1 ? "" : "s"} used the run's stored multiplier`
          : `${degraded} of ${total} case${total === 1 ? "" : "s"} needed a repair or bound`}
      </span>
    </div>
  );
}
