import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown } from "lucide-react";
import { getTodayMovers } from "@/lib/day-attribution.functions";

/**
 * Additive breakdown of the day's equity change: each position's move, the
 * FX funding legs (which never appear in the holdings list), trading costs
 * and whatever is left unexplained. Exists so a headline loss on a day of
 * across-the-board position gains reconciles instead of looking like a bug.
 */
export function WhatMovedToday() {
  const [open, setOpen] = useState(false);
  const fn = useServerFn(getTodayMovers);
  const query = useQuery({
    queryKey: ["today-movers", "live_prod"],
    queryFn: () => fn({ data: {} }),
    staleTime: 60_000,
  });

  const data = query.data;
  if (!data || data.portfolioCount === 0 || (!data.lines.length && !data.fees)) return null;

  const money = (n: number) =>
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: data.baseCurrency || "GBP",
      maximumFractionDigits: 2,
    }).format(Number.isFinite(n) ? (Object.is(n, -0) ? 0 : n) : 0);
  const signed = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`;
  const tone = (n: number) =>
    Math.abs(n) < 0.005 ? "text-muted-foreground" : n > 0 ? "text-success" : "text-destructive";

  const rows: Array<{ key: string; label: string; note: string; value: number }> = [
    ...data.lines
      .filter((l) => l.priced)
      .map((l) => ({
        key: l.symbol,
        label: l.symbol,
        note: l.kind === "fx"
          ? `fx leg · rate ${l.prevPrice?.toFixed(4)} → ${l.currPrice?.toFixed(4)}`
          : l.openedToday
            ? `bought today at ${l.prevPrice?.toFixed(2)} · now ${l.currPrice?.toFixed(2)}`
            : `${l.quantity} @ ${l.prevPrice?.toFixed(2)} → ${l.currPrice?.toFixed(2)}`,
        value: l.changeBase,
      })),
    ...(data.fees
      ? [{ key: "fees", label: "Trading costs", note: "commission and charges booked today", value: -data.fees }]
      : []),
    ...(data.netFlow
      ? [{ key: "flow", label: "Money in / out", note: "deposits and withdrawals", value: data.netFlow }]
      : []),
    ...(Math.abs(data.residual) >= 0.01
      ? [{
          key: "residual",
          label: "Not yet attributed",
          note: "spread, unreported charges, cash FX or snapshot timing",
          value: data.residual,
        }]
      : []),
  ];

  return (
    <div className="mt-3" data-testid="what-moved-today">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-md text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        <ChevronDown
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
        What moved today ({signed(data.totalChange)})
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-border/60 bg-surface-sunken p-2.5">
          <ul className="space-y-1.5" data-testid="what-moved-today-list">
            {rows.map((r) => (
              <li
                key={r.key}
                className="flex items-baseline justify-between gap-3 text-[11px]"
                data-testid={`moved-${r.key}`}
              >
                <span className="min-w-0">
                  <span className="font-medium text-foreground">{r.label}</span>{" "}
                  <span className="text-muted-foreground">{r.note}</span>
                </span>
                <span className={`shrink-0 tabular-nums font-semibold ${tone(r.value)}`}>
                  {signed(r.value)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-border/60 pt-2 text-[11px]">
            <span className="text-muted-foreground">
              Change since {data.prevDate ?? "the last snapshot"}
            </span>
            <span className={`tabular-nums font-semibold ${tone(data.totalChange)}`}>
              {signed(data.totalChange)}
            </span>
          </div>
          {data.unpricedCount > 0 && (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              {data.unpricedCount} holding{data.unpricedCount === 1 ? "" : "s"} could not be priced
              on both days and sit inside the unattributed line.
            </p>
          )}
          {data.warnings.map((w) => (
            <p key={w} className="mt-1.5 text-[10px] text-amber-500">
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
