// Small stat tile used by the portfolio detail headline grid (verbatim).

export function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "up" | "down";
}) {
  const toneClass = tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "";
  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-card px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`truncate text-base font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {hint ? (
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  );
}
