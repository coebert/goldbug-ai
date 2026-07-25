// Commodity rejection backtest — replays historical bars for gold/silver/
// oil/gas/copper ETCs and reports how often the current portfolio's risk
// config would have rejected each proposed buy.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  runCommodityBacktest,
  applyCommodityThresholds,
} from "@/lib/commodity-backtest.functions";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";

type Props = { portfolioId: string };



const REASON_LABEL: Record<string, string> = {
  illiquid_adv: "ADV below floor",
  excess_atr: "ATR above cap",
  min_notional: "Below min trade size",
  per_symbol_cap: "Per-symbol cap",
  group_cap: "Commodity group cap",
  asset_class_cap: "Asset-class cap",
  cash_floor: "Cash floor",
};

export function CommodityBacktestCard({ portfolioId }: Props) {
  const [years, setYears] = useState(3);
  const run = useServerFn(runCommodityBacktest);
  const apply = useServerFn(applyCommodityThresholds);
  const mut = useMutation({
    mutationFn: () => run({ data: { portfolio_id: portfolioId, years } }),
    onError: (e: unknown) =>
      toast.error("Commodity backtest failed", {
        description: e instanceof Error ? e.message : "Unknown error",
      }),
  });
  const applyMut = useMutation({
    mutationFn: (v: { min_adv_usd: number; max_atr_pct: number }) =>
      apply({ data: { portfolio_id: portfolioId, ...v } }),
    onSuccess: (res) => {
      toast.success("Risk thresholds updated", {
        description: `ADV floor $${res.applied.min_adv_usd.toLocaleString("en-GB")} · ATR cap ${(res.applied.max_atr_pct * 100).toFixed(1)}%`,
      });
      // Re-run backtest so before/after refreshes.
      mut.mutate();
    },
    onError: (e: unknown) =>
      toast.error("Could not apply thresholds", {
        description: e instanceof Error ? e.message : "Unknown error",
      }),
  });

  const report = mut.data?.report;
  const suggestion = mut.data?.suggestion;


  return (
    <Card>
      <CardHeader>
        <CardTitle>Commodity replay backtest</CardTitle>
        <CardDescription>
          Replays daily bars for gold, silver, oil, gas and copper ETCs against your
          current risk config and reports how many buy signals would have been rejected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label htmlFor="cbt-years">Years of history</Label>
            <Input
              id="cbt-years"
              type="number"
              min={1}
              max={10}
              value={years}
              onChange={(e) => setYears(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
              className="w-24"
            />
          </div>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "Replaying…" : "Run replay"}
          </Button>
          {mut.data && (
            <Badge variant="secondary">
              risk: {mut.data.risk_level ?? "balanced"} · {report?.daysReplayed ?? 0} trading days
            </Badge>
          )}
        </div>

        {report && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Signal days" value={report.totalSignalDays.toLocaleString("en-GB")} />
              <Stat label="Proposed buys" value={report.totalProposals.toLocaleString("en-GB")} />
              <Stat
                label="Accepted"
                value={`${report.accepted.toLocaleString("en-GB")} (${(report.acceptanceRate * 100).toFixed(1)}%)`}
              />
              <Stat
                label="Rejected"
                value={`${report.rejected.toLocaleString("en-GB")} (${((1 - report.acceptanceRate) * 100).toFixed(1)}%)`}
              />
            </div>

            <div>
              <div className="mb-2 text-sm font-medium">Rejections by reason</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                    <TableHead className="text-right">% of rejections</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(report.rejectionCounts)
                    .sort(([, a], [, b]) => b - a)
                    .map(([reason, count]) => (
                      <TableRow key={reason}>
                        <TableCell>{REASON_LABEL[reason] ?? reason}</TableCell>
                        <TableCell className="text-right">{count.toLocaleString("en-GB")}</TableCell>
                        <TableCell className="text-right">
                          {report.rejected > 0
                            ? `${((count / report.rejected) * 100).toFixed(1)}%`
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>

            {suggestion && (
              <div className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">Suggested threshold adjustments</div>
                  <Button
                    size="sm"
                    disabled={!suggestion.hasChange || applyMut.isPending}
                    onClick={() =>
                      applyMut.mutate({
                        min_adv_usd: suggestion.min_adv_usd.suggested,
                        max_atr_pct: suggestion.max_atr_pct.suggested,
                      })
                    }
                  >
                    {applyMut.isPending
                      ? "Applying…"
                      : suggestion.hasChange
                        ? "Apply to risk settings"
                        : "No change suggested"}
                  </Button>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Setting</TableHead>
                      <TableHead className="text-right">Current</TableHead>
                      <TableHead className="text-right">Suggested</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Rationale</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell>Min ADV (USD)</TableCell>
                      <TableCell className="text-right font-mono">
                        ${suggestion.min_adv_usd.current.toLocaleString("en-GB")}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        ${suggestion.min_adv_usd.suggested.toLocaleString("en-GB")}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            suggestion.min_adv_usd.action === "keep" ? "secondary" : "default"
                          }
                        >
                          {suggestion.min_adv_usd.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {suggestion.min_adv_usd.rationale}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Max ATR (%)</TableCell>
                      <TableCell className="text-right font-mono">
                        {(suggestion.max_atr_pct.current * 100).toFixed(2)}%
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {(suggestion.max_atr_pct.suggested * 100).toFixed(2)}%
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            suggestion.max_atr_pct.action === "keep" ? "secondary" : "default"
                          }
                        >
                          {suggestion.max_atr_pct.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {suggestion.max_atr_pct.rationale}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}



            <div>
              <div className="mb-2 text-sm font-medium">By commodity group</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Group</TableHead>
                    <TableHead className="text-right">Proposals</TableHead>
                    <TableHead className="text-right">Accepted</TableHead>
                    <TableHead className="text-right">Rejected</TableHead>
                    <TableHead className="text-right">Accept rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.byGroup.map((g) => (
                    <TableRow key={g.group}>
                      <TableCell>{g.group}</TableCell>
                      <TableCell className="text-right">{g.proposals.toLocaleString("en-GB")}</TableCell>
                      <TableCell className="text-right">{g.accepted.toLocaleString("en-GB")}</TableCell>
                      <TableCell className="text-right">{g.rejected.toLocaleString("en-GB")}</TableCell>
                      <TableCell className="text-right">
                        {g.proposals > 0 ? `${((g.accepted / g.proposals) * 100).toFixed(1)}%` : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {report.sampleRejections.length > 0 && (
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Sample rejections ({report.sampleRejections.length})
                </summary>
                <div className="mt-2 max-h-72 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Symbol</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Detail</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.sampleRejections.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-mono text-xs">{r.date}</TableCell>
                          <TableCell>{r.symbol}</TableCell>
                          <TableCell>{REASON_LABEL[r.reason] ?? r.reason}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.detail}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}
