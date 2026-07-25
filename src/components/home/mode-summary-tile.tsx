import { TrendingDown, TrendingUp } from "lucide-react";

/**
 * Mode summary tile — one for real-money, one for simulated. Locked
 * Intl.NumberFormat contract; see real-money-equity-formatting.contract
 * tests. Do NOT change fraction digits / grouping / rounding without
 * updating those tests in the same commit.
 */
export function ModeSummaryTile({
  label,
  sublabel,
  tone,
  money,
  pnl,
  pct,
  count,
}: {
  label: string;
  sublabel: string;
  tone: "sim" | "real";
  money: number;
  pnl: number;
  pct: number;
  count: number;
}) {
  const empty = count === 0;
  const safeMoney = Number.isFinite(money) ? (Object.is(money, -0) ? 0 : money) : 0;
  const safePnl = Number.isFinite(pnl) ? (Object.is(pnl, -0) ? 0 : pnl) : 0;
  const safePct = Number.isFinite(pct) ? (Object.is(pct, -0) ? 0 : pct) : 0;
  const borderTone = tone === "real" ? "border-emerald-500/50" : "border-cyan-500/40";
  const chipTone =
    tone === "real"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
      : "bg-cyan-500/15 text-cyan-300 border-cyan-500/40";
  return (
    <div className={`min-w-0 rounded-lg border ${borderTone} bg-card px-3 py-3 sm:px-4`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground sm:text-xs">{label}</div>
        <span className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase ${chipTone}`}>
          {tone === "real" ? "Real" : "Sim"}
        </span>
      </div>
      {empty ? (
        <div className="mt-1 text-sm text-muted-foreground">
          No {tone === "real" ? "real-money" : "simulated"} portfolios
        </div>
      ) : (
        <>
          <div className="mt-1 truncate text-base font-semibold tabular-nums sm:text-lg">
            {new Intl.NumberFormat(undefined, { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(safeMoney)}
          </div>
          <div className={`flex items-center gap-1 text-xs tabular-nums ${safePnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {safePnl >= 0 ? <TrendingUp className="h-3 w-3" aria-hidden="true" /> : <TrendingDown className="h-3 w-3" aria-hidden="true" />}
            <span>
              {safePnl >= 0 ? "+" : ""}
              {new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(safePct)}% ·{" "}
              {safePnl >= 0 ? "+" : ""}
              {new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(safePnl)}
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground">
            {sublabel} · {count} portfolio{count === 1 ? "" : "s"}
          </div>
        </>
      )}
    </div>
  );
}
