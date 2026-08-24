// Admin card: re-run the broker charge sync for fills whose fee is still zero,
// and list exactly which fills the broker report repaired.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Receipt, RefreshCw, ShieldCheck, AlertTriangle } from "lucide-react";
import { resyncZeroFeeFillsFn } from "@/lib/zero-fee-resync.functions";
import type { ZeroFeeResyncResult } from "@/lib/zero-fee-resync.server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const money = (v: number, ccy: string) => {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: ccy || "GBP",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `${v.toFixed(2)} ${ccy}`;
  }
};

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "short", timeStyle: "short" });
};

export function ZeroFeeResyncCard() {
  const run = useServerFn(resyncZeroFeeFillsFn);
  const [result, setResult] = useState<ZeroFeeResyncResult | null>(null);

  const resync = useMutation({
    mutationFn: () => run({ data: {} }),
    onSuccess: (r: ZeroFeeResyncResult) => {
      setResult(r);
      if (r.zeroFeeBefore === 0) toast.success("No zero-fee fills to repair.");
      else if (r.updatedFills.length === 0)
        toast.warning("Broker returned no charges for the zero-fee fills.");
      else
        toast.success(
          `${r.updatedFills.length} fill${r.updatedFills.length === 1 ? "" : "s"} updated from the broker invoice.`,
        );
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Charge re-sync failed"),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-4 w-4 text-muted-foreground" />
          Zero-fee charge re-sync
        </CardTitle>
        <Button size="sm" onClick={() => resync.mutate()} disabled={resync.isPending}>
          <RefreshCw className={`mr-2 h-4 w-4 ${resync.isPending ? "animate-spin" : ""}`} />
          {resync.isPending ? "Syncing…" : "Re-sync charges"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Re-pulls the broker's booked charges for trades still recorded with no fee, then reports
          every fill that changed. Safe to run repeatedly — charges are matched, not added.
        </p>

        {result && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Zero-fee before" value={String(result.zeroFeeBefore)} />
              <Stat label="Zero-fee after" value={String(result.zeroFeeAfter)} />
              <Stat label="Fills updated" value={String(result.updatedFills.length)} />
              <Stat label="Charged" value={money(result.totalCharged, "GBP")} />
            </div>

            {result.portfolios.some((p) => p.skipped) && (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {result.portfolios
                  .filter((p) => p.skipped)
                  .map((p) => (
                    <li key={p.portfolioId} className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span>
                        {p.name}: {p.skipped}
                      </span>
                    </li>
                  ))}
              </ul>
            )}

            {result.updatedFills.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-xs">
                  <thead className="text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-1 text-left font-medium">Fill</th>
                      <th className="py-1 text-left font-medium">Filled</th>
                      <th className="py-1 text-right font-medium">Fee before</th>
                      <th className="py-1 text-right font-medium">Fee after</th>
                      <th className="py-1 text-left font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.updatedFills.map((f) => (
                      <tr key={f.fillId} className="border-b last:border-0">
                        <td className="py-1">
                          <span className="font-medium">{f.symbol}</span>{" "}
                          <span className="text-muted-foreground">
                            {f.side} {f.quantity}
                          </span>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {f.fillId.slice(0, 8)}
                          </div>
                        </td>
                        <td className="py-1 text-muted-foreground">{when(f.filledAt)}</td>
                        <td className="py-1 text-right tabular-nums">
                          {money(f.feeBefore, f.currency)}
                        </td>
                        <td className="py-1 text-right tabular-nums">
                          {money(f.feeAfter, f.currency)}
                        </td>
                        <td className="py-1">
                          <Badge variant="secondary">{f.feeSourceAfter ?? "—"}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" />
                No fills changed in this pass.
              </p>
            )}

            {result.unchangedFills.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {result.unchangedFills.length} zero-fee fill
                {result.unchangedFills.length === 1 ? "" : "s"} still uninvoiced
                {result.unchangedFills[0]?.reason ? ` (${result.unchangedFills[0].reason})` : ""}.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}
