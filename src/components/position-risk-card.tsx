import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getPositionRisk, type PositionRiskRow } from "@/lib/position-risk.functions";

function money(n: number | null | undefined, ccy: string) {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: ccy || "GBP",
    maximumFractionDigits: 2,
  }).format(n);
}

const pct = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(1)}%`;

function WeightBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div
        className="h-full rounded-full bg-primary"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-1 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Rows({ rows, ccy }: { rows: PositionRiskRow[]; ccy: string }) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {rows.map((r) => (
        <li key={r.symbol} className="space-y-1.5 px-3 py-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="font-medium">{r.symbol}</span>
            <span className="tabular-nums">{pct(r.weightPct)}</span>
          </div>
          <WeightBar value={r.weightPct} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">{r.quantity} units</span>
            <span className="tabular-nums">
              {money(r.price, r.instrumentCurrency)} · {money(r.baseValue, ccy)}
            </span>
            {r.unrealisedPct != null && (
              <span
                className={
                  r.unrealisedPct >= 0 ? "tabular-nums text-success" : "tabular-nums text-destructive"
                }
              >
                {r.unrealisedPct >= 0 ? "+" : ""}
                {r.unrealisedPct.toFixed(1)}% vs cost
              </span>
            )}
            <Badge variant="outline" className="text-[10px]">
              {r.priceSource === "broker"
                ? "Saxo live"
                : r.priceSource === "cache"
                  ? "cached close"
                  : r.priceSource === "cost_basis"
                    ? "cost basis"
                    : "no price"}
            </Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Position weights, concentration, cash at risk and FX legs in one read. */
export function PositionRiskCard({ portfolioId }: { portfolioId: string }) {
  const fn = useServerFn(getPositionRisk);
  const q = useQuery({
    queryKey: ["position-risk", portfolioId],
    queryFn: () => fn({ data: { portfolioId } }),
    refetchInterval: 60_000,
  });

  if (q.isPending) {
    return <div className="h-64 rounded-xl border border-border bg-card" aria-hidden />;
  }
  if (q.error) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-destructive">
          {(q.error as Error).message}
        </CardContent>
      </Card>
    );
  }
  const d = q.data!;
  const ccy = d.baseCurrency;
  const positions = d.rows.filter((r) => r.assetClass !== "fx");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
          <CardTitle className="text-base">Exposure now</CardTitle>
          <Badge variant="outline" className="text-[11px]">
            {d.brokerPriced}/{d.requested} priced live by Saxo
          </Badge>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Account value" value={money(d.totalValue, ccy)} />
          <Tile
            label="Invested"
            value={money(d.holdingsValue, ccy)}
            sub={pct(d.totalValue > 0 ? (d.holdingsValue / d.totalValue) * 100 : 0) + " of account"}
          />
          <Tile
            label="Cash"
            value={money(d.cash, ccy)}
            sub={pct(d.totalValue > 0 ? (d.cash / d.totalValue) * 100 : 0) + " of account"}
          />
          <Tile
            label="Cash in other currencies"
            value={pct(d.concentration.cashAtFxRiskPct)}
            sub="exposed to exchange-rate moves"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Concentration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Largest position" value={pct(d.concentration.topWeightPct)} />
            <Tile label="Top three" value={pct(d.concentration.top3WeightPct)} />
            <Tile
              label="Spread of risk"
              value={d.concentration.effectivePositions.toFixed(1)}
              sub="equally-weighted equivalent"
            />
            <Tile label="Positions" value={String(positions.length)} />
          </div>
          <p className="text-sm text-muted-foreground">
            A single name above roughly a quarter of the account, or fewer than about three
            equally-weighted equivalents, means one bad print moves the whole balance.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Position weights</CardTitle>
        </CardHeader>
        <CardContent>
          {positions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open positions.</p>
          ) : (
            <Rows rows={positions} ccy={ccy} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Cash at risk</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {d.cashRows.map((c) => (
              <li
                key={c.currency}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span className="font-medium">{c.currency}</span>
                <span className="tabular-nums text-muted-foreground">
                  {money(c.amount, c.currency)} → {money(c.baseValue, ccy)} · {pct(c.weightPct)}
                </span>
                <Badge variant={c.atFxRisk ? "secondary" : "outline"} className="text-[10px]">
                  {c.atFxRisk ? "exchange-rate risk" : "base currency"}
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">FX legs</CardTitle>
        </CardHeader>
        <CardContent>
          {d.fxLegs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open currency legs.</p>
          ) : (
            <Rows rows={d.fxLegs} ccy={ccy} />
          )}
        </CardContent>
      </Card>

      {d.degraded && d.warnings.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Data quality</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {d.warnings.slice(0, 8).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
