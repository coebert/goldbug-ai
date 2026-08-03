import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getFxHealth } from "@/lib/fx-health.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, RefreshCw } from "lucide-react";
import { formatUkTime } from "@/lib/uk-time";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_ROLE,
  LEGEND_STYLE,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
} from "@/lib/chart-palette";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { POLL } from "@/lib/query-keys";

interface Props {
  portfolioId: string;
  active?: boolean;
}

/**
 * FX provider health for a portfolio. Reads the last 24h of FX_CAPTURE logs
 * and shows per-pair status plus provider hit counts so the operator can
 * see at a glance whether Yahoo / Frankfurter are healthy or whether the
 * app is coasting on cache / identity fallbacks.
 */
export function FxHealthCard({ portfolioId, active = true }: Props) {
  const fetchHealth = useServerFn(getFxHealth);
  const query = useQuery({
    queryKey: ["fx-health", portfolioId],
    queryFn: () => fetchHealth({ data: { portfolioId, sinceHours: 24 } }),
    enabled: active,
    staleTime: 30_000,
    refetchInterval: POLL.SEMI_LIVE,
  });

  const data = query.data;
  const overall = data?.overall ?? "ok";

  return (
    <Card
      className={
        overall === "critical"
          ? "border-destructive/40"
          : overall === "degraded"
            ? "border-amber-500/40"
            : "border-emerald-500/30"
      }
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity
              className={`h-4 w-4 ${
                overall === "critical"
                  ? "text-destructive"
                  : overall === "degraded"
                    ? "text-amber-500"
                    : "text-emerald-500"
              }`}
              aria-hidden
            />
            FX endpoint health
            <StatusPill status={overall} />
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            aria-label="Refresh FX health"
          >
            <RefreshCw
              className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`}
              aria-hidden
            />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Yahoo / Frankfurter success rate over the last {data?.windowHours ?? 24}h. Identity
          fallback (rate 1.0000) means both providers failed and cross-currency buys are being
          blocked.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading && <div className="h-20 rounded-lg border bg-muted/30" aria-hidden />}
        {query.error && (
          <p className="text-sm text-destructive">
            Failed to load: {String((query.error as Error).message ?? query.error)}
          </p>
        )}
        {data && data.pairs.length === 0 && !query.isLoading && (
          <p className="text-sm text-muted-foreground">
            No cross-currency FX activity in the window — nothing to monitor.
          </p>
        )}
        {data?.circuit?.open && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <div className="font-semibold">Cross-currency buy circuit: OPEN</div>
            <p className="mt-1 text-xs">
              New cross-currency buys are paused. Auto-resume when a live FX provider (Yahoo /
              Frankfurter) capture arrives.
              {data.circuit.lastFallbackAt && (
                <> Last fallback: {formatUkTime(data.circuit.lastFallbackAt)}.</>
              )}
              {data.circuit.lastOkAt && (
                <> Last live capture: {formatUkTime(data.circuit.lastOkAt)}.</>
              )}
            </p>
          </div>
        )}
        {data && !data.circuit?.open && data.circuit?.lastOkAt && (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-2 text-xs text-emerald-700 dark:text-emerald-400">
            Cross-currency buy circuit: CLOSED (allowing buys). Last live capture{" "}
            {formatUkTime(data.circuit.lastOkAt)}.
          </div>
        )}
        {data && <SkipCounters skips={data.skipCounters} />}
        {data && (
          <>
            <AvailabilityStrip availability={data.availability} />
            <TimelineChart timeline={data.timeline} />
          </>
        )}
        {data && data.pairs.length > 0 && (
          <>
            {overall !== "ok" && (
              <div
                role="alert"
                className={`rounded-lg border p-3 text-sm ${
                  overall === "critical"
                    ? "border-destructive/40 bg-destructive/5 text-destructive"
                    : "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
                }`}
              >
                {overall === "critical"
                  ? "FX providers are currently DOWN. Cross-currency buys will be refused. An in-app notification has been sent."
                  : "FX providers are degraded — some captures fell back to cache or stale rates. Trades continue with a wider safety buffer."}
              </div>
            )}
            <ul className="space-y-2">
              {data.pairs.map((p) => {
                const pt = data.pairTimelines?.find((t) => t.pair === p.pair);
                return (
                  <li key={p.pair} className="rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium">{p.pair}</span>
                        <StatusPill status={p.status} />
                      </div>
                      <div className="text-xs text-muted-foreground">
                        last: {p.lastRate != null ? p.lastRate.toFixed(4) : "?"}{" "}
                        <Badge variant="outline" className="ml-1 font-mono text-[10px]">
                          {p.lastSource}
                        </Badge>
                        {p.lastAt && <span className="ml-2">{formatUkTime(p.lastAt)}</span>}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                      <ProviderChip label="frankfurter" n={p.counts.frankfurter} good />
                      <ProviderChip label="er-api" n={p.counts["er-api"]} good />
                      {p.counts.yahoo > 0 && <ProviderChip label="yahoo" n={p.counts.yahoo} good />}
                      <ProviderChip label="cache" n={p.counts.cache} />
                      {p.counts["cache-stale"] > 0 && (
                        <ProviderChip label="cache-stale" n={p.counts["cache-stale"]} warn />
                      )}
                      {p.counts.fallback > 0 && (
                        <ProviderChip label="identity fallback" n={p.counts.fallback} bad />
                      )}
                    </div>
                    {pt && <PairTimelineChart pair={p.pair} buckets={pt.buckets} />}
                    {p.lastError && (
                      <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
                        {p.lastError}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatusPill({ status }: { status: "ok" | "degraded" | "critical" }) {
  if (status === "critical") return <Badge variant="destructive">critical</Badge>;
  if (status === "degraded")
    return (
      <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">
        degraded
      </Badge>
    );
  return (
    <Badge
      variant="outline"
      className="border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
    >
      healthy
    </Badge>
  );
}

function ProviderChip({
  label,
  n,
  good,
  warn,
  bad,
}: {
  label: string;
  n: number;
  good?: boolean;
  warn?: boolean;
  bad?: boolean;
}) {
  const cls = bad
    ? "border-destructive/60 text-destructive"
    : warn
      ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
      : good && n > 0
        ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
        : "";
  return (
    <Badge variant="outline" className={cls}>
      {label}: {n}
    </Badge>
  );
}

type Availability = {
  liveProviderPct: number;
  cachePct: number;
  stalePct: number;
  fallbackPct: number;
  total: number;
};

function AvailabilityStrip({ availability }: { availability: Availability }) {
  if (availability.total === 0) {
    return (
      <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
        No FX captures in window yet.
      </div>
    );
  }
  const items = [
    {
      label: "Live provider",
      value: availability.liveProviderPct,
      cls: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "Cache",
      value: availability.cachePct,
      cls: "text-muted-foreground",
    },
    {
      label: "Stale",
      value: availability.stalePct,
      cls: "text-amber-600 dark:text-amber-400",
    },
    {
      label: "Fallback",
      value: availability.fallbackPct,
      cls: "text-destructive",
    },
  ];
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {items.map((it) => (
          <div key={it.label} className="rounded-lg border bg-card p-2 text-center">
            <div className={`text-lg font-semibold tabular-nums ${it.cls}`}>
              {it.value.toFixed(1)}%
            </div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {it.label}
            </div>
          </div>
        ))}
      </div>
      <div
        className="mt-2 flex h-2 w-full overflow-hidden rounded-full border bg-muted"
        aria-label="FX source share"
      >
        <div className="bg-emerald-500" style={{ width: `${availability.liveProviderPct}%` }} />
        <div className="bg-muted-foreground/40" style={{ width: `${availability.cachePct}%` }} />
        <div className="bg-amber-500" style={{ width: `${availability.stalePct}%` }} />
        <div className="bg-destructive" style={{ width: `${availability.fallbackPct}%` }} />
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">
        {availability.total} FX captures analysed
      </div>
    </div>
  );
}

type TimelineBucket = {
  hour: string;
  ok: number;
  cache: number;
  stale: number;
  fallback: number;
  total: number;
};

function TimelineChart({ timeline }: { timeline: TimelineBucket[] }) {
  const data = timeline.map((b) => ({
    ...b,
    label: new Date(b.hour).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      timeZone: "Europe/London",
    }),
  }));
  const hasAny = data.some((b) => b.total > 0);
  if (!hasAny) return null;
  return (
    <div className="rounded-lg border p-2">
      <div className="mb-1 px-1 text-xs font-medium">Provider availability by hour</div>
      <div className="h-32 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <XAxis
              dataKey="label"
              tick={AXIS_TICK}
              interval="preserveStartEnd"
              axisLine={AXIS_LINE}
              tickLine={TICK_LINE}
            />
            <YAxis
              width={64}
              tick={AXIS_TICK}
              allowDecimals={false}
              axisLine={AXIS_LINE}
              tickLine={TICK_LINE}
            />
            <Tooltip
              contentStyle={TOOLTIP_CONTENT_STYLE}
              labelFormatter={(_, payload) => {
                const iso = payload?.[0]?.payload?.hour as string | undefined;
                return iso ? formatUkTime(iso) : "";
              }}
            />
            <Legend wrapperStyle={LEGEND_STYLE} iconSize={8} />
            <Bar dataKey="ok" name="Live" stackId="s" fill="var(--chart-2)" />
            <Bar dataKey="cache" name="Cache" stackId="s" fill="var(--muted-foreground)" />
            <Bar dataKey="stale" name="Stale" stackId="s" fill={CHART_ROLE.benchmark} />
            <Bar dataKey="fallback" name="Fallback" stackId="s" fill="var(--destructive)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function PairTimelineChart({ pair, buckets }: { pair: string; buckets: TimelineBucket[] }) {
  const data = buckets.map((b) => ({
    ...b,
    label: new Date(b.hour).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      timeZone: "Europe/London",
    }),
  }));
  const hasAny = data.some((b) => b.total > 0);
  if (!hasAny) return null;
  const totalFallback = data.reduce((n, b) => n + b.fallback, 0);
  return (
    <div className="mt-2 rounded-md border bg-muted/10 p-1.5">
      <div className="flex items-center justify-between px-1 pb-1">
        <div className="text-[11px] font-medium">
          <span className="font-mono">{pair}</span> hourly health
        </div>
        {totalFallback > 0 && (
          <span className="text-[10px] font-medium text-destructive">
            {totalFallback} identity-fallback{totalFallback === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="h-20 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 2, right: 6, left: -24, bottom: 0 }}>
            <XAxis
              dataKey="label"
              tick={AXIS_TICK}
              interval="preserveStartEnd"
              axisLine={AXIS_LINE}
              tickLine={TICK_LINE}
            />
            <YAxis
              tick={AXIS_TICK}
              allowDecimals={false}
              width={64}
              axisLine={AXIS_LINE}
              tickLine={TICK_LINE}
            />
            <Tooltip
              contentStyle={TOOLTIP_CONTENT_STYLE}
              labelFormatter={(_, payload) => {
                const iso = payload?.[0]?.payload?.hour as string | undefined;
                return iso ? formatUkTime(iso) : "";
              }}
            />
            <Bar dataKey="ok" name="Live" stackId="s" fill="var(--chart-2)" />
            <Bar dataKey="cache" name="Cache" stackId="s" fill="var(--muted-foreground)" />
            <Bar dataKey="stale" name="Stale" stackId="s" fill={CHART_ROLE.benchmark} />
            <Bar dataKey="fallback" name="Fallback" stackId="s" fill="var(--destructive)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

type SkipCountersData = {
  fxBroken: { events: number; orders: number; lastAt: string | null };
  circuit: { events: number; orders: number; lastAt: string | null };
  recent: Array<{
    method: "PRE_PLACE_FX_BLOCK" | "PRE_PLACE_FX_CIRCUIT_OPEN";
    at: string;
    pair: string | null;
    orderCount: number;
    reason: string | null;
  }>;
};

function SkipCounters({ skips }: { skips: SkipCountersData }) {
  const total = skips.fxBroken.events + skips.circuit.events;
  if (total === 0) {
    return (
      <div className="rounded-lg border bg-muted/20 p-2 text-xs text-muted-foreground">
        No cross-currency buys have been skipped in this window.
      </div>
    );
  }
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 text-xs font-medium">
        Cross-currency buy skips
        <span className="ml-1 text-muted-foreground">(this window)</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <SkipTile
          label="fxIsBroken (this tick)"
          events={skips.fxBroken.events}
          orders={skips.fxBroken.orders}
          lastAt={skips.fxBroken.lastAt}
          tone="destructive"
        />
        <SkipTile
          label="Persistent circuit"
          events={skips.circuit.events}
          orders={skips.circuit.orders}
          lastAt={skips.circuit.lastAt}
          tone="amber"
        />
      </div>
      {skips.recent.length > 0 && (
        <ul className="mt-2 space-y-1 text-[11px]">
          {skips.recent.slice(0, 6).map((e, i) => (
            <li
              key={`${e.at}-${i}`}
              className="flex flex-wrap items-center gap-2 border-t pt-1 first:border-t-0 first:pt-0"
            >
              <Badge
                variant="outline"
                className={
                  e.method === "PRE_PLACE_FX_BLOCK"
                    ? "border-destructive/50 text-destructive"
                    : "border-amber-500/50 text-amber-600 dark:text-amber-400"
                }
              >
                {e.method === "PRE_PLACE_FX_BLOCK" ? "fxBroken" : "circuit"}
              </Badge>
              <span className="font-mono text-muted-foreground">{e.pair ?? "—"}</span>
              <span className="text-muted-foreground">
                {e.orderCount} order{e.orderCount === 1 ? "" : "s"}
              </span>
              <span className="ml-auto text-muted-foreground">{formatUkTime(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SkipTile({
  label,
  events,
  orders,
  lastAt,
  tone,
}: {
  label: string;
  events: number;
  orders: number;
  lastAt: string | null;
  tone: "destructive" | "amber";
}) {
  const toneCls = tone === "destructive" ? "border-destructive/40" : "border-amber-500/40";
  const numCls = tone === "destructive" ? "text-destructive" : "text-amber-600 dark:text-amber-400";
  return (
    <div className={`rounded-md border p-2 ${toneCls}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${numCls}`}>
        {events}
        <span className="ml-1 text-xs font-normal text-muted-foreground">
          tick{events === 1 ? "" : "s"} · {orders} order{orders === 1 ? "" : "s"}
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground">
        {lastAt ? `Last: ${formatUkTime(lastAt)}` : "No skips in window"}
      </div>
    </div>
  );
}
