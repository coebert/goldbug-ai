// Real-money cost panel: the AI's cost floor next to what this account's own
// fills actually cost, and how much of the governor's reserve is left.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { getRealMoneyCostPanel } from "@/lib/real-money-cost.functions";

function money(n: number, ccy: string): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}${ccy} ${Math.abs(n).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function bps(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)} bps`;
}

function Line({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "up" | "down";
}) {
  const cls = tone === "up" ? "text-emerald-500" : tone === "down" ? "text-rose-400" : "";
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
      {note && <div className="text-[11px] text-muted-foreground tabular-nums">{note}</div>}
    </div>
  );
}

export function RealMoneyCostPanel({ portfolioId }: { portfolioId: string }) {
  const fetchPanel = useServerFn(getRealMoneyCostPanel);
  const q = useQuery({
    queryKey: ["pnl", "real-money-cost", portfolioId],
    queryFn: () => fetchPanel({ data: { portfolioId } }),
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
  const d = q.data;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Real money vs the AI's cost floor</CardTitle>
          {d && (
            <Badge variant={d.invoicedShare >= 0.999 ? "default" : "outline"} className="text-[11px]">
              {d.invoicedShare >= 0.999
                ? "Every charge invoiced by the broker"
                : `${Math.round(d.invoicedShare * 100)}% of tickets invoiced`}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          What the AI insists a trade must beat before it deals, next to what dealing has really
          cost this account — and how much of the dealing allowance is still free.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading && <p className="text-sm text-muted-foreground">Reading your fills…</p>}
        {q.isError && (
          <p className="text-sm text-destructive">Could not read costs: {(q.error as Error).message}</p>
        )}

        {d && (
          <>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Line
                label="AI's floor per round trip"
                value={bps(d.effectiveFloorBps)}
                note={`${d.floorHeadroom.toFixed(2)}× safety · ${d.hurdleMultiple.toFixed(2)}× your hurdle`}
              />
              <Line
                label="Actually paid per round trip"
                value={bps(d.measuredRoundTripBps)}
                note={
                  d.tickets > 0
                    ? `${bps(d.measuredFeeBps)} charges + ${bps(d.measuredSlippageBps)} slippage, one way · ${d.tickets} tickets`
                    : "No fills measured yet"
                }
              />
              <Line
                label="Cushion above real cost"
                value={bps(d.floorCushionBps)}
                note={
                  d.floorCushionBps == null
                    ? undefined
                    : d.floorCushionBps > 0
                      ? "Floor sits above what you pay"
                      : "Floor is below your real cost"
                }
                tone={d.floorCushionBps != null && d.floorCushionBps > 0 ? "up" : "down"}
              />
              <Line
                label={`Charges last ${d.windowDays} days`}
                value={money(-d.frictionBase, d.currency)}
                note={`${d.frictionBps == null ? "—" : d.frictionBps.toFixed(1)} of ${d.budgetBps} bps allowed`}
                tone="down"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Dealing allowance used</span>
                <span className="tabular-nums">
                  {d.budgetUsed == null ? "—" : `${Math.round(d.budgetUsed * 100)}%`}
                  {d.frictionRemainingBase != null
                    ? ` · ${money(d.frictionRemainingBase, d.currency)} left`
                    : ""}
                </span>
              </div>
              <Progress value={Math.min(100, Math.max(0, (d.budgetUsed ?? 0) * 100))} />
              <p className="text-[11px] text-muted-foreground">
                {money(d.invoicedBase, d.currency)} of that is money the broker billed;{" "}
                {money(d.estimatedBase, d.currency)} is still our estimate.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-5">
              <Line
                label="Smallest buy"
                value={d.minTicketBase == null ? "—" : money(d.minTicketBase, d.currency)}
                note="Below this, charges eat the trade"
              />
              <Line
                label="Buys today"
                value={`${d.buysToday} of ${d.maxBuysPerDay}`}
                note="Daily ticket limit"
              />
              <Line
                label="Single-name cap"
                value={`${Math.round(d.maxPositionPctOfNav * 100)}%`}
                note="Most of the account in one holding"
              />
              <Line
                label="Held-back tickets"
                value={`${d.reserveTickets}`}
                note="Kept free for a very strong signal"
              />
              <Line
                label="Top-up cooldown"
                value={`${d.addCooldownDays} days`}
                note="Wait before adding to a name"
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
