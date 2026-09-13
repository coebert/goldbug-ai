import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  clearSymbolLimits,
  getSymbolDetail,
  saveSymbolLimits,
} from "@/lib/symbol-desk.functions";

export const Route = createFileRoute("/symbols/$symbol")({
  head: ({ params }) => {
    const sym = String(params.symbol ?? "").toUpperCase();
    return {
      meta: [
        { title: `${sym} — Signal Strength & Risk Limits | Aegis` },
        {
          name: "description",
          content: `${sym}: measured signal strength from this account's history, dealing cost, price levels and the risk limits you can set by hand.`,
        },
        { property: "og:title", content: `${sym} — Signal Strength & Risk Limits | Aegis` },
        {
          property: "og:description",
          content: `Track record, price levels and hand-set trading limits for ${sym}.`,
        },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary" },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: SymbolDetailPage,
});

function pct(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}

function toPctField(v: number | null): string {
  return v == null ? "" : String(Math.round(v * 1000) / 10);
}

function fromPctField(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n / 100 : null;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-foreground">{value}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function SymbolDetailPage() {
  const { symbol } = useParams({ from: "/symbols/$symbol" });
  const load = useServerFn(getSymbolDetail);
  const save = useServerFn(saveSymbolLimits);
  const clear = useServerFn(clearSymbolLimits);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["symbol-detail", symbol],
    queryFn: () => load({ data: { symbol } }),
    staleTime: 30_000,
  });

  const [cap, setCap] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [minStrength, setMinStrength] = useState("");
  const [paused, setPaused] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    const o = data?.row.override;
    setCap(toPctField(o?.maxPositionPct ?? null));
    setStop(toPctField(o?.stopLossPct ?? null));
    setTarget(toPctField(o?.takeProfitPct ?? null));
    setMinStrength(toPctField(o?.minSignalStrength ?? null));
    setPaused(Boolean(o?.paused));
    setNote(o?.note ?? "");
  }, [data?.row.override]);

  const saving = useMutation({
    mutationFn: () =>
      save({
        data: {
          symbol,
          maxPositionPct: fromPctField(cap),
          stopLossPct: fromPctField(stop),
          takeProfitPct: fromPctField(target),
          minSignalStrength: fromPctField(minStrength),
          paused,
          note: note.trim() ? note.trim() : null,
        },
      }),
    onSuccess: () => {
      toast.success("Limits saved — the engine uses them from the next run.");
      void qc.invalidateQueries({ queryKey: ["symbol-detail", symbol] });
      void qc.invalidateQueries({ queryKey: ["symbol-desk"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });

  const clearing = useMutation({
    mutationFn: () => clear({ data: { symbol } }),
    onSuccess: () => {
      toast.success("Back to the portfolio-wide rules for this name.");
      void qc.invalidateQueries({ queryKey: ["symbol-detail", symbol] });
      void qc.invalidateQueries({ queryKey: ["symbol-desk"] });
    },
  });

  const row = data?.row;

  return (
    <div className="min-h-screen overflow-x-hidden bg-background">
      <AppHeader />
      <main className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-foreground">
              {row?.symbol ?? symbol}
              {row?.limits.paused ? (
                <Badge variant="destructive" className="ml-2 align-middle text-[10px]">
                  paused
                </Badge>
              ) : null}
            </h1>
            <p className="text-sm text-muted-foreground">
              Track record, price levels and the limits this name trades under.
            </p>
          </div>
          <div className="flex gap-3 text-sm text-muted-foreground">
            <Link to="/symbols" className="hover:text-foreground">
              ← All symbols
            </Link>
            <Link
              to="/market/$symbol"
              params={{ symbol: row?.symbol ?? symbol }}
              search={{ range: 180 as const }}
              className="hover:text-foreground"
            >
              Chart
            </Link>
          </div>
        </div>

        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : !row ? (
          <Card>
            <CardContent className="p-4 text-sm text-muted-foreground">
              Nothing recorded for this symbol yet.
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Track record</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat
                  label="Signal strength"
                  value={row.strength == null ? "not measured" : pct(row.strength, 0)}
                  hint={row.samples ? `${row.samples} observations` : "no history yet"}
                />
                <Stat
                  label="Hit rate"
                  value={pct(row.hitRate, 0)}
                  hint={row.tStat == null ? undefined : `t ${row.tStat.toFixed(2)}`}
                />
                <Stat
                  label="Mean outcome"
                  value={row.meanNetBps == null ? "—" : `${row.meanNetBps.toFixed(0)}bps`}
                  hint="net of dealing cost"
                />
                <Stat
                  label="Round trip cost"
                  value={row.roundTripBps == null ? "—" : `${row.roundTripBps.toFixed(0)}bps`}
                  hint={row.costMeasured ? "measured from fills" : "modelled"}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Price levels</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat
                    label="Last price"
                    value={row.lastPrice == null ? "—" : row.lastPrice.toFixed(2)}
                    hint={row.priceDate ?? undefined}
                  />
                  <Stat label="Daily range (ATR)" value={pct(row.atrPct, 2)} />
                  <Stat
                    label="Your average cost"
                    value={row.avgCost == null || !row.held ? "—" : row.avgCost.toFixed(2)}
                    hint={row.held ? `${row.quantity} units` : "not held"}
                  />
                  <Stat label="Share of account" value={row.held ? pct(row.exposurePct, 1) : "—"} />
                </div>

                {data?.levels ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[30rem] text-sm">
                      <tbody>
                        {data.levels.levels.map((l) => (
                          <tr key={l.key} className="border-b border-border/60 last:border-0">
                            <td className="py-2 pr-3 text-muted-foreground">{l.label}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{l.price.toFixed(2)}</td>
                            <td className="py-2 text-right tabular-nums text-muted-foreground">
                              {l.distancePct == null ? "" : pct(l.distancePct, 1)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                {data && data.history.length > 1 ? (
                  <div className="h-48 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.history}>
                        <CartesianGrid {...GRID_PROPS} />
                        <XAxis dataKey="date" hide />
                        <YAxis domain={["auto", "auto"]} width={56} {...AXIS_PROPS} />
                        <Tooltip
                          contentStyle={TOOLTIP_CONTENT_STYLE}
                          wrapperStyle={TOOLTIP_WRAPPER_STYLE}
                          labelStyle={TOOLTIP_LABEL_STYLE}
                          itemStyle={TOOLTIP_ITEM_STYLE}
                        />
                        <Line
                          type="monotone"
                          dataKey="close"
                          dot={false}
                          strokeWidth={2}
                          stroke={PRICE_COLOR}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Risk limits for this name</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Leave a box empty to follow the account-wide rule (cap{" "}
                  {pct(data?.base.maxPositionPct, 0)}, stop {pct(data?.base.stopLossPct, 0)}, target{" "}
                  {pct(data?.base.takeProfitPct, 0)}). Selling is never blocked.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="cap">Most of the account this name may take (%)</Label>
                    <Input
                      id="cap"
                      inputMode="decimal"
                      placeholder={toPctField(data?.base.maxPositionPct ?? null) || "no limit"}
                      value={cap}
                      onChange={(e) => setCap(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="stop">Stop loss distance (%)</Label>
                    <Input
                      id="stop"
                      inputMode="decimal"
                      placeholder={toPctField(data?.base.stopLossPct ?? null) || "—"}
                      value={stop}
                      onChange={(e) => setStop(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="target">Profit target distance (%)</Label>
                    <Input
                      id="target"
                      inputMode="decimal"
                      placeholder={toPctField(data?.base.takeProfitPct ?? null) || "—"}
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="minstrength">Minimum signal strength to buy (%)</Label>
                    <Input
                      id="minstrength"
                      inputMode="decimal"
                      placeholder="off"
                      value={minStrength}
                      onChange={(e) => setMinStrength(e.target.value)}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border p-3">
                  <div>
                    <div className="text-sm font-medium">Pause new buys in this name</div>
                    <div className="text-xs text-muted-foreground">
                      Existing holdings can still be sold.
                    </div>
                  </div>
                  <Switch checked={paused} onCheckedChange={setPaused} />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="note">Note (optional)</Label>
                  <Input
                    id="note"
                    placeholder="Why you set these"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => saving.mutate()} disabled={saving.isPending}>
                    {saving.isPending ? "Saving…" : "Save limits"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => clearing.mutate()}
                    disabled={clearing.isPending || !row.override}
                  >
                    Reset to account rules
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  In force now: cap {pct(row.limits.maxPositionPct, 0)}, stop{" "}
                  {pct(row.limits.stopLossPct, 0)}, target {pct(row.limits.takeProfitPct, 0)}
                  {row.limits.minSignalStrength == null
                    ? ""
                    : `, buys need ${pct(row.limits.minSignalStrength, 0)} strength`}
                  {row.limits.paused ? ", buys paused" : ""}.
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
