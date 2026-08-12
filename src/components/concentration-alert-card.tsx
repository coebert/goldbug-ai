// Action prompt shown when a single holding drifts past the concentration cap.
//
// The engine already refuses to *add* past the cap, but price drift can carry
// a position through it, so this surfaces the breach with a concrete trim
// size and what that trim does to risk — and hands the suggested percentage
// straight to the sell dialog.

import { useMemo, useState } from "react";
import { AlertTriangle, Scissors } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { HoldingSellDialog } from "@/components/holding-sell-dialog";
import { JargonText } from "@/components/jargon-text";
import { formatMoney } from "@/lib/format-money";
import { holdingAvgCostBase } from "@/lib/market-price-units";
import { quoteUnitsResolved } from "@/lib/valuation/kernel";
import {
  buildConcentrationAlert,
  SHOCK_MOVE,
  type ConcentrationBreach,
} from "@/lib/concentration-alert";
import { cn } from "@/lib/utils";

type Holding = {
  id: string;
  symbol: string;
  quantity: number | string;
  avg_cost: number | string;
  asset_class?: string | null;
  instrument_ccy?: string | null;
};

type SeriesInfo = { currentPrice: number | null };

export function ConcentrationAlertCard({
  holdings,
  series,
  totalValue,
  currency,
  mode,
  capPct,
  className,
}: {
  holdings: Holding[];
  series?: Record<string, SeriesInfo | undefined>;
  /** Portfolio NAV (cash + positions) in base currency. */
  totalValue: number;
  currency: string;
  mode: string;
  capPct?: number;
  className?: string;
}) {
  const [selling, setSelling] = useState<{ breach: ConcentrationBreach; holding: Holding } | null>(
    null,
  );

  const alert = useMemo(() => {
    const base = String(currency ?? "GBP").toUpperCase();
    const positions = holdings
      .map((h) => {
        // Same valuation path as the holdings table: GBX folded to GBP, and
        // rows whose quote units can't be resolved are excluded rather than
        // valued at a possibly 100x-wrong number.
        if (!quoteUnitsResolved(h.symbol, h.instrument_ccy ?? null, null, base)) return null;
        const qty = Number(h.quantity);
        const avg = holdingAvgCostBase(h.symbol, h.avg_cost);
        const live = series?.[h.symbol]?.currentPrice;
        const mark = live != null && Number.isFinite(Number(live)) ? Number(live) : avg;
        if (!Number.isFinite(qty) || !Number.isFinite(mark)) return null;
        return {
          holdingId: h.id,
          symbol: h.symbol,
          quantity: qty,
          valueBase: qty * mark,
          fractional: h.asset_class === "crypto" || h.asset_class === "fx",
        };
      })
      .filter((p): p is NonNullable<typeof p> => p != null);
    return buildConcentrationAlert({ positions, nav: Number(totalValue), capPct });
  }, [holdings, series, totalValue, currency, capPct]);

  if (!alert) return null;

  const money = (n: number) => formatMoney(n, currency);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const capLabel = `${(alert.capPct * 100).toFixed(0)}%`;
  const shockSaved = alert.impact.shockLossBefore - alert.impact.shockLossAfter;

  return (
    <>
      <Alert
        className={cn("border-amber-500/40 bg-amber-500/5", className)}
        data-testid="concentration-alert"
      >
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        <AlertTitle className="text-sm">
          {alert.breaches.length === 1
            ? `${alert.breaches[0].symbol} is over your ${capLabel} single-holding cap`
            : `${alert.breaches.length} holdings are over your ${capLabel} single-holding cap`}
        </AlertTitle>
        <AlertDescription className="text-xs">
          <JargonText>
            {`No single position should be worth more than ${capLabel} of the portfolio — beyond that, one company's bad day sets the whole account's result. Trimming moves the proceeds to cash; it does not realise a loss on the part you keep.`}
          </JargonText>

          <div className="mt-3 space-y-2">
            {alert.breaches.map((b) => {
              const holding = holdings.find((h) => h.id === b.holdingId);
              const tooSmall = b.trimQuantity <= 0;
              return (
                <div
                  key={b.holdingId}
                  className="flex flex-col gap-2 rounded-lg border bg-background/60 p-2.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-foreground">{b.symbol}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {pct(b.weight)} of portfolio
                      </Badge>
                      <span className="text-muted-foreground">
                        {money(b.valueBase)} · {money(b.excessBase)} over the cap
                      </span>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {tooSmall ? (
                        "Position is too small to trim in whole units — reduce it on the next rebalance instead."
                      ) : (
                        <>
                          Suggested: sell <strong>{b.trimPercent}%</strong> ({b.trimQuantity}{" "}
                          {b.trimQuantity === 1 ? "unit" : "units"}, about {money(b.trimBase)}) →{" "}
                          {pct(b.weightAfter)} of portfolio.
                        </>
                      )}
                    </div>
                  </div>
                  {!tooSmall && holding && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => setSelling({ breach: b, holding })}
                    >
                      <Scissors className="mr-1.5 h-3.5 w-3.5" />
                      Trim {b.trimPercent}%
                    </Button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-3 rounded-lg border bg-background/60 p-2.5">
            <div className="mb-1 font-medium text-foreground">Expected impact on risk</div>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-3">
              <Impact
                label="Largest holding"
                before={pct(alert.impact.topWeightBefore)}
                after={pct(alert.impact.topWeightAfter)}
              />
              <Impact
                label={`Loss if these fall ${(SHOCK_MOVE * 100).toFixed(0)}%`}
                before={money(alert.impact.shockLossBefore)}
                after={money(alert.impact.shockLossAfter)}
              />
              <Impact
                label="Concentration score"
                before={alert.impact.hhiBefore.toFixed(2)}
                after={alert.impact.hhiAfter.toFixed(2)}
              />
            </dl>
            <div className="mt-1.5 text-muted-foreground">
              <JargonText>
                {`Acting on every suggestion moves ${money(alert.impact.totalTrimBase)} into cash and cuts the worst-case hit from these names by ${money(shockSaved)}. The concentration score is a 0-1 measure of how much of the book sits in a few names — lower is more spread out.`}
              </JargonText>
            </div>
          </div>
        </AlertDescription>
      </Alert>

      {selling && (
        <HoldingSellDialog
          holding={{
            id: selling.holding.id,
            symbol: selling.holding.symbol,
            quantity: Number(selling.holding.quantity),
            asset_class: selling.holding.asset_class,
            instrument_ccy: selling.holding.instrument_ccy,
          }}
          mode={mode}
          initialPercent={selling.breach.trimPercent}
          onClose={() => setSelling(null)}
        />
      )}
    </>
  );
}

function Impact({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        <span className="text-muted-foreground line-through">{before}</span>{" "}
        <span className="font-medium text-foreground">→ {after}</span>
      </dd>
    </div>
  );
}
