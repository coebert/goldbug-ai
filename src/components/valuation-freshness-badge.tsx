import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getLastValuationRefresh } from "@/lib/valuation-freshness.functions";
import { formatUkDateTime } from "@/lib/uk-time";

function relative(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} mins ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** "Valued 3 mins ago" chip for live portfolio screens. */
export function ValuationFreshnessBadge({ portfolioId }: { portfolioId: string }) {
  const fetchFreshness = useServerFn(getLastValuationRefresh);
  const { data } = useQuery({
    queryKey: ["valuation-freshness", portfolioId],
    queryFn: () => fetchFreshness({ data: { portfolioId } }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Keep the relative label ticking without refetching.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const at = data?.lastRefreshedAt ?? null;
  const stale = at ? now - Date.parse(at) > 2 * 60 * 60 * 1000 : false;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center gap-1 text-[11px] ${
              stale ? "text-destructive" : "text-muted-foreground"
            }`}
            data-testid="valuation-freshness"
          >
            <Clock className="h-3 w-3" />
            {at ? `Valued ${relative(at, now)}` : "Valuation pending"}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {at
            ? `Last valuation refreshed ${formatUkDateTime(at)} (UK)`
            : "No broker valuation recorded yet for this portfolio."}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
