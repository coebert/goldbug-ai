import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getPriceFreshness } from "@/lib/price-freshness.functions";

/**
 * Warns when a held symbol is no longer quoting. Silence here used to mean a
 * retired ticker's last cached close was being marked as if it were live.
 */
export function StalePriceWarning({
  portfolioId,
  extraSymbols,
}: {
  portfolioId: string;
  extraSymbols?: string[];
}) {
  const fn = useServerFn(getPriceFreshness);
  const q = useQuery({
    queryKey: ["price-freshness", portfolioId, (extraSymbols ?? []).join(",")],
    queryFn: () => fn({ data: { portfolioId, extraSymbols: extraSymbols ?? [] } }),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });

  const bad = (q.data ?? []).filter((r) => r.status !== "ok");
  if (bad.length === 0) return null;

  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {bad.length} symbol{bad.length === 1 ? "" : "s"} not quoting live
      </AlertTitle>
      <AlertDescription className="space-y-1 text-xs">
        <p>
          These positions are marked at their last cached close, so their value and P&amp;L may be
          out of date. Unavailable symbols are usually delisted or renamed lines.
        </p>
        <ul className="space-y-0.5">
          {bad.map((r) => (
            <li key={r.symbol} className="tabular-nums">
              <span className="font-medium">{r.symbol}</span>
              {r.resolved.toUpperCase() !== r.symbol.toUpperCase() && ` → ${r.resolved}`} ·{" "}
              {r.status === "unavailable"
                ? "no price data at all"
                : `last close ${r.lastDate} (${r.ageDays} trading days ago)`}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
