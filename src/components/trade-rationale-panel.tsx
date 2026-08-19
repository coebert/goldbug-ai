import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, AlertTriangle, ExternalLink, Gauge, Newspaper, ShieldCheck, Target } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { RuleWhatIfPanel } from "@/components/backtest/rule-what-if-card";
import { Progress } from "@/components/ui/progress";
import { getTradeRationale, type TradeRationale } from "@/lib/trade-rationale.functions";
import { formatUkDate } from "@/lib/uk-time";
import { cn } from "@/lib/utils";
import { RationaleRefreshStatus } from "@/components/rationale-refresh-status";

function stanceClass(stance: string): string {
  if (stance === "supporting") return "border-emerald-500/40 text-emerald-400";
  if (stance === "cautionary") return "border-amber-500/40 text-amber-400";
  return "border-border text-muted-foreground";
}

const LEVEL_TONE: Record<string, string> = {
  trigger: "text-foreground",
  limit: "text-sky-400",
  stop: "text-rose-400",
  target: "text-emerald-400",
  trailing: "text-amber-400",
  cost_basis: "text-muted-foreground",
};

function fmtPrice(price: number, currency: string | null): string {
  const digits = price >= 100 ? 2 : price >= 1 ? 3 : 5;
  const value = price.toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
  return currency ? `${value} ${currency}` : value;
}

function fmtSignedPct(p: number | null): string | null {
  if (p == null) return null;
  if (Math.abs(p) < 0.00005) return "at trigger";
  return `${p > 0 ? "+" : ""}${(p * 100).toFixed(2)}%`;
}

