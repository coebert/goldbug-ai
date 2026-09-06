// Costs dashboard: what this account really pays to deal each symbol —
// average fill cost, slippage and the resulting cost floor — and the slider
// that sets how far above that floor a buy's expected move must clear.
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/layout/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getCostDashboard, saveCostHurdle } from "@/lib/cost-dashboard.functions";
import { backfillBrokerChargesFn } from "@/lib/broker-cost-backfill.functions";
import { formatUk } from "@/lib/uk-time";

export const Route = createFileRoute("/costs")({
  component: CostsDashboard,
  head: () => ({
    meta: [
      { title: "Dealing costs and cost hurdle | Goldbug" },
      {
        name: "description",
        content:
          "Each symbol's real average fill cost, slippage and round-trip cost floor measured from your fills, with the slider that sets the hurdle a new buy must clear.",
      },
      { property: "og:title", content: "Dealing costs and cost hurdle" },
      {
        property: "og:description",
        content:
          "Real per-symbol fill costs and slippage, and the adjustable cost hurdle the AI must beat before it buys.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const bps = (n: number) => `${n.toFixed(0)}bps`;
const money = (n: number) =>
  n.toLocaleString("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  });

function CostsDashboard() {
  const queryClient = useQueryClient();
  const fetchDashboard = useServerFn(getCostDashboard);
  const save = useServerFn(saveCostHurdle);
  const { data } = useQuery({
    queryKey: ["cost-dashboard"],
    queryFn: () => fetchDashboard(),
  });

  const [slider, setSlider] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const runSync = useServerFn(backfillBrokerChargesFn);

  const onSync = async () => {
    setSyncing(true);
    try {
      const res = await runSync({ data: {} });
      await queryClient.invalidateQueries({ queryKey: ["cost-dashboard"] });
      toast.success(
        res.totals.fillsUpdated > 0
          ? `${res.totals.fillsUpdated} trades now priced with the broker's own charges.`
          : res.message,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not sync broker charges");
    } finally {
      setSyncing(false);
    }
  };


  const multiple = slider ?? data?.hurdleMultiple ?? 1.25;
  const dirty = data != null && Math.abs(multiple - data.hurdleMultiple) > 1e-9;

  const onSave = async () => {
    setSaving(true);
    try {
      await save({ data: { multiple: Math.round(multiple * 100) / 100 } });
      await queryClient.invalidateQueries({ queryKey: ["cost-dashboard"] });
      setSlider(null);
      toast.success(`Cost hurdle set to ${multiple.toFixed(2)}x — applies to the next decision run.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the hurdle");
    } finally {
      setSaving(false);
    }
  };

  const rows = data?.rows ?? [];
  const accountRoundTrip =
    rows.length > 0 ? rows.reduce((s, r) => s + r.roundTripBps, 0) / rows.length : null;

  return (
    <PageShell title="Dealing costs">
      <AppHeader />
      <main className="mx-auto w-full max-w-5xl space-y-6 px-4 pb-16">
        <header>
          <h1 className="text-2xl font-semibold">Dealing costs</h1>
          <p className="text-sm text-muted-foreground">
            What your account actually pays to buy and sell each name — measured from your real
            fills — and the hurdle a new buy must clear before the AI lets it through.
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost hurdle</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Before any buy, the AI estimates how far the price could move and refuses the trade
              unless that move beats the full round-trip cost with this margin. Slide right for
              fewer, higher-conviction buys; slide left to allow smaller edges. Selling is never
              restricted.
            </p>
            <div className="flex items-center gap-4">
              <Slider
                min={1}
                max={2}
                step={0.05}
                value={[multiple]}
                onValueChange={(v) => setSlider(v[0] ?? multiple)}
                className="flex-1"
              />
              <span className="w-16 text-right font-mono text-lg font-semibold">
                {multiple.toFixed(2)}x
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              {accountRoundTrip != null && data != null && (
                <span>
                  At this setting, a typical buy must clear{" "}
                  <strong className="text-foreground">
                    {bps(accountRoundTrip * data.floorHeadroom * multiple)}
                  </strong>{" "}
                  of expected move.
                </span>
              )}
              <Button onClick={onSave} disabled={!dirty || saving} size="sm">
                {saving ? "Saving…" : dirty ? "Save hurdle" : "Saved"}
              </Button>
              {dirty && (
                <Button variant="ghost" size="sm" onClick={() => setSlider(null)}>
                  Reset
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost per symbol</CardTitle>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No fills measured yet — costs appear here after your first trades.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead className="text-right">Avg buy cost</TableHead>
                    <TableHead className="text-right">Avg sell cost</TableHead>
                    <TableHead className="text-right">Slippage</TableHead>
                    <TableHead className="text-right">Round trip</TableHead>
                    <TableHead className="text-right">Cost floor</TableHead>
                    <TableHead className="text-right">Hurdle</TableHead>
                    <TableHead className="text-right">Fills</TableHead>
                    <TableHead className="text-right">Last dealt</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.symbol}>
                      <TableCell className="font-medium">
                        {r.symbol}{" "}
                        {!r.measured && (
                          <Badge variant="outline" className="ml-1 text-xs">
                            est.
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{bps(r.buyBps)}</TableCell>
                      <TableCell className="text-right">{bps(r.sellBps)}</TableCell>
                      <TableCell className="text-right">{bps(r.slippageBps)}</TableCell>
                      <TableCell className="text-right font-medium">{bps(r.roundTripBps)}</TableCell>
                      <TableCell className="text-right">{bps(r.floorBps)}</TableCell>
                      <TableCell className="text-right font-semibold">
                        {bps(r.floorBps * multiple)}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.fills}
                        {r.invoicedFills > 0 && (
                          <span className="text-xs text-muted-foreground"> ({r.invoicedFills} inv.)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {r.lastFillAt ? formatUk(r.lastFillAt, { day: "numeric", month: "short" }) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Costs are measured from your own fills: broker charges plus the gap between the day's
              printed price and the price you actually got. The floor adds a safety allowance
              (x{data?.floorHeadroom.toFixed(2) ?? "1.33"}) so a quiet print can't under-price the
              next trade; the hurdle column shows what a buy must beat at the slider's current
              position.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">Broker charges and slippage</CardTitle>
            <Button size="sm" variant="outline" onClick={onSync} disabled={syncing}>
              {syncing ? "Syncing…" : "Sync broker charges"}
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">

            {data && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat
                  label="Broker charges paid"
                  value={data.account.feeBps != null ? bps(data.account.feeBps) : "—"}
                  note="one way, averaged over your tickets"
                />
                <Stat
                  label="Slippage paid"
                  value={data.account.slippageBps != null ? bps(data.account.slippageBps) : "—"}
                  note="gap between printed price and your fill"
                />
                <Stat
                  label="Round trip"
                  value={data.account.roundTripBps != null ? bps(data.account.roundTripBps) : "—"}
                  note={`${data.account.tickets} tickets measured`}
                />
              </div>
            )}
            <div>
              <p className="mb-2 text-sm font-medium">
                {data?.broker.broker ?? "Saxo"} {data?.broker.tier ?? "Classic"} tariff
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Market</TableHead>
                    <TableHead>Currency</TableHead>
                    <TableHead className="text-right">Commission</TableHead>
                    <TableHead className="text-right">Minimum per side</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.broker.rows ?? []).map((t) => (
                    <TableRow key={`${t.venue}-${t.currency}`}>
                      <TableCell className="font-medium">{t.venue}</TableCell>
                      <TableCell>{t.currency}</TableCell>
                      <TableCell className="text-right">{t.rateBps.toFixed(0)}bps</TableCell>
                      <TableCell className="text-right">
                        {t.minCharge.toLocaleString()} {t.currency}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {data && (
              <p className="text-xs text-muted-foreground">
                Taxes on top: UK stamp duty {(data.broker.ukStampDutyBps / 100).toFixed(2)}% on buys
                of UK single stocks (funds and non-UK listings are exempt), plus a £
                {data.broker.ptmLevyGbp.toFixed(2)} takeover-panel levy on UK trades above £
                {data.broker.ptmLevyThresholdGbp.toLocaleString()}.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reserve and ticket rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              These rules ration how often the AI may spend money on dealing
              {data?.reserve.portfolioName ? ` on ${data.reserve.portfolioName}` : ""}
              {data?.reserve.navBase != null
                ? `, sized on an account value of ${money(data.reserve.navBase)}`
                : ""}
              {data?.reserve.navAsOf
                ? ` (as of ${formatUk(data.reserve.navAsOf, { day: "numeric", month: "short" })})`
                : ""}
              . Selling is never rationed.
            </p>
            {data && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Stat
                  label="Smallest buy allowed"
                  value={data.reserve.minTicketBase != null ? money(data.reserve.minTicketBase) : "—"}
                  note={`greater of ${(data.reserve.minTicketPctOfNav * 100).toFixed(1)}% of the account or ${money(data.reserve.absoluteMinTicketBase)}`}
                />
                <Stat
                  label="Buys per day"
                  value={`${data.reserve.maxBuysPerDay} max`}
                  note="sells are not capped"
                />
                <Stat
                  label="Same-name cooldown"
                  value={`${data.reserve.addCooldownDays} days`}
                  note="before topping up a name again"
                />
                <Stat
                  label="Dealing budget"
                  value={`${(data.reserve.frictionBudgetPctOfNav * 10_000).toFixed(0)}bps`}
                  note={
                    data.reserve.frictionBudgetBase != null
                      ? `${money(data.reserve.frictionBudgetBase)} of costs per rolling window, never below ${data.reserve.minBudgetTickets} typical tickets`
                      : `per rolling window, never below ${data.reserve.minBudgetTickets} typical tickets`
                  }
                />
                <Stat
                  label="Most in one name"
                  value={`${(data.reserve.maxPositionPctOfNav * 100).toFixed(0)}%`}
                  note="hard cap on a single holding"
                />
                <Stat
                  label="Exception tickets"
                  value={`${data.reserve.reserveTickets} per run`}
                  note={`allowed past a spent budget when the expected gain is ${data.reserve.reserveEdgeMultiple}x the cost and conviction is at least ${(data.reserve.reserveMinConviction * 100).toFixed(0)}%`}
                />
                <Stat
                  label="Stall breaker"
                  value={`after ${data.reserve.stallDays} quiet days`}
                  note={`the exception bar eases to ${data.reserve.stallEdgeMultiple}x cost and ${(data.reserve.stallMinConviction * 100).toFixed(0)}% conviction, so the budget throttles rather than stops`}
                />
                <Stat
                  label="Normal pace"
                  value={`${data.reserve.churnCalmFills} buys / ${data.reserve.churnWindowDays} days`}
                  note="exception tickets shrink when the market is violent or the book is already busy"
                />
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </PageShell>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
