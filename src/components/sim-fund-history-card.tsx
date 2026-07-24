import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listSimFundEvents } from "@/lib/trading.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Banknote } from "lucide-react";

function fmt(currency: string, n: number) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
  const time = d.toUTCString().slice(17, 25); // HH:MM:SS
  return `${date} · ${time} GMT`;
}

export function SimFundHistoryCard({ portfolioId, currency }: { portfolioId: string; currency: string }) {
  const listFn = useServerFn(listSimFundEvents);
  const { data, isLoading } = useQuery({
    queryKey: ["sim-fund-events", portfolioId],
    queryFn: () => listFn({ data: { id: portfolioId } }),
  });

  const events = data?.events ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Banknote className="h-4 w-4" /> Funding history
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No top-ups yet. Use <span className="font-medium text-foreground">Add funds</span> to record a simulated deposit.
          </p>
        ) : (
          <ul className="divide-y">
            {events.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">+{fmt(e.currency ?? currency, Number(e.amount))}</div>
                  <div className="text-xs text-muted-foreground">{fmtWhen(e.created_at)}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-muted-foreground">Cash after</div>
                  <div className="font-medium tabular-nums">{fmt(e.currency ?? currency, Number(e.balance_after))}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
