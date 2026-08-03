import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { calibrateExecution } from "@/lib/trading.functions";
import { toast } from "sonner";
import { Wand2 } from "lucide-react";
import { qk } from "@/lib/query-keys";

type CalibrationMeta = {
  as_of: string;
  window_days: number;
  n_symbols: number;
  notes: string[];
} | null;

type ExecParams = {
  slippage_bps?: number;
  commission_bps?: number;
  spread_atr_frac?: number;
  adv_participation?: number;
  min_trade_value?: number;
} | null;

export function ExecutionCalibrationCard({
  portfolioId,
  execParams,
  calibration,
}: {
  portfolioId: string;
  execParams: ExecParams;
  calibration: CalibrationMeta;
}) {
  const qc = useQueryClient();
  const [windowDays, setWindowDays] = useState(90);
  const runFn = useServerFn(calibrateExecution);
  const [preview, setPreview] = useState<null | {
    slippage_bps: number;
    commission_bps: number;
    spread_atr_frac: number;
  }>(null);

  const m = useMutation({
    mutationFn: (apply: boolean) =>
      runFn({ data: { portfolio_id: portfolioId, window_days: windowDays, apply } }),
    onSuccess: (res, apply) => {
      setPreview({
        slippage_bps: res.recommended.slippage_bps,
        commission_bps: res.recommended.commission_bps,
        spread_atr_frac: res.recommended.spread_atr_frac,
      });
      if (apply) {
        toast.success("Calibrated execution model updated");
        qc.invalidateQueries({ queryKey: qk.portfolio.detail(portfolioId) });
      } else {
        toast.message("Preview ready — click Apply to save.");
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const rows: Array<{ label: string; current: string; recommended: string | null; help: string }> = [
    {
      label: "Slippage (per side)",
      current: `${(execParams?.slippage_bps ?? 8).toFixed(1)} bps`,
      recommended: preview ? `${preview.slippage_bps.toFixed(1)} bps` : null,
      help: "Half of estimated spread + 5% of ATR, floored per asset class.",
    },
    {
      label: "Commission (per side)",
      current: `${(execParams?.commission_bps ?? 5).toFixed(1)} bps`,
      recommended: preview ? `${preview.commission_bps.toFixed(1)} bps` : null,
      help: "Asset-class floor: stock/ETF 3, crypto 15, commodity 5, fx 2.",
    },
    {
      label: "Half-spread as fraction of ATR",
      current: `${((execParams?.spread_atr_frac ?? 0.25) * 100).toFixed(1)}%`,
      recommended: preview ? `${(preview.spread_atr_frac * 100).toFixed(1)}%` : null,
      help: "Corwin-Schultz spread ÷ 2 ÷ 14d ATR, median across the universe.",
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Wand2 className="h-4 w-4" /> Execution calibration
          {calibration && (
            <Badge variant="secondary" className="ml-2 font-normal">
              Last: {calibration.as_of}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-xs text-muted-foreground">
          Scans recent OHLCV for every symbol in this portfolio's universe and estimates realistic
          spread, slippage, and commission. The engine uses these numbers on every simulated fill.
        </p>

        <div className="flex items-end gap-3">
          <label className="text-xs flex flex-col">
            <span className="text-muted-foreground mb-1">Lookback (days)</span>
            <select
              className="border rounded px-2 py-1 bg-background text-sm"
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
              disabled={m.isPending}
            >
              {[30, 60, 90, 180, 365].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <Button variant="secondary" size="sm" onClick={() => m.mutate(false)} disabled={m.isPending}>
            {m.isPending ? "Estimating…" : "Preview"}
          </Button>
          <Button size="sm" onClick={() => m.mutate(true)} disabled={m.isPending}>
            Apply calibration
          </Button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left py-1">Parameter</th>
                <th className="text-right px-2">Current</th>
                <th className="text-right px-2">Recommended</th>
                <th className="text-left pl-3">How it's estimated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t border-border/40">
                  <td className="py-1 pr-2">{r.label}</td>
                  <td className="text-right px-2 font-mono">{r.current}</td>
                  <td className="text-right px-2 font-mono">
                    {r.recommended ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="pl-3 text-muted-foreground">{r.help}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {(calibration?.notes.length ?? 0) > 0 && (
          <div className="rounded border border-border/50 bg-muted/30 p-2 text-xs">
            <div className="font-medium mb-1">Last calibration notes</div>
            <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
              {calibration!.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
