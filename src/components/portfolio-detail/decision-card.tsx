import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Newspaper } from "lucide-react";
import { JargonText } from "@/components/jargon-text";
import { getCurrentRegime } from "@/lib/regime.functions";
import type { ConfidenceRegime } from "@/lib/order-confidence";
import type { TradingStyle } from "@/lib/trading-style";
import { OrderPanel } from "./order-panel";
import { normalizeWeights, SignalBadges } from "./signal-visuals";
import type { DecisionRaw, SignalWeights } from "./types";

export function DecisionCard({
  decision,
  currency,
  tradingStyle,
}: {
  decision: {
    id: string;
    run_date: string;
    briefing: string | null;
    rationale: string | null;
    portfolio_value: number | string | null;
    raw: unknown;
  };
  currency: string;
  tradingStyle?: TradingStyle | null;
}) {
  const raw = (decision.raw ?? {}) as DecisionRaw;
  const executed = raw.executed ?? [];
  const signals = raw.signals ?? [];
  const news = raw.news ?? [];
  const guardrails = raw.guardrails;
  const aiOrders = raw.orders ?? [];
  const signalBySymbol = new Map(signals.map((s) => [s.symbol, s]));
  const weightsByKey = new Map<string, SignalWeights>();
  const convictionByKey = new Map<string, number>();
  for (const o of aiOrders) {
    if (!o?.symbol || !o?.side) continue;
    const key = `${o.symbol.toUpperCase()}:${o.side}`;
    const w = normalizeWeights(o.signal_weights);
    if (w) weightsByKey.set(key, w);
    if (typeof o.conviction === "number") convictionByKey.set(key, o.conviction);
  }
  const approvedCount = executed.filter((e) => !e.rejected && e.quantity > 0).length;
  const rejectedCount = executed.filter((e) => e.rejected).length;

  // Latest regime — fetched once per rendered decision card. React
  // Query dedupes across cards on the same page so this is a single
  // request even when many decisions are visible.
  const getRegime = useServerFn(getCurrentRegime);
  const regimeQ = useQuery({
    queryKey: ["current-regime"],
    queryFn: () => getRegime(),
    staleTime: 5 * 60_000,
  });
  const regime = (regimeQ.data ?? null) as ConfidenceRegime;

  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="text-sm font-medium">{decision.run_date}</div>
            <div className="text-xs text-muted-foreground">
              {approvedCount} executed · {rejectedCount} blocked by guardrails
            </div>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            Value: {currency} {Number(decision.portfolio_value ?? 0).toFixed(2)}
          </span>
        </div>

        {guardrails && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            <Badge variant="secondary">{guardrails.risk_level}</Badge>
            <Badge variant="outline">
              Max position {(guardrails.max_position_pct * 100).toFixed(0)}%
            </Badge>
            <Badge variant="outline">
              Cash floor {(guardrails.cash_floor_pct * 100).toFixed(0)}%
            </Badge>
            <Badge variant="outline">≤ {guardrails.max_new_positions_per_day} new/day</Badge>
            <Badge variant="outline">No leverage</Badge>
          </div>
        )}

        {raw.plain_explanation?.text && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
            <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
              <span>Plain-English summary</span>
              {raw.plain_explanation.category && (
                <Badge variant="outline" className="text-[10px]">
                  {raw.plain_explanation.category === "traded" && "Traded"}
                  {raw.plain_explanation.category === "held_cash" && "Held cash"}
                  {raw.plain_explanation.category === "halted" && "Safety halt"}
                  {raw.plain_explanation.category === "no_signal" && "No signal"}
                </Badge>
              )}
            </div>
            <p className="text-sm">{raw.plain_explanation.text}</p>
          </div>
        )}

        {decision.briefing && (
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Market briefing
            </div>
            <p className="text-sm text-muted-foreground">
              <JargonText>{decision.briefing}</JargonText>
            </p>
          </div>
        )}
        {decision.rationale && (
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Rationale
            </div>
            <p className="text-sm">
              <JargonText>{decision.rationale}</JargonText>
            </p>
          </div>
        )}

        {executed.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Order-by-order breakdown
            </div>
            {executed.map((o, i) => (
              <OrderPanel
                key={i}
                decisionId={decision.id}
                orderIndex={i}
                order={o}
                signal={signalBySymbol.get(o.symbol.toUpperCase())}
                news={news}
                guardrails={guardrails}
                currency={currency}
                weights={weightsByKey.get(`${o.symbol.toUpperCase()}:${o.side}`)}
                conviction={convictionByKey.get(`${o.symbol.toUpperCase()}:${o.side}`) ?? null}
                regime={regime}
                tradingStyle={tradingStyle ?? null}
              />
            ))}
          </div>
        )}
        {executed.length === 0 && (
          <p className="text-sm text-muted-foreground">
            AI chose to hold — no orders were proposed this tick.
          </p>
        )}

        {(signals.length > 0 || news.length > 0) && (
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDown className="h-3 w-3" />
              Show all inputs the AI saw ({signals.length} candidates · {news.length} headlines)
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-3">
              {signals.length > 0 && (
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                    Candidate signals
                  </div>
                  <div className="space-y-1.5">
                    {signals.map((s) => (
                      <div key={s.symbol} className="flex flex-wrap items-center gap-2">
                        <span className="w-16 shrink-0 text-xs font-medium">{s.symbol}</span>
                        <SignalBadges s={s} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {news.length > 0 && (
                <div>
                  <div className="mb-1 flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
                    <Newspaper className="h-3 w-3" /> Headlines fed to the AI
                  </div>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {news.map((n, i) => (
                      <li key={i}>
                        • {n.headline}
                        {n.source ? <span className="opacity-60"> — {n.source}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}
