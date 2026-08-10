import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getBreakoutOrderFeed, type BreakoutOrderRow } from "@/lib/breakout-orders.functions";
import { POLL } from "@/lib/query-keys";

interface Props { portfolioId: string }

const WINDOWS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
];

const FILTERS = [
  { label: "All", value: "all" },
  { label: "Traded", value: "trade" },
  { label: "Downsized", value: "downsize" },
  { label: "Skipped", value: "skip" },
] as const;

type FilterValue = (typeof FILTERS)[number]["value"];

const ACTION_TONE: Record<string, string> = {
  trade: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  downsize: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  skip: "border-destructive/40 text-destructive",
};

function pct(x: number | null | undefined, digits = 2): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${x >= 0 ? "+" : ""}${x.toFixed(digits)}%`;
}

function num(x: number | null | undefined, digits = 2): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return x.toFixed(digits);
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums truncate">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground truncate">{hint}</p>}
    </div>
  );
}

function OrderRow({ row }: { row: BreakoutOrderRow }) {
  const b = row.breakout;
  return (
    <div className="rounded-lg border bg-card/40 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{row.symbol}</span>
        <Badge variant="outline" className={ACTION_TONE[b.action] ?? ""}>
          {b.action === "trade" ? "traded" : b.action === "downsize" ? "downsized" : "skipped"}
        </Badge>
        <Badge variant="secondary" className="text-[10px]">
          {b.cohort ?? "—"} · {b.direction ?? "—"}
        </Badge>
        <Badge variant="secondary" className="text-[10px]">{b.regime_bucket}</Badge>
        {b.high_vol && (
          <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600 dark:text-amber-400">
            high vol
          </Badge>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{when(row.decided_at)}</span>
      </div>

      <p className="text-sm text-muted-foreground">{b.explanation}</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field
          label="Cell expectancy"
          value={pct(b.cell_expectancy_pct)}
          hint={b.cell_trades == null ? b.cell_verdict : `n=${b.cell_trades} · ${b.cell_verdict}`}
        />
        <Field
          label="Cell win rate"
          value={b.cell_win_rate_pct == null ? "—" : `${b.cell_win_rate_pct.toFixed(1)}%`}
          hint={b.table_as_of ? `as of ${b.table_as_of}` : undefined}
        />
        <Field
          label="VIX"
          value={num(b.vix, 1)}
          hint={b.regime ? `regime ${b.regime}` : undefined}
        />
        <Field
          label="20d realised vol"
          value={b.realised_vol_20d == null ? "—" : `${(b.realised_vol_20d * 100).toFixed(2)}%/day`}
        />
        <Field label="Signal age" value={b.age_bars == null ? "—" : `${b.age_bars} bar${b.age_bars === 1 ? "" : "s"}`} hint={b.age_band ?? undefined} />
        <Field label="Quality" value={b.quality == null ? "—" : b.quality.toFixed(2)} hint={`pen ${num(b.penetration_atr)} ATR`} />
        <Field label="Volume vs ADV" value={b.volume_ratio == null ? "—" : `${b.volume_ratio.toFixed(2)}x`} hint={b.base_bars == null ? undefined : `base ${b.base_bars} bars`} />
        <Field
          label="Size applied"
          value={`${Math.round(b.applied_multiplier * 100)}%`}
          hint={`raw ${Math.round(b.raw_multiplier * 100)}%${b.age_multiplier != null ? ` · age ${Math.round(b.age_multiplier * 100)}%` : ""}`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline" className="text-[10px]">outcome: {row.outcome}</Badge>
        {row.notional != null && (
          <span className="text-muted-foreground tabular-nums">
            {row.instrument_ccy ?? ""} {row.notional.toLocaleString()}
          </span>
        )}
        <span className="text-muted-foreground truncate">reason: {b.reason}</span>
      </div>
    </div>
  );
}

export function BreakoutOrderLogCard({ portfolioId }: Props) {
  const [windowDays, setWindowDays] = useState(30);
  const [filter, setFilter] = useState<FilterValue>("all");
  const fetchFn = useServerFn(getBreakoutOrderFeed);
  const q = useQuery({
    queryKey: ["breakout-order-feed", portfolioId, windowDays, filter],
    queryFn: () => fetchFn({ data: { portfolioId, windowDays, action: filter, limit: 100 } }),
    refetchInterval: POLL.SEMI_LIVE,
  });

  const data = q.data;

  return (
    <Card>
      <CardHeader className="flex flex-col items-start gap-3 pb-3 sm:flex-row sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="text-base">Breakout order log</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Every order the breakout gate ruled on: the regime cell expectancy it
            read, the volatility inputs at the time, and the exact reason a trade
            was taken, trimmed, or skipped.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {WINDOWS.map((w) => (
            <Button
              key={w.value}
              size="sm"
              variant={windowDays === w.value ? "default" : "outline"}
              onClick={() => setWindowDays(w.value)}
              className="h-7 px-2 text-xs"
            >
              {w.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={filter === f.value ? "secondary" : "ghost"}
              onClick={() => setFilter(f.value)}
              className="h-7 px-2 text-xs"
            >
              {f.label}
              {data && f.value !== "all" && (
                <span className="ml-1 text-muted-foreground">{data.counts[f.value]}</span>
              )}
            </Button>
          ))}
        </div>

        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

        {data && data.rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No breakout-gated orders in the last {data.windowDays} days. The gate only
            records a row when a buy is actually breakout-driven.
          </p>
        )}

        {data && data.rows.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              {data.counts.total} gated order{data.counts.total === 1 ? "" : "s"} ·{" "}
              {data.counts.trade} traded · {data.counts.downsize} downsized ·{" "}
              {data.counts.skip} skipped
            </p>
            <div className="space-y-3">
              {data.rows.map((r) => (
                <OrderRow key={r.id} row={r} />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
