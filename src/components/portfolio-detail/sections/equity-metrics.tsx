import { formatMetricValue } from "@/components/portfolio-detail/format";
import { ExplainIcon } from "@/components/explain";
import type { TermId } from "@/lib/glossary";

/**
 * The performance figures that sit above the equity curve.
 *
 * Extracted verbatim from `portfolio.$id.tsx` — same numbers, same
 * formatting, same colour rules — so the route file only has to say
 * *where* the metrics go, not how each one is computed and coloured.
 */
export type PerfSide = {
  totalReturn: number;
  annReturn: number;
  annVol: number;
  maxDrawdown: number;
};

export type PerfMetrics = {
  port: PerfSide;
  bench: PerfSide | null;
  correlation?: number | null;
};

const colorFor = (
  v: number | null | undefined,
  signed: boolean,
  negative: boolean,
): string => {
  if (v == null) return "text-muted-foreground";
  if (negative) return v < 0 ? "text-destructive" : "text-foreground";
  if (!signed) return "text-foreground";
  return v >= 0 ? "text-primary" : "text-destructive";
};

export function EquityHeadlineMetrics({
  perfMetrics,
  benchmark,
  riskFreeRate,
}: {
  perfMetrics: PerfMetrics;
  benchmark: string;
  riskFreeRate: number;
}) {
  const rows = [
    {
      label: "CAGR",
      term: "cagr" as TermId,
      value: perfMetrics.port.annReturn,
      bench: perfMetrics.bench?.annReturn ?? null,
      suffix: "%",
      signed: true,
      negative: false,
    },
    {
      label: "Volatility (ann.)",
      term: "volatility" as TermId,
      value: perfMetrics.port.annVol,
      bench: perfMetrics.bench?.annVol ?? null,
      suffix: "%",
      signed: false,
      negative: false,
    },
    {
      label: `Sharpe (rf=${riskFreeRate}%)`,
      term: "sharpe" as TermId,
      value:
        perfMetrics.port.annVol > 0
          ? (perfMetrics.port.annReturn - riskFreeRate) / perfMetrics.port.annVol
          : null,
      bench:
        perfMetrics.bench && perfMetrics.bench.annVol > 0
          ? (perfMetrics.bench.annReturn - riskFreeRate) / perfMetrics.bench.annVol
          : null,
      suffix: "",
      signed: true,
      negative: false,
    },
    {
      label: "Max drawdown",
      term: "max_drawdown" as TermId,
      value: perfMetrics.port.maxDrawdown,
      bench: perfMetrics.bench?.maxDrawdown ?? null,
      suffix: "%",
      signed: false,
      negative: true,
    },
  ] as const;

  return (
    <div className="mx-6 mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {rows.map((m) => {
        const fmt = (v: number | null | undefined) => formatMetricValue(v, m.signed, m.suffix);
        return (
          <div
            key={m.label}
            className="min-w-0 rounded-md border border-border/70 bg-muted/30 p-3"
          >
            <div className="flex min-w-0 items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              <span className="truncate">{m.label}</span>
              <span className="shrink-0">
                <ExplainIcon term={m.term} />
              </span>
            </div>
            <div
              title={fmt(m.value)}
              className={`mt-0.5 truncate tabular-nums text-base font-semibold leading-tight sm:text-lg ${colorFor(m.value, m.signed, m.negative)}`}
            >
              {fmt(m.value)}
            </div>
            {perfMetrics.bench && (
              <div className="truncate tabular-nums text-[11px] text-muted-foreground">
                {benchmark}:{" "}
                <span className={colorFor(m.bench, m.signed, m.negative)}>{fmt(m.bench)}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function EquityBenchmarkMetrics({
  perfMetrics,
  benchmark,
}: {
  perfMetrics: PerfMetrics;
  benchmark: string;
}) {
  const rows = [
    { label: "Total return", key: "totalReturn", suffix: "%", signed: true, negative: false, derived: false },
    { label: "Annualized return", key: "annReturn", suffix: "%", signed: true, negative: false, derived: false },
    { label: "Volatility (ann.)", key: "annVol", suffix: "%", signed: false, negative: false, derived: false },
    { label: "Max drawdown", key: "maxDrawdown", suffix: "%", signed: false, negative: true, derived: false },
    { label: "Return / Vol", key: "rvr", suffix: "", signed: true, negative: false, derived: true },
  ] as const;

  return (
    <div className="mx-6 mb-3 rounded-md border border-border/70 bg-muted/30 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span className="min-w-0 truncate">
          Performance vs {benchmark === "none" ? "benchmark" : benchmark}
        </span>
        {perfMetrics.correlation != null && (
          <span className="shrink-0 tabular-nums">
            Correlation:{" "}
            <span className="font-medium text-foreground">
              {perfMetrics.correlation.toFixed(2)}
            </span>
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3 lg:grid-cols-5">
        {rows.map((m) => {
          const fmt = (v: number | null | undefined) => formatMetricValue(v, m.signed, m.suffix);
          const derived = (obj: PerfSide | null) =>
            obj && obj.annVol > 0 ? obj.annReturn / obj.annVol : null;
          const pick = (obj: PerfSide | null) => {
            if (!obj) return null;
            const v = (obj as unknown as Record<string, unknown>)[m.key];
            return typeof v === "number" ? v : null;
          };
          const pv = m.derived ? derived(perfMetrics.port) : pick(perfMetrics.port);
          const bv = m.derived ? derived(perfMetrics.bench) : pick(perfMetrics.bench);
          return (
            <div key={m.label} className="min-w-0">
              <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                {m.label}
              </div>
              <div
                title={fmt(pv)}
                className={`truncate tabular-nums font-medium ${colorFor(pv, m.signed, m.negative)}`}
              >
                {fmt(pv)}
              </div>
              {perfMetrics.bench && (
                <div className="truncate tabular-nums text-[11px] text-muted-foreground">
                  {benchmark}:{" "}
                  <span className={colorFor(bv, m.signed, m.negative)}>{fmt(bv)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
