import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCurrentRegime, getRegimeHistory, refreshRegimeNow } from "@/lib/trading.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Radar, RefreshCw, TrendingUp, TrendingDown, ShieldAlert, Waves, Sunrise, CircleDot } from "lucide-react";
import { toast } from "sonner";
import { publishRationaleRefresh } from "@/lib/rationale-refresh";

type RegimeLabel =
  | "bull_quiet" | "bull_volatile" | "correction" | "bear" | "crisis" | "recovery";

const META: Record<RegimeLabel, { label: string; color: string; icon: typeof CircleDot; blurb: string }> = {
  bull_quiet:     { label: "Bull · Quiet",     color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", icon: TrendingUp, blurb: "Trend up, low vol. Priors favour momentum & buy-the-dip." },
  bull_volatile:  { label: "Bull · Volatile",  color: "bg-teal-500/15 text-teal-300 border-teal-500/30",          icon: Waves,      blurb: "Uptrend intact, elevated vol. Priors: smaller size, quality bias." },
  correction:     { label: "Correction",       color: "bg-amber-500/15 text-amber-300 border-amber-500/30",       icon: TrendingDown, blurb: "5-20% off highs. Priors: partial de-risk, keep dry powder." },
  bear:           { label: "Bear",             color: "bg-red-500/15 text-red-300 border-red-500/30",             icon: TrendingDown, blurb: "Sustained downtrend. Priors: cash/bonds/gold, avoid failing bounces." },
  crisis:         { label: "Crisis",           color: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30", icon: ShieldAlert,  blurb: "Panic/dislocation. Priors: capital preservation, strong forward returns after capitulation." },
  recovery:       { label: "Recovery",         color: "bg-sky-500/15 text-sky-300 border-sky-500/30",             icon: Sunrise,      blurb: "Emerging from bear. Priors: cyclicals & beaten-down quality lead." },
};

function fmtPct(n: number | null | undefined, digits = 1) {
  if (n == null) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}
function fmt(n: number | null | undefined, digits = 2) {
  if (n == null) return "—";
  return n.toFixed(digits);
}

export function RegimePanel() {
  const getCurrent = useServerFn(getCurrentRegime);
  const getHistory = useServerFn(getRegimeHistory);
  const refresh = useServerFn(refreshRegimeNow);

  const cur = useQuery({
    queryKey: ["regime", "current"],
    queryFn: () => getCurrent(),
  });
  const hist = useQuery({
    queryKey: ["regime", "history", 60],
    queryFn: () => getHistory({ data: { days: 60 } }),
  });

  const transitions = useMemo(() => {
    const rows = (hist.data ?? []) as Array<{ as_of: string; regime: RegimeLabel; previous_regime: RegimeLabel | null; transitioned: boolean; notes: string | null }>;
    return rows.filter((r) => r.transitioned).slice(-5).reverse();
  }, [hist.data]);

  const current = cur.data as null | {
    as_of: string;
    regime: RegimeLabel;
    previous_regime: RegimeLabel | null;
    transitioned: boolean;
    confidence: number;
    notes: string | null;
    signals: {
      spy_price: number | null; spy_sma50: number | null; spy_sma200: number | null;
      spy_drawdown_pct: number | null; spy_return_30d: number | null; spy_vol_20d: number | null;
      vix_level: number | null; gld_return_30d: number | null; tlt_return_30d: number | null;
    };
  };

  const meta = current ? META[current.regime] : null;
  const Icon = meta?.icon ?? Radar;

  async function handleRefresh() {
    try {
      await refresh();
      await Promise.all([cur.refetch(), hist.refetch()]);
      publishRationaleRefresh("regime");
      toast.success("Regime refreshed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Refresh failed");
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Radar className="h-4 w-4 text-primary" />
          Macro Regime
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={handleRefresh} disabled={cur.isFetching}>
          <RefreshCw className={`mr-1 h-3 w-3 ${cur.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {!current && (
          <p className="text-sm text-muted-foreground">
            No regime assessment yet. Click Refresh to run one now.
          </p>
        )}
        {current && meta && (
          <>
            {current.transitioned && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-amber-400" />
                <div>
                  <div className="font-medium text-amber-200">Regime transition detected</div>
                  <div className="text-xs text-amber-200/80">
                    Shifted from <span className="font-medium">{META[current.previous_regime ?? "bull_quiet"].label}</span> → <span className="font-medium">{meta.label}</span> on {current.as_of}. The AI is updating its priors for today's decisions.
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-2 rounded-md border px-3 py-2 ${meta.color}`}>
                <Icon className="h-4 w-4" />
                <span className="text-sm font-semibold">{meta.label}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                <div>Confidence {(current.confidence * 100).toFixed(0)}%</div>
                <div>As of {current.as_of}</div>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">{meta.blurb}</p>

            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
              <Signal label="SPY" value={fmt(current.signals.spy_price)} />
              <Signal label="SPY 50d" value={fmt(current.signals.spy_sma50)} />
              <Signal label="SPY 200d" value={fmt(current.signals.spy_sma200)} />
              <Signal label="SPY 30d" value={fmtPct(current.signals.spy_return_30d)} />
              <Signal label="Drawdown" value={fmtPct(current.signals.spy_drawdown_pct)} tone={current.signals.spy_drawdown_pct != null && current.signals.spy_drawdown_pct < -0.05 ? "warn" : undefined} />
              <Signal label="20d vol" value={fmtPct(current.signals.spy_vol_20d, 2)} />
              <Signal label="VIX" value={fmt(current.signals.vix_level, 1)} tone={current.signals.vix_level != null && current.signals.vix_level >= 22 ? "warn" : undefined} />
              <Signal label="Gold 30d" value={fmtPct(current.signals.gld_return_30d)} />
              <Signal label="TLT 30d" value={fmtPct(current.signals.tlt_return_30d)} />
            </div>

            {current.notes && (
              <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Why:</span> {current.notes}
              </div>
            )}

            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                Recent transitions ({transitions.length})
              </div>
              {transitions.length === 0 ? (
                <p className="text-xs text-muted-foreground">No regime changes in the last 60 days.</p>
              ) : (
                <ul className="space-y-1.5 text-xs">
                  {transitions.map((t) => (
                    <li key={t.as_of} className="flex items-center gap-2">
                      <Badge variant="outline" className="tabular-nums">{t.as_of}</Badge>
                      <span className="text-muted-foreground">
                        {META[t.previous_regime ?? "bull_quiet"].label} → <span className="font-medium text-foreground">{META[t.regime].label}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Signal({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className={`rounded border px-2 py-1.5 ${tone === "warn" ? "border-amber-500/30 bg-amber-500/5" : "border-border/60 bg-muted/20"}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="tabular-nums font-medium">{value}</div>
    </div>
  );
}
