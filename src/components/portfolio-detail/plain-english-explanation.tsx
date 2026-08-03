import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JargonText } from "@/components/jargon-text";
import { explainDecisionOrder, type ExplainOrderInput } from "@/lib/order-explanations.functions";
import type { ExecutedRow, Guardrails, NewsRow, SignalWeights } from "./types";

export function PlainEnglishExplanation({
  decisionId,
  orderIndex,
  order,
  weights,
  relatedNews,
  guardrails,
  currency,
}: {
  decisionId: string;
  orderIndex: number;
  order: ExecutedRow;
  weights: SignalWeights | null;
  relatedNews: NewsRow[];
  guardrails?: Guardrails;
  currency: string;
}) {
  const orderKey = `${order.symbol.toUpperCase()}:${order.side}:${orderIndex}`;
  const explainFn = useServerFn(explainDecisionOrder);
  const q = useQuery({
    queryKey: ["order-explanation", decisionId, orderKey],
    enabled: false,
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
          <Sparkles className="h-3 w-3" /> Plain-English explanation
        </div>
        {!q.data && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            {q.isFetching ? "Generating…" : "Explain this trade"}
          </Button>
        )}
        {q.data && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            title="Regenerate"
          >
            {q.isFetching ? "Regenerating…" : "Regenerate"}
          </Button>
        )}
      </div>
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
      {!q.data && !q.isError && !q.isFetching && (
        <p className="text-xs text-muted-foreground">
          Get a jargon-free summary of what the AI did and why.
        </p>
      )}
    </div>
  );
}
