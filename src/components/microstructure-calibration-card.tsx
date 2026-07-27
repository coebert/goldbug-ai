import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  listMicrostructureCalibration,
  runMicrostructureCalibration,
} from "@/lib/execution-calibration-microstructure.functions";

function fmtNotional(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return n.toFixed(0);
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

/**
 * Displays per-symbol ADV, realised volatility, ATR and the derived
 * microstructure tuning (impact_coeff, vol widening coeff) that the trading
 * engine plugs into the spread-slippage model at order time.
 */
export function MicrostructureCalibrationCard() {
  const qc = useQueryClient();
  const listFn = useServerFn(listMicrostructureCalibration);
  const runFn = useServerFn(runMicrostructureCalibration);

  const q = useQuery({
    queryKey: ["microstructure-calibration"],
    queryFn: () => listFn({}),
  });

  const run = useMutation({
    mutationFn: () => runFn({ data: { window_days: 120 } }),
    onSuccess: (r) => {
      toast.success(
        `Calibrated ${r.persisted_count} symbols (skipped ${r.skipped.length})`,
      );
      qc.invalidateQueries({ queryKey: ["microstructure-calibration"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const rows = q.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Per-symbol execution calibration</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            ADV, realised vol and Corwin–Schultz spread are fitted from the
            last ~120 daily bars per symbol and used to tighten the market
            impact and ATR-based spread model at trade time.
          </p>
        </div>
        <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
          <Wand2 className="h-4 w-4 mr-1" />
          {run.isPending ? "Calibrating…" : "Recalibrate universe"}
        </Button>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No calibration rows yet — click <b>Recalibrate universe</b> to
            estimate ADV, volatility and spread for every symbol.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead className="text-right">ADV$ 20d</TableHead>
                  <TableHead className="text-right">Realised vol</TableHead>
                  <TableHead className="text-right">ATR%</TableHead>
                  <TableHead className="text-right">Spread</TableHead>
                  <TableHead className="text-right">Impact k</TableHead>
                  <TableHead className="text-right">Vol widen (bps/ATR)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.symbol}>
                    <TableCell className="font-mono">{r.symbol}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.asset_class}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {fmtNotional(r.adv_notional_20d)}
                    </TableCell>
                    <TableCell className="text-right">
                      {fmtPct(r.realized_vol_daily, 2)}
                    </TableCell>
                    <TableCell className="text-right">
                      {fmtPct(r.atr_pct_14d, 2)}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.half_spread_bps_est != null
                        ? `${(r.half_spread_bps_est * 2).toFixed(0)}bps`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.impact_coeff_est?.toFixed(1) ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.vol_widening_coeff_bps_est?.toFixed(0) ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
