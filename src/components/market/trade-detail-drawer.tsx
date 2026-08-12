// Details drawer for a single simulated backtest trade.
//
// Opens from the trade lists (and stays in sync with the chart highlight), so
// you can read the exact entry/exit dates, prices, gross vs net return and
// invalidation status without hunting across the chart.

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TradeDetail } from "@/lib/trade-detail";
import { formatUkDate } from "@/lib/uk-time";

function pct(v: number, digits = 2) {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}

function Row({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5 last:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right">
        <span
          className={`text-sm font-medium tabular-nums ${
            tone === "positive" ? "text-emerald-500" : tone === "negative" ? "text-destructive" : ""
          }`}
        >
          {value}
        </span>
        {hint ? <span className="block text-[11px] text-muted-foreground">{hint}</span> : null}
      </span>
    </div>
  );
}

export function TradeDetailDrawer({
  detail,
  symbol,
  open,
  onOpenChange,
}: {
  detail: TradeDetail | null;
  symbol?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Drawer open={open && detail != null} onOpenChange={onOpenChange}>
      <DrawerContent>
        {detail ? (
          <div className="mx-auto w-full max-w-lg">
            <DrawerHeader className="text-left">
              <DrawerTitle className="flex flex-wrap items-center gap-2 text-base">
                {symbol ? <span>{symbol}</span> : null}
                <span>{detail.title}</span>
                <Badge variant="outline" className="text-[10px] uppercase">
                  {detail.direction}
                </Badge>
              </DrawerTitle>
              <DrawerDescription>
                {detail.source} · {detail.outcome}
              </DrawerDescription>
            </DrawerHeader>

            <div className="max-h-[55vh] overflow-y-auto px-4 pb-2">
              <Row label="Entry" value={formatUkDate(detail.entryDate)} hint={detail.entryPrice.toFixed(2)} />
              <Row
                label={detail.open ? "Marked out" : "Exit"}
                value={formatUkDate(detail.exitDate)}
                hint={`${detail.exitPrice.toFixed(2)}${detail.open ? " · still open" : ""}`}
              />
              <Row label="Bars held" value={`${detail.bars}`} />
              <Row
                label="Gross return"
                value={pct(detail.grossReturn)}
                tone={detail.grossReturn >= 0 ? "positive" : "negative"}
                hint="price move, before costs"
              />
              <Row
                label="Net return"
                value={pct(detail.netReturn)}
                tone={detail.netReturn >= 0 ? "positive" : "negative"}
                hint="after round-trip friction"
              />
              <Row
                label="Cost drag"
                value={pct(-Math.abs(detail.frictionCost))}
                tone={detail.frictionCost > 0 ? "negative" : undefined}
              />
              <Row
                label="Invalidation"
                value={
                  detail.invalidationStatus === "broken"
                    ? "Broken"
                    : detail.invalidationStatus === "held"
                      ? "Held"
                      : "Not tracked"
                }
                tone={detail.invalidationStatus === "broken" ? "negative" : undefined}
                hint={
                  detail.invalidationLevel != null
                    ? `level ${detail.invalidationLevel.toFixed(2)}`
                    : undefined
                }
              />
              {detail.mfe != null ? (
                <Row
                  label="Best / worst while open"
                  value={`${pct(detail.mfe, 1)} / ${pct(-(detail.mae ?? 0), 1)}`}
                  hint="peak favourable vs adverse excursion"
                />
              ) : null}
              {detail.note ? (
                <p className="pt-3 text-[11px] text-muted-foreground">{detail.note}</p>
              ) : null}
            </div>

            <DrawerFooter className="pt-2">
              <DrawerClose asChild>
                <Button variant="outline" size="sm">
                  Close
                </Button>
              </DrawerClose>
            </DrawerFooter>
          </div>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}
