import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { MirrorCause, MirrorFinding } from "@/lib/portfolio-mirror-detect";

const CAUSE_LABEL: Record<MirrorCause, string> = {
  shared_broker_account: "Both linked to the same broker account",
  unlinked_default_account_fallback: "Neither is linked — a default account was mirrored in",
  linked_and_unlinked_mismatch: "One is linked, the other inherited its data",
  unknown: "Different broker accounts — likely a sync or seeding bug",
};

export function PortfolioMirrorAlert({ findings }: { findings: MirrorFinding[] }) {
  if (!findings || findings.length === 0) return null;
  const errors = findings.filter((f) => f.severity === "error");
  const isError = errors.length > 0;

  return (
    <Alert
      variant="destructive"
      className={
        isError
          ? "mb-4 border-destructive/60 bg-destructive/10"
          : "mb-4 border-amber-500/60 bg-amber-500/10 text-amber-100"
      }
      data-testid="portfolio-mirror-alert"
    >
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertTitle className="text-sm font-semibold">
        {isError
          ? "Account-linking error: portfolios are showing identical data"
          : "Two portfolios are showing identical data"}
      </AlertTitle>
      <AlertDescription className="mt-1 space-y-2 text-xs">
        <p>
          {findings.length === 1 ? "1 pair of portfolios" : `${findings.length} pairs of portfolios`}{" "}
          report the same holdings and the same equity. Independent strategies cannot produce
          identical books, so these numbers are not trustworthy until the broker links are fixed.
        </p>
        <ul className="list-disc space-y-1 pl-4">
          {findings.map((f) => (
            <li key={f.portfolioIds.join(":")} data-testid="portfolio-mirror-finding">
              <span className="font-medium">
                {f.portfolioNames[0]} ↔ {f.portfolioNames[1]}
              </span>
              : {CAUSE_LABEL[f.cause]}.{" "}
              {f.symbols.length > 0
                ? `Shared positions: ${f.symbols.join(", ")}.`
                : "Both books are empty."}{" "}
              Equity {f.equity[0]} vs {f.equity[1]}, cash {f.cash[0]} vs {f.cash[1]}. Broker account{" "}
              {f.brokerAccountIds[0] ?? "none"} vs {f.brokerAccountIds[1] ?? "none"}.
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
