import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getAllPortfoliosEquity } from "@/lib/trading.functions";
import { buildDepositAdjustedSeries } from "@/lib/deposit-adjusted-series";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

function compactNum(v: number) {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${(v / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return `${v.toFixed(0)}`;
}

function shortDate(s: string) {
  // "2026-07-24" -> "24 Jul"
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}


const LINE_COLORS = ["#f472b6", "#a78bfa", "#facc15", "#4ade80", "#fb923c", "#60a5fa"];
const SIM_COLOR = "#22d3ee";
const REAL_COLOR = "#34d399";
const AXIS_COLOR = "oklch(0.96 0.01 90)";
const GRID_COLOR = "hsl(var(--foreground))";

type Range = "7d" | "30d" | "90d" | "1y" | "all";

const RANGE_OPTS: { value: Range; label: string; days: number | null }[] = [
  { value: "7d", label: "7D", days: 7 },
  { value: "30d", label: "30D", days: 30 },
  { value: "90d", label: "90D", days: 90 },
  { value: "1y", label: "1Y", days: 365 },
  { value: "all", label: "All", days: null },
];

type PortfolioMeta = { id: string; name: string; currency: string; mode: string };

export function AllPortfoliosChart() {
  const fetchAll = useServerFn(getAllPortfoliosEquity);
  const q = useQuery({
    queryKey: ["all-portfolios-equity"],
    queryFn: () => fetchAll(),
    staleTime: 30_000,
  });

  const portfolios: PortfolioMeta[] = q.data?.portfolios ?? [];
  const currency = q.data?.currency ?? "GBP";
  const simPortfolios = portfolios.filter((p) => p.mode !== "live_prod");
  const realPortfolios = portfolios.filter((p) => p.mode === "live_prod");

  if (!q.data || portfolios.length === 0) return null;

  const allDeposits = q.data.deposits ?? [];
  const simIds = new Set(simPortfolios.map((p) => p.id));
  const realIds = new Set(realPortfolios.map((p) => p.id));
  const simDeposits = allDeposits.filter((d) => simIds.has(d.portfolio_id));
  const realDeposits = allDeposits.filter((d) => realIds.has(d.portfolio_id));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ModeChart
        title="Simulated portfolios"
        description="Paper trading and live-sim — no real money."
        badgeLabel="SIM"
        badgeTone="secondary"
        color={SIM_COLOR}
        totalKey="total_sim"
        portfolios={simPortfolios}
        allSeries={q.data.series}
        currency={currency}
        deposits={simDeposits}
      />
      <ModeChart
        title="Real-money portfolios"
        description="Live Saxo — actual cash at risk."
        badgeLabel="REAL"
        badgeTone="default"
        color={REAL_COLOR}
        totalKey="total_real"
        portfolios={realPortfolios}
        allSeries={q.data.series}
        currency={currency}
        deposits={realDeposits}
      />
    </div>
  );
}

function ModeChart({
  title,
  description,
  badgeLabel,
  badgeTone,
  color,
  totalKey,
  portfolios,
  allSeries,
  currency,
  deposits,
}: {
  title: string;
  description: string;
  badgeLabel: string;
  badgeTone: "default" | "secondary";
  color: string;
  totalKey: "total_sim" | "total_real";
  portfolios: PortfolioMeta[];
  allSeries: Array<Record<string, string | number>>;
  currency: string;
  deposits: Array<{ portfolio_id: string; date: string; amount: number }>;
}) {
  const [range, setRange] = useState<Range>("all");
  const isMobile = useIsMobile();


  const { series, totalNow, startingTotal, adjustedNow, netDeposits, yDomain } = useMemo(() => {
    const opt = RANGE_OPTS.find((r) => r.value === range)!;
    let s = allSeries.filter((row) => Number.isFinite(Number(row[totalKey])));
    if (opt.days && s.length > 0) {
      const cutoff = Date.now() - opt.days * 86_400_000;
      s = s.filter((r) => new Date(String(r.date)).getTime() >= cutoff);
      if (s.length === 0) s = allSeries.filter((row) => Number.isFinite(Number(row[totalKey]))).slice(-1);
    }
    const start = s[0] ? Number(s[0][totalKey]) : 0;
    const last = s[s.length - 1] ? Number(s[s.length - 1][totalKey]) : 0;
    const totals = s.map((r) => Number(r[totalKey])).filter((n) => Number.isFinite(n));
    let lo = Math.min(...totals);
    let hi = Math.max(...totals);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    const pad = Math.max((hi - lo) * 0.1, hi * 0.005, 1);

    // Deposit-adjusted trailing % for this window. Only deposits dated
    // strictly after the first visible point are netted out (matches
    // computeModeSummary semantics).
    const startDate = s[0] ? String(s[0].date) : "";
    const adj = buildDepositAdjustedSeries(
      s.map((r) => ({ date: String(r.date), equity: Number(r[totalKey]) })),
      deposits.map((d) => ({ date: d.date, amount: d.amount })),
      startDate,
    );
    const adjLast = adj.length > 0 ? adj[adj.length - 1].adjusted : last;
    const netDep = last - adjLast;

    return {
      series: s,
      totalNow: last,
      startingTotal: start,
      adjustedNow: adjLast,
      netDeposits: netDep,
      yDomain: [Math.max(0, lo - pad), hi + pad] as [number, number],
    };
  }, [allSeries, totalKey, range, deposits]);

  // Trading-only PnL and % — deposits are excluded so a cash top-up
  // never masquerades as profit.
  const pnl = adjustedNow - startingTotal;
  const pnlPct = startingTotal > 0 ? (pnl / startingTotal) * 100 : 0;
  const fmt = (v: number) => `${currency}${v.toFixed(0)}`;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant={badgeTone}>{badgeLabel}</Badge>
              <CardTitle className="text-base">{title}</CardTitle>
            </div>
            <CardDescription className="mt-1">{description}</CardDescription>
          </div>
          <ToggleGroup
            type="single"
            size="sm"
            value={range}
            onValueChange={(v) => v && setRange(v as Range)}
            className="shrink-0"
          >
            {RANGE_OPTS.map((r) => (
              <ToggleGroupItem key={r.value} value={r.value} className="px-2.5 text-xs">
                {r.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </CardHeader>
      <CardContent>
        {portfolios.length === 0 ? (
          <div className="flex h-[280px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            No {badgeLabel === "REAL" ? "real-money" : "simulated"} portfolios yet.
          </div>
        ) : (
          <>
            <div className="mb-3">
              <div className="text-lg font-semibold leading-tight tracking-tight tabular-nums sm:text-2xl">
                {currency} {totalNow.toFixed(2)}
              </div>
              <div className={`mt-0.5 text-[11px] leading-snug sm:text-xs ${pnl >= 0 ? "text-primary" : "text-destructive"}`}>
                {pnl >= 0 ? "+" : ""}{currency} {pnl.toFixed(2)} ({pnl >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%) over {RANGE_OPTS.find((r) => r.value === range)!.label}
                {Math.abs(netDeposits) > 0.005 && (
                  <span
                    className="ml-1 text-muted-foreground"
                    title={`Excludes ${currency}${netDeposits.toFixed(2)} of ${netDeposits >= 0 ? "deposits" : "withdrawals"} in this window`}
                  >
                    · trading only
                  </span>
                )}
              </div>
              </div>
            </div>
            <div className="h-[260px] w-full sm:h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={series} margin={{ top: 8, right: isMobile ? 6 : 12, bottom: 20, left: isMobile ? -8 : 8 }}>
                  <defs>
                    <linearGradient id={`area-${totalKey}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={color} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={GRID_COLOR} strokeOpacity={0.18} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: isMobile ? 10 : 11, fill: AXIS_COLOR }}
                    stroke={AXIS_COLOR}
                    strokeOpacity={0.6}
                    minTickGap={isMobile ? 56 : 40}
                    tickFormatter={(v) => (isMobile ? shortDate(String(v)) : String(v))}
                  />
                  <YAxis
                    width={isMobile ? 44 : 64}
                    tick={{ fontSize: isMobile ? 10 : 11, fill: AXIS_COLOR }}
                    stroke={AXIS_COLOR}
                    strokeOpacity={0.6}
                    tickFormatter={(v) => (isMobile ? `${currency}${compactNum(Number(v))}` : fmt(Number(v)))}
                    domain={yDomain}
                    allowDataOverflow
                  />
                  <Tooltip
                    cursor={{ stroke: AXIS_COLOR, strokeOpacity: 0.4, strokeDasharray: "3 3" }}
                    wrapperStyle={{ zIndex: 40, maxWidth: "min(85vw, 320px)" }}
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const row = payload[0].payload as Record<string, number | string>;
                      return (
                        <div className="max-w-[85vw] rounded-md border bg-popover px-2.5 py-2 text-[11px] shadow-md sm:text-xs">
                          <div className="mb-1 font-medium">{String(label)}</div>
                          <div className="mb-1 flex justify-between gap-3 tabular-nums">
                            <span className="text-muted-foreground">{badgeLabel} total</span>
                            <span className="font-medium">{currency} {Number(row[totalKey]).toFixed(2)}</span>
                          </div>
                          {portfolios.map((p, i) => (
                            <div key={p.id} className="flex justify-between gap-3 tabular-nums">
                              <span className="truncate" style={{ color: LINE_COLORS[i % LINE_COLORS.length] }}>{p.name}</span>
                              <span className="shrink-0">
                                {Number.isFinite(Number(row[p.id])) ? `${currency} ${Number(row[p.id]).toFixed(2)}` : "—"}
                              </span>
                            </div>
                          ))}
                        </div>
                      );
                    }}
                  />
                  <Legend verticalAlign="top" height={24} wrapperStyle={{ fontSize: isMobile ? 10 : 12, color: AXIS_COLOR }} />

                  <Area
                    type="monotone"
                    dataKey={totalKey}
                    name={`${badgeLabel} total`}
                    stroke={color}
                    strokeWidth={2.5}
                    fill={`url(#area-${totalKey})`}
                    isAnimationActive={false}
                  />
                  {portfolios.map((p, i) => (
                    <Line
                      key={p.id}
                      type="monotone"
                      dataKey={p.id}
                      name={p.name}
                      stroke={LINE_COLORS[i % LINE_COLORS.length]}
                      strokeWidth={1.75}
                      strokeDasharray="4 3"
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
