import { Badge } from "@/components/ui/badge";
import { Activity, TrendingDown, TrendingUp } from "lucide-react";
import { fmtNum, fmtPct } from "./format";
import type { ExecutedLiquidity, SignalRow, SignalWeights } from "./types";

export function SignalBadges({ s }: { s: SignalRow }) {
  const trendUp = s.sma20 != null && s.sma50 != null && s.sma20 > s.sma50;
  const rsi = s.rsi14;
  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      <Badge variant="outline" className="tabular-nums">
        Px {fmtNum(s.price)}
      </Badge>
      <Badge variant="outline" className="tabular-nums">
        {trendUp ? (
          <TrendingUp className="mr-1 h-3 w-3 text-primary" />
        ) : (
          <TrendingDown className="mr-1 h-3 w-3 text-destructive" />
        )}
        SMA20 {fmtNum(s.sma20)} / 50 {fmtNum(s.sma50)}
      </Badge>
      {rsi != null && (
        <Badge
          variant="outline"
          className={rsi >= 70 ? "text-destructive" : rsi <= 30 ? "text-primary" : ""}
        >
          RSI {fmtNum(rsi, 0)}
          {rsi >= 70 ? " · overbought" : rsi <= 30 ? " · oversold" : ""}
        </Badge>
      )}
      <Badge
        variant="outline"
        className={s.change5d != null && s.change5d >= 0 ? "text-primary" : "text-destructive"}
      >
        5d {fmtPct(s.change5d)}
      </Badge>
      <Badge
        variant="outline"
        className={s.change30d != null && s.change30d >= 0 ? "text-primary" : "text-destructive"}
      >
        30d {fmtPct(s.change30d)}
      </Badge>
    </div>
  );


const SIGNAL_LABELS: Array<{ key: keyof SignalWeights; label: string; color: string }> = [
  { key: "sma_trend", label: "SMA trend", color: "bg-primary" },
  { key: "rsi", label: "RSI", color: "bg-accent" },
  { key: "price_change", label: "Price change", color: "bg-chart-3" },
  { key: "news_sentiment", label: "News sentiment", color: "bg-chart-4" },
  { key: "volatility", label: "Volatility", color: "bg-chart-5" },
];

export function normalizeWeights(w: Partial<SignalWeights> | undefined): SignalWeights | null {
  if (!w) return null;
  const vals = SIGNAL_LABELS.map(({ key }) => Number(w[key] ?? 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const scale = 100 / total;
  return {
    sma_trend: vals[0] * scale,
    rsi: vals[1] * scale,
    price_change: vals[2] * scale,
    news_sentiment: vals[3] * scale,
    volatility: vals[4] * scale,
  };
}

export function SignalImportance({ weights }: { weights: SignalWeights }) {
  const ranked = [...SIGNAL_LABELS]
    .map((s) => ({ ...s, value: weights[s.key] }))
    .sort((a, b) => b.value - a.value);
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {ranked.map((s) => (
          <div
            key={s.key}
            className={s.color}
            style={{ width: `${Math.max(0, s.value)}%` }}
            title={`${s.label}: ${s.value.toFixed(0)}%`}
          />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
        {ranked.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 tabular-nums">
            <span className={`h-2 w-2 rounded-sm ${s.color}`} />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="ml-auto font-medium">{s.value.toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LiquidityStrip({ lq }: { lq: ExecutedLiquidity }) {
  const bucketClass =
    lq.rejection_bucket === "high"
      ? "border-destructive/40 text-destructive"
      : lq.rejection_bucket === "medium"
        ? "border-accent/40 text-accent"
        : "border-primary/40 text-primary";
  return (
    <div className="mb-3 rounded-md border border-border/60 bg-background/40 p-2">
      <div className="mb-1 flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
        <Activity className="h-3 w-3" /> Liquidity &amp; slippage (used for sizing)
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs tabular-nums">
        <Badge variant="outline" className={bucketClass}>
          Rejection risk {lq.rejection_score} · {lq.rejection_bucket}
        </Badge>
        <Badge variant="outline">Slippage ~{lq.est_slippage_bps.toFixed(0)}bps</Badge>
        <Badge variant="outline">
          Turnover{" "}
          {lq.est_turnover_pct_adv == null ? "—" : `${lq.est_turnover_pct_adv.toFixed(2)}% ADV`}
        </Badge>
        <Badge variant="outline">
          20d ADV {lq.adv_20d_usd == null ? "—" : `$${Math.round(lq.adv_20d_usd).toLocaleString()}`}
        </Badge>
        <Badge variant="outline">
          Spread {lq.spread_bps == null ? "—" : `${lq.spread_bps.toFixed(0)}bps`}
        </Badge>
        {lq.trim_fraction > 0 && (
          <Badge variant="outline" className="border-accent/40 text-accent">
            Trimmed {(lq.trim_fraction * 100).toFixed(0)}%
            {lq.liquidity_cap_spend != null
              ? ` → cap $${Math.round(lq.liquidity_cap_spend).toLocaleString()}`
              : ""}
          </Badge>
        )}
      </div>
    </div>
  );
}
