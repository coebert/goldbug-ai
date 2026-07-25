import { Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  computeOrderConfidence,
  confidenceTone,
  type ConfidenceInput,
} from "@/lib/order-confidence";

/**
 * Per-order confidence pill. Renders the composite score plus a
 * tooltip breaking down which inputs (base conviction, regime shift,
 * news alignment) moved the number. Colour keys off the tone band so
 * the eye can scan a run of orders without reading numbers.
 */
export function OrderConfidenceBadge(props: ConfidenceInput) {
  const result = computeOrderConfidence(props);
  const tone = confidenceTone(result.score);
  const toneClass =
    tone === "high"
      ? "border-primary/40 text-primary bg-primary/10"
      : tone === "medium"
      ? "border-warning/40 text-warning bg-warning/10"
      : "border-destructive/40 text-destructive bg-destructive/10";

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={`gap-1 tabular-nums ${toneClass}`}
            aria-label={`Confidence ${result.score} out of 100`}
          >
            <Gauge className="h-3 w-3" aria-hidden />
            {result.score}% confidence
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs space-y-1.5 p-3 text-xs">
          <div className="font-display text-sm font-semibold">
            How this {result.score}% was built
          </div>
          <ul className="space-y-1">
            {result.breakdown.map((b, i) => {
              const sign = b.delta > 0 ? "+" : b.delta < 0 ? "" : "";
              const color =
                b.delta > 0
                  ? "text-primary"
                  : b.delta < 0
                  ? "text-destructive"
                  : "text-muted-foreground";
              return (
                <li key={i} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">{b.label}</div>
                    <div className="text-muted-foreground">{b.detail}</div>
                  </div>
                  <span className={`shrink-0 tabular-nums ${color}`}>
                    {i === 0 ? `${b.delta}%` : `${sign}${b.delta} pts`}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="pt-1 text-[11px] text-muted-foreground">
            Score = base conviction × regime factor × news factor. Recomputed
            from the latest regime and related headlines whenever you open this
            decision.
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
