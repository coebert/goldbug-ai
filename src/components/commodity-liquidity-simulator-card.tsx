import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Droplets, RefreshCw } from "lucide-react";
import {
  simulateCommodityLiquidity,
  type CommodityLiquiditySymbol,
} from "@/lib/commodity-liquidity.functions";

const PRESETS = [1_000, 5_000, 10_000, 25_000, 100_000];

// Simulator that projects slippage, turnover and rejection risk for each
// commodity ETC/ETF at a user-chosen target spend. Reads recent price/volume
// bars via the paired server function; refreshes on demand.
export function CommodityLiquiditySimulatorCard() {
  const [spend, setSpend] = useState<number>(10_000);
  const runFn = useServerFn(simulateCommodityLiquidity);
  const q = useQuery({
    queryKey: ["commodity-liquidity", spend],
    queryFn: () => runFn({ data: { targetSpend: spend, lookbackDays: 20 } }),
    staleTime: 5 * 60_000,
  });

  const rows = q.data?.rows ?? [];
  const totals = rows.reduce(
    (acc, r) => {
      if (!r.trimmed && !r.stale && r.adv20d != null) acc.executable += spend;
      if (r.trimmed) acc.trimmed += r.trimFraction;
      if (r.rejectionBucket === "high") acc.highRisk += 1;
      return acc;
    },
    { executable: 0, trimmed: 0, highRisk: 0 },
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <Droplets className="h-4 w-4 text-sky-500" />
            Commodity slippage & liquidity simulator
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="lqty-spend" className="text-xs">
              Target spend (per trade)
            </Label>
            <Input
              id="lqty-spend"
              type="number"
              value={spend}
              min={100}
              step={100}
              className="w-32"
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n > 0) setSpend(n);
              }}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <Button
                key={p}
                variant={p === spend ? "default" : "outline"}
                size="sm"
                onClick={() => setSpend(p)}
              >
                ${p.toLocaleString()}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid gap-2 text-xs sm:grid-cols-3">
          <StatChip
            label="Fully executable"
            value={`${rows.filter((r) => !r.trimmed && !r.stale && r.adv20d != null).length}/${rows.length}`}
          />
          <StatChip
            label="High rejection risk"
            value={String(totals.highRisk)}
            tone={totals.highRisk > 0 ? "warn" : "ok"}
          />
          <StatChip
            label="Avg trim (trimmed only)"
            value={
              rows.filter((r) => r.trimmed).length
                ? `${(
                    (rows.filter((r) => r.trimmed).reduce((s, r) => s + r.trimFraction, 0) /
                      rows.filter((r) => r.trimmed).length) *
                    100
                  ).toFixed(0)}%`
                : "—"
            }
          />
        </div>

        {q.isLoading && (
          <p className="text-sm text-muted-foreground">Simulating…</p>
        )}
        {q.error && (
          <p className="text-sm text-rose-600">
            Failed to run simulation: {(q.error as Error).message}
          </p>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs tabular-nums">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3">Symbol</th>
                  <th className="py-1 pr-3 text-right">ADV$ (20d)</th>
                  <th className="py-1 pr-3 text-right">Turnover</th>
                  <th className="py-1 pr-3 text-right">Est slip</th>
                  <th className="py-1 pr-3 text-right">Round-trip</th>
                  <th className="py-1 pr-3 text-right">Risk</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <SymbolRow key={r.symbol} r={r} spend={spend} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Slippage uses ATR-proxy half-spread + fixed slippage; liquidity cap
          trims spend beyond 1% of 20-day ADV$. Rejection score weights
          liquidity trim, spread width, ADV$ depth, and price staleness.
        </p>
      </CardContent>
    </Card>
  );
}

function StatChip({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "warn";
}) {
  const cls =
    tone === "warn"
      ? "border-amber-500/40 bg-amber-500/10"
      : tone === "ok"
        ? "border-emerald-500/40 bg-emerald-500/10"
        : "border-border bg-muted/40";
  return (
    <div className={`rounded border px-2 py-1.5 ${cls}`}>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function SymbolRow({ r, spend }: { r: CommodityLiquiditySymbol; spend: number }) {
  const turnover =
    r.adv20d && r.adv20d > 0 ? (spend / r.adv20d) * 100 : null;
  const riskTone =
    r.rejectionBucket === "high"
      ? "text-rose-600"
      : r.rejectionBucket === "medium"
        ? "text-amber-600"
        : "text-emerald-600";

  return (
    <tr className="border-t border-border/60">
      <td className="py-1 pr-3">
        <div className="font-medium">{r.symbol}</div>
        <div className="text-[10px] text-muted-foreground">
          {r.stale && <Badge variant="outline" className="mr-1 text-[9px]">stale</Badge>}
          {r.trimmed && (
            <Badge variant="outline" className="mr-1 text-[9px]">
              trimmed {(r.trimFraction * 100).toFixed(0)}%
            </Badge>
          )}
          {r.name}
        </div>
      </td>
      <td className="py-1 pr-3 text-right">
        {r.adv20d == null ? "—" : `$${Math.round(r.adv20d).toLocaleString()}`}
      </td>
      <td className="py-1 pr-3 text-right">
        {turnover == null ? "—" : `${turnover.toFixed(2)}%`}
      </td>
      <td className="py-1 pr-3 text-right">
        {r.estSlippageBps == null ? "—" : `${r.estSlippageBps.toFixed(0)}bps`}
      </td>
      <td className="py-1 pr-3 text-right">
        {r.estCostPct == null ? "—" : `${(r.estCostPct * 100).toFixed(2)}%`}
      </td>
      <td className={`py-1 pr-3 text-right font-medium ${riskTone}`}>
        {r.rejectionScore} · {r.rejectionBucket}
      </td>
    </tr>
  );
}
