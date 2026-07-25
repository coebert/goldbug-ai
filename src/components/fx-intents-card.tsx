import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listFxIntents, type FxIntentRow } from "@/lib/fx-intents.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, Coins } from "lucide-react";
import { formatUkTime } from "@/lib/uk-time";

interface Props {
  portfolioId: string;
  active?: boolean;
}

const KIND_LABEL: Record<string, string> = {
  pre_fund: "Pre-fund",
  hedge: "Hedge",
  sweep_idle: "Sweep",
  carry_tilt: "Carry",
  close_hedge: "Close hedge",
};

const KIND_TONE: Record<string, string> = {
  pre_fund: "bg-blue-500/15 text-blue-500 border-blue-500/30",
  hedge: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  sweep_idle: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  carry_tilt: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  close_hedge: "bg-purple-500/15 text-purple-400 border-purple-500/30",
};

function statusFor(row: FxIntentRow): { label: string; tone: string } {
  if (row.skipped) return { label: "trimmed/skipped", tone: "bg-muted text-muted-foreground border-border" };
  if (row.applied?.rejected) return { label: "rejected", tone: "bg-destructive/15 text-destructive border-destructive/30" };
  if (row.applied) return { label: "applied", tone: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" };
  return { label: "pending", tone: "bg-muted text-muted-foreground border-border" };
}

/**
 * Recent FX intents (Phase 6 observability). Reads decisions.raw.ai_fx
 * and shows the last N intents the AI emitted, whether they compiled to
 * an order, and whether the applier accepted or rejected them.
 */
export function FxIntentsCard({ portfolioId, active = true }: Props) {
  const fetchIntents = useServerFn(listFxIntents);
  const query = useQuery({
    queryKey: ["fx-intents", portfolioId],
    queryFn: () => fetchIntents({ data: { portfolioId, limit: 25 } }),
    enabled: active,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const rows = query.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Coins className="h-4 w-4 text-muted-foreground" />
          Recent FX intents
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No FX intents in the last 30 decisions. The AI emits intents when the FX wallet is
            active and a rule fires — pre-fund a foreign buy, hedge a currency spike, sweep
            idle cash, tilt for carry, or close a hedge.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r, i) => {
              const s = statusFor(r);
              const kindTone = KIND_TONE[r.kind] ?? "bg-muted text-foreground border-border";
              return (
                <li key={`${r.decisionId}-${i}`} className="py-2 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <Badge variant="outline" className={kindTone}>
                      {KIND_LABEL[r.kind] ?? r.kind}
                    </Badge>
                    {r.order ? (
                      <span className="font-mono">
                        {r.order.from_ccy} <ArrowRight className="inline h-3 w-3" /> {r.order.to_ccy} · {r.order.amount_percent}%
                      </span>
                    ) : (
                      <span className="font-mono text-muted-foreground">
                        {r.ccy || "—"} · no order
                      </span>
                    )}
                    <Badge variant="outline" className={s.tone}>
                      {s.label}
                    </Badge>
                    <span className="ml-auto text-muted-foreground">
                      {formatUkTime(r.createdAt)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-snug">
                    {r.reason}
                  </p>
                  {(r.skipped || r.applied?.rejected) && (
                    <p className="text-xs text-amber-500/90">
                      {r.skipped ?? r.applied?.rejected}
                    </p>
                  )}
                  {r.applied && !r.applied.rejected && (
                    <p className="text-xs text-muted-foreground font-mono">
                      Converted {r.applied.amount_from.toFixed(2)} {r.order?.from_ccy} →{" "}
                      {r.applied.amount_to.toFixed(2)} {r.order?.to_ccy} @ {r.applied.rate.toFixed(5)}
                      {" · "}notional ≈ {r.notionalBase.toFixed(2)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
