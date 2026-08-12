import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Loader2, TrendingDown } from "lucide-react";
import { manualSellHolding } from "@/lib/manual-sell.functions";
import { toast } from "sonner";

type Props = {
  holding: {
    id: string;
    symbol: string;
    quantity: number;
    asset_class?: string | null;
    instrument_ccy?: string | null;
  };
  mode: string;
  /** Pre-selected sell size, e.g. a suggested concentration trim. */
  initialPercent?: number;
  onClose: () => void;
  onSold?: () => void;
};

const QUICK = [25, 50, 75, 100];

export function HoldingSellDialog({ holding, mode, initialPercent, onClose, onSold }: Props) {
  const [percent, setPercent] = useState(() =>
    initialPercent != null && Number.isFinite(initialPercent)
      ? Math.min(100, Math.max(1, Math.round(initialPercent)))
      : 25,
  );
  const qc = useQueryClient();
  const sellFn = useServerFn(manualSellHolding);

  const isFractional =
    holding.asset_class === "crypto" || holding.asset_class === "fx";
  const rawQty = holding.quantity * (percent / 100);
  const previewQty =
    percent >= 100
      ? holding.quantity
      : isFractional
        ? Math.floor(rawQty * 1e6) / 1e6
        : Math.floor(rawQty);

  const mut = useMutation({
    mutationFn: async () => sellFn({ data: { holdingId: holding.id, percent } }),
    onSuccess: (res) => {
      const detail =
        res.status === "filled"
          ? `Filled ${res.qty} ${holding.symbol}`
          : `Order ${res.status} for ${res.qty} ${holding.symbol}`;
      toast.success("Sell submitted", { description: detail });
      qc.invalidateQueries();
      onSold?.();
      onClose();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Manual sell failed.";
      toast.error("Sell failed", { description: msg });
    },
  });

  const isLive = mode === "live_sim" || mode === "live_prod";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4" /> Sell {holding.symbol}
          </DialogTitle>
          <DialogDescription>
            Liquidate a percent of your position. Orders never exceed the units
            you hold and cannot open a short.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <div className="mb-1 flex items-baseline justify-between text-xs text-muted-foreground">
              <span>Percent to sell</span>
              <span className="font-semibold text-foreground tabular-nums">
                {percent}%
              </span>
            </div>
            <Slider
              value={[percent]}
              min={1}
              max={100}
              step={1}
              onValueChange={(v) => setPercent(v[0] ?? 1)}
              disabled={mut.isPending}
            />
            <div className="mt-2 flex gap-1.5">
              {QUICK.map((q) => (
                <Button
                  key={q}
                  size="sm"
                  variant={percent === q ? "default" : "outline"}
                  className="h-7 px-2 text-xs"
                  onClick={() => setPercent(q)}
                  disabled={mut.isPending}
                >
                  {q}%
                </Button>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-border/60 bg-muted/40 p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Units held</span>
              <span className="tabular-nums">
                {holding.quantity.toLocaleString(undefined, {
                  maximumFractionDigits: 6,
                })}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-muted-foreground">Units to sell</span>
              <span className="font-semibold tabular-nums">
                {previewQty.toLocaleString(undefined, {
                  maximumFractionDigits: 6,
                })}
              </span>
            </div>
            {previewQty <= 0 && (
              <p className="mt-2 text-[11px] text-amber-500">
                This percent rounds down to zero sellable units — pick a larger
                percent.
              </p>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground">
            {isLive
              ? "Sends a market SELL to your broker. Fill price and status are confirmed by the next reconciliation cycle."
              : "Applies a simulated sell using the latest close and the app's execution-realism spread/slippage model."}
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={mut.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => mut.mutate()}
            disabled={mut.isPending || previewQty <= 0}
          >
            {mut.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Sell {previewQty > 0 ? previewQty.toLocaleString(undefined, { maximumFractionDigits: 6 }) : ""} {holding.symbol}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
