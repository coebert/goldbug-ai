import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  BellRing,
  ArrowUpRight,
  ChevronRight,
  Minus,
  RefreshCw,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { getMarketPulse } from "@/lib/market-pulse.functions";
import type { PulseAlert } from "@/lib/market-pulse-alerts";
import { DEFAULT_RANGE, isKnownSymbol } from "@/lib/market-symbol-history";
import {
  groupLabel,
  toneBlurb,
  toneLabel,
  type MarketPulse,
  type PulseGroup,
  type PulseQuote,
} from "@/lib/market-pulse";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChartFrame } from "@/components/chart-frame";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_SEQUENCE,
  GRID_PROPS,
  LEGEND_STYLE,
  REFERENCE_LINE,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "@/lib/chart-palette";

const WINDOWS = [30, 90, 180] as const;

const GROUP_ORDER: PulseGroup[] = ["equities", "rates", "commodities", "fx", "crypto", "volatility"];

function pct(v: number | null | undefined, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function moveClass(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v) || Math.abs(v) < 0.01) return "text-muted-foreground";
  return v > 0 ? "text-emerald-500" : "text-destructive";
}

function MoveIcon({ v }: { v: number | null | undefined }) {
  if (v == null || Math.abs(v) < 0.01) return <Minus className="h-3.5 w-3.5" aria-hidden="true" />;
  return v > 0 ? (
    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
  ) : (
    <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />
  );
}

/** Horizontal heat bar for a single sector's move, centred on zero. */
function HeatBar({ value, max }: { value: number | null; max: number }) {
  const v = value ?? 0;
  const width = max > 0 ? Math.min(50, (Math.abs(v) / max) * 50) : 0;
  return (
    <div className="relative h-2.5 w-full rounded-full bg-muted/50" aria-hidden="true">
      <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <div
        className={`absolute inset-y-0 rounded-full ${v >= 0 ? "bg-emerald-500/80" : "bg-destructive/80"}`}
        style={
          v >= 0
            ? { left: "50%", width: `${width}%` }
            : { right: "50%", width: `${width}%` }
        }
      />
    </div>
  );
}

