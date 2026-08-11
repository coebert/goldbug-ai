import { useState } from "react";
import type { FrictionBreakdown, FrictionBreakdownRow } from "@/lib/friction-kpi";
import { formatMoney } from "@/lib/format-money";

const VENUE_NAMES: Record<string, string> = {
  XLON: "London",
  XETR: "Frankfurt",
  XPAR: "Paris",
  XAMS: "Amsterdam",
  XMIL: "Milan",
  XSWX: "Zurich",
  XMAD: "Madrid",
  XSTO: "Stockholm",
  XCSE: "Copenhagen",
  XOSL: "Oslo",
  XHEL: "Helsinki",
  XTSE: "Toronto",
  XHKG: "Hong Kong",
  XTKS: "Tokyo",
  XASX: "Sydney",
  XNAS: "Nasdaq",
  XNYS: "New York",
  ARCX: "NYSE Arca",
  BATS: "Cboe US",
  CRYPTO: "Crypto",
  US: "US markets",
  UNKNOWN: "Unknown",
  Other: "Everything else",
};

function label(by: "asset" | "venue", key: string): string {
  if (by !== "venue") return key;
  return VENUE_NAMES[key] ?? key;
}

function ratioText(row: FrictionBreakdownRow): string {
  if (row.realisedRatio == null) return "estimated";
  return `${row.realisedRatio.toFixed(2)}x model`;
}

/**
 * Where the money actually went: each asset or venue's charged cost split into
 * broker charges, the buy/sell gap, and stamp duty — next to what the model
 * said it should have cost, so an expensive venue is visible rather than
 * averaged away in the headline number.
 */
export function FrictionCostDrilldown({
  byAsset,
  byVenue,
  currency,
}: {
  byAsset: FrictionBreakdown;
  byVenue: FrictionBreakdown;
  currency: string;
}) {
  const [by, setBy] = useState<"asset" | "venue">("venue");
  const table = by === "venue" ? byVenue : byAsset;

  if (table.rows.length === 0) return null;

  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Where the costs came from</p>
        <div className="flex gap-1" role="group" aria-label="Group costs by">
          {(["venue", "asset"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setBy(k)}
              aria-pressed={by === k}
              className={`rounded px-2 py-0.5 text-xs capitalize transition-colors ${
                by === k ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {k === "venue" ? "By market" : "By holding"}
            </button>
          ))}
        </div>
      </div>

      <div className="-mx-3 overflow-x-auto px-3">
        <table className="w-full min-w-[34rem] text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col" className="py-1 text-left font-normal">
                {by === "venue" ? "Market" : "Holding"}
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                Broker charges
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                Buy/sell gap
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                Stamp duty
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                Total
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                vs estimate
              </th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.key} className="border-t border-border/40">
                <th scope="row" className="py-1 text-left font-normal">
                  <span className="block">{label(table.by, row.key)}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {row.tickets} trade{row.tickets === 1 ? "" : "s"} ·{" "}
                    {row.chargedBpsOfTurnover == null
                      ? "—"
                      : `${row.chargedBpsOfTurnover.toFixed(1)}bps of traded value`}
                  </span>
                </th>
                <td className="py-1 text-right tabular-nums">
                  {formatMoney(row.components.commissionBase, currency, 2)}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {formatMoney(row.components.spreadBase, currency, 2)}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {formatMoney(row.components.taxBase, currency, 2)}
                </td>
                <td className="py-1 text-right font-medium tabular-nums">
                  {formatMoney(row.chargedBase, currency, 2)}
                </td>
                <td className="py-1 text-right tabular-nums text-muted-foreground">
                  {ratioText(row)}
                </td>
              </tr>
            ))}
            <tr className="border-t border-border">
              <th scope="row" className="py-1 text-left font-medium">
                All trades
              </th>
              <td className="py-1 text-right tabular-nums">
                {formatMoney(table.totals.components.commissionBase, currency, 2)}
              </td>
              <td className="py-1 text-right tabular-nums">
                {formatMoney(table.totals.components.spreadBase, currency, 2)}
              </td>
              <td className="py-1 text-right tabular-nums">
                {formatMoney(table.totals.components.taxBase, currency, 2)}
              </td>
              <td className="py-1 text-right font-medium tabular-nums">
                {formatMoney(table.totals.chargedBase, currency, 2)}
              </td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">
                {ratioText(table.totals)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Rows marked “estimated” have no broker invoice yet, so their cost is our own model. Where a
        bill exists, the multiple shows how the real charge compared with it — the model estimated{" "}
        {formatMoney(table.totals.modelledBase, currency, 2)} in total.
      </p>
    </div>
  );
}
