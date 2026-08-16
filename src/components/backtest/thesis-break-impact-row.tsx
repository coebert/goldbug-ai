import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { runThesisBreakImpactFn } from "@/lib/backtest/thesis-break-impact.functions";
import type { ThesisImpactResult } from "@/lib/backtest/thesis-break-impact.server";

const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const pp = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}pp`;

function verdictBadge(v: ThesisImpactResult["verdict"]) {
  if (v === "protective")
    return <Badge className="bg-primary text-primary-foreground">Cut losses, kept return</Badge>;
  if (v === "protective_but_costly")
    return <Badge variant="secondary">Cut losses, cost return</Badge>;
  if (v === "harmful") return <Badge variant="destructive">Made losses worse</Badge>;
  return <Badge variant="outline">No measurable effect</Badge>;
}

function Pair({
  label,
  before,
  after,
  delta,
  improved,
}: {
  label: string;
  before: string;
  after: string;
  delta: string;
  improved: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-medium tabular-nums">
        <span className="text-muted-foreground">{before}</span>
        <span className="mx-1 text-muted-foreground">→</span>
        <span>{after}</span>
      </div>
      <div
        className={`text-[11px] tabular-nums ${improved ? "text-primary" : "text-destructive"}`}
      >
        {delta}
      </div>
    </div>
  );
}

/**
 * One row on the backtest card answering the only question the thesis-break
 * exit layer exists to answer: with it on, how much shallower is the drawdown
 * and how much smaller is the average losing trade?
 */
export function ThesisBreakImpactRow({ className }: { className?: string }) {
  const run = useServerFn(runThesisBreakImpactFn);
  const m = useMutation({
    mutationFn: () => run({ data: {} }) as Promise<ThesisImpactResult>,
  });
  const r = m.data;

  return (
    <div className={`rounded-xl border border-border/60 p-3 ${className ?? ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">Thesis-break exit impact</div>
          <div className="text-xs text-muted-foreground">
            Same tape replayed with the fast-exit layer off vs on
          </div>
        </div>
        <div className="flex items-center gap-2">
          {r ? verdictBadge(r.verdict) : null}
          <Button size="sm" variant="outline" onClick={() => m.mutate()} disabled={m.isPending}>
            {m.isPending ? "Replaying…" : r ? "Re-run" : "Measure impact"}
          </Button>
        </div>
      </div>

      {m.isError ? (
        <p className="mt-2 text-xs text-destructive">
          {(m.error as Error)?.message ?? "Replay failed"}
        </p>
      ) : null}

      {r ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Pair
              label="Max drawdown"
              before={pct(r.base.maxDrawdownPct)}
              after={pct(r.withLayer.maxDrawdownPct)}
              delta={`${pp(r.drawdownDeltaPp)} deeper/shallower`}
              improved={
                Math.abs(r.withLayer.maxDrawdownPct) <= Math.abs(r.base.maxDrawdownPct)
              }
            />
            <Pair
              label="Average losing trade"
              before={pct(r.base.avgLossPct)}
              after={pct(r.withLayer.avgLossPct)}
              delta={`${pp(r.avgLossDeltaPp)} per loss`}
              improved={Math.abs(r.withLayer.avgLossPct) <= Math.abs(r.base.avgLossPct)}
            />
            <Pair
              label="Total return"
              before={pct(r.base.totalReturnPct)}
              after={pct(r.withLayer.totalReturnPct)}
              delta={`${pp(r.returnDeltaPp)} vs layer off`}
              improved={r.returnDeltaPp >= 0}
            />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {r.actions.total} actions ({r.actions.trim} trims, {r.actions.close} closes) across{" "}
            {r.symbols.length} symbols, {r.from} → {r.to}. Fires on{" "}
            {r.repeatFireRatePct.toFixed(0)}% of repeat losers vs{" "}
            {r.firstLossFireRatePct.toFixed(0)}% of first losses.
          </p>
        </>
      ) : null}
    </div>
  );
}
