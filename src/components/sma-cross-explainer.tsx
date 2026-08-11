import { ArrowDownRight, ArrowUpRight, Minus, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type { SmaExplanation } from "@/lib/sma-explanation";

const nf = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmt(v: number | null) {
  return v == null || !Number.isFinite(v) ? "—" : nf.format(v);
}

function fmtPct(v: number | null) {
  return v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function DirectionIcon({ direction }: { direction: SmaExplanation["fast"]["direction"] }) {
  if (direction === "bull") return <ArrowUpRight className="h-3.5 w-3.5 text-primary" />;
  if (direction === "bear") return <ArrowDownRight className="h-3.5 w-3.5 text-destructive" />;
  return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
}

const INFLUENCE_TONE: Record<SmaExplanation["influence"]["kind"], string> = {
  blocked: "border-destructive/40 bg-destructive/10 text-destructive",
  exit: "border-destructive/40 bg-destructive/10 text-destructive",
  trim: "border-warning/40 bg-warning/10 text-warning",
  downsized: "border-warning/40 bg-warning/10 text-warning",
  upsized: "border-primary/40 bg-primary/10 text-primary",
  neutral: "border-border bg-muted/40 text-muted-foreground",
  unavailable: "border-border bg-muted/40 text-muted-foreground",
};

function ValueCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-background/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  );
}

/**
 * Shows the SMA values behind one trade, which way the averages crossed,
 * how strong that read was, and exactly what the rules did to the order
 * under the portfolio's risk setting.
 */
export function SmaCrossExplainer({ explanation }: { explanation: SmaExplanation }) {
  const x = explanation;
  const v = x.values;

  return (
    <section
      data-testid="sma-cross-explainer"
      aria-label="How the SMA trend model influenced this trade"
      className="rounded-md border border-border/70 bg-background/30 p-2.5 space-y-2.5"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
          <TrendingUp className="h-3.5 w-3.5" />
          Moving-average trend
        </div>
        <Badge variant="outline" className="text-[10px] capitalize">
          {x.riskLevel} risk
        </Badge>
      </header>

      {!x.available ? (
        <p className="text-xs text-muted-foreground">{x.influence.detail}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <ValueCell label="Price" value={fmt(v.price)} sub={`vs SMA20 ${fmtPct(v.priceVsFastPct)}`} />
            <ValueCell label="SMA20" value={fmt(v.sma20)} />
            <ValueCell label="SMA50" value={fmt(v.sma50)} sub={`spread ${fmtPct(v.fastSpreadPct)}`} />
            <ValueCell
              label="SMA200"
              value={fmt(v.sma200)}
              sub={v.sma200 == null ? "no history" : `spread ${fmtPct(v.regimeSpreadPct)}`}
            />
          </div>

          <div className="grid gap-1.5 sm:grid-cols-2">
            <div className="flex items-start gap-1.5 text-xs">
              <DirectionIcon direction={x.fast.direction} />
              <div>
                <div className="font-medium">Fast cross (20/50)</div>
                <p className="text-muted-foreground">{x.fast.label}</p>
              </div>
            </div>
            <div className="flex items-start gap-1.5 text-xs">
              <DirectionIcon
                direction={
                  x.regime.state === "golden" ? "bull" : x.regime.state === "death" ? "bear" : "none"
                }
              />
              <div>
                <div className="font-medium">Regime (50/200)</div>
                <p className="text-muted-foreground">{x.regime.label}</p>
              </div>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Signal strength</span>
              <span className="tabular-nums capitalize">
                {x.strength}/100 · {x.strengthLabel}
              </span>
            </div>
            <Progress value={x.strength} aria-label="SMA trend signal strength" />
          </div>

          <div
            data-testid="sma-influence"
            className={`rounded-md border p-2 text-xs ${INFLUENCE_TONE[x.influence.kind]}`}
          >
            <div className="font-medium">{x.influence.headline}</div>
            <p className="mt-0.5 text-muted-foreground">{x.influence.detail}</p>
          </div>

          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
            {x.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>

          <p className="text-[10px] text-muted-foreground">{x.riskSummary}</p>
        </>
      )}
    </section>
  );
}