function TradeLevelsSection({ levels }: { levels: NonNullable<TradeRationale["levels"]> }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <Target className="h-3.5 w-3.5" />
        Price levels used
      </div>

      <ul className="space-y-1.5">
        {levels.levels.map((l) => (
          <li key={l.key} className="rounded-md border bg-muted/20 p-2">
            <div className="flex flex-wrap items-baseline justify-between gap-1.5">
              <span className="text-xs font-medium">{l.label}</span>
              <span className={cn("text-xs font-semibold tabular-nums", LEVEL_TONE[l.key] ?? "")}>
                {fmtPrice(l.price, levels.currency)}
                {fmtSignedPct(l.distancePct) && (
                  <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                    {fmtSignedPct(l.distancePct)}
                  </span>
                )}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{l.basis}</p>
          </li>
        ))}
      </ul>

      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {levels.riskPct != null && (
          <Badge variant="outline" className="text-[10px]">
            Risk {(levels.riskPct * 100).toFixed(1)}%
          </Badge>
        )}
        {levels.rewardPct != null && (
          <Badge variant="outline" className="text-[10px]">
            Reward {(levels.rewardPct * 100).toFixed(1)}%
          </Badge>
        )}
        {levels.riskReward != null && (
          <Badge variant="outline" className="text-[10px]">
            R:R {levels.riskReward.toFixed(2)}×
          </Badge>
        )}
        {levels.atrPct != null && (
          <Badge variant="outline" className="text-[10px]">
            ATR {(levels.atrPct * 100).toFixed(2)}%
          </Badge>
        )}
        {levels.maxHoldDays != null && levels.maxHoldDays > 0 && (
          <Badge variant="outline" className="text-[10px]">
            Max hold {levels.maxHoldDays}d
          </Badge>
        )}
      </div>

      {levels.notes.map((note) => (
        <p key={note} className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}

const BAND_TONE: Record<string, string> = {
  high: "border-emerald-500/40 text-emerald-400",
  moderate: "border-amber-500/40 text-amber-400",
  low: "border-rose-500/40 text-rose-400",
};

function ConfidenceSection({ confidence }: { confidence: TradeRationale["confidence"] }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <Gauge className="h-3.5 w-3.5" />
        AI confidence
      </div>
      <div className="rounded-md border bg-muted/20 p-2">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="text-sm font-semibold tabular-nums">{confidence.score}/100</span>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className={cn("text-[10px] capitalize", BAND_TONE[confidence.band])}>
              {confidence.band} confidence
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              Evidence coverage {Math.round(confidence.coverage * 100)}%
            </Badge>
          </div>
        </div>
        <Progress value={confidence.score} className="mt-1.5 h-1.5" />
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{confidence.summary}</p>
        {confidence.components.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {confidence.components.map((c) => (
              <li key={c.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] font-medium">{c.label}</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {Math.round(c.value * 100)}% · weight {c.weight.toFixed(1)}
                  </span>
                </div>
                <Progress value={Math.round(c.value * 100)} className="mt-0.5 h-1" />
                <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{c.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RiskLimitsSection({ limits }: { limits: NonNullable<TradeRationale["riskLimits"]> }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        Risk limits — {limits.levelName}
        {limits.level != null && <span className="normal-case">(level {limits.level}/5)</span>}
      </div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {limits.items.map((i) => (
          <li key={i.key} className="rounded-md border bg-muted/20 p-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium">{i.label}</span>
              <span className="text-xs font-semibold tabular-nums">{i.value}</span>
            </div>
            {i.utilisation != null && (
              <Progress
                value={Math.round(i.utilisation * 100)}
                className={cn("mt-1 h-1", i.utilisation >= 1 && "[&>div]:bg-rose-500")}
              />
            )}
            <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{i.detail}</p>
          </li>
        ))}
      </ul>
      {limits.notes.map((n) => (
        <p key={n} className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
          {n}
        </p>
      ))}
    </div>
  );
}

export function TradeRationaleView({
  rationale,
  portfolioId,
}: {
  rationale: TradeRationale;
  portfolioId?: string;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs font-medium">{rationale.headline}</p>

      {rationale.aiRationale && (
        <p className="text-xs leading-relaxed text-muted-foreground">{rationale.aiRationale}</p>
      )}

      <ConfidenceSection confidence={rationale.confidence} />

      {rationale.riskLimits && rationale.riskLimits.items.length > 0 && (
        <RiskLimitsSection limits={rationale.riskLimits} />
      )}

      {rationale.levels && <TradeLevelsSection levels={rationale.levels} />}

      {portfolioId && <RuleWhatIfPanel portfolioId={portfolioId} symbol={rationale.symbol} />}

      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          <Activity className="h-3.5 w-3.5" />
          Signals
        </div>
        {rationale.signals.length === 0 ? (
          <p className="text-xs text-muted-foreground">No structured signals were recorded.</p>
        ) : (
          <ul className="space-y-2">
            {rationale.signals.map((s) => (
              <li key={s.key} className="rounded-md border bg-muted/20 p-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium">{s.label}</span>
                  <Badge variant="outline" className={cn("text-[10px] capitalize", stanceClass(s.stance))}>
                    {s.stance}
                  </Badge>
                </div>
                {s.detail && (
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{s.detail}</p>
                )}
                {s.strength != null && (
                  <Progress value={Math.round(Math.min(1, Math.abs(s.strength)) * 100)} className="mt-1.5 h-1" />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          <Newspaper className="h-3.5 w-3.5" />
          Recent market events
        </div>
        {rationale.events.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No headlines or scheduled events referenced this instrument in the days before the decision.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rationale.events.map((e) => (
              <li key={`${e.kind}-${e.id}`} className="rounded-md border p-2">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span>{formatUkDate(e.date)}</span>
                  {e.source && <span>· {e.source}</span>}
                  {e.sentiment && (
                    <Badge variant="outline" className="text-[10px] capitalize">
                      {e.sentiment}
                    </Badge>
                  )}
                  {e.relevance != null && <span>· relevance {Math.round(e.relevance)}</span>}
                </div>
                <p className="mt-0.5 text-xs leading-snug">
                  {e.url ? (
                    <a
                      href={e.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-start gap-1 underline underline-offset-2"
                    >
                      {e.title}
                      <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    e.title
                  )}
                </p>
                {e.detail && (
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{e.detail}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {rationale.runRationale && (
        <p className="rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">
          Run context: {rationale.runRationale}
        </p>
      )}

      {rationale.sparse && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Only the free-text rationale was stored for this decision.
        </p>
      )}
    </div>
  );
}

/** Loads and renders the rationale for one instrument in one portfolio. */
export function TradeRationalePanel({
  portfolioId,
  symbol,
  date,
}: {
  portfolioId: string;
  symbol: string;
  date?: string;
}) {
  const fetchRationale = useServerFn(getTradeRationale);
  const query = useQuery({
    queryKey: ["trade-rationale", portfolioId, symbol, date ?? "latest"],
    queryFn: () => fetchRationale({ data: { portfolioId, symbol, date } }),
    staleTime: 5 * 60_000,
  });

  if (query.isLoading) return <div className="h-24 animate-pulse rounded-md bg-muted" aria-hidden />;
  if (query.error)
    return <p className="text-xs text-destructive">Couldn't load rationale: {(query.error as Error).message}</p>;
  if (!query.data)
    return <p className="text-xs text-muted-foreground">No recorded decision for {symbol} on this day.</p>;

  return (
    <div className="space-y-2">
      <RationaleRefreshStatus />
      <TradeRationaleView rationale={query.data} portfolioId={portfolioId} />
    </div>
  );
}
