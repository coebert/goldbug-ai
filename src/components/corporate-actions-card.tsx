// Read-only corporate-actions panel. Lists pending Saxo events, their
// election options and — the part that actually matters — the response
// deadline. Aegis never instructs on an election; the card links you to
// the Saxo platform to do that yourself.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listCorporateActions,
  type CorporateActionView,
} from "@/lib/corporate-actions.functions";
import { daysUntil, deadlineUrgency } from "@/lib/corporate-actions";
import { bestValueOption } from "@/lib/corporate-action-impact";
import { formatMoney } from "@/lib/format-money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Landmark, RefreshCw, Scale } from "lucide-react";
import { formatUkDateTime } from "@/lib/uk-time";

function deadlineBadge(deadline: string | null) {
  const urgency = deadlineUrgency(deadline);
  const days = daysUntil(deadline);
  if (urgency === "unknown") {
    return { cls: "bg-muted text-muted-foreground", label: "no deadline published" };
  }
  if (urgency === "passed") {
    return { cls: "bg-muted text-muted-foreground", label: "deadline passed" };
  }
  const label = days === 0 ? "due today" : `${days}d left`;
  if (urgency === "urgent") return { cls: "bg-destructive text-destructive-foreground", label };
  if (urgency === "soon") return { cls: "bg-amber-500 text-white hover:bg-amber-500", label };
  return { cls: "bg-muted text-muted-foreground", label };
}

function ImpactPreviewTable({ event }: { event: CorporateActionView }) {
  const { impact } = event;
  const best = bestValueOption(impact);
  const ccy = impact.position.currency;

  return (
    <div className="mt-3 rounded-lg border border-dashed bg-muted/20 p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium">
        <Scale className="h-3.5 w-3.5 text-primary" /> Impact preview
        {impact.position.quantity > 0 && (
          <span className="font-normal text-muted-foreground">
            on {impact.position.quantity} shares
            {impact.position.price != null
              ? ` @ ${formatMoney(impact.position.price, ccy)}`
              : ""}
          </span>
        )}
      </div>

      {impact.unavailableReason ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{impact.unavailableReason}</p>
      ) : (
        <>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="pb-1 pr-2 font-normal">If you elect</th>
                  <th className="pb-1 pr-2 text-right font-normal">Cash</th>
                  <th className="pb-1 pr-2 text-right font-normal">Shares</th>
                  <th className="pb-1 text-right font-normal">Est. value</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {impact.impacts.map((i, idx) => (
                  <tr key={i.optionId ?? `${event.id}-imp-${idx}`} className="border-t">
                    <td className="py-1 pr-2 align-top">
                      <span className="font-medium">{i.label}</span>
                      {best && best.optionId === i.optionId && (
                        <Badge className="ml-1.5 bg-primary/15 text-[10px] text-primary hover:bg-primary/15">
                          higher est. value
                        </Badge>
                      )}
                      <div className="text-[10px] font-normal text-muted-foreground">
                        {i.basis}
                      </div>
                    </td>
                    <td className="py-1 pr-2 text-right align-top">
                      {i.cashDelta ? `+${formatMoney(i.cashDelta, ccy)}` : "—"}
                    </td>
                    <td className="py-1 pr-2 text-right align-top">
                      {i.sharesDelta ? `+${i.sharesDelta} → ${i.sharesAfter}` : impact.position.quantity}
                    </td>
                    <td className="py-1 text-right align-top">
                      {i.totalValue ? formatMoney(i.totalValue, ccy) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Estimates only: fractional entitlements, withholding tax and the registrar's
            scrip reference price can change the outcome.
          </p>
        </>
      )}
    </div>
  );
}

function EventRow({ event }: { event: CorporateActionView }) {
  const badge = deadlineBadge(event.deadline);
  return (
    <li className="rounded-lg border bg-card/50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {event.instrument ?? event.symbol ?? "Unknown instrument"}
          </div>
          <div className="text-xs text-muted-foreground">
            {event.eventTypeLabel}
            {event.symbol && event.instrument ? ` · ${event.symbol}` : ""}
            {event.status ? ` · ${event.status}` : ""}
          </div>
        </div>
        <Badge className={`${badge.cls} text-[10px] whitespace-nowrap`}>{badge.label}</Badge>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Respond by</dt>
          <dd className="tabular-nums">
            {event.deadline ? formatUkDateTime(event.deadline) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Ex-date</dt>
          <dd className="tabular-nums">{event.exDate ? formatUkDateTime(event.exDate) : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Pay date</dt>
          <dd className="tabular-nums">{event.payDate ? formatUkDateTime(event.payDate) : "—"}</dd>
        </div>
      </dl>

      {event.options.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {event.options.map((o, i) => (
            <li
              key={o.id ?? `${event.id}-${i}`}
              className="flex flex-wrap items-center gap-1.5 text-xs"
            >
              <span className="text-muted-foreground">{o.id ? `${o.id}.` : "•"}</span>
              <span>{o.label}</span>
              {o.detail && <span className="text-muted-foreground">({o.detail})</span>}
              {o.isDefault && (
                <Badge variant="outline" className="text-[10px]">
                  applied if you do nothing
                </Badge>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          No election options published — this event is mandatory or informational.
        </p>
      )}

      <ImpactPreviewTable event={event} />
    </li>

  );
}

export function CorporateActionsCard({
  portfolioId,
  active = true,
}: {
  portfolioId: string;
  active?: boolean;
}) {
  const fetchEvents = useServerFn(listCorporateActions);
  const q = useQuery({
    queryKey: ["corporate-actions", portfolioId],
    queryFn: () => fetchEvents({ data: { portfolioId } }),
    enabled: active,
    staleTime: 10 * 60_000,
    refetchInterval: 30 * 60_000,
  });

  const res = q.data;
  const events = res?.events ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Landmark className="h-4 w-4 text-primary" /> Corporate actions
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Pending broker events and their deadlines. Read-only — elections are made in
            Saxo.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isError && (
          <div className="text-sm text-destructive">
            Failed to load: {(q.error as Error).message}
          </div>
        )}
        {q.isLoading && (
          <div className="h-16 animate-pulse rounded-lg border bg-muted/30" aria-hidden />
        )}
        {res && !res.brokerBacked && (
          <p className="text-sm text-muted-foreground">
            {res.reason ?? "This portfolio is not linked to a broker account."}
          </p>
        )}
        {res?.brokerBacked && !res.supported && (
          <p className="text-sm text-muted-foreground">{res.reason}</p>
        )}
        {res?.supported && events.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No pending corporate actions on this account.
          </p>
        )}
        {events.length > 0 && (
          <ul className="space-y-2">
            {events.map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </ul>
        )}
        {res?.fetchedAt && (
          <p className="text-[10px] text-muted-foreground">
            Checked {formatUkDateTime(res.fetchedAt)}
            {res.env ? ` · ${res.env.toUpperCase()}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
