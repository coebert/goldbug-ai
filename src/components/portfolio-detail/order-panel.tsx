import { Badge } from "@/components/ui/badge";
import { Activity, Newspaper, ShieldAlert, ShieldCheck } from "lucide-react";
import { JargonText } from "@/components/jargon-text";
import { OrderConfidenceBadge } from "@/components/order-confidence-badge";
import type { ConfidenceRegime } from "@/lib/order-confidence";
import { fmtNum, keywordMatch } from "./format";
import { LiquidityStrip, SignalBadges, SignalImportance } from "./signal-visuals";
import { PlainEnglishExplanation } from "./plain-english-explanation";
import type { ExecutedRow, Guardrails, NewsRow, SignalRow, SignalWeights } from "./types";

export function OrderPanel({
  decisionId,
  orderIndex,
  order,
  signal,
  news,
  guardrails,
  currency,
  weights,
  conviction,
  regime,
}: {
  decisionId: string;
  orderIndex: number;
  order: ExecutedRow;
  signal?: SignalRow;
  news: NewsRow[];
  guardrails?: Guardrails;
  currency: string;
  weights?: SignalWeights | null;
  conviction?: number | null;
  regime?: ConfidenceRegime;
}) {
  const approved = !order.rejected;
  const side = order.side;
  const relatedNews = signal
    ? news.filter((n) => keywordMatch(n.headline, signal.symbol, signal.name)).slice(0, 3)
    : [];

  return (
    <div className="rounded-lg border border-border bg-muted/10 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge
            className={
              side === "buy"
                ? "bg-primary/15 text-primary hover:bg-primary/15"
                : "bg-accent/15 text-accent hover:bg-accent/15"
            }
          >
            {side.toUpperCase()}
          </Badge>
          <span className="font-medium">{order.symbol}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {order.quantity > 0
              ? `${fmtNum(order.quantity, 4)} @ ${fmtNum(order.price)} = ${currency} ${fmtNum(order.value)}`
              : `intended · ${currency} ${fmtNum(order.price)}`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <OrderConfidenceBadge
            side={side}
            conviction={conviction ?? null}
            regime={regime ?? null}
            relatedNews={relatedNews.map((n) => ({
              headline: n.headline,
              sentiment: n.sentiment ?? null,
              source_weight: n.source_weight ?? 1,
            }))}
          />
          {approved ? (
            <Badge variant="outline" className="border-primary/40 text-primary">
              <ShieldCheck className="mr-1 h-3 w-3" /> Guardrails passed
            </Badge>
          ) : (
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              <ShieldAlert className="mr-1 h-3 w-3" /> Blocked · {order.rejected}
            </Badge>
          )}
        </div>
      </div>

      <p className="mb-2 text-sm">
        <span className="text-muted-foreground">AI reason: </span>
        <JargonText>{order.reason}</JargonText>
      </p>

      {order.liquidity && <LiquidityStrip lq={order.liquidity} />}

      <PlainEnglishExplanation
        decisionId={decisionId}
        orderIndex={orderIndex}
        order={order}
        weights={weights ?? null}
        relatedNews={relatedNews}
        guardrails={guardrails}
        currency={currency}
      />

      {weights && (
        <div className="mb-3">
          <div className="mb-1.5 flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
            <Activity className="h-3 w-3" /> Signal importance (AI-attributed)
          </div>
          <SignalImportance weights={weights} />
        </div>
      )}

      {signal && (
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
            <Activity className="h-3 w-3" /> Signals driving this call
          </div>
          <SignalBadges s={signal} />
        </div>
      )}

      {relatedNews.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
            <Newspaper className="h-3 w-3" /> Related headlines
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {relatedNews.map((n, i) => (
              <li key={i}>
                • {n.headline}
                {n.source ? <span className="opacity-60"> — {n.source}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {guardrails && (
        <div className="mt-2 rounded border border-border/60 bg-background/40 p-2 text-xs text-muted-foreground">
          <div className="mb-1 font-medium text-foreground/80">Guardrail check</div>
          {approved && side === "buy" && (
            <ul className="space-y-0.5">
              <li>
                ✓ Cash floor respected — kept ≥ {currency} {fmtNum(guardrails.cash_floor_value)} (
                {(guardrails.cash_floor_pct * 100).toFixed(0)}% of portfolio)
              </li>
              <li>
                ✓ Position ≤ {currency} {fmtNum(guardrails.max_position_value)} cap (
                {(guardrails.max_position_pct * 100).toFixed(0)}% max)
              </li>
              <li>✓ Within {guardrails.max_new_positions_per_day} new-position daily cap</li>
              <li>✓ No leverage, no borrow, cash-funded</li>
            </ul>
          )}
          {approved && side === "sell" && (
            <ul className="space-y-0.5">
              <li>✓ Held quantity available to sell</li>
              <li>✓ Proceeds returned to cash (no shorting)</li>
            </ul>
          )}
          {!approved && (
            <p>
              ✗ Rejected by guardrail: <span className="text-destructive">{order.rejected}</span>.
              The AI's intent was recorded but no trade was placed.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
