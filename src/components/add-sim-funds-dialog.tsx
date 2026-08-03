import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
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
import { qk } from "@/lib/query-keys";

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
  holdingsValue = 0,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  portfolioId: string;
  portfolioName: string;
  currency: string;
  currentCash: number;
  startingCash: number;
  holdingsValue?: number;
  onAdded?: (amount: number) => void;
}) {
  const [amount, setAmount] = useState<string>("");
  const [addedAmount, setAddedAmount] = useState<number | null>(null);
  const addFn = useServerFn(addSimFunds);
  const qc = useQueryClient();

  useEffect(() => {
    if (open) {
      setAmount("");
      setAddedAmount(null);
    }
  }, [open]);

  const trimmed = amount.trim();
  const parsed = Number(trimmed);
  const isNumber = trimmed !== "" && Number.isFinite(parsed);
  let error: string | null = null;
  if (trimmed === "") error = null;
  else if (!isNumber) error = "Enter a valid number";
  else if (parsed <= 0) error = "Amount must be greater than zero";
  else if (parsed < 1) error = `Minimum top-up is ${fmt(currency, 1)}`;
  else if (parsed > 1_000_000) error = `Maximum top-up is ${fmt(currency, 1_000_000)}`;
  else if (Math.round(parsed * 100) !== parsed * 100) error = "Use at most 2 decimal places";
  const valid = isNumber && error === null && parsed > 0;

  const mut = useMutation({
    mutationFn: (n: number) => addFn({ data: { id: portfolioId, amount: n } }),
    onSuccess: async (_res, n) => {
      toast.success(`Added ${fmt(currency, n)} to ${portfolioName}`);
      setAddedAmount(n);
      onAdded?.(n);
      await Promise.all([
        qc.refetchQueries({ queryKey: qk.portfolios.all(), type: "active" }),
        qc.refetchQueries({ queryKey: qk.portfolio.detail(portfolioId), type: "active" }),
        qc.refetchQueries({ queryKey: ["sim-fund-events", portfolioId], type: "active" }),
        qc.refetchQueries({ queryKey: qk.portfolios.equity(), type: "active" }),
      ]);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to add funds"),
  });

  const presets = [100, 250, 500, 1000];

  const newStarting = startingCash + (addedAmount ?? 0);
  const newCurrent = currentCash + (addedAmount ?? 0);
  const newEquity = newCurrent + holdingsValue;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {addedAmount !== null ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                Added {fmt(currency, addedAmount)}
              </DialogTitle>
              <DialogDescription>
                Cash breakdown for <span className="font-medium">{portfolioName}</span> after this top-up.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <div className="rounded-md border p-3 text-sm space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Starting cash</span>
                  <span className="tabular-nums font-medium">{fmt(currency, newStarting)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Current cash</span>
                  <span className="tabular-nums font-medium">{fmt(currency, newCurrent)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Holdings value</span>
                  <span className="tabular-nums font-medium">{fmt(currency, holdingsValue)}</span>
                </div>
                <div className="flex items-center justify-between border-t pt-2">
                  <span className="font-medium">Total equity</span>
                  <span className="tabular-nums font-semibold">{fmt(currency, newEquity)}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Starting cash tracks lifetime deposits; total equity = current cash + holdings value.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddedAmount(null)}>
                Add more
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
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
                  min="1"
                  max="1000000"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  autoFocus
                  placeholder="e.g. 250"
                  aria-invalid={!!error}
                  aria-describedby={error ? "add-amount-error" : "add-amount-help"}
                />
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {presets.map((p) => (
                    <Button
                      key={p}
                      type="button"
                      size="sm"
                      variant={parsed === p ? "default" : "outline"}
                      onClick={() => setAmount(String(p))}
                    >
                      +{fmt(currency, p)}
                    </Button>
                  ))}
                </div>
                {error ? (
                  <p id="add-amount-error" className="text-xs text-destructive">{error}</p>
                ) : (
                  <p id="add-amount-help" className="text-xs text-muted-foreground">
                    Between {fmt(currency, 1)} and {fmt(currency, 1_000_000)}.
                  </p>
                )}
              </div>

              {valid && (
                <div className="rounded-md border p-3 text-sm space-y-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">New cash available</span><span className="font-medium">{fmt(currency, currentCash + parsed)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">New total capital</span><span className="font-medium">{fmt(currency, startingCash + parsed)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">New total equity</span><span className="font-medium">{fmt(currency, currentCash + parsed + holdingsValue)}</span></div>
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
