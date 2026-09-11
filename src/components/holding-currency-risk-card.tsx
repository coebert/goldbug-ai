// Per-holding currency risk: which positions move when the exchange rate moves.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Coins, AlertTriangle } from "lucide-react";
import { getHoldingCurrencyRisk } from "@/lib/holding-currency-risk.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { CurrencyRiskBand } from "@/lib/holding-currency-risk";

interface Props {
  portfolioId: string;
  active?: boolean;
}

function money(amount: number, ccy: string) {
  try {
    return amount.toLocaleString("en-GB", {
      style: "currency",
      currency: ccy,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    return `${amount.toFixed(2)} ${ccy}`;
  }
}

function pct(x: number, dp = 1) {
  return `${(x * 100).toFixed(dp)}%`;
}

const BAND_LABEL: Record<CurrencyRiskBand, string> = {
  none: "No FX risk",
  low: "Low",
  medium: "Medium",
  high: "High",
};

function bandVariant(band: CurrencyRiskBand): "secondary" | "outline" | "destructive" {
  if (band === "high") return "destructive";
  if (band === "medium") return "secondary";
  return "outline";
}

export function HoldingCurrencyRiskCard({ portfolioId, active = true }: Props) {
  const fetchRisk = useServerFn(getHoldingCurrencyRisk);
  const q = useQuery({
    queryKey: ["holding-currency-risk", portfolioId],
    queryFn: () => fetchRisk({ data: { portfolioId } }),
    enabled: !!portfolioId && active,
    staleTime: 120_000,
    refetchOnWindowFocus: false,
  });

  const d = q.data;
  const base = d?.baseCcy ?? "GBP";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Coins className="h-4 w-4" />
          Currency risk by holding
          {d && d.estimatedVolCcys.length > 0 && (
            <Badge variant="outline" className="gap-1 text-[10px]">
              <AlertTriangle className="h-3 w-3" />
              Estimated swing for {d.estimatedVolCcys.join(", ")}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {q.isLoading && <div className="text-muted-foreground">Working out exposure…</div>}
        {q.isError && (
          <div className="text-destructive">Could not load currency risk.</div>
        )}
        {d && d.rows.length === 0 && (
          <div className="text-muted-foreground">No holdings to measure yet.</div>
        )}

        {d && d.rows.length > 0 && (
          <>
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <div className="text-xs text-muted-foreground">Held in other currencies</div>
                <div className="font-medium">{money(d.foreignValueBase, base)}</div>
                <div className="text-xs text-muted-foreground">
                  {pct(d.foreignPctOfEquity)} of the account
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Not covered by a currency trade</div>
                <div className="font-medium">{money(d.unhedgedValueBase, base)}</div>
                <div className="text-xs text-muted-foreground">
                  {pct(d.unhedgedPctOfEquity)} of the account
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Typical bad day</div>
                <div className="font-medium">{money(d.totalOneDayVarBase, base)}</div>
                <div className="text-xs text-muted-foreground">1-in-20 daily move</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">If rates move 5% against you</div>
                <div className="font-medium">{money(d.totalAdverse5PctBase, base)}</div>
                <div className="text-xs text-muted-foreground">
                  {d.topCurrency ? `Most exposed: ${d.topCurrency}` : "No foreign exposure"}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-1.5 text-left font-normal">Holding</th>
                    <th className="py-1.5 text-left font-normal">Currency</th>
                    <th className="py-1.5 text-right font-normal">Worth</th>
                    <th className="py-1.5 text-right font-normal">Exposed</th>
                    <th className="py-1.5 text-right font-normal">Daily swing</th>
                    <th className="py-1.5 text-right font-normal">Bad day</th>
                    <th className="py-1.5 text-right font-normal">5% move</th>
                    <th className="py-1.5 text-right font-normal">Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.symbol} className="border-b last:border-0">
                      <td className="py-1.5 font-medium">{r.symbol}</td>
                      <td className="py-1.5">{r.currency}</td>
                      <td className="py-1.5 text-right">{money(r.valueBase, base)}</td>
                      <td className="py-1.5 text-right">
                        {money(r.unhedgedBase, base)}
                        {r.hedgedShare > 0.01 && r.currency !== base && (
                          <div className="text-[10px] text-muted-foreground">
                            {pct(r.hedgedShare, 0)} covered
                          </div>
                        )}
                      </td>
                      <td className="py-1.5 text-right">
                        {r.currency === base ? "—" : pct(r.dailyVolPct, 2)}
                      </td>
                      <td className="py-1.5 text-right">
                        {r.oneDayVarBase > 0 ? money(r.oneDayVarBase, base) : "—"}
                      </td>
                      <td className="py-1.5 text-right">
                        {r.adverse5PctBase > 0 ? money(r.adverse5PctBase, base) : "—"}
                      </td>
                      <td className="py-1.5 text-right">
                        <Badge variant={bandVariant(r.band)} className="text-[10px]">
                          {BAND_LABEL[r.band]}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Positions priced in {base} carry no exchange-rate risk. "Bad day" is the
              move only exceeded on about one day in twenty, based on the last few
              months of daily rates.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
