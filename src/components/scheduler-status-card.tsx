import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CalendarClock, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSchedulerStatus } from "@/lib/scheduler-status.functions";
import {
  explainPortfolioSchedule,
  isLondonWeekend,
  type UniverseSymbolStatus,
} from "@/lib/scheduler-status";
import { getMarketStatusForSymbol } from "@/lib/market-hours";
import { formatUkTime } from "@/lib/uk-time";

const RANGES = [
  { label: "3d", days: 3 },
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
];

function rel(iso: string | null): string {
  if (!iso) return "never";
  return formatUkTime(iso);
}

export function SchedulerStatusCard() {
  const [days, setDays] = useState(7);
  const fetchStatus = useServerFn(getSchedulerStatus);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["scheduler-status", days],
    queryFn: () => fetchStatus({ data: { days } }),
    staleTime: 60_000,
  });

  const weekendNow = isLondonWeekend(new Date());

  const rows = useMemo(() => {
    if (!data) return [];
    return data.portfolios.map((p) => {
      const symbols: UniverseSymbolStatus[] = p.symbols.map((s) => {
        const st = getMarketStatusForSymbol(s);
        return { symbol: s, venue: st.venue, isOpen: st.isOpen, phase: st.phase };
      });
      return { p, verdict: explainPortfolioSchedule({ symbols, paused: p.paused }) };
    });
  }, [data]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4" />
            Scheduler status
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {weekendNow
              ? "It's the weekend in London — equity venues are closed, so most portfolios are expected to skip."
              : "Weekday session — equity venues follow their normal hours."}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <Button
              key={r.days}
              size="sm"
              variant={days === r.days ? "default" : "outline"}
              onClick={() => setDays(r.days)}
            >
              {r.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {isLoading && <p className="text-sm text-muted-foreground">Loading scheduler activity…</p>}

        {data && (
          <>
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Jobs — weekend vs weekday
              </h3>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Job</TableHead>
                      <TableHead className="text-right">Runs</TableHead>
                      <TableHead className="text-right">Weekend</TableHead>
                      <TableHead className="text-right">Failed</TableHead>
                      <TableHead>Last run</TableHead>
                      <TableHead>Last weekend run</TableHead>
                      <TableHead>Skipped phases</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.jobs.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-sm text-muted-foreground">
                          No runs recorded in this window.
                        </TableCell>
                      </TableRow>
                    )}
                    {data.jobs.map((j) => (
                      <TableRow key={j.job}>
                        <TableCell className="font-medium">{j.job}</TableCell>
                        <TableCell className="text-right tabular-nums">{j.runs}</TableCell>
                        <TableCell className="text-right tabular-nums">{j.weekendRuns}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {j.failures > 0 ? (
                            <Badge variant="destructive">{j.failures}</Badge>
                          ) : (
                            0
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{rel(j.lastRunAt)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {rel(j.lastWeekendRunAt)}
                        </TableCell>
                        <TableCell className="space-x-1">
                          {j.skippedPhases.length === 0 && (
                            <span className="text-xs text-muted-foreground">none</span>
                          )}
                          {j.skippedPhases.map((s) => (
                            <Badge key={s.phase} variant="outline" title={s.lastNote ?? undefined}>
                              {s.phase} · {s.weekend}we/{s.weekday}wd
                            </Badge>
                          ))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Portfolios & universes — would a run tick right now?
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {rows.map(({ p, verdict }) => (
                  <div key={p.id} className="rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{p.name}</p>
                        <p className="text-xs text-muted-foreground">{p.mode}</p>
                      </div>
                      <Badge variant={verdict.willTick ? "default" : "secondary"}>
                        {verdict.willTick ? "Would tick" : verdict.outcome.replace(/_/g, " ")}
                      </Badge>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{verdict.reason}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {p.classes.map((c) => (
                        <Badge key={c} variant="outline" className="text-[10px]">
                          {c}
                        </Badge>
                      ))}
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Open venues</dt>
                      <dd className="text-right">{verdict.openVenues.join(", ") || "—"}</dd>
                      <dt className="text-muted-foreground">Closed venues</dt>
                      <dd className="text-right">{verdict.closedVenues.join(", ") || "—"}</dd>
                      <dt className="text-muted-foreground">Ticks ({data.windowDays}d)</dt>
                      <dd className="text-right tabular-nums">
                        {p.activity.total} ({p.activity.weekend} weekend)
                      </dd>
                      <dt className="text-muted-foreground">Last tick</dt>
                      <dd className="text-right">{rel(p.activity.lastTickAt)}</dd>
                      <dt className="text-muted-foreground">Last weekend tick</dt>
                      <dd className="text-right">{rel(p.activity.lastWeekendTickAt)}</dd>
                    </dl>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default SchedulerStatusCard;
