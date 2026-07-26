// Currency diagnostics banner
// -----------------------------------------------------------------------------
// Surfaces, at the top of a sim/live portfolio page, whether the portfolio's
// accounting currency currently matches the broker account currency. When they
// disagree, downstream P&L / % change is intentionally blocked and CASH_SYNC
// is skipped by the preflight (see src/lib/live-cash-sync.server.ts). Without
// this banner the user only sees a locked P&L card with no explanation.
//
// It reads the most recent CASH_SYNC / CASH_SYNC_PREFLIGHT audit rows for the
// portfolio and calls out:
//   * portfolio currency (from the portfolio row, passed in as a prop)
//   * broker currency (from the latest audit response)
//   * the exact field on the audit row that triggered the mismatch
//   * a plain-English remediation ("switch the portfolio to <BROKER>")
//
// It stays silent (returns null) when there's no data, no mismatch, or when
// the portfolio isn't a live_* mode.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertCircle, CheckCircle2 } from "lucide-react";

import { getCashSyncHistory } from "@/lib/live.functions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { formatUkDateTime } from "@/lib/uk-time";

type Row = {
  id: string;
  created_at: string;
  status: number | null;
  env: string | null;
  method: string | null;
  request: unknown;
  response: unknown;
  error: string | null;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function pickString(v: unknown): string | null {
  return typeof v === "string" && v ? v.toUpperCase() : null;
}

export type CurrencyDiagnosticsBannerProps = {
  portfolioId: string;
  portfolioCurrency: string | null | undefined;
  mode: string;
};

export function CurrencyDiagnosticsBanner({
  portfolioId,
  portfolioCurrency,
  mode,
}: CurrencyDiagnosticsBannerProps) {
  const fetchFn = useServerFn(getCashSyncHistory);
  const isLive = mode === "live_sim" || mode === "live_prod";
  const q = useQuery({
    queryKey: ["cash-sync-history", portfolioId, "diagnostics"],
    queryFn: () => fetchFn({ data: { portfolioId, limit: 10 } }),
    enabled: isLive,
    staleTime: 30_000,
  });

  const diagnosis = useMemo(() => {
    const rows = (q.data?.rows ?? []) as Row[];
    if (rows.length === 0) return null;
    const latest = rows[0];
    const req = asRecord(latest.request);
    const res = asRecord(latest.response);
    const portfolioCcy =
      pickString(req.portfolioCurrency) ??
      (portfolioCurrency ? portfolioCurrency.toUpperCase() : null);
    const brokerCcy = pickString(res.currency) ?? pickString(res.brokerCurrency);
    const isPreflight = latest.method === "CASH_SYNC_PREFLIGHT";
    const isMismatch =
      (isPreflight && Number(latest.status) === 409) ||
      (req.currencyMatches === false) ||
      (portfolioCcy != null && brokerCcy != null && portfolioCcy !== brokerCcy);
    // Pinpoint the exact field that flipped the guard so the user knows
    // whether it's the portfolio row or the broker response that needs
    // attention.
    let field: string;
    if (!portfolioCcy) {
      field = "portfolios.currency (portfolio has no accounting currency set)";
    } else if (!brokerCcy) {
      field = "broker balance response · currency (broker did not return a currency)";
    } else {
      field = "portfolios.currency vs broker balance response · currency";
    }
    return {
      isMismatch,
      isPreflight,
      portfolioCcy,
      brokerCcy,
      field,
      at: latest.created_at,
      reason: latest.error,
    };
  }, [q.data, portfolioCurrency]);

  if (!isLive) return null;
  if (q.isLoading || !diagnosis) return null;

  const { isMismatch, isPreflight, portfolioCcy, brokerCcy, field, at, reason } = diagnosis;

  if (!isMismatch) {
    return (
      <Alert
        className="border-emerald-500/40 bg-emerald-500/5"
        data-testid="currency-diagnostics-banner"
        data-state="ok"
      >
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        <AlertTitle className="flex flex-wrap items-center gap-2">
          Currencies aligned
          <Badge variant="secondary" className="font-mono">
            {portfolioCcy ?? "—"} = {brokerCcy ?? "—"}
          </Badge>
        </AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          Portfolio accounting currency matches the broker account. CASH_SYNC
          and P&amp;L calculations are running normally. Last check{" "}
          {formatUkDateTime(at)}.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert
      variant="destructive"
      data-testid="currency-diagnostics-banner"
      data-state="mismatch"
    >
      <AlertCircle className="h-4 w-4" />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        Currency mismatch is blocking P&amp;L
        <Badge variant="outline" className="border-destructive/40 font-mono">
          portfolio {portfolioCcy ?? "—"} ≠ broker {brokerCcy ?? "—"}
        </Badge>
        {isPreflight && (
          <Badge variant="outline" className="border-destructive/40">
            CASH_SYNC preflight halted
          </Badge>
        )}
      </AlertTitle>
      <AlertDescription className="mt-2 space-y-2 text-xs">
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          <div>
            <span className="font-medium">Portfolio currency:</span>{" "}
            <span className="font-mono">{portfolioCcy ?? "not set"}</span>
            <span className="text-muted-foreground"> (portfolios.currency)</span>
          </div>
          <div>
            <span className="font-medium">Broker currency:</span>{" "}
            <span className="font-mono">{brokerCcy ?? "not returned"}</span>
            <span className="text-muted-foreground">
              {" "}
              (Saxo /balance · Currency)
            </span>
          </div>
        </div>
        <div>
          <span className="font-medium">Mismatch source:</span>{" "}
          <span className="font-mono">{field}</span>
        </div>
        {reason && (
          <div>
            <span className="font-medium">Preflight reason:</span>{" "}
            <span className="font-mono">{reason}</span>
          </div>
        )}
        <div className="pt-1">
          <span className="font-medium">Fix:</span>{" "}
          {portfolioCcy && brokerCcy
            ? `switch this portfolio's accounting currency from ${portfolioCcy} to ${brokerCcy} to match the linked Saxo account.`
            : !portfolioCcy
              ? "set an accounting currency on this portfolio."
              : "check the broker connection — the account balance response is missing a currency field."}
        </div>
        <div className="text-muted-foreground">
          Last check {formatUkDateTime(at)}. Full history is in the broker cash
          reconciliation log below.
        </div>
      </AlertDescription>
    </Alert>
  );
}
