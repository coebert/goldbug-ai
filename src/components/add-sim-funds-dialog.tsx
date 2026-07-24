import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { addSimFunds } from "@/lib/trading.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function fmt(currency: string, n: number) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

export function AddSimFundsDialog({
  open,
  onOpenChange,
  portfolioId,
  portfolioName,
  currency,
  currentCash,
  startingCash,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  portfolioId: string;
  portfolioName: string;
  currency: string;
  currentCash: number;
  startingCash: number;
  onAdded?: (amount: number) => void;
}) {
  const [amount, setAmount] = useState<string>("");
  const addFn = useServerFn(addSimFunds);
  const qc = useQueryClient();

  useEffect(() => {
    if (open) setAmount("");
  }, [open]);

  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000;

  const mut = useMutation({
    mutationFn: (n: number) => addFn({ data: { id: portfolioId, amount: n } }),
    onSuccess: () => {
      toast.success(`Added ${fmt(currency, parsed)} to ${portfolioName}`);
      qc.invalidateQueries({ queryKey: ["portfolios"] });
      qc.invalidateQueries({ queryKey: ["portfolio", portfolioId] });
      onAdded?.(parsed);
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to add funds"),
  });

  const presets = [100, 500, 1000, 5000];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add simulated funds</DialogTitle>
          <DialogDescription>
            Top up virtual cash in <span className="font-medium">{portfolioName}</span>. This is play money — no real
            transfer occurs.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !mut.isPending) mut.mutate(parsed);
          }}
          className="space-y-4"
        >
          <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Cash available</span><span className="font-medium">{fmt(currency, currentCash)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Total capital</span><span className="font-medium">{fmt(currency, startingCash)}</span></div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-amount">Amount to add ({currency})</Label>
            <Input
              id="add-amount"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
              placeholder="e.g. 500"
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {presets.map((p) => (
                <Button key={p} type="button" size="sm" variant="outline" onClick={() => setAmount(String(p))}>
                  +{fmt(currency, p)}
                </Button>
              ))}
            </div>
          </div>

          {valid && (
            <div className="rounded-md border p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">New cash available</span><span className="font-medium">{fmt(currency, currentCash + parsed)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">New total capital</span><span className="font-medium">{fmt(currency, startingCash + parsed)}</span></div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={mut.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || mut.isPending}>
              {mut.isPending ? "Adding…" : "Add funds"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
