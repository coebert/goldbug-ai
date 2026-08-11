import { useMemo } from "react";
import { Activity, Newspaper, ShieldAlert, Sparkles } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type { AuditEntry } from "@/lib/audit-log";
import { buildTradeExplanation, type ExplainedSignal } from "@/lib/trade-explanation";
import { readCalibration, type CalibrationBand } from "@/lib/confidence-calibration";
import { buildSmaExplanation } from "@/lib/sma-explanation";
import { SmaCrossExplainer } from "@/components/sma-cross-explainer";
import {
  getConfidenceCalibration,
  type ConfidenceCalibrationResult,
} from "@/lib/confidence-calibration.functions";


function SignalList({
  title,
  icon,
  signals,
  empty,
}: {
  title: string;
  icon: React.ReactNode;
  signals: ExplainedSignal[];
  empty: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs uppercase text-muted-foreground mb-1">
        {icon}
        {title}
      </div>
      {signals.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {signals.map((s) => (
            <Badge key={s.key} variant="outline" className="text-[10px]">
              {s.label}: {s.weight.toFixed(2)}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function TradeExplanationPanel({
  entry,
  unitsUnresolved,
  unitsReason,
  portfolioId,
  calibration,
}: {
  entry: AuditEntry;
  unitsUnresolved?: boolean;
  unitsReason?: string;
  /** When provided, the panel loads historical calibration for this portfolio. */
  portfolioId?: string;
  /** Pre-supplied calibration (tests / server-rendered callers). */
  calibration?: ConfidenceCalibrationResult;
}) {
  const x = useMemo(
    () => buildTradeExplanation(entry, { unitsUnresolved, unitsReason }),
    [entry, unitsUnresolved, unitsReason],
  );

  const calibrationFn = useServerFn(getConfidenceCalibration);
  const query = useQuery({
    queryKey: ["confidence-calibration", portfolioId],
    enabled: !!portfolioId && !calibration,
    staleTime: 10 * 60_000,
    queryFn: () =>
      calibrationFn({ data: { portfolioId: portfolioId! } }) as Promise<ConfidenceCalibrationResult>,
  });

  const data = calibration ?? query.data;
  const calibrationLoading = !calibration && !!portfolioId && query.isLoading;
  const report = data?.report ?? null;
  const reading = useMemo(
    () => (data ? readCalibration(x.confidence.score, data.report, data.samples) : null),
    [data, x.confidence.score],
  );

  const sma = useMemo(
    () =>
      buildSmaExplanation({
        state: entry.smaCross,
        side: entry.side,
        riskLevel:
          entry.riskLevel ??
          (typeof entry.guardrails?.risk_level === "string" ? entry.guardrails.risk_level : null),
      }),
    [entry.smaCross, entry.side, entry.riskLevel, entry.guardrails],
  );

  const trendPct = Math.round(x.trendShare * 100);
  const eventPct = Math.round(x.eventShare * 100);



  return (
    <section
      aria-label={`Explain this trade: ${entry.symbol}`}
      data-testid="trade-explanation-panel"
      className="rounded-lg border border-border bg-card/60 p-3 space-y-3"
    >
      <header className="flex items-start gap-2">
        <Sparkles className="h-4 w-4 mt-0.5 text-primary shrink-0" />
        <div>
          <h4 className="text-sm font-medium leading-snug">Explain this trade</h4>
          <p className="text-sm text-muted-foreground mt-0.5">{x.headline}</p>
        </div>
      </header>

      <div>
        <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
          <span>Trend {trendPct}%</span>
          <Badge variant="secondary" className="text-[10px] capitalize">
            {x.driver.replace("-", " ")}
          </Badge>
          <span>Events {eventPct}%</span>
        </div>
        <Progress value={trendPct} aria-label="Share of decision driven by trend signals" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <SignalList
          title="Trend signals"
          icon={<Activity className="h-3.5 w-3.5" />}
          signals={x.trendSignals}
          empty="No trend/technical weights recorded."
        />
        <SignalList
          title="Event signals"
          icon={<Newspaper className="h-3.5 w-3.5" />}
          signals={x.eventSignals}
          empty="No news/event weights recorded."
        />
      </div>

      <SmaCrossExplainer explanation={sma} />

      <div>
        <div className="text-xs uppercase text-muted-foreground mb-1">Confidence</div>
        {x.confidence.label ? (
          <p className="text-sm">
            <span className="font-medium capitalize">{x.confidence.label}</span>{" "}
            <span className="text-muted-foreground tabular-nums">
              ({x.confidence.score!.toFixed(2)})
            </span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Not recorded for this order.</p>
        )}

        {calibrationLoading ? (
          <p className="mt-1 text-xs text-muted-foreground">Checking historical hit-rate…</p>
        ) : reading ? (
          <div data-testid="confidence-calibration" className="mt-2 space-y-2">
            <p className="text-xs text-muted-foreground">{reading.sentence}</p>
            {!reading.insufficient && reading.band?.hitRate != null && (
              <div>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                  <span>Historical hit-rate in this band</span>
                  <span className="tabular-nums">
                    {Math.round(reading.band.hitRate * 100)}% of {reading.band.n}
                  </span>
                </div>
                <Progress
                  value={Math.round(reading.band.hitRate * 100)}
                  aria-label="Historical hit-rate for this confidence band"
                />
              </div>
            )}
            {report && report.totalSamples > 0 && (
              <div className="flex flex-wrap gap-1">
                {report.bands
                  .filter((b: CalibrationBand) => b.n > 0)
                  .map((b: CalibrationBand) => (

                    <Badge
                      key={b.label}
                      variant={b === reading.band ? "secondary" : "outline"}
                      className="text-[10px] tabular-nums"
                    >
                      {b.label}: {b.hitRate != null ? `${Math.round(b.hitRate * 100)}%` : "—"} (n=
                      {b.n})
                    </Badge>
                  ))}
              </div>
            )}
            {reading.percentile != null && (
              <p className="text-[10px] text-muted-foreground">
                Percentile band: this order ranks at the {reading.percentile}th percentile of
                confidence across the last {report?.totalSamples ?? 0} scored orders, measured over
                a {report?.horizonDays ?? 5}-session horizon.
              </p>
            )}
          </div>
        ) : null}

        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground list-disc pl-4">
          {x.confidence.drivers.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      </div>


      {x.withheldValue.withheld && (
        <div
          data-testid="withheld-value-reason"
          className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2"
        >
          <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-xs font-medium text-amber-300">Value withheld — units unresolved</div>
            <p className="text-xs text-muted-foreground mt-0.5">{x.withheldValue.reason}</p>
          </div>
        </div>
      )}

      <ul className="space-y-1 text-xs text-muted-foreground list-disc pl-4">
        {x.bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
    </section>
  );
}
