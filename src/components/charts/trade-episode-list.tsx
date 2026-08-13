// Trade list panel: one row per position episode, clickable to spotlight the
// matching holding-period band on the chart.
//
// The charts answer "what happened to equity"; this answers "which trades did
// it". Rows carry entry/exit, side, size, realised P&L and duration, and
// selecting one lifts the corresponding `ReferenceArea` band (see
// `renderEpisodeBands({ selectedKey })`) while fading the rest.

import { useMemo, useState } from "react";

import { formatHoldingDuration, type EpisodeBand } from "@/lib/trade-episodes";
import { episodeBandHue } from "@/components/charts/trade-episode-bands";
import { cn } from "@/lib/utils";

type SortKey = "open" | "pnl" | "days" | "symbol";

export type TradeEpisodeListProps = {
  bands: readonly EpisodeBand[];
  /** Currently spotlighted band key, or null for "no selection". */
  selectedKey: string | null;
  /** Called with the row's key, or null when the row is toggled off. */
  onSelect: (key: string | null) => void;
  /** Money formatter for P&L and prices (trade currency). */
  money: (v: number) => string;
  /** Rows shown before the "show all" toggle. */
  initialRows?: number;
  className?: string;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const s = String(iso);
  const t = Date.parse(s.length <= 10 ? `${s}T00:00:00Z` : s);
  if (!Number.isFinite(t)) return s.slice(0, 10);
  return new Date(t).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    timeZone: "Europe/London",
  });
}

function fmtQty(q: number): string {
  if (!Number.isFinite(q) || q === 0) return "—";
  return q >= 100 ? q.toFixed(0) : q.toFixed(q < 1 ? 4 : 2);
}

export function TradeEpisodeList({
  bands,
  selectedKey,
  onSelect,
  money,
  initialRows = 8,
  className,
}: TradeEpisodeListProps) {
  const [sort, setSort] = useState<SortKey>("open");
  const [desc, setDesc] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const list = [...bands];
    list.sort((a, b) => {
      const ea = a.episode;
      const eb = b.episode;
      let d = 0;
      if (sort === "open") d = ea.openMs - eb.openMs;
      else if (sort === "days") d = ea.days - eb.days;
      else if (sort === "symbol") d = ea.symbol.localeCompare(eb.symbol);
      else d = (ea.realized ?? Number.NEGATIVE_INFINITY) - (eb.realized ?? Number.NEGATIVE_INFINITY);
      return desc ? -d : d;
    });
    return list;
  }, [bands, sort, desc]);

  const visible = showAll ? rows : rows.slice(0, initialRows);

  const toggleSort = (key: SortKey) => {
    if (key === sort) setDesc((v) => !v);
    else {
      setSort(key);
      setDesc(key !== "symbol");
    }
  };

  if (bands.length === 0) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        No completed or open positions in this window.
      </p>
    );
  }

  const Th = ({ label, k, align = "left" }: { label: string; k?: SortKey; align?: "left" | "right" }) => (
    <th
      scope="col"
      className={cn(
        "py-1 font-medium text-muted-foreground",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {k ? (
        <button
          type="button"
          onClick={() => toggleSort(k)}
          className="hover:text-foreground transition-colors"
          aria-label={`Sort by ${label}`}
        >
          {label}
          {sort === k ? <span aria-hidden>{desc ? " ↓" : " ↑"}</span> : null}
        </button>
      ) : (
        label
      )}
    </th>
  );

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {bands.length} position{bands.length === 1 ? "" : "s"} · tap a row to highlight it on the
          chart
        </p>
        {selectedKey ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Clear highlight
          </button>
        ) : null}
      </div>

      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-[11px] tabular-nums">
          <thead>
            <tr className="border-b border-border/60">
              <Th label="Symbol" k="symbol" />
              <Th label="Side" />
              <Th label="Entry" k="open" />
              <Th label="Exit" />
              <Th label="Size" align="right" />
              <Th label="P&L" k="pnl" align="right" />
              <Th label="Held" k="days" align="right" />
            </tr>
          </thead>
          <tbody>
            {visible.map((b) => {
              const ep = b.episode;
              const selected = b.key === selectedKey;
              const pnl = ep.realized;
              return (
                <tr
                  key={b.key}
                  tabIndex={0}
                  role="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(selected ? null : b.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(selected ? null : b.key);
                    }
                  }}
                  className={cn(
                    "cursor-pointer border-b border-border/30 transition-colors outline-none",
                    selected ? "bg-muted/70 text-foreground" : "hover:bg-muted/40",
                    "focus-visible:ring-1 focus-visible:ring-ring",
                  )}
                >
                  <td className="py-1.5 pr-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                        style={{
                          backgroundColor: `hsl(${episodeBandHue(ep.symbol)} 80% 60% / ${selected ? 0.95 : 0.45})`,
                        }}
                      />
                      <span className="font-medium">{ep.symbol}</span>
                    </span>
                  </td>
                  <td className="py-1.5 pr-2">
                    <span
                      className={cn(
                        "rounded px-1 py-0.5 text-[10px] uppercase tracking-wide",
                        ep.side === "short"
                          ? "bg-destructive/15 text-destructive"
                          : "bg-primary/15 text-primary",
                      )}
                    >
                      {ep.side}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 text-muted-foreground">
                    {fmtDate(ep.openAt)}
                    {ep.avgBuy > 0 ? (
                      <span className="ml-1 opacity-70">@{money(ep.avgBuy)}</span>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-2 text-muted-foreground">
                    {ep.open ? (
                      <span className="text-foreground/70">open</span>
                    ) : (
                      <>
                        {fmtDate(ep.closeAt)}
                        {ep.avgSell != null ? (
                          <span className="ml-1 opacity-70">@{money(ep.avgSell)}</span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right">{fmtQty(ep.peakQuantity)}</td>
                  <td
                    className={cn(
                      "py-1.5 pr-2 text-right font-medium",
                      pnl == null
                        ? "text-muted-foreground"
                        : pnl >= 0
                          ? "text-primary"
                          : "text-destructive",
                    )}
                  >
                    {pnl == null ? "—" : `${pnl >= 0 ? "+" : "−"}${money(Math.abs(pnl))}`}
                  </td>
                  <td className="py-1.5 text-right text-muted-foreground">
                    {formatHoldingDuration(ep.days)}
                    {ep.open ? <span aria-hidden> …</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rows.length > initialRows ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {showAll ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}
