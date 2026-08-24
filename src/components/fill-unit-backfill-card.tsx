// Admin card for the fill-unit backfill.
//
// Shows how many stored fills are recorded in the wrong unit (LSE pence
// booked as pounds, or the reverse) and lets the repair be previewed before
// it rewrites `live_fills`, the trades ledger and historical equity
// snapshots.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Ruler, RefreshCw, AlertTriangle, ShieldCheck, Wrench } from "lucide-react";
import {
  previewFillUnitBackfill,
  applyFillUnitBackfill,
  type FillUnitBackfillResult,
} from "@/lib/fill-unit-backfill.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const ACTION_LABEL: Record<string, string> = {
  fold_gbx: "Pence booked as pounds (÷100)",
  unfold_gbx: "Pounds booked as pence (×100)",
  unexplained: "Unexplained gap vs close",
  no_reference: "No reference close",
  ok: "Consistent",
};

/** Snapshot of the two verification passes either side of a repair. */
type BeforeAfter = {
  before: FillUnitBackfillResult;
  after: FillUnitBackfillResult;
  updated: number;
  recompute: FillUnitBackfillResult["recompute"];
  errors: FillUnitBackfillResult["updateErrors"];
};

const problemCount = (r: FillUnitBackfillResult) =>
  r.changes.filter((c) => c.action === "fold_gbx" || c.action === "unfold_gbx").length;

export function FillUnitBackfillCard() {
  const preview = useServerFn(previewFillUnitBackfill);
  const apply = useServerFn(applyFillUnitBackfill);
  const [result, setResult] = useState<FillUnitBackfillResult | null>(null);
  const [applied, setApplied] = useState(false);
  const [comparison, setComparison] = useState<BeforeAfter | null>(null);

  const previewM = useMutation({
    mutationFn: () => preview({ data: {} }),
    onSuccess: (r) => {
      setResult(r);
      setApplied(false);
      setComparison(null);
      toast.success(
        r.changes.length === 0
          ? "All stored fills are in the expected unit."
          : `${r.changes.length} fill${r.changes.length === 1 ? "" : "s"} need correcting.`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // One click: verify, repair, then re-verify so the card can show what
  // actually changed rather than only what was planned.
  const repairNowM = useMutation({
    mutationFn: async (): Promise<BeforeAfter | null> => {
      const before = await preview({ data: {} });
      if (before.changes.length === 0) {
        setResult(before);
        setApplied(false);
        setComparison(null);
        return null;
      }
      const run = await apply({ data: {} });
      const after = await preview({ data: {} });
      return {
        before,
        after,
        updated: run.updated,
        recompute: run.recompute,
        errors: run.updateErrors,
      };
    },
    onSuccess: (c) => {
      if (!c) {
        toast.success("Nothing to repair — all stored fills are in the expected unit.");
        return;
      }
      setComparison(c);
      setResult(c.after);
      setApplied(true);
      const left = problemCount(c.after);
      toast.success(
        left === 0
          ? `Repaired ${c.updated} fill${c.updated === 1 ? "" : "s"} and recomputed history.`
          : `Repaired ${c.updated}, but ${left} still look mis-scaled.`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const applyM = useMutation({
    mutationFn: () => apply({ data: {} }),
    onSuccess: (r) => {
      setResult(r);
      setApplied(true);
      setComparison(null);
      toast.success(`Corrected ${r.updated} fill${r.updated === 1 ? "" : "s"} and recomputed history.`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const counts = result?.counts;
  const pending = result ? result.changes.length : 0;
  const busy = previewM.isPending || applyM.isPending || repairNowM.isPending;


  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            {pending > 0 && !applied ? (
              <AlertTriangle className="h-4 w-4 text-destructive" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-primary" />
            )}
            Fill unit integrity
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Detects fills stored in pence where pounds are expected (and the reverse), which
            distorts realised P&amp;L and trading-cost figures.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => previewM.mutate()}>
            {previewM.isPending ? (
              <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Ruler className="mr-1 h-3.5 w-3.5" />
            )}
            Check
          </Button>
          {pending > 0 && !applied && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => applyM.mutate()}
            >
              Repair
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => repairNowM.mutate()}>
            {repairNowM.isPending ? (
              <RefreshCw className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wrench className="mr-1 h-3.5 w-3.5" />
            )}
            Repair now
          </Button>
        </div>

      </CardHeader>
      <CardContent className="space-y-3">
        {!result ? (
          <p className="text-sm text-muted-foreground">Run a check to see stored-fill units.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary">{result.fillsScanned} scanned</Badge>
              {counts &&
                Object.entries(counts)
                  .filter(([, n]) => n > 0)
                  .map(([k, n]) => (
                    <Badge key={k} variant={k === "ok" ? "secondary" : "destructive"}>
                      {ACTION_LABEL[k] ?? k}: {n}
                    </Badge>
                  ))}
              {applied && <Badge>{result.updated} corrected</Badge>}
            </div>

            {comparison && (
              <div className="rounded-md border border-border/60 bg-muted/30 p-3">
                <p className="mb-2 text-xs font-medium">Before / after</p>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="text-muted-foreground">Metric</div>
                  <div className="text-right text-muted-foreground">Before</div>
                  <div className="text-right text-muted-foreground">After</div>

                  <div>Mis-scaled fills</div>
                  <div className="text-right tabular-nums text-destructive">
                    {problemCount(comparison.before)}
                  </div>
                  <div className="text-right tabular-nums text-primary">
                    {problemCount(comparison.after)}
                  </div>

                  <div>Flagged rows</div>
                  <div className="text-right tabular-nums">{comparison.before.changes.length}</div>
                  <div className="text-right tabular-nums">{comparison.after.changes.length}</div>

                  <div>Fills scanned</div>
                  <div className="text-right tabular-nums">{comparison.before.fillsScanned}</div>
                  <div className="text-right tabular-nums">{comparison.after.fillsScanned}</div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {comparison.updated} fill{comparison.updated === 1 ? "" : "s"} rewritten
                  {comparison.recompute.length > 0 && (
                    <>
                      {" "}
                      · {comparison.recompute.reduce((a, r) => a + (r.tradesRebuilt ?? 0), 0)} trades
                      rebuilt ·{" "}
                      {comparison.recompute.reduce((a, r) => a + (r.snapshotsRewritten ?? 0), 0)}{" "}
                      equity snapshots revalued
                    </>
                  )}
                </p>
                {comparison.errors.length > 0 && (
                  <p className="mt-1 text-xs text-destructive">
                    {comparison.errors.length} row
                    {comparison.errors.length === 1 ? "" : "s"} could not be rewritten:{" "}
                    {comparison.errors[0]?.message}
                  </p>
                )}
              </div>
            )}



            {result.changes.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-1 pr-3">Symbol</th>
                      <th className="py-1 pr-3">Issue</th>
                      <th className="py-1 pr-3 text-right">Stored</th>
                      <th className="py-1 text-right">Corrected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.changes.slice(0, 25).map((c) => (
                      <tr key={c.id} className="border-t border-border/50">
                        <td className="py-1 pr-3 font-medium">{c.symbol}</td>
                        <td className="py-1 pr-3 text-muted-foreground">
                          {ACTION_LABEL[c.action] ?? c.action}
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums">{c.storedPrice}</td>
                        <td className="py-1 text-right tabular-nums">{c.correctedPrice}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result.recompute.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Recomputed {result.recompute.length} portfolio
                {result.recompute.length === 1 ? "" : "s"}: trades rebuilt and equity snapshots
                revalued from the corrected fills.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
