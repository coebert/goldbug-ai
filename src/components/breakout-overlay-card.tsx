import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Crosshair } from "lucide-react";
import { BreakoutOverlayChart } from "@/components/charts/breakout-overlay-chart";
import { getBreakoutOverlay } from "@/lib/breakout-overlay.functions";
import type { OverlaySignal } from "@/lib/breakout-overlay";
import type { SignalCohort } from "@/lib/breakout-backtest";

const COHORT_TONE: Record<SignalCohort, string> = {
  confirmed: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  pending: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  extended: "bg-sky-500/15 text-sky-500 border-sky-500/30",
  failed: "bg-red-500/15 text-red-500 border-red-500/30",
};

const HORIZONS = [5, 10, 20] as const;

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: abs < 10 ? 3 : 2,
    maximumFractionDigits: abs < 10 ? 3 : 2,
  });
}

/**
 * Visual verification for the breakout engine: pick a symbol, pick one of the
 * signals it fired, and see the range it measured, the level it broke and the
 * hold window it expected — all drawn on the same price series the detector saw.
 */
export function BreakoutOverlayCard({ portfolioId }: { portfolioId: string }) {
  const fetchOverlay = useServerFn(getBreakoutOverlay);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [horizonBars, setHorizonBars] = useState<number>(10);
  const [signalIndex, setSignalIndex] = useState<number | null>(null);

  const query = useQuery({
    queryKey: ["breakout-overlay", portfolioId, symbol, horizonBars],
    queryFn: () =>
      fetchOverlay({
        data: {
          portfolioId,
          ...(symbol ? { symbol } : {}),
          horizonBars,
        },
      }),
    staleTime: 5 * 60_000,
  });

  const overlay = query.data?.overlay ?? null;
  const signals = useMemo(() => overlay?.signals ?? [], [overlay]);

  // Default to the most recent signal whenever the series changes.
  useEffect(() => {
    setSignalIndex(signals.length ? signals[signals.length - 1]!.index : null);
  }, [signals]);

  const selected: OverlaySignal | null =
    signals.find((s) => s.index === signalIndex) ?? signals.at(-1) ?? null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Crosshair className="h-4 w-4 text-muted-foreground" />
            Breakout overlay
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={symbol ?? query.data?.overlay.symbol ?? ""}
              onValueChange={(v) => setSymbol(v)}
            >
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue placeholder="Symbol" />
              </SelectTrigger>
              <SelectContent>
                {(query.data?.symbols ?? []).map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex overflow-hidden rounded-md border border-border/60">
              {HORIZONS.map((h) => (
                <Button
                  key={h}
                  type="button"
                  size="sm"
                  variant={horizonBars === h ? "secondary" : "ghost"}
                  className="h-8 rounded-none px-2 text-xs"
                  onClick={() => setHorizonBars(h)}
                >
                  {h}b hold
                </Button>
              ))}
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Shaded box = the Donchian range the detector measured; the coloured rule is the level that
          broke. The dashed verticals mark the signal bar and the expected-hold exit trigger.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {query.isPending && <Skeleton className="h-[260px] w-full" />}

        {query.isError && (
          <p className="text-sm text-red-500">
            {(query.error as Error)?.message ?? "Could not load the overlay."}
          </p>
        )}

        {overlay && (
          <>
            <BreakoutOverlayChart
              overlay={overlay}
              signal={selected}
              formatPrice={fmtPrice}
            />

            {signals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No breakout signals fired on {overlay.symbol} in this window — the range band still
                shows where the boundaries sat.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {signals
                    .slice()
                    .reverse()
                    .map((s) => (
                      <button
                        key={`${s.index}-${s.cohort}`}
                        type="button"
                        onClick={() => setSignalIndex(s.index)}
                        className={`rounded-md border px-2 py-1 text-[11px] leading-none transition ${
                          s.index === selected?.index
                            ? COHORT_TONE[s.cohort]
                            : "border-border/60 text-muted-foreground hover:text-foreground"
                        }`}
                        aria-pressed={s.index === selected?.index}
                      >
                        <span className="tabular-nums">{s.date.slice(5)}</span>{" "}
                        <span className="capitalize">{s.cohort}</span>{" "}
                        {s.direction === "up" ? "↑" : "↓"}
                      </button>
                    ))}
                </div>

                {selected && (
                  <div className="grid gap-2 rounded-lg border border-border/60 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                    <Detail label="Signal">
                      <Badge className={`gap-1 ${COHORT_TONE[selected.cohort]}`}>
                        {selected.cohort} {selected.direction === "up" ? "breakout" : "breakdown"}
                      </Badge>
                    </Detail>
                    <Detail label="Level broken">
                      {fmtPrice(selected.level)}{" "}
                      <span className="text-muted-foreground">
                        ({selected.penetrationAtr.toFixed(2)} ATR through)
                      </span>
                    </Detail>
                    <Detail label="Range at signal">
                      {selected.channelLow != null && selected.channelHigh != null
                        ? `${fmtPrice(selected.channelLow)} – ${fmtPrice(selected.channelHigh)}`
                        : "—"}
                    </Detail>
                    <Detail label="Expected hold">
                      {selected.plannedExitIndex - selected.index} bars
                      {selected.plannedExitDate ? ` → ${selected.plannedExitDate}` : " (still open)"}
                    </Detail>
                    <Detail label="Entry / stop / target">
                      {fmtPrice(selected.entry)} ·{" "}
                      <span className="text-red-500">
                        {selected.stop != null ? fmtPrice(selected.stop) : "—"}
                      </span>{" "}
                      ·{" "}
                      <span className="text-emerald-500">
                        {selected.target != null ? fmtPrice(selected.target) : "—"}
                      </span>
                    </Detail>
                    <Detail label="Actual exit">
                      {selected.barsHeld > 0
                        ? `${selected.exitReason} after ${selected.barsHeld}b at ${fmtPrice(selected.exitPrice)}`
                        : "not yet resolved"}
                    </Detail>
                    <Detail label="Outcome">
                      <span
                        className={selected.returnPct >= 0 ? "text-emerald-500" : "text-red-500"}
                      >
                        {selected.returnPct >= 0 ? "+" : ""}
                        {selected.returnPct.toFixed(2)}%
                      </span>{" "}
                      <span className="text-muted-foreground">net of costs</span>
                    </Detail>
                    <Detail label="Evidence quality">
                      {(selected.quality * 100).toFixed(0)}%
                      {selected.volumeRatio != null && (
                        <span className="text-muted-foreground">
                          {" "}
                          · vol ×{selected.volumeRatio.toFixed(2)}
                        </span>
                      )}
                    </Detail>
                  </div>
                )}
              </>
            )}

            <p className="text-[11px] text-muted-foreground">
              Prices are in the venue's own quote units (LSE lines are pence). Exits shown are the
              engine's modelled ATR stop/target and time exit, not live order state.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="tabular-nums">{children}</div>
    </div>
  );
}
