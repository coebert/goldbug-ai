import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Banknote } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartFrame } from "@/components/chart-frame";
import { Badge } from "@/components/ui/badge";
import { ChartSkeleton } from "@/components/ui/card-skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { SectionCard, SectionCardBody, SectionCardHeader } from "@/components/ui/section-card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getCashReserveHistory } from "@/lib/cash-reserve-history.functions";
import { CHART_ROLE, LEGEND_PROPS, OKABE_ITO } from "@/lib/chart-palette";
import { useChartPreset } from "@/lib/chart-axis";
import { SAXO_AXIS, SAXO_GRID, SAXO_TOOLTIP_CONTENT, SAXO_TOOLTIP_CURSOR, SAXO_TOOLTIP_LABEL, fadeStops } from "@/lib/saxo-chart";

type Range = "30d" | "90d" | "1y" | "all";
const RANGES: Array<{ value: Range; label: string; days: number | null }> = [
  { value: "30d", label: "30D", days: 30 },
  { value: "90d", label: "90D", days: 90 },
  { value: "1y", label: "1Y", days: 365 },
  { value: "all", label: "All", days: null },
];

function compactMoney(value: number, currency: string) {
  const abs = Math.abs(value);
  const amount = abs >= 1_000 ? `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k` : value.toFixed(0);
  const symbol = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  })
    .formatToParts(0)
    .find((part) => part.type === "currency")?.value ?? currency;
  return `${symbol}${amount}`;
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

function shortDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export function CashReserveHistoryChart({ portfolioId, enabled = true, className }: { portfolioId: string; enabled?: boolean; className?: string }) {
  const fetchHistory = useServerFn(getCashReserveHistory);
  const q = useQuery({
    queryKey: ["cash-reserve-history", portfolioId],
    queryFn: () => fetchHistory({ data: { portfolioId } }),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const [range, setRange] = useState<Range>("all");
  const { isMobile, margin } = useChartPreset();
  const visible = useMemo(() => {
    const rows = q.data?.series ?? [];
    const days = RANGES.find((option) => option.value === range)?.days;
    if (!days || rows.length === 0) return rows;
    const last = Date.parse(`${rows[rows.length - 1].date}T12:00:00Z`);
    const cutoff = last - days * 86_400_000;
    return rows.filter((row) => Date.parse(`${row.date}T12:00:00Z`) >= cutoff);
  }, [q.data?.series, range]);
  const latest = visible.at(-1);
  const currency = q.data?.currency ?? "GBP";

  return (
    <SectionCard className={className}>
      <SectionCardHeader
        icon={<Banknote className="h-4 w-4" />}
        title="Cash & reserves"
        description="Daily broker cash against the AI’s minimum buy and rolling dealing allowance."
        badge={q.data?.mode === "live_prod" ? <Badge>REAL</Badge> : undefined}
        action={
          <ToggleGroup type="single" size="sm" value={range} onValueChange={(value) => value && setRange(value as Range)}>
            {RANGES.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value} aria-label={`${option.label} range`} className="px-2.5 text-xs">
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />
      <SectionCardBody>
        {q.isLoading && <ChartSkeleton height="280px" />}
        {q.isError && <ErrorState description={q.error instanceof Error ? q.error.message : "Cash history is unavailable."} onRetry={() => q.refetch()} retrying={q.isFetching} />}
        {!q.isLoading && !q.isError && visible.length === 0 && (
          <EmptyState icon={<Banknote />} title="No daily cash history yet" description="The chart will start when the broker writes an authoritative daily cash snapshot." />
        )}
        {latest && q.data && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div><p className="text-[10px] uppercase text-muted-foreground">Cash now</p><p className="font-semibold tabular-nums">{money(latest.cash, currency)}</p></div>
              <div><p className="text-[10px] uppercase text-muted-foreground">Minimum buy</p><p className="font-semibold tabular-nums">{money(latest.minimumBuy, currency)}</p></div>
              <div><p className="text-[10px] uppercase text-muted-foreground">30-day allowance left</p><p className="font-semibold tabular-nums">{money(latest.allowanceRemaining, currency)}</p></div>
              <div><p className="text-[10px] uppercase text-muted-foreground">Strong-signal reserve</p><p className="font-semibold tabular-nums">{q.data.rules.reserveTickets} ticket{q.data.rules.reserveTickets === 1 ? "" : "s"}</p></div>
            </div>
            <ChartFrame className="h-[280px] sm:h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={visible} margin={margin}>
                  <defs>
                    <linearGradient id={`cash-fill-${portfolioId}`} x1="0" y1="0" x2="0" y2="1">
                      {fadeStops(CHART_ROLE.neutral).map((stop) => <stop key={String(stop.offset)} {...stop} />)}
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...SAXO_GRID} />
                  <XAxis dataKey="date" {...SAXO_AXIS} minTickGap={isMobile ? 42 : 56} tickFormatter={(value) => shortDate(String(value))} />
                  <YAxis {...SAXO_AXIS} width={isMobile ? 62 : 78} domain={[0, "auto"]} tickFormatter={(value) => compactMoney(Number(value), currency)} />
                  <Tooltip
                    contentStyle={SAXO_TOOLTIP_CONTENT}
                    labelStyle={SAXO_TOOLTIP_LABEL}
                    cursor={SAXO_TOOLTIP_CURSOR}
                    labelFormatter={(label) => shortDate(String(label))}
                    formatter={(value: number, name: string) => [money(Number(value), currency), name]}
                  />
                  <Legend {...LEGEND_PROPS} />
                  <Area type="monotone" dataKey="cash" name="Cash balance" stroke={CHART_ROLE.neutral} strokeWidth={2.5} fill={`url(#cash-fill-${portfolioId})`} dot={false} activeDot={{ r: 4 }} />
                  <Line type="stepAfter" dataKey="minimumBuy" name="Minimum buy" stroke={OKABE_ITO.orange} strokeWidth={2} strokeDasharray="7 4" dot={false} />
                  <Line type="stepAfter" dataKey="dealingAllowance" name="30-day cost allowance" stroke={OKABE_ITO.reddishPurple} strokeWidth={2} strokeDasharray="2 3" dot={false} />
                  <Line type="stepAfter" dataKey="allowanceRemaining" name="Allowance left" stroke={CHART_ROLE.positive} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartFrame>
            <p className="text-[11px] text-muted-foreground">
              The AI allows up to {q.data.rules.maxBuysPerDay} buys a day, waits {q.data.rules.addCooldownDays} days before adding to the same name, and keeps {q.data.rules.reserveTickets} ticket for signals clearing {q.data.rules.reserveEdgeMultiple}× their expected cost. After {q.data.rules.stallDays} quiet days, that reserve bar relaxes to {q.data.rules.stallReserveEdgeMultiple}×.
            </p>
          </div>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
