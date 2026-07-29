import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Scale, TrendingUp, TrendingDown, Minus } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  buildBenchmarkSeries,
  compareToVanguard,
  VANGUARD_CAGR,
  type DepositLike,
  type EquityPoint,
} from "@/lib/vanguard-benchmark";
import { formatUk } from "@/lib/uk-time";

/**
 * "vs Vanguard benchmark" performance tile.
 *
 * Compares the portfolio's realised trajectory to a passive Vanguard
 * LifeStrategy 60% Equity proxy (5.5% long-run CAGR, GBP-hedged). Deposits
 * added mid-run are compounded from their own date so the comparison is
 * apples-to-apples with the actual trading account.
 */

interface Props {
  startingCash: number;
  currency: string;
  equity: EquityPoint[];
  deposits?: DepositLike[];
  cagr?: number;
}

export function VanguardBenchmarkCard({
  startingCash,
  currency,
  equity,
  deposits = [],
  cagr = VANGUARD_CAGR,
}: Props) {
  const fmtCcy = useMemo(
    () =>
      new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
      }),
    [currency],
  );

  const cmp = useMemo(
    () => compareToVanguard(startingCash, equity, deposits, cagr),
    [startingCash, equity, deposits, cagr],
  );

  const hasData = equity.length > 0;
  const beating = cmp.alphaPct > 0.05;
  const trailing = cmp.alphaPct < -0.05;
  const AlphaIcon = beating ? TrendingUp : trailing ? TrendingDown : Minus;
  const alphaCls = beating
    ? "text-emerald-600 dark:text-emerald-400"
    : trailing
      ? "text-destructive"
      : "text-muted-foreground";
  const verdict = beating
    ? "Beating passive"
    : trailing
      ? "Trailing passive"
      : "In line with passive";

  const fmtPct = (n: number) =>
    `${n >= 0 ? "+" : ""}${Number.isFinite(n) ? n.toFixed(2) : "—"}%`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Scale className="h-4 w-4 text-primary" aria-hidden />
          vs Vanguard benchmark
          <Badge variant="outline" className="ml-1 font-mono text-[10px]">
            VLS60 · {(cagr * 100).toFixed(1)}% CAGR
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          What a boring, low-cost Vanguard LifeStrategy 60% Equity fund would
          have done with the same starting pot and top-ups — the alpha below
          is the value the AI is adding (or destroying) over pure passive.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasData && (
          <p className="text-sm text-muted-foreground">
            No equity snapshots yet — once the portfolio has a couple of
            daily marks, the passive comparison will appear here.
          </p>
        )}

        {hasData && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Tile
                label="Portfolio"
                value={fmtCcy.format(cmp.portfolioValue)}
                sub={fmtPct(cmp.portfolioReturnPct)}
                cls={cmp.portfolioReturnPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}
              />
              <Tile
                label="Vanguard 60/40"
                value={fmtCcy.format(cmp.benchmarkValue)}
                sub={fmtPct(cmp.benchmarkReturnPct)}
                cls="text-muted-foreground"
              />
              <Tile
                label="Alpha"
                value={
                  <span className="inline-flex items-center gap-1">
                    <AlphaIcon className="h-4 w-4" aria-hidden />
                    {fmtPct(cmp.alphaPct)}
                  </span>
                }
                sub={`${cmp.alphaCcy >= 0 ? "+" : ""}${fmtCcy.format(cmp.alphaCcy)}`}
                cls={alphaCls}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <span className={`font-medium ${alphaCls}`}>{verdict}</span>
              <span className="font-mono text-muted-foreground">
                {cmp.startDate ? formatUk(cmp.startDate) : "—"}
                {" → "}
                {cmp.asOf ? formatUk(cmp.asOf) : "—"}
                {" · "}
                {cmp.days.toFixed(0)}d
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({
  label,
  value,
  sub,
  cls,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  cls?: string;
}) {
  return (
    <div className="rounded-md border bg-card/40 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${cls ?? ""}`}>
        {value}
      </div>
      {sub && <div className={`text-xs tabular-nums ${cls ?? "text-muted-foreground"}`}>{sub}</div>}
    </div>
  );
}
