import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { companyName } from "@/lib/symbol-names";

/**
 * A ticker symbol that reveals the company / instrument name on hover
 * (and on keyboard focus or tap, via the Radix tooltip trigger).
 *
 * Unknown symbols render as plain text so nothing regresses for instruments
 * outside the curated universe.
 */
export function SymbolTicker({
  symbol,
  className,
  children,
  detail,
}: {
  symbol: string;
  className?: string;
  /** Custom rendering of the symbol itself; defaults to the raw symbol. */
  children?: ReactNode;
  /** Extra line shown under the name (e.g. quantity and price). */
  detail?: ReactNode;
}) {
  const name = companyName(symbol);
  const label = children ?? symbol;
  if (!name && !detail) return <span className={className}>{label}</span>;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={className}
            tabIndex={0}
            data-testid={`symbol-ticker-${symbol}`}
            aria-label={name ? `${symbol} — ${name}` : symbol}
          >
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-[240px] bg-popover text-popover-foreground border border-border shadow-md"
        >
          <p className="font-semibold">{name ?? symbol}</p>
          {name && <p className="text-[10px] opacity-70">{symbol}</p>}
          {detail && <p className="mt-1 text-[10px] opacity-80">{detail}</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