/** Wraps children in a drill-down link to the full chart for `symbol`. */
function SymbolLink({
  symbol,
  className,
  children,
  ariaLabel,
}: {
  symbol: string;
  className?: string;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  if (!isKnownSymbol(symbol)) return <div className={className}>{children}</div>;
  return (
    <Link
      to="/market/$symbol"
      params={{ symbol }}
      search={{ range: DEFAULT_RANGE }}
      aria-label={ariaLabel}
      className={`${className ?? ""} cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
    >
      {children}
    </Link>
  );
}

function QuoteRow({ q }: { q: PulseQuote }) {
  return (
    <SymbolLink
      symbol={q.symbol}
      ariaLabel={`View full chart for ${q.label}`}
      className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 odd:bg-muted/20"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{q.label}</div>
        <div className="text-[11px] text-muted-foreground">
          {q.aboveSma50 == null
            ? "trend unknown"
            : q.aboveSma50
              ? "above its 50-day average"
              : "below its 50-day average"}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-right tabular-nums">
        <div className={`flex items-center gap-0.5 text-sm font-semibold ${moveClass(q.changePct1d)}`}>
          <MoveIcon v={q.changePct1d} />
          {pct(q.changePct1d)}
        </div>
        <div className="hidden w-14 text-xs text-muted-foreground sm:block">
          5d {pct(q.changePct5d)}
        </div>
        <div className="w-16 text-xs text-muted-foreground">1m {pct(q.changePct1m)}</div>
        <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </div>
    </SymbolLink>
  );
}

/** Tripped watch rules, each with the metric's live value and its threshold. */
function PulseAlerts({ alerts }: { alerts: PulseAlert[] }) {
  if (!alerts.length) return null;
  return (
    <section className="space-y-2" aria-label="Market pulse alerts">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <BellRing className="h-3.5 w-3.5" aria-hidden="true" /> Alerts ({alerts.length})
      </div>
      <ul className="space-y-2">
        {alerts.map((a) => {
          const critical = a.severity === "critical";
          const tone = critical
            ? "border-destructive/40 bg-destructive/10"
            : "border-amber-500/40 bg-amber-500/10";
          const inner = (
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <AlertTriangle
                    className={`h-4 w-4 shrink-0 ${critical ? "text-destructive" : "text-amber-500"}`}
                    aria-hidden="true"
                  />
                  <span className="text-sm font-semibold">{a.title}</span>
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {critical ? "Critical" : "Warning"}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{a.body}</p>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <div className="text-sm font-semibold">{a.valueText}</div>
                <div className="text-[11px] text-muted-foreground">
                  {a.metric} · alert at {a.thresholdText}
                </div>
              </div>
            </div>
          );
          return (
            <li key={`${a.id}-${a.severity}`}>
              {a.symbol ? (
                <SymbolLink
                  symbol={a.symbol}
                  ariaLabel={`View full chart for ${a.metric}`}
                  className={`block rounded-xl border p-3 ${tone}`}
                >
                  {inner}
                </SymbolLink>
              ) : (
                <div className={`rounded-xl border p-3 ${tone}`}>{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}


function ToneGauge({ score, tone }: { score: number; tone: MarketPulse["tone"] }) {
  const color =
    tone === "risk_on" ? "bg-emerald-500" : tone === "risk_off" ? "bg-destructive" : "bg-amber-500";
  return (
    <div className="space-y-1.5">
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted/60">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Fearful</span>
        <span>Neutral</span>
        <span>Confident</span>
      </div>
    </div>
  );
}
/** Auto-refresh cadence for the market pulse dashboard. */
const REFRESH_MS = 5 * 60_000;


/**
 * Home-screen market dashboard: one risk-appetite read, cross-asset moves,
 * sector leadership and a normalised comparison chart — enough to judge the
 * general state of markets in a few seconds.
 */
export function MarketPulseCard() {
  const fetchPulse = useServerFn(getMarketPulse);
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(90);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const query = useQuery({
    queryKey: ["market-pulse", days],
    queryFn: () => fetchPulse({ data: { comparisonDays: days } }),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
    refetchInterval: autoRefresh ? REFRESH_MS : false,
  });

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const secondsLeft = query.dataUpdatedAt
    ? Math.max(0, Math.ceil((query.dataUpdatedAt + REFRESH_MS - now) / 1000))
    : REFRESH_MS / 1000;


  const pulse = query.data;
  const grouped = useMemo(() => {
    const out = new Map<PulseGroup, PulseQuote[]>();
    for (const q of pulse?.quotes ?? []) {
      const list = out.get(q.group);
      if (list) list.push(q);
      else out.set(q.group, [q]);
    }
    return out;
  }, [pulse]);

  const sectorMax = useMemo(() => {
    const vals = (pulse?.sectors ?? []).map((s) => Math.abs(s.changePct1m ?? 0));
    return Math.max(1, ...vals);
  }, [pulse]);

  const sortedSectors = useMemo(
    () => [...(pulse?.sectors ?? [])].sort((a, b) => (b.changePct1m ?? 0) - (a.changePct1m ?? 0)),
    [pulse],
  );

  if (query.isLoading) {
    return <div className="h-72 rounded-2xl border bg-card/50" aria-hidden="true" />;
  }

  if (query.isError || !pulse) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-3 py-6">
          <p className="text-sm text-muted-foreground">Couldn't load market data right now.</p>
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>
            <RefreshCw className="mr-1 h-4 w-4" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const b = pulse.breadth;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 pb-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" /> Market pulse
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            The state of world markets{pulse.asOf ? ` as at ${pulse.asOf}` : ""} — prices, trends and
            where the money is going.
          </p>
        </div>
        <Badge
          variant="outline"
          className={
            pulse.tone === "risk_on"
              ? "border-emerald-500/40 text-emerald-500"
              : pulse.tone === "risk_off"
                ? "border-destructive/40 text-destructive"
                : "border-amber-500/40 text-amber-500"
          }
        >
          {toneLabel(pulse.tone)} · {pulse.toneScore}/100
        </Badge>
      </CardHeader>

      <CardContent className="space-y-6">
        <PulseAlerts alerts={pulse.alerts ?? []} />

        {/* Headline read */}
        <section className="grid gap-4 rounded-xl border border-border/70 bg-surface-2 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <div>
              <div className="font-display text-xl font-bold tracking-tight">{toneBlurb(pulse.tone)}</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Score blends participation, trend, volatility and sector leadership.
              </p>
            </div>
            <ToneGauge score={pulse.toneScore} tone={pulse.tone} />
          </div>
          <ul className="space-y-1.5 text-xs text-muted-foreground">
            {pulse.toneReasons.map((r) => (
              <li key={r} className="flex gap-2">
                <span aria-hidden="true">•</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Breadth strip */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Rising today" value={`${b.advancers}/${b.total}`} sub={pct(b.advancersPct, 0)} />
          <Stat label="Falling today" value={`${b.decliners}/${b.total}`} />
          <Stat
            label="In an uptrend"
            value={b.aboveSma50Pct == null ? "—" : `${Math.round(b.aboveSma50Pct)}%`}
            sub="above 50-day average"
          />
          <Stat
            label="Volatility (VIX)"
            value={
              pulse.quotes.find((q) => q.symbol === "^VIX")?.close.toFixed(1) ?? "—"
            }
            sub={pct(pulse.quotes.find((q) => q.symbol === "^VIX")?.changePct1d)}
            symbol="^VIX"
          />
        </section>

        {/* Comparison chart */}
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">How the big markets have moved</h3>
            <div className="flex gap-1">
              {WINDOWS.map((w) => (
                <Button
                  key={w}
                  size="sm"
                  variant={w === days ? "secondary" : "ghost"}
                  className="h-7 px-2 text-xs"
                  onClick={() => setDays(w)}
                >
                  {w}d
                </Button>
              ))}
            </div>
          </div>
          <ChartFrame className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={pulse.comparison.series} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="date"
                  tick={AXIS_TICK}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                  minTickGap={40}
                  tickFormatter={(d: string) => d.slice(5)}
                />
                <YAxis
                  tick={AXIS_TICK}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                  width={44}
                  domain={["auto", "auto"]}
                  tickFormatter={(v: number) => `${v.toFixed(0)}`}
                />
                <ReferenceLine y={100} {...REFERENCE_LINE} />
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  formatter={(v: number, name: string) => [`${(v - 100).toFixed(1)}%`, name]}
                />
                {pulse.comparison.keys.map((k, i) => (
                  <Line
                    key={k.symbol}
                    type="monotone"
                    dataKey={k.symbol}
                    name={k.label}
                    stroke={CHART_SEQUENCE[i % CHART_SEQUENCE.length]}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </ChartFrame>
          <div className="flex flex-wrap gap-3" style={LEGEND_STYLE}>
            {pulse.comparison.keys.map((k, i) => (
              <SymbolLink
                key={k.symbol}
                symbol={k.symbol}
                ariaLabel={`View full chart for ${k.label}`}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs underline-offset-2 hover:underline"
              >
                <span
                  className="inline-block h-2 w-4 rounded-full"
                  style={{ background: CHART_SEQUENCE[i % CHART_SEQUENCE.length] }}
                  aria-hidden="true"
                />
                {k.label}
              </SymbolLink>
            ))}
            <span className="text-xs text-muted-foreground">
              All lines start at 100 — the value shown is the % change since then.
            </span>
          </div>
        </section>

        {/* Cross-asset table */}
        <section className="grid gap-4 lg:grid-cols-2">
          {GROUP_ORDER.filter((g) => grouped.get(g)?.length).map((g) => (
            <div key={g} className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {groupLabel(g)}
              </h3>
              <div className="rounded-lg border border-border/60">
                {(grouped.get(g) ?? []).map((q) => (
                  <QuoteRow key={q.symbol} q={q} />
                ))}
              </div>
            </div>
          ))}
        </section>

        {/* Sector leadership */}
        {sortedSectors.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Which parts of the market are leading</h3>
            <p className="-mt-1 text-xs text-muted-foreground">
              US sectors, ranked by their move over the last month.
            </p>
            <div className="space-y-1.5">
              {sortedSectors.map((s) => (
                <SymbolLink
                  key={s.symbol}
                  symbol={s.symbol}
                  ariaLabel={`View full chart for ${s.label}`}
                  className="grid grid-cols-[7.5rem_1fr_3.5rem] items-center gap-3 rounded-lg px-1 py-1 sm:grid-cols-[10rem_1fr_4rem]"
                >
                  <span className="truncate text-xs">{s.label}</span>
                  <HeatBar value={s.changePct1m} max={sectorMax} />
                  <span className={`text-right text-xs font-medium tabular-nums ${moveClass(s.changePct1m)}`}>
                    {pct(s.changePct1m)}
                  </span>
                </SymbolLink>
              ))}
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  sub,
  symbol,
}: {
  label: string;
  value: string;
  sub?: string;
  symbol?: string;
}) {
  const body = (
    <>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-display text-lg font-bold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </>
  );
  const cls = "block rounded-xl border border-border/60 bg-surface-2 px-3 py-2.5";
  if (symbol && isKnownSymbol(symbol)) {
    return (
      <SymbolLink symbol={symbol} ariaLabel={`View full chart for ${label}`} className={cls}>
        {body}
      </SymbolLink>
    );
  }
  return <div className={cls}>{body}</div>;
}
