import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Clock, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JargonText } from "@/components/jargon-text";
import { explainDecisionOrder, type ExplainOrderInput } from "@/lib/order-explanations.functions";
import { estimateHoldingPeriod } from "@/lib/expected-holding-period";
import type { TradingStyle } from "@/lib/trading-style";
import type { ExecutedRow, Guardrails, NewsRow, SignalWeights } from "./types";

export function PlainEnglishExplanation({
  decisionId,
  orderIndex,
  order,
  weights,
  relatedNews,
  guardrails,
  currency,
  tradingStyle,
}: {
  decisionId: string;
  orderIndex: number;
  order: ExecutedRow;
  weights: SignalWeights | null;
  relatedNews: NewsRow[];
  guardrails?: Guardrails;
  currency: string;
  tradingStyle?: TradingStyle | null;
}) {
  const orderKey = `${order.symbol.toUpperCase()}:${order.side}:${orderIndex}`;
  const explainFn = useServerFn(explainDecisionOrder);

  // Deterministic, instant — shown even before the AI sentence arrives.
  const hold = estimateHoldingPeriod({
    side: order.side,
    weights: weights ?? null,
    reason: order.reason ?? "",
    tradingStyle: tradingStyle ?? null,
  });
  const showHold = hold.applicable && !order.rejected;

  const q = useQuery({
    queryKey: ["order-explanation", decisionId, orderKey],
    staleTime: Infinity,
    gcTime: 1000 * 60 * 60,
    retry: 0,
    queryFn: async () => {
      const payload: ExplainOrderInput = {
        decisionId,
        orderKey,
        symbol: order.symbol,
        side: order.side,
        reason: order.reason ?? "",
        rejected: order.rejected ?? null,
        quantity: Number(order.quantity ?? 0),
        price: Number(order.price ?? 0),
        value: Number(order.value ?? 0),
        currency,
        weights: weights ?? null,
        tradingStyle: tradingStyle ?? null,
        relatedNews: relatedNews.map((n) => ({
          headline: n.headline,
          source: n.source ?? null,
        })),
        guardrails: guardrails
          ? {
              risk_level: guardrails.risk_level,
              max_position_pct: guardrails.max_position_pct,
              cash_floor_pct: guardrails.cash_floor_pct,
            }
          : null,
      };
      return explainFn({ data: payload });
    },
  });

  return (
    <div className="mb-3 rounded-md border border-primary/30 bg-primary/5 p-2.5">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-primary">
          <Sparkles className="h-3 w-3" /> Why this trade
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          title="Regenerate"
        >
          {q.isFetching ? "Generating…" : "Regenerate"}
        </Button>
      </div>

      {showHold && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="border-primary/40 text-primary">
            <Clock className="mr-1 h-3 w-3" /> Expected hold: {hold.label}
          </Badge>
        </div>
      )}

      {q.isFetching && !q.data && (
        <p className="text-xs text-muted-foreground">Writing a plain-English summary…</p>
      )}

      {q.isError && (
        <p className="text-xs text-destructive">
          {q.error instanceof Error
            ? q.error.message
            : "Could not generate an explanation. Try again in a moment."}
        </p>
      )}

      {q.data && !q.isError && (
        <p className="text-sm leading-relaxed text-foreground/90">
          <JargonText>{q.data.explanation}</JargonText>
        </p>
      )}

      {showHold && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground/80">How long and why: </span>
          {hold.basis} {hold.earlyExit}
        </p>
      )}
      {!showHold && order.side === "sell" && !order.rejected && (
        <p className="mt-2 text-xs text-muted-foreground">
          This sell closes the position, so there is no holding period — the proceeds go back to
          cash.
        </p>
      )}
    </div>
  );
}
